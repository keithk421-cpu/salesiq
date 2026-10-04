/**
 * Device scan for the setup screen.
 *
 * - 'find': listens to EVERY active output (loopback) and microphone at once, so Keith can
 *   click Zoom's Test Speaker, talk, and see which devices light up. The app then suggests
 *   the pair; Keith still confirms. Nothing in Windows or Zoom is changed.
 * - 'test': listens to the one chosen pair.
 *
 * Uses probe streams (separate native slots) in WASAPI shared mode, read-only. Sends nothing
 * anywhere and saves nothing. Reports what Windows actually delivers per device so a flat
 * meter can be diagnosed (no packets vs. packets of pure silence vs. real audio).
 */
import type { EndpointInfo, NativeAudioModule, NativeCaptureEvent, ProbeStream } from '../shared/nativeApi'
import { MIC_THRESHOLDS, StreamActivity, SYSTEM_THRESHOLDS } from './activity'
import { isDigitalZero, toInt16 } from './pcm'

export interface ProbeStats {
  id: string
  flow: 'render' | 'capture'
  name: string
  rmsDbfs: number
  peakDbfs: number
  activeMs: number
  passed: boolean
  /** Chunks of real audio from Windows (not synthetic fill) that contained sound. */
  soundChunks: number
  /** Chunks from Windows that were all zeros / flagged silent. */
  silentChunks: number
  /** Loopback idle fill: Windows delivered nothing because nothing played to this device. */
  idleChunks: number
  error?: string
}

export interface DeviceScanEvent {
  mode: 'find' | 'test'
  running: boolean
  remainingMs: number
  devices: ProbeStats[]
  suggestedOutputId: string | null
  suggestedMicId: string | null
}

interface Probe {
  stream: ProbeStream
  ep: EndpointInfo
  activity: StreamActivity
  peakDb: number
  soundChunks: number
  silentChunks: number
  idleChunks: number
  error?: string
}

const MAX_PER_FLOW = 16

export class DeviceScanner {
  private probes: Probe[] = []
  private timer: NodeJS.Timeout | null = null
  private gen = 0
  private mode: 'find' | 'test' = 'test'
  running = false
  private lastPassed = new Set<string>()

  constructor(
    private readonly native: NativeAudioModule,
    private readonly emit: (e: DeviceScanEvent) => void,
    private readonly log: (e: string, d?: Record<string, unknown>) => void,
  ) {}

  /** Listen to every active output and mic. */
  find(durationMs = 45000): { ok: boolean; error?: string; opened: number } {
    const eps = this.native.listEndpoints().filter((e) => e.state === 'active')
    const outs = eps.filter((e) => e.flow === 'render').slice(0, MAX_PER_FLOW)
    const mics = eps.filter((e) => e.flow === 'capture').slice(0, MAX_PER_FLOW)
    return this.run('find', [...outs, ...mics], durationMs)
  }

  /** Listen to one chosen output + mic pair. */
  test(systemId: string, micId: string, durationMs = 60000): { ok: boolean; error?: string; opened: number } {
    const eps = this.native.listEndpoints()
    const sys = eps.find((e) => e.id === systemId)
    const mic = eps.find((e) => e.id === micId)
    if (!sys || sys.flow !== 'render') return { ok: false, error: 'Pick a meeting-audio output first.', opened: 0 }
    if (!mic || mic.flow !== 'capture') return { ok: false, error: 'Pick a microphone first.', opened: 0 }
    return this.run('test', [sys, mic], durationMs)
  }

  private run(mode: 'find' | 'test', eps: EndpointInfo[], durationMs: number): { ok: boolean; error?: string; opened: number } {
    this.stop()
    this.mode = mode
    this.lastPassed.clear()
    const gen = ++this.gen
    this.probes = []
    eps.forEach((ep, i) => {
      const stream = `${ep.flow === 'render' ? 'probe_render' : 'probe_capture'}:${i}` as ProbeStream
      const probe: Probe = {
        stream, ep,
        activity: new StreamActivity(ep.flow === 'render' ? SYSTEM_THRESHOLDS : MIC_THRESHOLDS),
        peakDb: -100, soundChunks: 0, silentChunks: 0, idleChunks: 0,
      }
      const res = this.native.startCapture(stream, ep.id, (ev) => {
        if (gen !== this.gen) return
        try {
          this.onEvent(probe, ev)
        } catch (err) {
          this.log('handler_error', { where: 'device_scan', message: (err as Error).message })
        }
      })
      if (!res.ok) probe.error = `${res.code}: ${res.error}`
      this.probes.push(probe)
    })
    const opened = this.probes.filter((p) => !p.error).length
    this.log('device_scan_start', {
      mode,
      devices: this.probes.map((p) => ({ id: p.ep.id, flow: p.ep.flow, name: p.ep.friendlyName, error: p.error })),
    })
    if (opened === 0) {
      this.stopProbes()
      return { ok: false, error: this.probes.map((p) => `${p.ep.friendlyName}: ${p.error}`).join('; ') || 'No devices found.', opened }
    }
    this.running = true
    const started = Date.now()
    this.timer = setInterval(() => {
      const remainingMs = Math.max(0, durationMs - (Date.now() - started))
      this.emit(this.snapshot(true, remainingMs))
      if (remainingMs <= 0) this.stop()
    }, 100)
    return { ok: true, opened }
  }

  private onEvent(p: Probe, ev: NativeCaptureEvent): void {
    if (ev.kind === 'audio') {
      p.activity.push(ev.data, this.native.monotonicNowMs(), ev.syntheticSilence)
      if (ev.syntheticSilence) p.idleChunks++
      else if (isDigitalZero(toInt16(ev.data))) p.silentChunks++
      else p.soundChunks++
      p.peakDb = Math.max(p.peakDb, p.activity.level.rmsDbfs)
    } else if (ev.kind === 'error') {
      p.error = `${ev.code}: ${ev.message}`
    }
  }

  private snapshot(running: boolean, remainingMs: number): DeviceScanEvent {
    const devices: ProbeStats[] = this.probes.map((p) => ({
      id: p.ep.id,
      flow: p.ep.flow,
      name: p.ep.friendlyName,
      rmsDbfs: p.activity.level.rmsDbfs,
      peakDbfs: p.peakDb,
      activeMs: Math.round(p.activity.activeMs),
      passed: p.activity.passed,
      soundChunks: p.soundChunks,
      silentChunks: p.silentChunks,
      idleChunks: p.idleChunks,
      error: p.error,
    }))
    for (const d of devices) if (d.passed) this.lastPassed.add(d.id)
    const best = (flow: 'render' | 'capture') =>
      devices.filter((d) => d.flow === flow && d.passed).sort((a, b) => b.activeMs - a.activeMs)[0]?.id ?? null
    return { mode: this.mode, running, remainingMs, devices, suggestedOutputId: best('render'), suggestedMicId: best('capture') }
  }

  stop(): void {
    this.gen++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.running) {
      const final = this.snapshot(false, 0)
      this.log('device_scan_stop', {
        mode: this.mode,
        results: final.devices.map((d) => ({ id: d.id, name: d.name, activeMs: d.activeMs, sound: d.soundChunks, silent: d.silentChunks, idle: d.idleChunks, error: d.error })),
      })
      this.emit(final)
    }
    this.stopProbes()
    this.running = false
  }

  private stopProbes(): void {
    for (const p of this.probes) this.native.stopCapture(p.stream)
  }

  /** True only if the most recent scan heard real audio on BOTH of these devices. */
  passedFor(systemId: string, micId: string): boolean {
    return this.lastPassed.has(systemId) && this.lastPassed.has(micId)
  }
}
