import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioEndpointConfig } from '../src/shared/contracts'
import { StartWait } from '../src/main/appRules'
import { toEndpointRef } from '../src/main/endpoints'
import { MOCK_IDS, MockNative } from '../src/main/mockNative'
import { SessionController, type SessionEvent } from '../src/main/session'
import { noise, tone, zeros } from './helpers/audio'
import { fakeWsFactory } from './helpers/fakeWs'

/**
 * Locking the PC while Start waits for the call, wired the way index.ts does it: autoPause calls
 * startWait.cancel() then session.stop(); events go to the window through startWait.shown(); the
 * Start button gets startWait.finish(await session.start()).
 */
function setup(opts: { checkTimeoutMs?: number; onEvent?: (e: SessionEvent, s: SessionController) => void } = {}) {
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
  const startWait = new StartWait()
  /** What the window is sent. */
  const toWindow: SessionEvent[] = []
  const session: SessionController = new SessionController({
    native, wsFactory: fakeWsFactory().factory, apiKey: 'test-key', config,
    emit: (e) => {
      toWindow.push(startWait.shown(e))
      opts.onEvent?.(e, session)
    },
    log: () => undefined,
    checkTimeoutMs: opts.checkTimeoutMs ?? 60_000,
    finalizeGraceMs: 300,
  })
  /** The Start button: what it gets back, which it shows as the last banner. */
  const start = async () => {
    startWait.begin()
    return startWait.finish(await session.start())
  }
  /** Locking the PC while Start is waiting. */
  const lock = () => {
    startWait.cancel('lock')
    void session.stop()
  }
  return { native, session, startWait, toWindow, start, lock }
}

type Ctx = ReturnType<typeof setup>

/** 20 ms chunks to both streams for `ms`; the buyer side silent unless `buyer`. */
async function feed(ctx: Ctx, ms: number, buyer: boolean) {
  for (let t = 0; t < ms; t += 20) {
    ctx.native.emitAudio('system_remote', buyer ? noise(320, 5000, t + 1) : zeros(320), { syntheticSilence: !buyer })
    ctx.native.emitAudio('local_mic', tone(320, 7000, 210, t * 16))
    await vi.advanceTimersByTimeAsync(20)
  }
}

const idleDetails = (ctx: Ctx) => ctx.toWindow.flatMap((e) => (e.type === 'state' && e.state === 'idle' ? [e.detail ?? ''] : []))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('locking the PC while Start waits for the call', () => {
  it('Keith sees why the wait stopped, never "Stopped by Keith", and the next Start is unaffected', async () => {
    const ctx = setup()
    const p = ctx.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(ctx, 600, false) // Keith is there; the buyer hasn't joined yet
    expect(ctx.session.state).toBe('checking')
    ctx.lock()
    const done = await p
    // The Start button's banner comes last: it must say why.
    expect(done.result.ok).toBe(false)
    expect(done.result.reason).toMatch(/Stopped waiting for the call because the PC was locked/)
    expect(done.pauseFor).toBeNull()
    expect(idleDetails(ctx)).toEqual([done.result.reason])
    expect(JSON.stringify(ctx.toWindow)).not.toContain('Stopped by Keith')
    expect(ctx.session.state).toBe('idle')

    // Next Start fails for its own reason: no leftover lock message.
    const again = setup({ checkTimeoutMs: 1000 })
    const q = again.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let t = 0; t < 1400; t += 20) {
      again.native.emitAudio('system_remote', noise(320, 5000, t + 1))
      again.native.emitAudio('local_mic', zeros(320))
      await vi.advanceTimersByTimeAsync(20)
    }
    const r2 = await q
    expect(r2.result.reason).toMatch(/no voice heard/)
    expect(idleDetails(again)).toEqual([r2.result.reason])
  })

  it('the same StartWait carries no stale lock reason into the next Start on the same session', async () => {
    const ctx = setup({ checkTimeoutMs: 1000 })
    const p = ctx.start()
    await vi.advanceTimersByTimeAsync(0)
    ctx.lock()
    expect((await p).result.reason).toMatch(/PC was locked/)
    const q = ctx.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(ctx, 1400, false)
    const r = await q
    expect(r.result.reason).toMatch(/no meeting audio heard/)
    expect(idleDetails(ctx).at(-1)).toBe(r.result.reason)
  })

  it('locked in the same moment the check passed: the call goes live and is flagged for pausing', async () => {
    let locked = false
    const ctx: Ctx = setup({
      onEvent: (e) => {
        // The check passes in this tick; the lock lands before Start's own continuation runs.
        if (!locked && e.type === 'check' && e.micPassed && e.systemPassed && e.providersOpen) {
          locked = true
          queueMicrotask(() => ctx.lock())
        }
      },
    })
    const p = ctx.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(ctx, 600, true)
    const done = await p
    expect(locked).toBe(true)
    expect(done.result).toEqual({ ok: true })
    expect(ctx.session.state).toBe('live')
    expect(done.pauseFor).toBe('lock')
    // What index.ts then does: pause it like any call on a locked PC.
    expect(ctx.session.pause().ok).toBe(true)
    expect(ctx.session.state).toBe('paused')
    await ctx.session.stop()
  })
})
