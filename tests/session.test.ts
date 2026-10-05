import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioEndpointConfig, AudioFrame } from '../src/shared/contracts'
import { toEndpointRef } from '../src/main/endpoints'
import { MOCK_IDS, MockNative } from '../src/main/mockNative'
import { START_WAIT_MS, SessionController, type SessionEvent } from '../src/main/session'
import { noise, tone, zeros } from './helpers/audio'
import { dgResults, fakeWsFactory } from './helpers/fakeWs'

function setup(opts: { checkTimeoutMs?: number } = {}) {
  const native = new MockNative({ now: () => Date.now() })
  const eps = native.listEndpoints()
  const config: AudioEndpointConfig = {
    config_id: 'c1',
    system_output: toEndpointRef(eps.find((e) => e.id === MOCK_IDS.RAZER_OUT)!),
    microphone: toEndpointRef(eps.find((e) => e.id === MOCK_IDS.RAZER_MIC)!),
    confirmed_at: new Date().toISOString(),
    confirmed_by_test: true,
    last_verified_at: null,
  }
  const ws = fakeWsFactory()
  const events: SessionEvent[] = []
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = []
  const frames: AudioFrame[] = []
  const session = new SessionController({
    native, wsFactory: ws.factory, apiKey: 'test-key', config,
    emit: (e) => events.push(e),
    log: (event, data) => logs.push({ event, data }),
    onFrame: (f) => frames.push(f),
    checkTimeoutMs: opts.checkTimeoutMs ?? 5000,
    finalizeGraceMs: 300,
  })
  return { native, config, ws, events, logs, frames, session }
}

type Ctx = ReturnType<typeof setup>

/** Feed 20 ms chunks to both streams for `ms`. */
async function feed(ctx: Ctx, ms: number, mic: 'voice' | 'zero' | 'none' = 'voice', sys: 'audio' | 'zero' | 'none' = 'audio') {
  for (let t = 0; t < ms; t += 20) {
    if (sys !== 'none') ctx.native.emitAudio('system_remote', sys === 'audio' ? noise(320, 5000, t + 1) : zeros(320), { syntheticSilence: sys === 'zero' })
    if (mic !== 'none') ctx.native.emitAudio('local_mic', mic === 'voice' ? tone(320, 7000, 210, t * 16) : zeros(320))
    await vi.advanceTimersByTimeAsync(20)
  }
}

async function startLive(ctx: Ctx) {
  const p = ctx.session.start()
  await vi.advanceTimersByTimeAsync(0)
  await feed(ctx, 600)
  const r = await p
  expect(r).toEqual({ ok: true })
  expect(ctx.session.state).toBe('live')
}

const others = (ctx: Ctx) => ctx.native.startCalls.filter((c) => c.endpointId !== MOCK_IDS.RAZER_MIC && c.endpointId !== MOCK_IDS.RAZER_OUT)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('session-start gate', () => {
  it('blocks when a saved endpoint is missing and never opens anything else', async () => {
    const ctx = setup()
    ctx.native.endpoints = ctx.native.endpoints.filter((e) => e.id !== MOCK_IDS.RAZER_MIC)
    const r = await ctx.session.start()
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Microphone .*not found/)
    expect(ctx.native.startCalls).toHaveLength(0)
  })

  it('blocks when the headset is off (endpoint not present)', async () => {
    const ctx = setup()
    ctx.native.endpoints.find((e) => e.id === MOCK_IDS.RAZER_OUT)!.state = 'notpresent'
    const r = await ctx.session.start()
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Meeting audio output .* is notpresent/)
    expect(ctx.native.startCalls).toHaveLength(0)
  })

  it('blocks when the mic stays silent, and leaves nothing capturing', async () => {
    const ctx = setup({ checkTimeoutMs: 1000 })
    const p = ctx.session.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(ctx, 1400, 'zero', 'audio')
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no voice heard/)
    expect(ctx.session.state).toBe('idle')
    expect(ctx.native.isCapturing('local_mic') || ctx.native.isCapturing('system_remote')).toBe(false)
  })

  it('blocks when no meeting audio is heard', async () => {
    const ctx = setup({ checkTimeoutMs: 1000 })
    const p = ctx.session.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(ctx, 1400, 'voice', 'zero')
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no meeting audio heard/)
  })

  it('keeps waiting past a minute for the call to begin, and reconnects the speech service if it drops meanwhile', async () => {
    expect(START_WAIT_MS).toBe(20 * 60_000)
    const ctx = setup({ checkTimeoutMs: START_WAIT_MS })
    const p = ctx.session.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(ctx, 61_000, 'voice', 'zero') // Keith is there; the buyer hasn't joined yet
    expect(ctx.session.state).toBe('checking')
    const before = ctx.ws.sockets.length
    ctx.ws.sockets.find((w) => !w.closed && w.url.includes('diarize=true'))!.serverClose(1011, 'idle')
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.ws.sockets.length).toBe(before + 1)
    await feed(ctx, 600)
    expect(await p).toEqual({ ok: true })
    expect(ctx.session.state).toBe('live')
  })

  it('blocks when Deepgram rejects the key', async () => {
    const ctx = setup()
    const sockets: Array<{ reject: (n: number) => void }> = []
    ;(ctx.session as any).deps.wsFactory = (url: string, h: Record<string, string>) => {
      const s = ctx.ws.factory(url, h) as any
      sockets.push(s)
      return s
    }
    // Replace the auto-open with a rejection.
    const p = ctx.session.start()
    for (const s of ctx.ws.sockets) s.reject(401)
    await vi.advanceTimersByTimeAsync(10)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/speech service unavailable/)
  })

  it('goes live only on the saved IDs, with no audio sent during the check', async () => {
    const ctx = setup()
    const p = ctx.session.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(ctx, 200) // not enough activity yet to pass the gate
    expect(ctx.session.state).toBe('checking')
    for (const s of ctx.ws.sockets) expect(s.audioChunks()).toHaveLength(0)
    await feed(ctx, 400)
    expect(await p).toEqual({ ok: true })
    expect(others(ctx)).toHaveLength(0)
    expect(ctx.native.startCalls.map((c) => c.endpointId).sort()).toEqual([MOCK_IDS.RAZER_MIC, MOCK_IDS.RAZER_OUT].sort())
    expect(ctx.ws.sockets.find((s) => s.url.includes('diarize=true'))).toBeTruthy()
    expect(ctx.ws.sockets.every((s) => s.url.includes('mip_opt_out=true'))).toBe(true)
    await feed(ctx, 200)
    for (const s of ctx.ws.sockets) expect(s.audioChunks().length).toBeGreaterThan(0)
  })
})

describe('device loss during a call', () => {
  it('surfaces, marks a gap, never switches, and recovers only on the same ID', async () => {
    const ctx = setup()
    await startLive(ctx)
    // Windows default changes to the laptop: must have no effect.
    ctx.native.setDefault('capture', MOCK_IDS.LAPTOP_MIC)
    ctx.native.setDefault('render', MOCK_IDS.LAPTOP_OUT)
    await feed(ctx, 200)
    const micSocketBefore = ctx.ws.sockets.find((s) => !s.url.includes('diarize=true'))!

    ctx.native.unplug(MOCK_IDS.RAZER_MIC)
    await vi.advanceTimersByTimeAsync(10)
    const err = ctx.events.find((e) => e.type === 'alert' && e.level === 'error')
    expect(err && err.type === 'alert' && err.message).toMatch(/Microphone lost.*Not switching/)
    const gapOpen = ctx.events.find((e) => e.type === 'gap_open' && e.gap.cause === 'device_lost')
    expect(gapOpen).toBeTruthy()

    // While unplugged: system keeps flowing, nothing else is opened.
    await feed(ctx, 3000, 'none', 'audio')
    expect(others(ctx)).toHaveLength(0)
    expect(ctx.session.state).toBe('live')

    // Headset comes back: reconnect on the same confirmed ID, new STT epoch.
    ctx.native.replug(MOCK_IDS.RAZER_MIC)
    await feed(ctx, 1500, 'voice', 'audio')
    expect(others(ctx)).toHaveLength(0)
    expect(ctx.native.isCapturing('local_mic')).toBe(true)
    const close = ctx.events.find((e) => e.type === 'gap_close' && e.gap.stream === 'local_mic')
    expect(close && close.type === 'gap_close' && close.gap.recovery).toBe('recovered')
    const micSockets = ctx.ws.sockets.filter((s) => !s.url.includes('diarize=true'))
    expect(micSockets.length).toBe(2)
    expect(micSocketBefore.closed).toBe(true)
    // First mic frame after recovery is flagged as a discontinuity.
    const micFrames = ctx.frames.filter((f) => f.stream === 'local_mic')
    expect(micFrames.some((f) => f.discontinuity_before)).toBe(true)
    await ctx.session.stop()
  })

  it('a device that keeps stalling right after recovery backs off instead of flapping', async () => {
    const ctx = setup()
    await startLive(ctx)
    // Mic endpoint stays "active" but delivers nothing (headset off, dongle still plugged in).
    await feed(ctx, 20000, 'none', 'audio')
    const micOpens = ctx.native.startCalls.filter((c) => c.stream === 'local_mic').length
    // Without back-off this would reopen roughly every 2.5 s (6+ opens in 20 s here).
    expect(micOpens).toBeLessThanOrEqual(4)
    expect(others(ctx)).toHaveLength(0)
    await ctx.session.stop()
  })

  it('mic frame timestamps follow the native clock (no drift)', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 2000)
    const mic = ctx.frames.filter((f) => f.stream === 'local_mic')
    const sys = ctx.frames.filter((f) => f.stream === 'system_remote')
    expect(Math.abs(mic.at(-1)!.monotonic_start_ms - sys.at(-1)!.monotonic_start_ms)).toBeLessThanOrEqual(120)
    await ctx.session.stop()
  })

  it('a stalled stream (no data) is treated as a loss', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 3000, 'none', 'audio')
    expect(ctx.events.some((e) => e.type === 'gap_open' && e.gap.cause === 'device_stalled' && e.gap.stream === 'local_mic')).toBe(true)
    await ctx.session.stop()
  })

  it('a noise-gated mic (exact zeros between words) does not raise false alarms; only a long run is noted', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 10000, 'zero', 'audio') // e.g. Razer BlackShark V2 Pro gate while Keith listens
    expect(ctx.events.some((e) => e.type === 'alert' && /No sound from microphone/.test(e.message))).toBe(false)
    await feed(ctx, 51000, 'zero', 'audio')
    expect(ctx.events.some((e) => e.type === 'alert' && /No sound from microphone .* 6\d s/.test(e.message))).toBe(true)
    expect(others(ctx)).toHaveLength(0)
    await ctx.session.stop()
  })

  it('an explicit switch uses exactly the endpoint Keith picked', async () => {
    const ctx = setup()
    await startLive(ctx)
    ctx.native.unplug(MOCK_IDS.RAZER_MIC)
    await vi.advanceTimersByTimeAsync(10)
    const laptop = ctx.native.listEndpoints().find((e) => e.id === MOCK_IDS.LAPTOP_MIC)!
    const p = ctx.session.switchEndpoint('local_mic', laptop)
    await vi.advanceTimersByTimeAsync(10)
    expect(await p).toEqual({ ok: true })
    expect(ctx.native.startCalls.at(-1)).toEqual({ stream: 'local_mic', endpointId: MOCK_IDS.LAPTOP_MIC })
    await ctx.session.stop()
  })
})

describe('pause / resume / stop', () => {
  it('pause stops both captures immediately and nothing captured during pause is sent', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 200)
    ctx.session.pause()
    expect(ctx.native.isCapturing('local_mic')).toBe(false)
    expect(ctx.native.isCapturing('system_remote')).toBe(false)
    const sentBefore = ctx.ws.sockets.map((s) => s.audioChunks().length)
    await feed(ctx, 500) // emitAudio is a no-op without an active capture; also guards stale gens
    expect(ctx.ws.sockets.map((s) => s.audioChunks().length)).toEqual(sentBefore)
    expect(ctx.events.filter((e) => e.type === 'gap_open' && e.gap.cause === 'pause')).toHaveLength(2)
    await ctx.session.stop()
  })

  it('resume opens fresh epochs and drops late results from before the pause', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 400)
    const oldSys = ctx.ws.sockets.find((s) => s.url.includes('diarize=true'))!
    // Keep the old socket open across the pause (simulate slow finalize).
    ;(oldSys as any).send = function (d: Buffer | string) { this.sent.push(d) }
    ctx.session.pause()
    const p = ctx.session.resume()
    await vi.advanceTimersByTimeAsync(10)
    expect(await p).toEqual({ ok: true })
    expect(ctx.session.state).toBe('live')
    // A late pre-pause result arrives on the old connection after Resume: must be ignored.
    const turnsBefore = ctx.events.filter((e) => e.type === 'turn').length
    oldSys.message(dgResults([['Stale', 0.1, 0.3, 0], ['words', 0.3, 0.5, 0]]))
    await feed(ctx, 1000)
    expect(ctx.events.filter((e) => e.type === 'turn').length).toBe(turnsBefore)
    // New connections exist and receive current audio.
    expect(ctx.ws.sockets.length).toBe(4)
    expect(ctx.ws.sockets.slice(2).every((s) => s.audioChunks().length > 0)).toBe(true)
    const pauseGaps = ctx.events.filter((e) => e.type === 'gap_close' && e.gap.cause === 'pause')
    expect(pauseGaps).toHaveLength(2)
    await ctx.session.stop()
  })

  it('resume is refused if the headset disappeared while paused', async () => {
    const ctx = setup()
    await startLive(ctx)
    ctx.session.pause()
    ctx.native.unplug(MOCK_IDS.RAZER_OUT)
    const r = await ctx.session.resume()
    expect(r.ok).toBe(false)
    expect(ctx.session.state).toBe('paused')
    expect(others(ctx)).toHaveLength(0)
    await ctx.session.stop()
  })

  it('stop leaves nothing capturing', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 200)
    const p = ctx.session.stop()
    await vi.advanceTimersByTimeAsync(1000)
    await p
    expect(ctx.session.state).toBe('stopped')
    expect(ctx.native.isCapturing('local_mic')).toBe(false)
    expect(ctx.native.isCapturing('system_remote')).toBe(false)
    expect(ctx.logs.find((l) => l.event === 'teardown_verified')?.data?.stillCapturing).toEqual([])
  })

  it('shutdownNow (app exit) stops everything synchronously', async () => {
    const ctx = setup()
    await startLive(ctx)
    ctx.session.shutdownNow()
    expect(ctx.native.isCapturing('local_mic')).toBe(false)
    expect(ctx.native.isCapturing('system_remote')).toBe(false)
  })
})

describe('provider disconnect', () => {
  it('marks a gap, drops audio while down (no replay), reconnects with a new epoch', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 200)
    const sys1 = ctx.ws.sockets.find((s) => s.url.includes('diarize=true'))!
    sys1.serverClose(1011, 'internal')
    await feed(ctx, 300) // audio during the outage
    expect(ctx.events.some((e) => e.type === 'gap_open' && e.gap.cause === 'provider_disconnect')).toBe(true)
    await feed(ctx, 1000)
    const sysSockets = ctx.ws.sockets.filter((s) => s.url.includes('diarize=true'))
    expect(sysSockets).toHaveLength(2)
    // Outage lasted ~500 ms (first retry backoff). That audio is dropped, never replayed:
    // the new connection only receives audio captured after it opened (~800 ms of 1300 ms fed).
    const newChunks = sysSockets[1].audioChunks().length
    expect(newChunks).toBeGreaterThan(30)
    expect(newChunks).toBeLessThanOrEqual(41)
    const dropped = ctx.session.counters.droppedWhileUnavailableMs.system_remote
    expect(dropped).toBeGreaterThanOrEqual(460)
    expect(dropped).toBeLessThanOrEqual(540)
    const close = ctx.events.find((e) => e.type === 'gap_close' && e.gap.cause === 'provider_disconnect')
    expect(close && close.type === 'gap_close' && close.gap.recovery).toBe('recovered')
    await ctx.session.stop()
  })
})

describe('transcript', () => {
  it('maps Deepgram word times to session time and builds diarized turns', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 1000)
    const sys = ctx.ws.sockets.find((s) => s.url.includes('diarize=true'))!
    sys.message(dgResults([['We', 0.1, 0.3, 0], ['use', 0.3, 0.5, 0], ['Datadog', 0.5, 0.9, 0], ['Agreed', 0.95, 1.2, 1]]))
    await vi.advanceTimersByTimeAsync(5000)
    const finals = ctx.events.filter((e) => e.type === 'turn' && e.event.type === 'turn_final').map((e) => (e as any).event.turn)
    expect(finals.map((t: any) => t.text)).toEqual(['We use Datadog', 'Agreed'])
    expect(finals[0].speaker_cluster).toBe('e1:s0')
    expect(finals[1].speaker_cluster).toBe('e1:s1')
    expect(finals[0].start_ms).toBeGreaterThanOrEqual(80)
    expect(finals[0].start_ms).toBeLessThanOrEqual(140)
    // Including interims (live, not final), the call's diagnostics log never carries what was said.
    const mic = ctx.ws.sockets.find((s) => s.url.includes('diarize=false'))!
    mic.message(dgResults([['Kubernetes', 1.5, 1.9]], false))
    await vi.advanceTimersByTimeAsync(100)
    await ctx.session.stop()
    expect(JSON.stringify(ctx.logs)).not.toMatch(/datadog|agreed|kubernetes/i)
  })
})

describe('audit fixes: discontinuities, overflow, validation, backpressure, device changes', () => {
  it('a mid-stream WASAPI glitch becomes an explicit gap; the first packet after open does not', async () => {
    const ctx = setup()
    const p = ctx.session.start()
    await vi.advanceTimersByTimeAsync(0)
    ctx.native.emitAudio('local_mic', tone(320, 7000), { discontinuity: true }) // first packet: start of capture
    await feed(ctx, 600)
    expect(await p).toEqual({ ok: true })
    expect(ctx.events.some((e) => e.type === 'gap_open')).toBe(false)
    ctx.native.emitAudio('system_remote', noise(320, 5000, 3), { discontinuity: true })
    const gap = ctx.events.find((e) => e.type === 'gap_close' && e.gap.cause === 'wasapi_discontinuity')
    expect(gap && gap.type === 'gap_close' && gap.gap.stream).toBe('system_remote')
    await ctx.session.stop()
  })

  it('dropped chunks from a full native queue are marked as a capture_overflow gap', async () => {
    const ctx = setup()
    await startLive(ctx)
    ctx.native.emitAudio('local_mic', tone(320, 7000), { discontinuity: true, droppedChunks: 12 })
    const gap = ctx.events.find((e) => e.type === 'gap_close' && e.gap.cause === 'capture_overflow')
    expect(gap && gap.type === 'gap_close' && gap.gap.detail).toMatch(/12 audio chunks dropped/)
    await ctx.session.stop()
  })

  it('malformed native events are rejected and logged, never processed', async () => {
    const ctx = setup()
    await startLive(ctx)
    const sentBefore = ctx.ws.sockets.map((s) => s.audioChunks().length)
    ctx.native.emitRaw('system_remote', { kind: 'audio', data: 'not a buffer', samples: 3, monotonicMs: 1, discontinuity: false, syntheticSilence: false })
    ctx.native.emitRaw('system_remote', { kind: 'audio', data: Buffer.alloc(3), samples: 1, monotonicMs: 1, discontinuity: false, syntheticSilence: false })
    ctx.native.emitRaw('system_remote', { kind: 'bogus' })
    expect(ctx.logs.filter((l) => l.event === 'invalid_native_event')).toHaveLength(3)
    expect(ctx.ws.sockets.map((s) => s.audioChunks().length)).toEqual(sentBefore)
    await ctx.session.stop()
  })

  it('a backed-up upstream connection drops audio (bounded) and marks a gap until it drains', async () => {
    const ctx = setup()
    await startLive(ctx)
    const sys = ctx.ws.sockets.find((s) => s.url.includes('diarize=true'))!
    sys.bufferedAmount = 10_000_000
    await feed(ctx, 300)
    const sentWhileBacked = sys.audioChunks().length
    await feed(ctx, 300)
    expect(sys.audioChunks().length).toBe(sentWhileBacked)
    expect(ctx.events.some((e) => e.type === 'gap_open' && e.gap.cause === 'provider_disconnect' && e.gap.stream === 'system_remote')).toBe(true)
    expect(ctx.logs.some((l) => l.event === 'provider_backpressure')).toBe(true)
    sys.bufferedAmount = 0
    await feed(ctx, 100)
    expect(sys.audioChunks().length).toBeGreaterThan(sentWhileBacked)
    expect(ctx.events.some((e) => e.type === 'gap_close' && e.gap.cause === 'provider_disconnect' && e.gap.recovery === 'recovered')).toBe(true)
    await ctx.session.stop()
  })

  it('Windows default changes are made visible but never acted on', async () => {
    const ctx = setup()
    await startLive(ctx)
    const calls = ctx.native.startCalls.length
    ctx.native.setDefault('render', MOCK_IDS.LAPTOP_OUT)
    await feed(ctx, 5200)
    expect(ctx.events.some((e) => e.type === 'alert' && /Windows default devices changed.*Ignored/.test(e.message))).toBe(true)
    expect(ctx.native.startCalls.length).toBe(calls)
    expect(ctx.logs.some((l) => l.event === 'windows_defaults_changed')).toBe(true)
    await ctx.session.stop()
  })
})

describe('latency', () => {
  it('releases Keith\'s words immediately when the remote side was silent (no duplicate hold)', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 3500, 'voice', 'zero') // remote silent for the last ~3 s
    const mic = ctx.ws.sockets.find((s) => !s.url.includes('diarize=true'))!
    mic.message(dgResults([['Hello', 2.6, 2.9], ['there', 2.9, 3.2]]))
    await vi.advanceTimersByTimeAsync(0)
    const turn = ctx.events.find((e) => e.type === 'turn' && e.event.turn.stream === 'local_mic')
    expect(turn).toBeTruthy()
    await ctx.session.stop()
  })

  it('holds Keith\'s words briefly when the remote side was talking, to check for duplicates', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 1000, 'voice', 'audio')
    const mic = ctx.ws.sockets.find((s) => !s.url.includes('diarize=true'))!
    mic.message(dgResults([['Hello', 0.2, 0.5], ['there', 0.5, 0.8]]))
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.events.some((e) => e.type === 'turn' && e.event.turn.stream === 'local_mic')).toBe(false)
    await vi.advanceTimersByTimeAsync(1800)
    expect(ctx.events.some((e) => e.type === 'turn' && e.event.turn.stream === 'local_mic')).toBe(true)
    await ctx.session.stop()
  })

  it('reports capture lag and speech-service delay', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 1000)
    const sys = ctx.ws.sockets.find((s) => s.url.includes('diarize=true'))!
    sys.message(dgResults([['Okay', 0.2, 0.5, 0]]))
    await feed(ctx, 10000)
    const t = ctx.logs.find((l) => l.event === 'timing' && l.data?.stream === 'system_remote')
    expect(t?.data?.stt_delay_avg_ms).toBeTypeOf('number')
    expect(ctx.events.some((e) => e.type === 'timing')).toBe(true)
    expect(ctx.ws.sockets.every((s) => s.url.includes('keyterm=Arize'))).toBe(true)
    await ctx.session.stop()
  })
})

describe('turns during continuous speech', () => {
  it('does not split one speaker into many bubbles when finals arrive seconds late', async () => {
    const ctx = setup()
    await startLive(ctx)
    const sys = ctx.ws.sockets.find((s) => s.url.includes('diarize=true'))!
    // Remote talks continuously; each final segment arrives ~3 s after its audio.
    await feed(ctx, 4000)
    sys.message(dgResults([['As', 0.1, 0.4, 0], ['much', 0.4, 0.8, 0], ['as', 0.8, 1.0, 0]]))
    await feed(ctx, 3500)
    sys.message(dgResults([['the', 1.1, 1.3, 0], ['first', 1.3, 1.7, 0], ['spacewalk', 1.7, 2.4, 0]]))
    await feed(ctx, 3500)
    sys.message(dgResults([['with', 2.5, 2.7, 0], ['a', 2.7, 2.8, 0], ['team', 2.8, 3.2, 0]]))
    // Speaker stops: the stream goes quiet, so the turn closes.
    await feed(ctx, 4000, 'voice', 'zero')
    const finals = ctx.events.filter((e) => e.type === 'turn' && e.event.type === 'turn_final' && e.event.turn.stream === 'system_remote').map((e) => (e as any).event.turn)
    expect(finals.map((t: any) => t.text)).toEqual(['As much as the first spacewalk with a team'])
    await ctx.session.stop()
  })
})
