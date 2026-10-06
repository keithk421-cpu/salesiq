/** M3 A, session side: end of speech from the speech service, listening blind, and the confidence spread (numbers only). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioEndpointConfig } from '../src/shared/contracts'
import { ConfidenceSpread } from '../src/main/confidence'
import { toEndpointRef } from '../src/main/endpoints'
import { BLIND_WARN_MS } from '../src/main/help/heard'
import { MOCK_IDS, MockNative } from '../src/main/mockNative'
import { SessionController, type SessionEvent } from '../src/main/session'
import { noise, tone, zeros } from './helpers/audio'
import { dgResults, fakeWsFactory } from './helpers/fakeWs'

function setup() {
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
  const session = new SessionController({
    native, wsFactory: ws.factory, apiKey: 'test-key', config,
    emit: (e) => events.push(e), log: (event, data) => logs.push({ event, data }),
    checkTimeoutMs: 5000, finalizeGraceMs: 300,
  })
  return { native, ws, events, logs, session }
}
type Ctx = ReturnType<typeof setup>

/** 20 ms chunks on both streams: the meeting audio loud ('audio') or silent ('zero'). */
async function feed(ctx: Ctx, ms: number, sys: 'audio' | 'zero' = 'audio') {
  for (let t = 0; t < ms; t += 20) {
    ctx.native.emitAudio('system_remote', sys === 'audio' ? noise(320, 5000, t + 1) : zeros(320), { syntheticSilence: sys === 'zero' })
    ctx.native.emitAudio('local_mic', tone(320, 7000, 210, t * 16))
    await vi.advanceTimersByTimeAsync(20)
  }
}

async function startLive(ctx: Ctx) {
  const p = ctx.session.start()
  await vi.advanceTimersByTimeAsync(0)
  await feed(ctx, 600)
  expect(await p).toEqual({ ok: true })
}

const sys = (ctx: Ctx) => ctx.ws.sockets.filter((w) => !w.closed && w.url.includes('diarize=true')).at(-1)!
const mic = (ctx: Ctx) => ctx.ws.sockets.filter((w) => !w.closed && !w.url.includes('diarize=true')).at(-1)!

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('end of speech', () => {
  it("the meeting audio's speech_final goes out after its words' turns; Keith's mic never sends one", async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 1000)
    ctx.events.length = 0
    sys(ctx).message(dgResults([['Do', 0.1, 0.2, 0], ['you', 0.2, 0.3, 0], ['integrate?', 0.3, 0.6, 0]], true))
    const kinds = ctx.events.map((e) => e.type)
    expect(kinds).toContain('speech_end')
    expect(kinds.lastIndexOf('turn')).toBeLessThan(kinds.indexOf('speech_end'))
    expect(ctx.events.find((e) => e.type === 'speech_end')).toEqual({ type: 'speech_end', stream: 'system_remote', signal: 'speech_final' })
    ctx.events.length = 0
    mic(ctx).message(dgResults([['Great', 0.7, 0.9], ['question.', 0.9, 1.2]], true))
    expect(ctx.events.some((e) => e.type === 'speech_end')).toBe(false)
    // A final that isn't the end of their speech doesn't count.
    sys(ctx).message({ ...dgResults([['And', 0.7, 0.8, 0]], true), speech_final: false })
    expect(ctx.events.some((e) => e.type === 'speech_end')).toBe(false)
  })

  it("UtteranceEnd on the meeting audio is an end of speech too; on the mic it isn't", async () => {
    const ctx = setup()
    await startLive(ctx)
    ctx.events.length = 0
    sys(ctx).message({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 0.6 })
    expect(ctx.events.filter((e) => e.type === 'speech_end')).toEqual([{ type: 'speech_end', stream: 'system_remote', signal: 'utterance_end' }])
    mic(ctx).message({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 0.6 })
    expect(ctx.events.filter((e) => e.type === 'speech_end')).toHaveLength(1)
  })
})

describe('listening blind', () => {
  it('counts sound on the meeting audio after the last word back, and starts again when words come', async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 4000)
    const early = ctx.session.untranscribedMs('system_remote')
    expect(early).toBeGreaterThan(3000)
    expect(early).toBeLessThan(BLIND_WARN_MS)
    await feed(ctx, 3000)
    expect(ctx.session.untranscribedMs('system_remote')).toBeGreaterThanOrEqual(BLIND_WARN_MS)
    // An interim covering the audio up to ~6.9 s in: only the last bit is still untranscribed.
    sys(ctx).message(dgResults([['We', 6.5, 6.7, 0], ['sample', 6.7, 6.95, 0]], false))
    expect(ctx.session.untranscribedMs('system_remote')).toBeLessThan(500)
  })

  it('silence is not blind, and nothing counts once the call is stopped', async () => {
    const ctx = setup()
    await startLive(ctx)
    sys(ctx).message(dgResults([['Hi', 0.0, 0.1, 0]], true))
    await feed(ctx, 8000, 'zero')
    expect(ctx.session.untranscribedMs('system_remote')).toBeLessThan(800)
    await feed(ctx, 7000)
    expect(ctx.session.untranscribedMs('system_remote')).toBeGreaterThanOrEqual(BLIND_WARN_MS)
    await ctx.session.stop()
    expect(ctx.session.untranscribedMs('system_remote')).toBe(0)
  })
})

describe('confidence spread', () => {
  it('count, lowest, median and share under 0.6', () => {
    const c = new ConfidenceSpread()
    expect(c.summary()).toEqual({ words: 0, min: null, median: null, under_060: null })
    c.add([0.99, 0.95, 0.9, 0.5, 0.42, Number.NaN].map((confidence) => ({ confidence })))
    expect(c.summary()).toEqual({ words: 5, min: 0.42, median: 0.9, under_060: 0.4 })
  })

  it("logged once at Stop from the meeting audio's finals: numbers only, never words", async () => {
    const ctx = setup()
    await startLive(ctx)
    await feed(ctx, 1000)
    const msg = dgResults([['Lang', 0.1, 0.3, 0], ['Smith', 0.3, 0.5, 0], ['tracing', 0.5, 0.8, 0]], true)
    msg.channel.alternatives[0].words[1].confidence = 0.31
    sys(ctx).message(msg)
    sys(ctx).message(dgResults([['interim', 0.8, 0.9, 0]], false)) // interims would count a word twice
    mic(ctx).message(dgResults([['Keith', 0.1, 0.3]], true)) // his mic isn't the meeting audio
    await ctx.session.stop()
    const spread = ctx.logs.filter((l) => l.event === 'confidence_spread')
    expect(spread).toHaveLength(1)
    expect(spread[0].data).toEqual({ stream: 'system_remote', words: 3, min: 0.31, median: 0.95, under_060: 0.33 })
    expect(JSON.stringify(spread)).not.toMatch(/Lang|Smith|tracing|Keith/)
  })
})
