/** M5 call modes: the call's length and "No SA today", the background card per mode, live speaker ids. Invented calls only. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioEndpointConfig, Turn } from '../src/shared/contracts'
import { CALL_LENGTH_CHOICES, CALL_LENGTH_DEFAULTS, CALL_TYPES, type CallSetup } from '../src/shared/help'
import { toEndpointRef } from '../src/main/endpoints'
import { CallMemory, DEFAULT_SETUP, mergeModeSetup, setupKey, validLength } from '../src/main/help/callMemory'
import { modeFacts } from '../src/main/help/callModes'
import { loadPlaybook } from '../src/main/help/prompt'
import { replayAt } from '../src/main/help/replay'
import { HelpService } from '../src/main/helpService'
import { MOCK_IDS, MockNative } from '../src/main/mockNative'
import { SessionController, type SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'
import { GOAL_PLACEHOLDER, defaultLength, lengthChoices, offersNoSa, typeOf } from '../src/renderer/callSetup'
import { noise, tone } from './helpers/audio'
import { dgResults, fakeWsFactory } from './helpers/fakeWs'
import { StagedModel, engineFixture, inventedCall } from './helpers/helpEngine'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const CARD = 'MOVE: clarify_current_state\nASK: Who picks the sample each week?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'
const BASE = { call_type: 'discovery', call_goal: 'Learn how they review answers', desired_outcomes: ['next meeting booked'], account: 'Quillfeather Labs (invented)', deployment: 'saas' }

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5setup-'))
  const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
  help.setSettings({ prefetch: false })
  let t = 0
  const state = (st: string) => help.onSessionEvent({ type: 'state', state: st, sessionId: 's-m5' } as SessionEvent, 's-m5', () => t)
  return { help, dir, state, at: (ms: number) => (t = ms) }
}

describe('call length and "No SA today" in the setup (M5)', () => {
  it('a length is one the strip offers or a whole number of minutes from 5 to 180', () => {
    for (const n of [...CALL_LENGTH_CHOICES, 5, 50, 180]) expect(validLength(n), String(n)).toBe(n)
    expect(validLength('45')).toBe(45)
    for (const bad of [4, 181, 0, -30, 30.5, Number.NaN, 'thirty', '45 min', null, undefined, true, {}]) expect(validLength(bad), String(bad)).toBeNull()
  })

  it('merges like the must-learns: not sent keeps it, null or false clears it, junk keeps it, stored only when set', () => {
    const cur: CallSetup = { ...DEFAULT_SETUP, length_min: 45, no_sa: true }
    const next = (raw: unknown) => {
      const s: CallSetup = { ...DEFAULT_SETUP }
      mergeModeSetup(s, raw, cur)
      return { length_min: s.length_min, no_sa: s.no_sa, keys: Object.keys(s).filter((k) => k === 'length_min' || k === 'no_sa') }
    }
    expect(next({})).toEqual({ length_min: 45, no_sa: true, keys: ['length_min', 'no_sa'] })
    expect(next({ length_min: 60 })).toMatchObject({ length_min: 60, no_sa: true })
    expect(next({ length_min: 'soon', no_sa: 'yes' })).toMatchObject({ length_min: 45, no_sa: true })
    expect(next({ length_min: null, no_sa: false })).toEqual({ length_min: undefined, no_sa: undefined, keys: [] })
    expect(next(null)).toMatchObject({ length_min: 45, no_sa: true })
    // An older setup without them reads as before (absent: the type's usual length, an SA on the call).
    const old: CallSetup = { ...DEFAULT_SETUP }
    mergeModeSetup(old, { call_type: 'demo' }, { call_type: 'demo', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' })
    expect(Object.keys(old)).not.toContain('length_min')
    expect(Object.keys(old)).not.toContain('no_sa')
  })

  it('a type change from the strip keeps the account, goal, outcomes, must-learns, length and No SA today', () => {
    const { help } = service()
    help.setSetup({ ...BASE, call_type: 'demo', length_min: 45, no_sa: true, must_learn: ['who else should see it'] })
    // The strip saves its fields; a save from elsewhere may leave the new ones out.
    const after = help.setSetup({ ...BASE, call_type: 'technical_deep_dive' })
    expect(after).toEqual({ ...BASE, call_type: 'technical_deep_dive', must_learn: ['who else should see it'], length_min: 45, no_sa: true })
    expect(help.info().setup).toEqual(after)
    // The must-learn box saves on its own: the rest stays.
    expect(help.setMustLearn(['what pass looks like'])).toMatchObject({ call_type: 'technical_deep_dive', length_min: 45, no_sa: true })
    // Saved to disk too (call-setup.json), read back on the next open.
    expect(help.setSetup({ ...BASE, call_type: 'technical_deep_dive', length_min: 90, no_sa: false })).toMatchObject({ length_min: 90 })
    expect(help.info().setup.no_sa).toBeUndefined()
    help.shutdown()
  })

  it('changeable mid-call (the call keeps the latest); Stop clears them with the rest, keeping the call type', () => {
    const s = service()
    s.help.setSetup({ ...BASE, call_type: 'demo', length_min: 60 })
    s.state('checking')
    s.state('live')
    expect(s.help.memory!.setup).toMatchObject({ call_type: 'demo', length_min: 60 })
    s.help.setSetup({ ...BASE, call_type: 'demo', length_min: 30, no_sa: true })
    expect(s.help.memory!.setup).toMatchObject({ length_min: 30, no_sa: true, account: BASE.account })
    const rec = s.help.db.sql.prepare('SELECT setup_json FROM sessions WHERE id = ?').get('s-m5') as { setup_json: string }
    expect(JSON.parse(rec.setup_json)).toMatchObject({ length_min: 30, no_sa: true })
    s.at(60_000)
    s.state('stopping')
    s.state('stopped')
    expect(s.help.info().setup).toEqual({ call_type: 'demo', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' })
    s.help.shutdown()
  })

  it("mid-call, a type change keeps the call's length (a 30-minute discovery that becomes a demo is still 30 minutes); before Start it follows the type", () => {
    for (const sent of [{ length_min: null }, {}]) {
      const s = service()
      s.help.setSetup({ ...BASE })
      s.state('checking')
      s.state('live')
      // The strip sends no length (or null) when Keith never picked one.
      const after = s.help.setSetup({ ...BASE, call_type: 'demo', ...sent })
      expect(after.length_min, JSON.stringify(sent)).toBe(30)
      expect(s.help.memory!.setup).toMatchObject({ call_type: 'demo', length_min: 30 })
      // At minute 21 of the real 30, HELP hears "about 10 min left", not the demo's 60.
      expect(modeFacts(s.help.memory!, 21 * 60_000, 'demo', s.help.memory!.setup).minutes_left).toBe('10')
      // A length Keith picks mid-call still wins.
      expect(s.help.setSetup({ ...BASE, call_type: 'demo', length_min: 45 }).length_min).toBe(45)
      s.state('stopping')
      s.state('stopped')
      s.help.shutdown()
    }
    // Before Start, the type's usual length (nothing saved).
    const before = service()
    expect(before.help.setSetup({ ...BASE, call_type: 'demo', length_min: null }).length_min).toBeUndefined()
    before.help.shutdown()
  })

  it('mid-call, a new call type or goal drops the background card; a new outcome or length alone does not (the card key covers that)', () => {
    const s = service()
    s.help.setSetup({ ...BASE })
    s.state('checking')
    s.state('live')
    const discard = vi.spyOn(s.help.engine!, 'discardPrefetch')
    s.help.setSetup({ ...BASE, desired_outcomes: ['their top problems in their words'], length_min: 45 })
    expect(discard).not.toHaveBeenCalled()
    s.help.setSetup({ ...BASE, call_type: 'demo' })
    expect(discard).toHaveBeenCalledTimes(1)
    s.help.setSetup({ ...BASE, call_type: 'demo', call_goal: 'Show the trace view' })
    expect(discard).toHaveBeenCalledTimes(2)
    s.state('stopping')
    s.state('stopped')
    s.help.shutdown()
  })
})

describe('the background card follows the setup (M5)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the setup key changes with the type, length, No SA today, goal or must-learns, and never carries their words', () => {
    const base: CallSetup = { ...DEFAULT_SETUP, call_goal: 'Learn how they review answers', must_learn: ['who else has a view'] }
    const k = setupKey(base)
    for (const changed of [
      { ...base, call_type: 'demo' as const }, { ...base, length_min: 45 }, { ...base, no_sa: true }, { ...base, call_goal: 'Book the next meeting' },
      { ...base, must_learn: ['what prompted the call'] },
    ]) expect(setupKey(changed)).not.toBe(k)
    // The account and deployment have their own place in the card (who it's for); the same setup, the same key.
    expect(setupKey({ ...base })).toBe(k)
    expect(k).not.toMatch(/review|answers|view/i)
    expect(setupKey(null)).toMatch(/^\/\/0\/[0-9a-f]{8}$/)
  })

  async function readyCard(s: ReturnType<typeof engineFixture>, m: StagedModel) {
    s.engine.onFinalWords()
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(1)
    m.calls[0].send(CARD)
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    s.advance(1500)
  }

  it('a card prepared before a type change is never served; with the setup unchanged it is', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.memory.setup = { ...s.memory.setup, call_type: 'demo' }
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(false)

    const m2 = new StagedModel()
    const s2 = engineFixture(m2, playbook, { prefetch: true })
    await readyCard(s2, m2)
    s2.engine.press()
    expect(m2.calls).toHaveLength(1)
    expect(s2.events.at(-1)!.timing.served_from_prefetch).toBe(true)
  })

  it('a new call length also means a fresh card (the time left changes what fits)', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.memory.setup = { ...s.memory.setup, length_min: 45 }
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(false)
  })

  /** A demo with Sam, an SA Keith tagged as a teammate, and Dana, the buyer. */
  function demoCall(type: CallSetup['call_type'] = 'demo') {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, {
      prefetch: true,
      call: inventedCall({ call_type: type, speakers: { 'e1:s0': { role: 'buyer', name: 'Dana' }, 'e1:s1': { role: 'teammate', name: 'Sam (SA)' } } }),
    })
    s.memory.setup = { ...s.memory.setup, call_type: type }
    return { m, s }
  }

  it("in a demo, the tagged SA's words never start a background card; the buyer's do", async () => {
    const { m, s } = demoCall()
    s.engine.onFinalWords('system_remote', 'So here you can see every span in the trace.', 'e1:s1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls).toHaveLength(0)
    s.engine.onFinalWords('system_remote', 'Oh, that is what we have been hacking together.', 'e1:s0')
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(1)
  })

  it("in a demo or deep-dive, the SA carrying on cancels one waiting for the buyer, as Keith's words do", async () => {
    for (const type of ['demo', 'technical_deep_dive'] as const) {
      const { m, s } = demoCall(type)
      s.engine.onFinalWords('system_remote', 'Can it show the cost per call?', 'e1:s0')
      await vi.advanceTimersByTimeAsync(300)
      s.engine.onFinalWords('system_remote', 'Good question, let me open that view.', 'e1:s1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(m.calls, type).toHaveLength(0)
    }
  })

  it("the SA's short filler while the buyer finishes leaves the waiting card alone, as Keith's does", async () => {
    for (const filler of ['Mm-hmm.', 'Yeah, makes sense.', 'Right.']) {
      const { m, s } = demoCall()
      s.engine.onFinalWords('system_remote', 'Can it show the cost per call?', 'e1:s0')
      await vi.advanceTimersByTimeAsync(300)
      s.engine.onFinalWords('system_remote', filler, 'e1:s1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(m.calls, filler).toHaveLength(1)
    }
    // Filler with real words after it is the SA carrying on: it cancels.
    for (const words of ['Mm-hmm, and over here is the cost view.', 'Yeah, so let me open that.']) {
      const { m, s } = demoCall()
      s.engine.onFinalWords('system_remote', 'Can it show the cost per call?', 'e1:s0')
      await vi.advanceTimersByTimeAsync(300)
      s.engine.onFinalWords('system_remote', words, 'e1:s1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(m.calls, words).toHaveLength(0)
    }
    // The SA's filler on its own still starts nothing.
    const { m, s } = demoCall()
    s.engine.onFinalWords('system_remote', 'Mm-hmm.', 'e1:s1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls).toHaveLength(0)
  })

  /**
   * Integration review: the buyer asks, the background card starts, and only then does the SA's
   * "Mm-hmm" come back (the usual lag) or is still being transcribed when Keith presses.
   */
  async function saFillerAfterCardStarted(type: CallSetup['call_type'], filler: string, how: 'final' | 'live') {
    const { m, s } = demoCall(type)
    let now = 20_000
    const question = 'Can it show the cost per call for each team?'
    s.say(question)
    s.engine.onFinalWords('system_remote', question, 'e1:s0')
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(1)
    s.advance(400)
    now += 400
    if (how === 'final') {
      s.memory.upsertTurn({ id: 'sa-filler', stream: 'system_remote', cluster: 'e1:s1', start_ms: now - 300, end_ms: now - 100, text: filler, available_ms: now }, true)
      s.engine.onFinalWords('system_remote', filler, 'e1:s1')
    } else s.memory.setInterim('system_remote', filler, now, 'e1:s1')
    m.calls[0].send(CARD)
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    s.advance(1500)
    s.engine.press()
    return { m, s }
  }

  it("the SA's \"Mm-hmm\" after the background card started keeps that card for the press, as Keith's filler does", async () => {
    for (const type of ['demo', 'technical_deep_dive'] as const) {
      for (const how of ['final', 'live'] as const) {
        const { m, s } = await saFillerAfterCardStarted(type, 'Mm-hmm.', how)
        expect(s.events.at(-1)!.timing.served_from_prefetch, `${type} ${how}`).toBe(true)
        expect(m.calls, `${type} ${how}`).toHaveLength(1)
      }
    }
  })

  it('the SA carrying on after the card started, or a teammate on a discovery call, still means a fresh card', async () => {
    for (const how of ['final', 'live'] as const) {
      const words = await saFillerAfterCardStarted('demo', 'Mm-hmm, and over here is the cost view.', how)
      expect(words.s.events.at(-1)!.timing.served_from_prefetch, how).toBe(false)
      const disco = await saFillerAfterCardStarted('discovery', 'Mm-hmm.', how)
      expect(disco.s.events.at(-1)!.timing.served_from_prefetch, `discovery ${how}`).toBe(false)
    }
  })

  it('anywhere else, or with nobody tagged, it behaves as before', async () => {
    // Discovery: a teammate's words start a candidate, as today.
    const d = demoCall('discovery')
    d.s.engine.onFinalWords('system_remote', 'So here you can see every span.', 'e1:s1')
    await vi.advanceTimersByTimeAsync(800)
    expect(d.m.calls).toHaveLength(1)
    // A demo with an untagged speaker (e1:s2) or no speaker id: their side, as today.
    for (const cluster of ['e1:s2', null, undefined]) {
      const u = demoCall()
      u.s.engine.onFinalWords('system_remote', 'Does this work with our stack?', cluster)
      await vi.advanceTimersByTimeAsync(800)
      expect(u.m.calls, String(cluster)).toHaveLength(1)
    }
  })

  it('who counts as the SA presenting: a tagged teammate, on a demo or deep-dive only', () => {
    const mem = new CallMemory('m5-sa')
    mem.setLabel({ cluster: 'e1:s1', role: 'teammate', name: 'Sam (SA)' })
    mem.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana' })
    for (const type of CALL_TYPES) {
      mem.setup = { ...DEFAULT_SETUP, call_type: type }
      const sa = type === 'demo' || type === 'technical_deep_dive'
      expect(mem.saPresenting('e1:s1'), type).toBe(sa)
      expect(mem.saPresenting('e1:s0'), type).toBe(false)
      expect(mem.saPresenting('e2:s1'), type).toBe(false) // a new connection numbers speakers afresh: not tagged
      expect(mem.saPresenting(null), type).toBe(false)
    }
  })
})

describe("the live call passes the speaker id to the background card (M5)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("in a demo, the tagged SA's turn from the session starts no background card; the buyer's does", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5wire-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    help.setSettings({ prefetch: true, call_notes: false, wrapup: false })
    const m = new StagedModel()
    help.createModel = () => m
    let t = 0
    let n = 0
    const state = (st: string) => help.onSessionEvent({ type: 'state', state: st, sessionId: 's-w' } as SessionEvent, 's-w', () => t)
    const say = (cluster: string, text: string) => {
      const start = t
      t += 4000
      const turn: Turn = {
        turn_id: `w${++n}`, session_id: 's-w', stream: 'system_remote', speaker_cluster: cluster,
        speaker_identity_id: null, speaker_role: 'unknown', start_ms: start, end_ms: t, text, final: true, source_word_ids: [], gap_before: null,
      }
      help.onSessionEvent({ type: 'turn', event: { type: 'turn_final', turn } } as SessionEvent, 's-w', () => t)
    }
    help.setSetup({ ...BASE, call_type: 'demo' })
    state('checking')
    state('live')
    expect(help.setLabel({ cluster: 'e1:s1', role: 'teammate', name: 'Sam (SA)' })).toEqual({ ok: true })
    const spy = vi.spyOn(help.engine!, 'onFinalWords')
    say('e1:s1', 'So here you can see every span in the trace, and the cost per call.')
    expect(spy).toHaveBeenLastCalledWith('system_remote', expect.any(String), 'e1:s1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls).toHaveLength(0)
    say('e1:s0', 'Can it show that per team?')
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls).toHaveLength(1)
    help.engine!.cancelAll('stop')
    help.shutdown()
  })
})

describe('live speaker ids on words still being transcribed (M5)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the session sends the newest live word\'s speaker id with the interim', async () => {
    const native = new MockNative({ now: () => Date.now() })
    const eps = native.listEndpoints()
    const config: AudioEndpointConfig = {
      config_id: 'c1', system_output: toEndpointRef(eps.find((e) => e.id === MOCK_IDS.RAZER_OUT)!), microphone: toEndpointRef(eps.find((e) => e.id === MOCK_IDS.RAZER_MIC)!),
      confirmed_at: new Date().toISOString(), confirmed_by_test: true, last_verified_at: null,
    }
    const ws = fakeWsFactory({ autoOpen: true })
    const events: SessionEvent[] = []
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = []
    const session = new SessionController({ native, wsFactory: ws.factory, apiKey: 'test-key', config, emit: (e) => events.push(e), log: (event, data) => logs.push({ event, data }), checkTimeoutMs: 5000, finalizeGraceMs: 300 })
    const feed = async (ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        native.emitAudio('system_remote', noise(320, 5000, t + 1))
        native.emitAudio('local_mic', tone(320, 7000, 210, t * 16))
        await vi.advanceTimersByTimeAsync(20)
      }
    }
    const p = session.start()
    await vi.advanceTimersByTimeAsync(0)
    await feed(600)
    expect(await p).toEqual({ ok: true })
    await feed(1000)
    const sys = ws.sockets.find((x) => x.url.includes('diarize=true'))!
    const mic = ws.sockets.find((x) => x.url.includes('diarize=false'))!
    // The buyer's words, then the SA's: the newest word decides.
    sys.message(dgResults([['Oh', 0.1, 0.2, 0], ['so', 0.3, 0.4, 1], ['here', 0.4, 0.6, 1]], false))
    mic.message(dgResults([['Right', 0.5, 0.7]], false))
    await vi.advanceTimersByTimeAsync(50)
    const interims = events.filter((e): e is Extract<SessionEvent, { type: 'interim' }> => e.type === 'interim' && e.text !== '')
    expect(interims.find((e) => e.stream === 'system_remote')).toMatchObject({ text: 'Oh so here', cluster: 'e1:s1' })
    expect(interims.find((e) => e.stream === 'local_mic')).toMatchObject({ text: 'Right', cluster: null })
    await session.stop()
    // Diagnostics still never carry what was said.
    expect(JSON.stringify(logs)).not.toMatch(/here|right/i)
  })

  it('HELP keeps it with the live words and gives it back as of the press', () => {
    const s = service()
    s.help.setSetup({ ...BASE, call_type: 'demo' })
    s.state('checking')
    s.state('live')
    s.at(10_000)
    s.help.onSessionEvent({ type: 'interim', stream: 'system_remote', text: 'so here you can see', cluster: 'e1:s1' }, 's-m5', () => 10_000)
    s.help.onSessionEvent({ type: 'interim', stream: 'local_mic', text: 'mm-hmm', cluster: null }, 's-m5', () => 10_000)
    const m = s.help.memory!
    expect(m.interimsAsOf(10_000)).toEqual([
      { stream: 'system_remote', text: 'so here you can see', cluster: 'e1:s1' },
      { stream: 'local_mic', text: 'mm-hmm', cluster: null },
    ])
    // Not yet heard at an earlier time.
    expect(m.interimsAsOf(9_000)).toEqual([])
    // An event without one (an older sender): no speaker id, as before.
    s.help.onSessionEvent({ type: 'interim', stream: 'system_remote', text: 'and the cost view' }, 's-m5', () => 10_000)
    expect(m.interimsAsOf(10_000)[0]).toEqual({ stream: 'system_remote', text: 'and the cost view' })
    // The words firmed up (empty interim): gone, speaker id and all.
    s.help.onSessionEvent({ type: 'interim', stream: 'system_remote', text: '', cluster: 'e1:s1' }, 's-m5', () => 10_000)
    expect(m.interimsAsOf(10_000).map((i) => i.stream)).toEqual(['local_mic'])
    s.state('stopping')
    s.state('stopped')
    s.help.shutdown()
  })

  it('replay gives a line still being spoken at the press its speaker id', () => {
    const call = inventedCall({
      call_type: 'demo',
      speakers: { 'e1:s0': { role: 'buyer', name: 'Dana' }, 'e1:s1': { role: 'teammate', name: 'Sam (SA)' } },
      transcript: [
        { t: 0, who: 'keith', text: 'Sam, over to you.' },
        { t: 3, end: 30, who: 'e1:s1', text: 'So here you can see every span in the trace, and over here the cost per call for each model.' },
      ],
      help_at_s: 20,
    })
    const r = replayAt(call, 20)
    const live = r.memory.interimsAsOf(r.atMs)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ stream: 'system_remote', cluster: 'e1:s1' })
    // Keith mid-sentence: their own mic, no speaker id.
    const k = replayAt(inventedCall({ transcript: [{ t: 10, end: 30, who: 'keith', text: 'So what I am hearing is that the platform team reviews a weekly sample by hand.' }], help_at_s: 20 }), 20)
    expect(k.memory.interimsAsOf(k.atMs)[0]).toMatchObject({ stream: 'local_mic', cluster: null })
  })
})

describe('the setup strip helpers (M5, callSetup.ts)', () => {
  it('the length follows the type: discovery 30, demo 60, deep-dive 60, pricing 30, follow-up 30', () => {
    expect(CALL_TYPES.map((t) => [t, defaultLength(t)])).toEqual(CALL_TYPES.map((t) => [t, CALL_LENGTH_DEFAULTS[t]]))
    expect(defaultLength('demo')).toBe(60)
    expect(defaultLength('negotiation')).toBe(30)
    expect(defaultLength('nonsense')).toBe(30) // read as discovery
    expect(typeOf('technical_deep_dive')).toBe('technical_deep_dive')
    expect(typeOf(undefined)).toBe('discovery')
  })

  it('the select offers the usual lengths, plus a saved one that isn\'t among them', () => {
    expect(lengthChoices(30)).toEqual([...CALL_LENGTH_CHOICES])
    expect(lengthChoices(50)).toEqual([15, 30, 45, 50, 60, 90])
    expect(lengthChoices(null)).toEqual([...CALL_LENGTH_CHOICES])
  })

  it('"No SA today" only on a demo or deep-dive', () => {
    expect(CALL_TYPES.filter(offersNoSa)).toEqual(['demo', 'technical_deep_dive'])
  })

  it('a goal and outcomes placeholder for every type; outcomes in the box\'s own comma style; never about privacy or recording', () => {
    for (const t of CALL_TYPES) {
      expect(GOAL_PLACEHOLDER[t].goal.length, t).toBeGreaterThan(10)
      expect(GOAL_PLACEHOLDER[t].outcomes, t).not.toContain(';')
      expect(`${GOAL_PLACEHOLDER[t].goal} ${GOAL_PLACEHOLDER[t].outcomes}`, t).not.toMatch(/\b(?:privacy|consent|record\w*|legal|IT)\b/)
    }
    expect(GOAL_PLACEHOLDER.discovery.goal).toContain("real problem, why now, who else cares")
    expect(GOAL_PLACEHOLDER.negotiation.goal).toContain("trade don't give")
  })
})

describe('Hold cards in the after-call review (M5)', () => {
  it('a card whose move was no_move is marked as a Hold; any other card is not', () => {
    const { help } = service()
    help.onSessionEvent({ type: 'state', state: 'checking', sessionId: 's-h' }, 's-h', () => 0)
    const ins = help.db.sql.prepare(
      "INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, card_json, timing_json, prefetch) VALUES (?, 's-h', 'help_requested', 't', ?, 'complete', '{}', ?, '{}', 0)",
    )
    ins.run('h1', 30_000, JSON.stringify({ move: 'no_move', primary_kind: 'ask', primary: 'How does that land for you?', follow_up: null }))
    ins.run('h2', 60_000, JSON.stringify({ move: 'clarify_current_state', primary_kind: 'ask', primary: 'How do you handle that today?', follow_up: null }))
    const cards = help.callCards()
    expect(cards.map((c) => [c.id, c.hold ?? false])).toEqual([['h1', true], ['h2', false]])
    expect(Object.keys(cards[1])).not.toContain('hold')
    help.shutdown()
  })
})
