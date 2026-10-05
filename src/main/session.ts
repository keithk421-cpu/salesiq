/**
 * M0 session controller.
 *
 * Locked behaviour (AUDIO_DEVICE_REQUIREMENT.md, M0_RAVEN_TEARDOWN.md):
 * - Captures ONLY the saved/confirmed endpoint IDs. Never a default, never a look-alike.
 * - Start is blocked until both endpoints resolve, both captures open, both show real
 *   audio activity, and both Deepgram connections are open.
 * - Device loss: surface immediately, mark a gap, never switch endpoints, reconnect only
 *   to the same confirmed ID (or one Keith explicitly picks), resume from current audio.
 * - Pause stops BOTH native captures (threads joined) and drops everything queued.
 *   Resume opens fresh captures + fresh STT epochs. Nothing buffered is ever replayed.
 * - Stop / app exit leaves nothing capturing.
 */
import { randomUUID } from 'node:crypto'
import type {
  AudioEndpointConfig,
  AudioFrame,
  DiarizedWord,
  EndpointStatus,
  EndpointStatusState,
  GapCause,
  GapRecord,
  Stream,
} from '../shared/contracts'
import type { EndpointInfo, NativeAudioModule, NativeCaptureEvent } from '../shared/nativeApi'
import { MIC_THRESHOLDS, StreamActivity, SYSTEM_THRESHOLDS, type Level } from './activity'
import { DeepgramStream, isRefusal, type ProviderState, type WsFactory } from './deepgram'
import { DuplicateGate, type Suppressed } from './duplicateGate'
import { ResidualEchoGate } from './echoGate'
import { resolveConfig } from './endpoints'
import { samplesToMs } from './pcm'
import { invalidNativeEvent } from './validate'

/** Level above which a chunk counts as audible sound for duplicate-overlap checks. */
const AUDIBLE_DBFS = -50
import { TurnBuilder, type TurnEvent } from './turnBuilder'

/** How long Start keeps waiting to hear both sides before giving up (Stop cancels sooner). */
export const START_WAIT_MS = 20 * 60_000

/** What a pause gap says about why the call was paused. Automatic pauses say so. */
export const PAUSE_DETAIL = {
  keith: 'Paused by Keith',
  lock: 'Paused automatically: the PC was locked',
  sleep: 'Paused automatically: the PC went to sleep',
  nobodyHeard: 'Paused automatically: nothing was heard from the call',
} as const

export type SessionState = 'idle' | 'checking' | 'live' | 'paused' | 'stopping' | 'stopped'
export type CaptureState = 'off' | 'capturing' | 'lost' | 'recovering'

export interface StreamStatusEvent extends EndpointStatus {
  friendly_name: string
  capture: CaptureState
  provider: ProviderState | 'none'
  epoch: number
}

export type SessionEvent =
  | { type: 'state'; state: SessionState; sessionId: string | null; detail?: string }
  | { type: 'levels'; mic: Level; system: Level }
  | { type: 'check'; micPassed: boolean; systemPassed: boolean; micActiveMs: number; systemActiveMs: number; providersOpen: boolean; remainingMs: number }
  | { type: 'stream_status'; status: StreamStatusEvent }
  | { type: 'gap_open'; gap: GapRecord }
  | { type: 'gap_close'; gap: GapRecord }
  | { type: 'turn'; event: TurnEvent }
  | { type: 'interim'; stream: Stream; text: string }
  | { type: 'timing'; stream: Stream; captureLagMs: number; sttDelayMs: number | null }
  | { type: 'alert'; level: 'error' | 'warning' | 'info'; message: string }
  | { type: 'suppressed'; kind: 'echo_audio' | 'duplicate_text'; stream: Stream; detail: string }

export interface SessionDeps {
  native: NativeAudioModule
  wsFactory: WsFactory
  apiKey: string
  config: AudioEndpointConfig
  emit: (ev: SessionEvent) => void
  log: (event: string, data?: Record<string, unknown>) => void
  onFrame?: (frame: AudioFrame) => void
  checkTimeoutMs?: number
  devicePollMs?: number
  stallMs?: number
  digitalZeroWarnMs?: number
  recoveryPollMs?: number
  finalizeGraceMs?: number
}

interface StreamRt {
  stream: Stream
  label: string
  endpointId: string
  friendlyName: string
  captureGen: number
  capture: CaptureState
  dg: DeepgramStream | null
  epoch: number
  connecting: boolean
  activity: StreamActivity
  openGap: GapRecord | null
  nextDiscontinuity: boolean
  seq: number
  recoveryTimer: NodeJS.Timeout | null
  providerRetryTimer: NodeJS.Timeout | null
  providerAttempts: number
  silentWarned: boolean
  lastStatusKey: string
  /** Monotonic ms just past the last audio chunk from the current capture (null right after open). */
  lastChunkEndMono: number | null
  /** Native -> JS delivery lag samples (ms) since the last timing report. */
  lagSamples: number[]
  /** STT delay: wall time of final words minus the end of the last word (ms), last report window. */
  sttDelays: number[]
  /** Session-ms intervals where this stream carried audible (non-synthetic) sound; last ~30 s. */
  audible: Array<[number, number]>
  lastRecoveredAt: number
  recoveryBackoffMs: number
  lostAt: number
}

export class SessionController {
  state: SessionState = 'idle'
  sessionId: string | null = null
  private t0 = 0
  private readonly rt: Record<Stream, StreamRt>
  private readonly echoGate = new ResidualEchoGate()
  private readonly dupGate = new DuplicateGate()
  private turnBuilder: TurnBuilder | null = null
  private closing = new Set<DeepgramStream>()
  /** Speech-service connections still opening; aborted if Start is cancelled or the app exits meanwhile. */
  private pendingConnects = new Set<DeepgramStream>()
  private timers: NodeJS.Timeout[] = []
  private checkResolve: ((r: { ok: boolean; reason?: string }) => void) | null = null
  private endpointsAtStart: EndpointInfo[] = []
  readonly counters = {
    echoSuppressedWindows: 0,
    duplicateSuppressedSegments: 0,
    droppedWhileUnavailableMs: { local_mic: 0, system_remote: 0 } as Record<Stream, number>,
    gaps: 0,
    providerReconnects: 0,
    deviceRecoveries: 0,
  }

  constructor(private readonly deps: SessionDeps) {
    const mk = (stream: Stream, label: string, endpointId: string, friendlyName: string): StreamRt => ({
      stream, label, endpointId, friendlyName,
      captureGen: 0, capture: 'off', dg: null, epoch: 0, connecting: false,
      activity: new StreamActivity(stream === 'local_mic' ? MIC_THRESHOLDS : SYSTEM_THRESHOLDS),
      openGap: null, nextDiscontinuity: false, seq: 0,
      recoveryTimer: null, providerRetryTimer: null, providerAttempts: 0,
      silentWarned: false, lastStatusKey: '', lastChunkEndMono: null,
      lagSamples: [], sttDelays: [], audible: [],
      lastRecoveredAt: 0, recoveryBackoffMs: 0, lostAt: 0,
    })
    this.rt = {
      local_mic: mk('local_mic', 'Microphone', deps.config.microphone.endpoint_id, deps.config.microphone.friendly_name),
      system_remote: mk('system_remote', 'Meeting audio (system output)', deps.config.system_output.endpoint_id, deps.config.system_output.friendly_name),
    }
  }

  private get streams(): StreamRt[] {
    return [this.rt.system_remote, this.rt.local_mic]
  }

  private now(): number {
    return this.deps.native.monotonicNowMs()
  }

  /** Current session-relative time (ms) on the monotonic clock; used as HELP's "as of" time. */
  nowSessionMs(): number {
    return this.sessionMs()
  }

  private sessionMs(mono = this.now()): number {
    return Math.round(mono - this.t0)
  }

  private setState(state: SessionState, detail?: string): void {
    this.state = state
    this.deps.log('state', { state, detail })
    this.deps.emit({ type: 'state', state, sessionId: this.sessionId, detail })
  }

  private alert(level: 'error' | 'warning' | 'info', message: string): void {
    this.deps.log('alert', { level, message })
    this.deps.emit({ type: 'alert', level, message })
  }

  // ------------------------------------------------------------------ start

  /** Runs the session-start gate. Resolves ok:true once live, or ok:false with the blocking reason. */
  async start(): Promise<{ ok: boolean; reason?: string }> {
    if (this.state !== 'idle' && this.state !== 'stopped') return { ok: false, reason: `Cannot start while ${this.state}` }
    if (!this.deps.apiKey) return { ok: false, reason: 'Add your Deepgram API key first.' }

    // 1-2. Resolve saved endpoint IDs and verify each exists and is active.
    this.endpointsAtStart = this.deps.native.listEndpoints()
    const resolved = resolveConfig(this.deps.config, this.endpointsAtStart)
    if (!resolved.ready) {
      const reason = `Start blocked: ${resolved.problems.join(' ')} Nothing was changed in Windows or Zoom.`
      this.deps.log('start_blocked', { problems: resolved.problems })
      return { ok: false, reason }
    }

    this.sessionId = `s-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`
    this.turnBuilder = new TurnBuilder(this.sessionId)
    this.t0 = this.now()
    this.deps.log('session_created', {
      sessionId: this.sessionId,
      system_endpoint: this.rt.system_remote.endpointId,
      mic_endpoint: this.rt.local_mic.endpointId,
    })
    this.setState('checking', 'Verifying both audio streams')

    // Open both captures on the exact saved IDs.
    for (const rt of this.streams) {
      rt.activity.reset()
      rt.providerAttempts = 0
      const res = this.openCapture(rt)
      if (!res.ok) {
        this.teardownCaptures()
        const reason = `Start blocked: could not open ${rt.label} "${rt.friendlyName}" (${res.code}: ${res.error}). Nothing was changed in Windows or Zoom.`
        this.setState('idle', reason)
        return { ok: false, reason }
      }
    }
    this.startMeters()
    this.emitStatuses()

    // Keith often presses Start before the buyer joins: keep waiting for both sides (Stop cancels).
    const timeoutMs = this.deps.checkTimeoutMs ?? START_WAIT_MS
    const startedAt = Date.now()
    const result = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      this.checkResolve = resolve
      // Connect STT while the activity check runs. No audio is sent until live.
      for (const rt of this.streams) {
        this.connectProvider(rt).catch((err: Error) => {
          if (this.state !== 'checking') return
          this.deps.log('provider_connect_failed', { stream: rt.stream, message: err.message })
          this.onWaitingConnectFailed(rt, err)
        })
      }
      const tick = setInterval(() => {
        if (this.state !== 'checking') return
        const sys = this.rt.system_remote.activity
        const mic = this.rt.local_mic.activity
        // Both sides must be heard at about the same time, not two stray sounds minutes apart.
        const now = this.now()
        const sysNow = sys.passedRecently(now)
        const micNow = mic.passedRecently(now)
        const providersOpen = this.streams.every((r) => r.dg?.state === 'open')
        const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
        this.deps.emit({
          type: 'check', micPassed: micNow, systemPassed: sysNow,
          micActiveMs: Math.round(mic.recentActiveMs(now)), systemActiveMs: Math.round(sys.recentActiveMs(now)), providersOpen, remainingMs,
        })
        if (sysNow && micNow && providersOpen) {
          this.finishCheck({ ok: true })
        } else if (remainingMs <= 0) {
          const missing: string[] = []
          if (!sys.passed) missing.push(`no meeting audio heard on "${this.rt.system_remote.friendlyName}" (play Zoom's Test Speaker sound or join the meeting audio)`)
          if (!mic.passed) missing.push(`no voice heard on "${this.rt.local_mic.friendlyName}" (say a few words)`)
          if (sys.passed && mic.passed && !(sysNow && micNow)) missing.push('heard the meeting audio and your voice, but not at the same time (press Start again when the call begins)')
          if (!providersOpen) missing.push('speech service not connected')
          this.finishCheck({ ok: false, reason: `Start blocked: ${missing.join('; ')}.` })
        }
      }, 100)
      this.timers.push(tick)
    })

    if (!result.ok) {
      this.abortStart(result.reason ?? 'Start blocked')
      return result
    }
    this.goLive()
    return { ok: true }
  }

  private finishCheck(r: { ok: boolean; reason?: string }): void {
    const resolve = this.checkResolve
    this.checkResolve = null
    resolve?.(r)
  }

  private abortStart(reason: string): void {
    this.deps.log('start_aborted', { reason })
    this.clearTimers()
    this.teardownCaptures()
    for (const dg of this.pendingConnects) dg.abort()
    this.pendingConnects.clear()
    for (const rt of this.streams) {
      if (rt.providerRetryTimer) clearTimeout(rt.providerRetryTimer)
      rt.providerRetryTimer = null
      rt.dg?.abort()
      rt.dg = null
    }
    this.setState('idle', reason)
    this.emitStatuses()
  }

  private goLive(): void {
    this.t0 = this.now()
    this.echoGate.reset()
    for (const rt of this.streams) rt.nextDiscontinuity = false
    this.setState('live')
    this.alert('info', `Listening. Meeting audio: "${this.rt.system_remote.friendlyName}". Mic: "${this.rt.local_mic.friendlyName}".`)
    this.startLiveTimers()
    this.emitStatuses()
  }

  // ------------------------------------------------------------------ capture

  private openCapture(rt: StreamRt): { ok: boolean; code?: string; error?: string } {
    const gen = ++rt.captureGen
    const res = this.deps.native.startCapture(rt.stream, rt.endpointId, (ev) => {
      // Never let an exception escape into the native callback (it would crash the main process).
      try {
        this.onNative(rt, gen, ev)
      } catch (err) {
        this.deps.log('handler_error', { stream: rt.stream, message: (err as Error).message })
      }
    })
    this.deps.log('capture_open', { stream: rt.stream, endpoint: rt.endpointId, ok: res.ok, code: res.code, error: res.error, mixFormat: res.mixFormat })
    if (res.ok) {
      rt.capture = 'capturing'
      rt.activity.reset()
      rt.activity.lastChunkAtMs = this.now()
      rt.lastChunkEndMono = null
      rt.silentWarned = false
    }
    return res
  }

  private closeCapture(rt: StreamRt): void {
    rt.captureGen++ // anything still queued from the old capture is ignored
    this.deps.native.stopCapture(rt.stream)
    if (rt.capture === 'capturing') rt.capture = 'off'
  }

  private teardownCaptures(): void {
    for (const rt of this.streams) this.closeCapture(rt)
    for (const rt of this.streams) rt.capture = 'off'
  }

  private onNative(rt: StreamRt, gen: number, ev: NativeCaptureEvent): void {
    if (gen !== rt.captureGen) return // stale: from a capture we already stopped
    const bad = invalidNativeEvent(ev)
    if (bad) {
      this.deps.log('invalid_native_event', { stream: rt.stream, reason: bad })
      return
    }
    if (ev.kind === 'audio') {
      const now = this.now()
      rt.activity.push(ev.data, now, ev.syntheticSilence)
      const prevEnd = rt.lastChunkEndMono
      rt.lastChunkEndMono = ev.monotonicMs + samplesToMs(ev.samples)
      if (!ev.syntheticSilence) {
        if (rt.lagSamples.length < 2000) rt.lagSamples.push(now - rt.lastChunkEndMono)
        if (this.state === 'live' && rt.activity.level.rmsDbfs > AUDIBLE_DBFS) this.markAudible(rt, this.sessionMs(ev.monotonicMs), this.sessionMs(rt.lastChunkEndMono))
      }
      // The first packet after opening a stream commonly carries the WASAPI discontinuity
      // flag; that is the start of capture, not a gap.
      if (ev.discontinuity && prevEnd !== null) {
        rt.nextDiscontinuity = true
        const dropped = ev.droppedChunks ?? 0
        this.deps.log('wasapi_discontinuity', { stream: rt.stream, sessionMs: this.sessionMs(ev.monotonicMs), droppedChunks: dropped })
        if (this.state === 'live') {
          this.recordInstantGap(
            rt,
            dropped > 0 ? 'capture_overflow' : 'wasapi_discontinuity',
            prevEnd,
            ev.monotonicMs,
            dropped > 0 ? `${dropped} audio chunks dropped (app fell behind)` : 'Windows reported an audio glitch (data discontinuity)',
          )
        }
      }
      if (this.state !== 'live') return
      if (rt.stream === 'system_remote') {
        this.echoGate.pushSystemPcm(ev.data)
        this.sendFrame(rt, ev.data, ev.samples, ev.monotonicMs)
      } else {
        if (ev.discontinuity) this.echoGate.discardPending()
        // Re-anchor on every chunk: the first buffered sample's time is this chunk's time minus what is still pending.
        let ts = ev.monotonicMs - samplesToMs(this.echoGate.pendingSampleCount)
        for (const w of this.echoGate.pushMicPcm(ev.data)) {
          const windowTs = ts
          ts += 100
          if (w.decision === 'echo' || w.decision === 'hold') {
            this.counters.echoSuppressedWindows++
            if (this.counters.echoSuppressedWindows % 10 === 1) {
              this.deps.emit({ type: 'suppressed', kind: 'echo_audio', stream: 'local_mic', detail: `Meeting audio leaking into mic was muted (corr ${w.correlation.toFixed(2)}).` })
            }
            this.deps.log('echo_suppressed', { sessionMs: this.sessionMs(windowTs), corr: Number(w.correlation.toFixed(3)), decision: w.decision })
          }
          this.sendFrame(rt, w.pcm, 1600, windowTs)
        }
      }
      return
    }
    if (ev.kind === 'error') {
      this.deps.log('capture_error', { stream: rt.stream, code: ev.code, message: ev.message, hresult: ev.hresult })
      const cause: GapCause = ev.code === 'device_invalidated' ? 'device_lost' : 'capture_error'
      this.handleLoss(rt, cause, `${ev.code}${ev.hresult ? ` (${ev.hresult})` : ''}: ${ev.message}`)
      return
    }
    if (ev.kind === 'stopped' && ev.reason === 'error') {
      this.handleLoss(rt, 'capture_error', 'Capture stopped unexpectedly')
    }
  }

  private sendFrame(rt: StreamRt, pcm: Buffer, samples: number, monoMs: number): void {
    if (this.state !== 'live' || rt.capture !== 'capturing') return
    const sMs = this.sessionMs(monoMs)
    const dg = rt.dg
    if (!dg || dg.state !== 'open' || !dg.send(pcm, samples, sMs)) {
      // Provider unavailable: drop (never buffer for replay) and make sure a gap is open.
      this.counters.droppedWhileUnavailableMs[rt.stream] += samplesToMs(samples)
      if (!rt.openGap) this.openGap(rt, 'provider_disconnect', 'Speech service not connected; audio dropped, not buffered')
      return
    }
    const discontinuity = rt.nextDiscontinuity || rt.openGap !== null
    if (rt.openGap) this.closeGap(rt, sMs, 'recovered')
    rt.nextDiscontinuity = false
    this.deps.onFrame?.({
      session_id: this.sessionId!, stream: rt.stream, seq: rt.seq++, monotonic_start_ms: sMs,
      duration_ms: samplesToMs(samples), sample_rate_hz: 16000, channels: 1, encoding: 'linear16',
      payload: pcm, discontinuity_before: discontinuity,
    })
  }

  // ------------------------------------------------------------------ loss + recovery

  private handleLoss(rt: StreamRt, cause: GapCause, detail: string): void {
    if (this.state === 'checking') {
      this.finishCheck({ ok: false, reason: `Start blocked: ${rt.label} "${rt.friendlyName}" failed during the check (${detail}).` })
      return
    }
    if (this.state !== 'live') return
    if (rt.capture === 'lost' || rt.capture === 'recovering') return

    this.closeCapture(rt)
    rt.capture = 'lost'
    // A device that keeps failing right after recovery (e.g. headset off but dongle present) is retried
    // with growing back-off so it does not flap.
    const now = Date.now()
    rt.recoveryBackoffMs =
      rt.lastRecoveredAt && now - rt.lastRecoveredAt < 15000 ? Math.min(30000, Math.max(2000, rt.recoveryBackoffMs * 2)) : 0
    rt.lostAt = now
    const deviceState = this.deps.native.getEndpointState(rt.endpointId)
    if (rt.openGap) this.closeGap(rt, this.sessionMs(), 'not_recovered')
    this.openGap(rt, cause, detail, deviceState)
    this.alert(
      'error',
      `${rt.label} lost: "${rt.friendlyName}" (${detail}). Transcript gap marked. Not switching to any other device and not touching Windows/Zoom settings. Waiting for this device to come back, or pick a device explicitly.`,
    )
    if (rt.stream === 'system_remote') this.echoGate.reset()
    this.retireProvider(rt)
    this.emitStatuses()
    this.startRecoveryPoll(rt)
  }

  private startRecoveryPoll(rt: StreamRt): void {
    if (rt.recoveryTimer) clearInterval(rt.recoveryTimer)
    rt.recoveryTimer = setInterval(() => {
      if (this.state !== 'live') return
      if (Date.now() - rt.lostAt < rt.recoveryBackoffMs) return
      if (this.deps.native.getEndpointState(rt.endpointId) === 'active') void this.tryRecover(rt)
    }, this.deps.recoveryPollMs ?? 1000)
  }

  private async tryRecover(rt: StreamRt): Promise<void> {
    if (rt.capture !== 'lost') return
    rt.capture = 'recovering'
    this.emitStatuses()
    // Provider first, then capture, so the first audio after recovery is current audio.
    const providerOk = await this.connectProvider(rt).then(() => true, () => false)
    if (this.state !== 'live' || rt.capture !== 'recovering') return
    if (!providerOk) {
      rt.capture = 'lost'
      this.emitStatuses()
      return
    }
    const res = this.openCapture(rt)
    if (!res.ok) {
      this.deps.log('recovery_attempt_failed', { stream: rt.stream, code: res.code, error: res.error })
      this.retireProvider(rt)
      rt.capture = 'lost'
      this.emitStatuses()
      return
    }
    if (rt.recoveryTimer) clearInterval(rt.recoveryTimer)
    rt.recoveryTimer = null
    rt.nextDiscontinuity = true
    rt.lastRecoveredAt = Date.now()
    if (rt.stream === 'local_mic') this.echoGate.discardPending()
    this.counters.deviceRecoveries++
    this.alert('info', `${rt.label} reconnected to the same confirmed device "${rt.friendlyName}". Resuming from current audio only.`)
    this.emitStatuses()
  }

  /**
   * Keith explicitly picked a (different) endpoint for this stream during the session.
   * Used for this session only; saving it as the default pair happens in device setup.
   */
  async switchEndpoint(stream: Stream, endpoint: EndpointInfo): Promise<{ ok: boolean; reason?: string }> {
    const rt = this.rt[stream]
    const wantFlow = stream === 'system_remote' ? 'render' : 'capture'
    if (endpoint.flow !== wantFlow) return { ok: false, reason: `That is not ${wantFlow === 'render' ? 'an output' : 'an input'} device.` }
    this.deps.log('endpoint_switch_confirmed', { stream, from: rt.endpointId, to: endpoint.id })
    if (this.state === 'live' && rt.capture === 'capturing') {
      this.closeCapture(rt)
      rt.capture = 'lost'
      this.openGap(rt, 'device_lost', `Keith switched to "${endpoint.friendlyName}"`, 'active')
      this.retireProvider(rt)
    }
    rt.endpointId = endpoint.id
    rt.friendlyName = endpoint.friendlyName
    if (this.state === 'live') {
      await this.tryRecover(rt)
      if (rt.capture !== 'capturing') this.startRecoveryPoll(rt)
    }
    this.emitStatuses()
    return { ok: true }
  }

  // ------------------------------------------------------------------ provider

  private async connectProvider(rt: StreamRt): Promise<void> {
    if (!this.sessionId) throw new Error('no session')
    rt.connecting = true
    const epoch = ++rt.epoch
    const dg = new DeepgramStream({
      apiKey: this.deps.apiKey,
      sessionId: this.sessionId,
      stream: rt.stream,
      epoch,
      diarize: rt.stream === 'system_remote',
      wsFactory: this.deps.wsFactory,
      log: (e, d) => this.deps.log(e, d),
      onWords: (words, info) => this.onWords(rt, words, info.isFinal),
      onUnexpectedClose: (detail) => this.onProviderClosed(rt, dg, detail),
    })
    this.pendingConnects.add(dg)
    try {
      await dg.connect()
    } catch (err) {
      rt.connecting = false
      this.emitStatuses()
      throw err
    } finally {
      rt.connecting = false
      this.pendingConnects.delete(dg)
    }
    if (this.state === 'stopping' || this.state === 'stopped' || this.state === 'idle') {
      dg.abort()
      throw new Error('session ended')
    }
    rt.dg?.abort()
    rt.dg = dg
    rt.providerAttempts = 0
    this.emitStatuses()
  }

  private retireProvider(rt: StreamRt): void {
    const dg = rt.dg
    rt.dg = null
    if (!dg) return
    this.closing.add(dg)
    void dg.finalizeAndClose(this.deps.finalizeGraceMs ?? 1500).then(() => this.closing.delete(dg))
  }

  private onProviderClosed(rt: StreamRt, dg: DeepgramStream, detail: string): void {
    if (rt.dg !== dg) return
    rt.dg = null
    this.deps.log('provider_lost', { stream: rt.stream, epoch: dg.epoch, detail })
    // While waiting for the call to begin, just reconnect: no audio has been sent, so nothing is missed.
    if (this.state === 'checking') return this.scheduleProviderRetry(rt)
    if (this.state !== 'live') return
    if (!rt.openGap) this.openGap(rt, 'provider_disconnect', `Speech service connection closed (${detail})`)
    this.alert('warning', `${rt.label}: speech service disconnected (${detail}). Reconnecting; gap marked; no audio will be replayed.`)
    this.emitStatuses()
    this.scheduleProviderRetry(rt)
  }

  /**
   * While waiting for the call to begin, a failed connect is retried like a later drop: no audio has
   * been sent, so nothing is missed. Only a refusal (e.g. the API key was rejected) blocks Start now.
   */
  private onWaitingConnectFailed(rt: StreamRt, err: Error): void {
    if (this.state !== 'checking') return
    if (isRefusal(err)) {
      this.finishCheck({ ok: false, reason: `Start blocked: speech service unavailable (${err.message}).` })
      return
    }
    this.scheduleProviderRetry(rt)
  }

  private scheduleProviderRetry(rt: StreamRt): void {
    if (rt.providerRetryTimer) return
    const delay = Math.min(8000, 500 * 2 ** rt.providerAttempts)
    rt.providerAttempts++
    rt.providerRetryTimer = setTimeout(async () => {
      rt.providerRetryTimer = null
      const waiting = this.state === 'checking'
      if ((this.state !== 'live' && !waiting) || rt.dg || rt.capture !== 'capturing') return
      try {
        await this.connectProvider(rt)
        if (waiting) return
        this.counters.providerReconnects++
        this.alert('info', `${rt.label}: speech service reconnected (new connection epoch ${rt.epoch}; speaker labels restart).`)
      } catch (err) {
        this.deps.log('provider_retry_failed', { stream: rt.stream, attempt: rt.providerAttempts, message: (err as Error).message })
        if (this.state === 'checking') this.onWaitingConnectFailed(rt, err as Error)
        else if (this.state === 'live') this.scheduleProviderRetry(rt)
      }
    }, delay)
  }

  private onWords(rt: StreamRt, words: DiarizedWord[], isFinal: boolean): void {
    if (!this.turnBuilder) return
    if (this.state === 'idle' || this.state === 'checking') return
    if (!isFinal) {
      // Interim text is provisional and display-only; turns are built from finals.
      this.deps.emit({ type: 'interim', stream: rt.stream, text: words.map((w) => w.word).join(' ') })
      return
    }
    const last = words[words.length - 1]
    const sttDelayMs = last ? this.sessionMs() - last.end_ms : null
    if (sttDelayMs !== null && rt.sttDelays.length < 500) rt.sttDelays.push(sttDelayMs)
    this.deps.log('final_words', {
      stream: rt.stream, epoch: words[0]?.connection_epoch, count: words.length,
      start_ms: words[0]?.start_ms, end_ms: last?.end_ms, stt_delay_ms: sttDelayMs,
    })
    this.deps.emit({ type: 'interim', stream: rt.stream, text: '' })
    if (rt.stream === 'system_remote') {
      this.dupGate.addSystemWords(words)
      this.emitTurns(this.turnBuilder.addFinalWords(words))
    } else {
      const start = words[0].start_ms - 1500
      const end = (last?.end_ms ?? words[0].end_ms) + 1500
      const systemMayOverlap = this.rt.system_remote.audible.some(([a, b]) => b >= start && a <= end)
      this.dupGate.addMicWords(words, Date.now(), systemMayOverlap)
      if (!systemMayOverlap) this.pumpDuplicateGate()
    }
  }

  /** Record that a stream carried audible sound over [startMs, endMs] (session ms), keeping ~30 s. */
  private markAudible(rt: StreamRt, startMs: number, endMs: number): void {
    const lastIv = rt.audible[rt.audible.length - 1]
    if (lastIv && startMs - lastIv[1] <= 50) lastIv[1] = Math.max(lastIv[1], endMs)
    else rt.audible.push([startMs, endMs])
    while (rt.audible.length && rt.audible[0][1] < endMs - 30000) rt.audible.shift()
  }

  private pumpDuplicateGate(force = false): void {
    if (!this.turnBuilder) return
    const { release, suppressed } = this.dupGate.poll(Date.now(), force)
    for (const s of suppressed) this.reportDuplicate(s)
    for (const words of release) this.emitTurns(this.turnBuilder.addFinalWords(words))
  }

  private reportDuplicate(s: Suppressed): void {
    this.counters.duplicateSuppressedSegments++
    const text = s.words.map((w) => w.word).join(' ')
    this.deps.log('duplicate_suppressed', { start_ms: s.words[0].start_ms, score: Number(s.score.toFixed(2)), words: s.words.length })
    this.deps.emit({ type: 'suppressed', kind: 'duplicate_text', stream: 'local_mic', detail: `Dropped mic text that repeated meeting audio: "${text}"` })
  }

  private emitTurns(events: TurnEvent[]): void {
    for (const e of events) this.deps.emit({ type: 'turn', event: e })
  }

  // ------------------------------------------------------------------ gaps

  private openGap(rt: StreamRt, cause: GapCause, detail: string, deviceState = this.deps.native.getEndpointState(rt.endpointId)): void {
    const gap: GapRecord = {
      gap_id: `g${++this.counters.gaps}`,
      stream: rt.stream,
      cause,
      start_ms: this.sessionMs(),
      end_ms: null,
      duration_ms: null,
      device_state: deviceState,
      provider_state: rt.dg ? rt.dg.state : 'none',
      recovery: 'pending',
      detail,
    }
    rt.openGap = gap
    this.deps.log('gap_open', { ...gap })
    this.deps.emit({ type: 'gap_open', gap: { ...gap } })
    if (this.turnBuilder) this.emitTurns(this.turnBuilder.markGap(gap))
  }

  /** A discontinuity that is already over when detected (glitch, dropped chunks): open + close at once. */
  private recordInstantGap(rt: StreamRt, cause: GapCause, startMono: number, endMono: number, detail: string): void {
    if (rt.openGap) return // already inside a gap on this stream
    const start = this.sessionMs(Math.min(startMono, endMono))
    const end = this.sessionMs(Math.max(startMono, endMono))
    const gap: GapRecord = {
      gap_id: `g${++this.counters.gaps}`,
      stream: rt.stream,
      cause,
      start_ms: start,
      end_ms: end,
      duration_ms: end - start,
      device_state: this.deps.native.getEndpointState(rt.endpointId),
      provider_state: rt.dg ? rt.dg.state : 'none',
      recovery: 'recovered',
      detail,
    }
    this.deps.log('gap_open', { ...gap, end_ms: null, duration_ms: null, recovery: 'pending' })
    this.deps.log('gap_close', { ...gap })
    this.deps.emit({ type: 'gap_open', gap: { ...gap } })
    this.deps.emit({ type: 'gap_close', gap: { ...gap } })
    if (this.turnBuilder) this.emitTurns(this.turnBuilder.markGap(gap))
  }

  private closeGap(rt: StreamRt, endMs: number, recovery: GapRecord['recovery']): void {
    const gap = rt.openGap
    if (!gap) return
    rt.openGap = null
    gap.end_ms = endMs
    gap.duration_ms = Math.max(0, endMs - gap.start_ms)
    gap.recovery = recovery
    gap.provider_state = rt.dg ? rt.dg.state : 'none'
    this.deps.log('gap_close', { ...gap })
    this.deps.emit({ type: 'gap_close', gap: { ...gap } })
  }

  // ------------------------------------------------------------------ pause / resume / stop

  /** `detail` is recorded on the pause gap; automatic pauses pass one of PAUSE_DETAIL's other entries. */
  pause(detail: string = PAUSE_DETAIL.keith): { ok: boolean; reason?: string } {
    if (this.state !== 'live') return { ok: false, reason: `Cannot pause while ${this.state}` }
    this.setState('paused')
    this.clearTimers()
    for (const rt of this.streams) {
      this.closeCapture(rt) // joins the native thread: nothing is capturing after this line
      rt.capture = 'off'
      if (rt.recoveryTimer) clearInterval(rt.recoveryTimer)
      if (rt.providerRetryTimer) clearTimeout(rt.providerRetryTimer)
      rt.recoveryTimer = null
      rt.providerRetryTimer = null
      if (rt.openGap) this.closeGap(rt, this.sessionMs(), 'not_recovered')
      this.openGap(rt, 'pause', detail, 'active')
      this.retireProvider(rt)
    }
    this.echoGate.reset()
    const stillCapturing = this.streams.filter((rt) => this.deps.native.isCapturing(rt.stream)).map((rt) => rt.stream)
    this.deps.log('pause_verified', { stillCapturing })
    if (stillCapturing.length) this.alert('error', `Pause: native capture still running for ${stillCapturing.join(', ')}`)
    // Release held mic text from before the pause now, so nothing pre-pause can appear after Resume.
    this.pumpDuplicateGate(true)
    const pauseTimer = setInterval(() => this.pumpDuplicateGate(), 250)
    this.timers.push(pauseTimer)
    this.emitStatuses()
    return { ok: true }
  }

  async resume(): Promise<{ ok: boolean; reason?: string }> {
    if (this.state !== 'paused') return { ok: false, reason: `Cannot resume while ${this.state}` }
    // Anything from before the pause that has not arrived yet will never be shown.
    for (const dg of this.closing) dg.abort()
    this.closing.clear()
    this.pumpDuplicateGate(true)
    this.clearTimers()

    for (const rt of this.streams) {
      const st = this.deps.native.getEndpointState(rt.endpointId)
      if (st !== 'active') {
        const reason = `Still paused: ${rt.label} "${rt.friendlyName}" is ${st}. Turn it back on, or pick a device explicitly.`
        this.alert('error', reason)
        return { ok: false, reason }
      }
    }
    try {
      await Promise.all(this.streams.map((rt) => this.connectProvider(rt)))
    } catch (err) {
      for (const rt of this.streams) { rt.dg?.abort(); rt.dg = null }
      const reason = `Still paused: speech service unavailable (${(err as Error).message}).`
      this.alert('error', reason)
      return { ok: false, reason }
    }
    if (this.state !== 'paused') return { ok: false, reason: 'Session changed during resume' }
    for (const rt of this.streams) {
      const res = this.openCapture(rt)
      if (!res.ok) {
        this.teardownCaptures()
        for (const r of this.streams) { r.dg?.abort(); r.dg = null }
        const reason = `Still paused: could not reopen ${rt.label} "${rt.friendlyName}" (${res.code}: ${res.error}).`
        this.alert('error', reason)
        return { ok: false, reason }
      }
      rt.nextDiscontinuity = true
    }
    this.echoGate.reset()
    this.setState('live')
    this.startLiveTimers()
    this.emitStatuses()
    return { ok: true }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped' || this.state === 'stopping') return
    if (this.state === 'checking') {
      this.finishCheck({ ok: false, reason: 'Stopped by Keith' })
      return
    }
    this.setState('stopping')
    this.clearTimers()
    for (const rt of this.streams) {
      if (rt.recoveryTimer) clearInterval(rt.recoveryTimer)
      if (rt.providerRetryTimer) clearTimeout(rt.providerRetryTimer)
      rt.recoveryTimer = null
      rt.providerRetryTimer = null
    }
    this.teardownCaptures()
    this.deps.native.stopAll()
    const grace = this.deps.finalizeGraceMs ?? 1500
    await Promise.all([
      ...this.streams.map((rt) => {
        const dg = rt.dg
        rt.dg = null
        return dg ? dg.finalizeAndClose(grace) : Promise.resolve()
      }),
      ...[...this.closing].map((dg) => dg.finalizeAndClose(grace)),
    ])
    this.closing.clear()
    this.pumpDuplicateGate(true)
    if (this.turnBuilder) this.emitTurns(this.turnBuilder.flushAll())
    for (const rt of this.streams) if (rt.openGap) this.closeGap(rt, this.sessionMs(), 'session_ended')
    const stillCapturing = this.streams.filter((rt) => this.deps.native.isCapturing(rt.stream)).map((rt) => rt.stream)
    this.deps.log('teardown_verified', { stillCapturing, counters: this.counters, durationMs: this.sessionMs() })
    this.setState('stopped', `Session length ${Math.round(this.sessionMs() / 1000)} s`)
    this.emitStatuses()
  }

  /** Synchronous emergency teardown for app exit. */
  shutdownNow(): void {
    this.clearTimers()
    for (const rt of this.streams) {
      if (rt.recoveryTimer) clearInterval(rt.recoveryTimer)
      if (rt.providerRetryTimer) clearTimeout(rt.providerRetryTimer)
      rt.captureGen++
      rt.dg?.abort()
      rt.dg = null
    }
    for (const dg of this.closing) dg.abort()
    for (const dg of this.pendingConnects) dg.abort()
    this.deps.native.stopAll()
    this.deps.log('shutdown_now', { stillCapturing: this.streams.filter((rt) => this.deps.native.isCapturing(rt.stream)).map((r) => r.stream) })
  }

  // ------------------------------------------------------------------ timers / status

  private startMeters(): void {
    this.timers.push(
      setInterval(() => {
        this.deps.emit({ type: 'levels', mic: this.rt.local_mic.activity.level, system: this.rt.system_remote.activity.level })
      }, 100),
    )
  }

  /** Summarize Windows defaults + present endpoints, to make changes visible (never acted on). */
  private deviceLandscape(eps: EndpointInfo[]): { defaults: string; present: Set<string> } {
    const name = (flow: 'render' | 'capture') => eps.find((e) => e.flow === flow && e.isDefaultConsole)?.friendlyName ?? 'none'
    return {
      defaults: `output=${name('render')} | input=${name('capture')}`,
      present: new Set(eps.filter((e) => e.state === 'active').map((e) => e.id)),
    }
  }

  private startLiveTimers(): void {
    this.startMeters()
    // Timing report: where latency comes from (native delivery vs speech service).
    this.timers.push(
      setInterval(() => {
        if (this.state !== 'live') return
        for (const rt of this.streams) {
          const lag = rt.lagSamples
          const stt = rt.sttDelays
          if (lag.length === 0 && stt.length === 0) continue
          const avg = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) / a.length)
          const captureLagMs = lag.length ? avg(lag) : 0
          const sttDelayMs = stt.length ? avg(stt) : null
          this.deps.log('timing', {
            stream: rt.stream, capture_lag_avg_ms: captureLagMs, capture_lag_max_ms: lag.length ? Math.round(Math.max(...lag)) : null,
            stt_delay_avg_ms: sttDelayMs, stt_delay_max_ms: stt.length ? Math.round(Math.max(...stt)) : null, finals: stt.length,
          })
          this.deps.emit({ type: 'timing', stream: rt.stream, captureLagMs, sttDelayMs })
          rt.lagSamples = []
          rt.sttDelays = []
        }
      }, 10000),
    )
    // Windows default / device-list changes: shown and logged, never acted on.
    let landscape = this.deviceLandscape(this.endpointsAtStart)
    this.timers.push(
      setInterval(() => {
        if (this.state !== 'live') return
        let eps: EndpointInfo[]
        try {
          eps = this.deps.native.listEndpoints()
        } catch {
          return
        }
        const next = this.deviceLandscape(eps)
        if (next.defaults !== landscape.defaults) {
          this.deps.log('windows_defaults_changed', { from: landscape.defaults, to: next.defaults })
          this.alert('info', `Windows default devices changed (${next.defaults}). Ignored: still capturing only your selected devices.`)
        }
        const added = eps.filter((e) => next.present.has(e.id) && !landscape.present.has(e.id)).map((e) => e.friendlyName)
        const removed = this.endpointsAtStart.concat(eps).filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i)
          .filter((e) => landscape.present.has(e.id) && !next.present.has(e.id)).map((e) => e.friendlyName)
        if (added.length || removed.length) {
          this.deps.log('endpoints_changed', { added, removed })
          this.alert('info', `Audio devices changed${added.length ? `; added: ${added.join(', ')}` : ''}${removed.length ? `; removed: ${removed.join(', ')}` : ''}.`)
        }
        landscape = next
      }, 5000),
    )
    // Device presence + stall + digital-silence watch.
    this.timers.push(
      setInterval(() => {
        if (this.state !== 'live') return
        const now = this.now()
        for (const rt of this.streams) {
          if (rt.capture !== 'capturing') continue
          const st = this.deps.native.getEndpointState(rt.endpointId)
          if (st !== 'active') {
            this.handleLoss(rt, 'device_lost', `Windows reports the device is ${st}`)
            continue
          }
          const since = rt.activity.sinceLastChunk(now)
          if (since !== null && since > (this.deps.stallMs ?? 2000)) {
            this.handleLoss(rt, 'device_stalled', `No audio data from Windows for ${Math.round(since)} ms`)
            continue
          }
          if (rt.stream === 'local_mic') {
            // Many headsets (e.g. Razer BlackShark V2 Pro) noise-gate the mic to exact zeros whenever
            // Keith is not talking, so short digital silence is normal. Only a long run is worth a note.
            const zero = rt.activity.digitalZeroRunMs >= (this.deps.digitalZeroWarnMs ?? 60000)
            if (zero && !rt.silentWarned) {
              rt.silentWarned = true
              this.alert('warning', `No sound from microphone "${rt.friendlyName}" for ${Math.round(rt.activity.digitalZeroRunMs / 1000)} s. Fine if you've been listening; if you've been talking, check the headset's mute/power.`)
              this.deps.log('mic_digital_silence', { sessionMs: this.sessionMs() })
            } else if (!zero && rt.silentWarned && rt.activity.digitalZeroRunMs === 0) {
              rt.silentWarned = false
              this.alert('info', `Microphone "${rt.friendlyName}" is picking up sound again.`)
            }
          }
        }
        this.emitStatuses()
      }, this.deps.devicePollMs ?? 500),
    )
    // Duplicate gate + idle turn closing.
    this.timers.push(
      setInterval(() => {
        this.pumpDuplicateGate()
        if (this.turnBuilder) {
          const now = this.sessionMs()
          // Keep a turn open while its stream still carries sound after the turn's last word
          // (the speaker is still talking; finals lag), up to a hard cap of 10 s.
          this.emitTurns(this.turnBuilder.flushIdle(now, (stream, end) => {
            if (now - end > 10000) return false
            return this.rt[stream].audible.some(([a, b]) => b > end + 300 && a < now)
          }))
        }
      }, 250),
    )
  }

  private clearTimers(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  private emitStatuses(): void {
    for (const rt of this.streams) {
      const st = this.deps.native.getEndpointState(rt.endpointId)
      let state: EndpointStatusState = st
      let reason = `Windows reports ${st}`
      if (st === 'active') {
        if (rt.capture === 'lost') { state = 'invalidated'; reason = 'Capture lost; waiting for device' }
        else if (rt.stream === 'local_mic' && rt.silentWarned) { state = 'silent'; reason = 'Digital silence from device' }
        else reason = rt.capture === 'capturing' ? 'Capturing' : 'Ready'
      }
      const info = this.endpointsAtStart.find((e) => e.id === rt.endpointId)
      const status: StreamStatusEvent = {
        stream: rt.stream,
        endpoint_id: rt.endpointId,
        friendly_name: rt.friendlyName,
        state,
        detected_at_ms: this.sessionMs(),
        reason,
        is_windows_default: !!info && (info.isDefaultConsole || info.isDefaultCommunications),
        capture: rt.capture,
        provider: rt.dg ? rt.dg.state : rt.connecting ? 'connecting' : 'none',
        epoch: rt.epoch,
      }
      const key = `${status.state}|${status.capture}|${status.provider}|${status.epoch}|${status.endpoint_id}`
      if (key !== rt.lastStatusKey) {
        rt.lastStatusKey = key
        this.deps.log('stream_status', { ...status })
      }
      this.deps.emit({ type: 'stream_status', status })
    }
  }
}
