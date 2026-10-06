import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Turn } from '../src/shared/contracts'
import { CallMemory } from '../src/main/help/callMemory'
import { runScenario } from '../src/main/help/evalRunner'
import { DEFAULT_HELP_CONFIG, MockHelpModel } from '../src/main/help/models'
import { buildPracticeMoment, refreshFeedback } from '../src/main/help/practice'
import {
  ANOTHER_ANGLE_WINDOW_MS, anotherAngleOk, buyingSignal, cleanPressDetail, decidePress, isOpening, latestSignal, pressModeOf, pressUserMessage, recentSignal,
} from '../src/main/help/pressModes'
import { buildUserMessage, loadPlaybook } from '../src/main/help/prompt'
import { buildScorecard, readFeedback } from '../src/main/help/scorecard'
import { isWrapRequest } from '../src/main/help/wrap'
import { HelpService } from '../src/main/helpService'
import type { SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'
import { StagedModel, engineFixture, inventedCall } from './helpers/helpEngine'

// M3 smarter presses: the opening, a buying signal's next step, another angle. Invented call details only.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const CARD = 'MOVE: clarify_current_state\nASK: Who looks at the weekly sample with the platform team?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'
const CARD2 = 'MOVE: identify_owner\nASK: Who would sign off on changing that review?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'
/** Enough buyer words that the call is past its opening. */
const LONG_ANSWER = 'We send a sample of answers to the platform team every Friday and they mark anything that looks wrong, then the product owner reads the notes on Monday and decides what to change in the prompts before the next release goes out to everyone.'

describe('buying signals', () => {
  it('hears them asking about a pilot, rollout time, pricing or something for their boss', () => {
    const cases: Array<[string, string]> = [
      ['Can we do a pilot first?', 'pilot'], ['Could we run a quick POC with one team?', 'pilot'], ['Do you offer a free trial?', 'pilot'],
      ['Is there a trial we could start?', 'pilot'], ['What would a pilot look like?', 'pilot'], ["We'd want to run a pilot before anything else.", 'pilot'],
      ['How long does a POC take?', 'pilot'], ['How do we start a proof of concept?', 'pilot'], ['Do you guys do POCs?', 'pilot'],
      ['How long does implementation take?', 'rollout'], ['How long would it take to get us up and running?', 'rollout'],
      ['What does the rollout look like?', 'rollout'], ["What's the typical onboarding timeline?", 'rollout'], ['How quickly could we be live?', 'rollout'],
      ['How would we roll it out to the other teams?', 'rollout'],
      ['How much does it cost?', 'pricing'], ['What would this cost us?', 'pricing'], ["What's your pricing like?", 'pricing'],
      ['How is it priced?', 'pricing'], ['Is it priced per seat?', 'pricing'], ['Can you send over pricing?', 'pricing'], ['How do you guys charge?', 'pricing'],
      ['How does pricing work?', 'pricing'], ['Could we get a quote?', 'pricing'], ['Can you give me a ballpark price?', 'pricing'],
      ['Could you send me a one-pager for my VP?', 'send_to_boss'], ['Something short I can forward to my CTO would help.', 'send_to_boss'],
      ['A summary we could share with leadership would be great.', 'send_to_boss'], ['My boss will want to see a business case.', 'send_to_boss'],
      ['Can you put together something to share with our head of engineering?', 'send_to_boss'],
      ['Can we do a pilot? And how much does it cost?', 'pilot'], ['Can we do a PILOT first?', 'pilot'],
    ]
    for (const [t, kind] of cases) expect(buyingSignal(t), t).toBe(kind)
  })

  it("doesn't mistake their own work for a buying signal", () => {
    for (const t of [
      'Token pricing in our pipeline is a big line item.', 'The rollout of our new model slipped a week.', 'Our internal pilot of the chatbot went well.',
      'We priced it per seat internally.', 'The autopilot feature is separate.', 'We rolled out the feature last week.',
      'The cost of running inference is high.', "I'll send the logs to my boss.", 'Our pilot program for the copilot ends in May.',
      "We're running a pilot with another vendor.", 'Our implementation of RAG uses two indexes.', 'The deployment is on Kubernetes.',
      'We need to price our own API for customers.', 'How long does the eval job take to run?', 'How much does the retriever slow things down?',
      'I need to write a summary for my boss about the outage.', 'My manager owns the rollout plan for the new model.',
      'What does the trial data look like in your schema?', 'We have a trial account with the cloud provider.', '',
    ]) expect(buyingSignal(t), t).toBeNull()
  })
})

function memoryWith(lines: Array<{ who: 'buyer' | 'keith' | 'sa'; text: string; at: number }>): CallMemory {
  const m = new CallMemory('sess-unit')
  m.setLabel({ cluster: 'e1:s1', role: 'teammate', name: 'Sam' })
  lines.forEach((l, i) => m.upsertTurn({
    id: `t${i}`, stream: l.who === 'keith' ? 'local_mic' : 'system_remote', cluster: l.who === 'keith' ? null : l.who === 'sa' ? 'e1:s1' : 'e1:s0',
    start_ms: l.at - 3000, end_ms: l.at, text: l.text, available_ms: l.at + 1000,
  }, true))
  return m
}

describe('which press is this', () => {
  it('follows the plan: WRAP, another angle, closing words, a buying signal, the opening, else a normal press', () => {
    const prior = { move: 'clarify_current_state', primary_kind: 'ask' as const, primary: 'How do you review answers today?' }
    // Early and quiet: the opening.
    const quiet = memoryWith([{ who: 'buyer', text: 'Hi, thanks for making the time.', at: 20_000 }])
    expect(decidePress('help_requested', quiet, 25_000).mode).toBe('opening')
    // A buying signal beats the opening; another angle beats the signal; WRAP beats them all.
    const sig = memoryWith([{ who: 'buyer', text: 'Can we do a pilot first?', at: 60_000 }])
    expect(decidePress('help_requested', sig, 65_000)).toEqual({ wrap: null, mode: 'signal', detail: { signal: 'pilot' } })
    expect(decidePress('help_requested', sig, 65_000, prior)).toEqual({ wrap: null, mode: 'another_angle', detail: { prior } })
    expect(decidePress('wrap_requested', sig, 65_000, prior)).toEqual({ wrap: 'button', mode: null, detail: { wrap_signal: { kind: 'pilot', at_ms: 57_000 } } })
    // Closing words beat a signal (the wrap instruction then mentions the signal).
    const closing = memoryWith([{ who: 'buyer', text: 'How much does it cost? I have a hard stop in two minutes.', at: 60_000 }])
    expect(decidePress('help_requested', closing, 65_000)).toMatchObject({ wrap: 'closing', mode: null, detail: { wrap_signal: { kind: 'pricing' } } })
    // A signal older than 30 s no longer makes it a next-step press (but WRAP still remembers it).
    expect(decidePress('help_requested', sig, 100_000).mode).toBe('opening')
    expect(decidePress('wrap_requested', sig, 400_000).detail.wrap_signal?.kind).toBe('pilot')
    // Past the opening and nothing special: a normal press.
    const busy = memoryWith([{ who: 'buyer', text: LONG_ANSWER, at: 60_000 }])
    expect(decidePress('help_requested', busy, 65_000)).toEqual({ wrap: null, mode: null, detail: {} })
    expect(decidePress('coach_proactive', sig, 65_000)).toEqual({ wrap: null, mode: null, detail: {} })
  })

  it('the opening: under 40 words from the other side, in the first 5 minutes; their words still being transcribed count', () => {
    const m = memoryWith([{ who: 'keith', text: LONG_ANSWER, at: 30_000 }, { who: 'buyer', text: 'Sure, sounds good.', at: 40_000 }])
    expect(isOpening(m, 45_000)).toBe(true) // Keith talking a lot doesn't end the opening
    expect(isOpening(m, 5 * 60_000)).toBe(false)
    m.setInterim('system_remote', LONG_ANSWER, 44_000)
    expect(isOpening(m, 45_000)).toBe(false)
    // An Arize teammate on the meeting audio is not the other side.
    const sa = memoryWith([{ who: 'sa', text: LONG_ANSWER, at: 30_000 }])
    expect(isOpening(sa, 45_000)).toBe(true)
    expect(isOpening(new CallMemory('empty'), 0)).toBe(true)
  })

  it('only the other side gives a buying signal: not Keith, not a tagged teammate; words being transcribed count for the press', () => {
    const m = memoryWith([{ who: 'keith', text: 'We can do a pilot if you like. How much does it cost you today?', at: 30_000 }, { who: 'sa', text: 'Could we run a POC next month?', at: 40_000 }])
    expect(recentSignal(m, 45_000)).toBeNull()
    expect(latestSignal(m, 45_000)).toBeNull()
    m.setInterim('system_remote', 'and how long does implementation take', 44_000)
    expect(recentSignal(m, 45_000)).toBe('rollout')
  })

  it('another angle needs the card on screen 2 to 20 seconds and nothing new said', () => {
    expect(anotherAngleOk(1000, 4000, true)).toBe(true)
    expect(anotherAngleOk(1000, 2500, true)).toBe(false)
    expect(anotherAngleOk(1000, 1000 + ANOTHER_ANGLE_WINDOW_MS + 1, true)).toBe(false)
    expect(anotherAngleOk(1000, 4000, false)).toBe(false)
    expect(anotherAngleOk(null, 4000, true)).toBe(false)
  })
})

describe('the instruction blocks', () => {
  const ctx = '<call_setup>x</call_setup>'
  it('a normal press is unchanged; each smarter press adds its block after the context', () => {
    expect(pressUserMessage(ctx, null, null)).toBe(buildUserMessage(ctx))
    const first = pressUserMessage(ctx, null, 'opening', { must_learn: ['who signs off', 'eval process'] })
    expect(first.startsWith(ctx)).toBe(true)
    expect(first).toMatch(/<opening_press>[\s\S]*This is the first call with them[\s\S]*set a short agenda from the call goal and Keith's must-learns/)
    expect(first).toContain(`Keith's must-learns for this call: "who signs off"; "eval process".`)
    expect(first).toMatch(/If they just asked a question or raised something, answer or handle that first/)
    expect(first).toMatch(/no outside research/)
    expect(first.trimEnd().endsWith('Give Keith his next line.')).toBe(true)
    const again = pressUserMessage(`${ctx}\n\n<earlier_calls note="x">\n2026-09-29 · They owe: an eval sample\n</earlier_calls>`, null, 'opening', {})
    expect(again).toMatch(/This is not the first call with them[\s\S]*pick up where they left off[\s\S]*as a question/)
    expect(again).toMatch(/never say it happened, or that it is still true/)
    expect(again).not.toMatch(/must-learns for this call/)

    const signal = pressUserMessage(ctx, null, 'signal', { signal: 'pricing' })
    expect(signal).toMatch(/they asked about pricing or cost: a buying signal/)
    expect(signal).toMatch(/never a price, discount, contract term or delivery date/)
    expect(signal).toMatch(/FOLLOW: one concrete next step[\s\S]*what it is, who should be there and when, asked, not picked/)
    expect(signal).toMatch(/Never pick a date, a name or a commitment nobody said/)

    const angle = pressUserMessage(ctx, null, 'another_angle', { prior: { move: 'clarify_current_state', primary_kind: 'ask', primary: 'How do you <review> answers\ntoday?' } })
    expect(angle).toContain('He already has: MOVE clarify_current_state; ASK "How do you review answers today?"')
    expect(angle).toMatch(/genuinely different move or question, not a rewording/)
    expect(angle.trimEnd().endsWith('Give Keith a different line.')).toBe(true)
    expect(pressModeOf(first)).toBe('opening')
    expect(pressModeOf(signal)).toBe('signal')
    expect(pressModeOf(angle)).toBe('another_angle')
    expect(pressModeOf(buildUserMessage(ctx))).toBeNull()
  })

  it("WRAP builds on the call's latest buying signal, in its own block, and stays a wrap card", () => {
    const u = pressUserMessage(ctx, 'button', null, { wrap_signal: { kind: 'pilot', at_ms: 862_000 } })
    expect(isWrapRequest(u)).toBe(true)
    expect(u).toMatch(/<\/wrap_card>\n\n<buying_signal>\nAt 14:22 they asked about a pilot, POC or trial\./)
    expect(u.trimEnd().endsWith('Give Keith his line to lock the next step.')).toBe(true)
    expect(pressUserMessage(ctx, 'closing', null, {}).includes('<buying_signal>')).toBe(false)
  })

  it('a stored press read from a hand-edited file keeps only what it can use', () => {
    expect(cleanPressDetail({ signal: 'bribe', prior: { primary: '', move: 'x' }, must_learn: ['a', 3, ' ', 'b', 'c', 'd'], wrap_signal: { kind: 'pricing', at_ms: 'soon' } })).toEqual({ must_learn: ['a', 'b', 'c'] })
    expect(cleanPressDetail(null)).toEqual({})
    expect(cleanPressDetail({ prior: { primary: 'Ask this', move: 'made_up', primary_kind: 'say' } })).toEqual({ prior: { primary: 'Ask this', move: 'no_move', primary_kind: 'say' } })
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A press answered with `text`, and the card completed. */
async function answer(_s: ReturnType<typeof engineFixture>, m: StagedModel, i: number, text = CARD) {
  m.calls[i].send(text)
  m.calls[i].finish()
  await vi.advanceTimersByTimeAsync(0)
}

const pastOpening = () => inventedCall({ transcript: [
  { t: 0, who: 'keith', text: 'How do you review model outputs today?' },
  { t: 4, end: 14, who: 'e1:s0', text: LONG_ANSWER },
  { t: 15, end: 18, who: 'keith', text: 'Got it, thanks.' },
] })

describe('another angle', () => {
  it('a re-press on the same moment asks for a different move, labels it, and marks the first card passed', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    const first = s.engine.press()
    s.advance(800)
    await answer(s, m, 0)
    s.advance(3000)
    const second = s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(pressModeOf(m.calls[1].user)).toBe('another_angle')
    expect(m.calls[1].user).toContain('He already has: MOVE clarify_current_state; ASK "Who looks at the weekly sample with the platform team?"')
    await answer(s, m, 1, CARD2)
    expect(s.events.at(-1)).toMatchObject({ request_id: second, status: 'complete', press_mode: 'another_angle', content: { move: 'identify_owner' } })
    // The first card was passed on: a feedback row that is not a rating.
    const rows = s.db.sql.prepare('SELECT card_id, origin, type FROM feedback').all()
    expect(rows).toEqual([{ card_id: first, origin: 'help_requested', type: 'passed' }])
    expect(readFeedback(s.db, [first]).get(first)).toMatchObject({ rating: null, passed: true, used: false })
    const timing = JSON.parse((s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(second) as { timing_json: string }).timing_json)
    expect(timing).toMatchObject({ press_mode: 'another_angle', angle_of: first })
    expect(s.logs.find((l) => l.e === 'help_press' && l.d?.request_id === second)?.d).toMatchObject({ press_mode: 'another_angle', angle_of: first })
    // Diagnostics never carry the line Keith already had, nor the call.
    expect(JSON.stringify(s.logs)).not.toMatch(/weekly sample|platform team|sign off/)
  })

  it('not when the card was barely on screen, too long ago, or something was said since', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    s.engine.press()
    await answer(s, m, 0)
    s.advance(1000) // barely seen
    s.engine.press()
    expect(pressModeOf(m.calls[1].user)).toBeNull()
    await answer(s, m, 1)
    s.advance(25_000) // long gone
    s.engine.press()
    expect(pressModeOf(m.calls[2].user)).toBeNull()
    await answer(s, m, 2)
    s.advance(3000)
    s.say('Mostly the platform team, honestly.') // something new
    s.engine.press()
    expect(pressModeOf(m.calls[3].user)).toBeNull()
    await answer(s, m, 3)
    s.advance(3000)
    s.memory.setInterim('local_mic', 'So who looks at', s.memory.turnsAsOf(1e9).at(-1)!.available_ms) // Keith is reading it out
    s.engine.press()
    expect(pressModeOf(m.calls[4].user)).toBeNull()
    expect(s.db.sql.prepare("SELECT COUNT(*) AS n FROM feedback WHERE type = 'passed'").get()).toEqual({ n: 0 })
  })

  it('never serves a stale background card on the second press', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening(), prefetch: true })
    // A background card, adopted at the first press.
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    await answer(s, m, 0)
    s.advance(1000)
    const first = s.engine.press()
    expect(m.calls).toHaveLength(1)
    expect(s.events.at(-1)).toMatchObject({ request_id: first, status: 'complete', timing: { served_from_prefetch: true } })
    // The same final turn arrives again: a second background card is built for the very same moment.
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(2)
    await answer(s, m, 1)
    s.advance(2500)
    const second = s.engine.press()
    // A fresh request with the another-angle block, not that background card.
    expect(m.calls).toHaveLength(3)
    expect(second).not.toBe(first)
    expect(pressModeOf(m.calls[2].user)).toBe('another_angle')
    expect(s.events.at(-1)).toMatchObject({ request_id: second, press_mode: 'another_angle', timing: { served_from_prefetch: false } })
    expect(s.db.sql.prepare("SELECT card_id FROM feedback WHERE type = 'passed'").all()).toEqual([{ card_id: first }])
  })
})

describe('buying-signal and opening presses', () => {
  it('a HELP press after a pricing question asks for a next step in FOLLOW, labelled "Next step"', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    s.say('This is useful. How much does it cost for a team our size?')
    const id = s.engine.press()
    expect(pressModeOf(m.calls[0].user)).toBe('signal')
    expect(m.calls[0].user).toMatch(/they asked about pricing or cost/)
    await answer(s, m, 0)
    expect(s.events.at(-1)).toMatchObject({ press_mode: 'signal', status: 'complete' })
    const timing = JSON.parse((s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(id) as { timing_json: string }).timing_json)
    expect(timing).toMatchObject({ press_mode: 'signal', press_signal: 'pricing' })
    expect(JSON.stringify(s.logs)).not.toMatch(/how much|team our size/i)
  })

  it('a background card built for the same press is still used; one built for a different press is not', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening(), prefetch: true })
    s.say('Can we run a pilot with one team first?')
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    expect(pressModeOf(m.calls[0].user)).toBe('signal')
    await answer(s, m, 0)
    s.advance(1000)
    s.engine.press()
    expect(m.calls).toHaveLength(1)
    expect(s.events.at(-1)).toMatchObject({ press_mode: 'signal', timing: { served_from_prefetch: true } })
    // A candidate built while the question was fresh, pressed for once it's over 30 s old: a normal press, built fresh.
    const u = engineFixture(m, playbook, { call: pastOpening(), prefetch: true })
    u.say('Can we run a pilot with one team first?')
    u.advance(10_000)
    u.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(2)
    expect(pressModeOf(m.calls[1].user)).toBe('signal')
    await answer(u, m, 1)
    u.advance(21_000)
    u.engine.press()
    expect(m.calls).toHaveLength(3)
    expect(pressModeOf(m.calls[2].user)).toBeNull()
    expect(u.events.at(-1)).toMatchObject({ timing: { served_from_prefetch: false } })
    expect(u.events.at(-1)).not.toHaveProperty('press_mode')
  })

  it("an early press sets the agenda from the goal and Keith's must-learns, labelled \"Opening\"; the must-learns never reach the logs", async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook)
    s.memory.setup = { ...s.memory.setup, must_learn: ['who signs off on tooling', 'how evals run today'] }
    const id = s.engine.press()
    expect(pressModeOf(m.calls[0].user)).toBe('opening')
    expect(m.calls[0].user).toContain(`"who signs off on tooling"; "how evals run today"`)
    await answer(s, m, 0)
    expect(s.events.at(-1)).toMatchObject({ request_id: id, press_mode: 'opening' })
    expect(JSON.stringify(s.logs)).not.toMatch(/signs off|evals run/)
    // Older setups without must-learns still get an opening.
    const t = engineFixture(m, playbook)
    delete (t.memory.setup as { must_learn?: string[] }).must_learn
    t.engine.press()
    expect(pressModeOf(m.calls[1].user)).toBe('opening')
    expect(m.calls[1].user).not.toMatch(/must-learns for this call/)
  })

  it('Practice mode answers each smarter press in kind', async () => {
    const s = engineFixture(new MockHelpModel(10), playbook)
    s.engine.press()
    await vi.advanceTimersByTimeAsync(50)
    expect(s.events.at(-1)).toMatchObject({ status: 'complete', mock: true, press_mode: 'opening', content: { move: 'call_control' } })
    s.advance(3000)
    s.engine.press()
    await vi.advanceTimersByTimeAsync(50)
    expect(s.events.at(-1)).toMatchObject({ status: 'complete', press_mode: 'another_angle', content: { move: 'identify_owner' } })
    s.advance(3000)
    s.engine.press()
    await vi.advanceTimersByTimeAsync(50)
    // Another angle on the another-angle card: a different move again.
    expect(s.events.at(-1)).toMatchObject({ press_mode: 'another_angle', content: { move: 'explore_process' } })
    const t = engineFixture(new MockHelpModel(10), playbook, { call: pastOpening() })
    t.say('Do you offer a free trial?')
    t.engine.press()
    await vi.advanceTimersByTimeAsync(50)
    expect(t.events.at(-1)).toMatchObject({ status: 'complete', press_mode: 'signal' })
    expect(t.events.at(-1)!.content.follow_up).toMatch(/^\[MOCK\] Who should join/)
  })
})

describe('practice moments replay the same press', () => {
  it('another angle replays with the line Keith already had; an opening with its must-learns', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    const first = s.engine.press()
    await answer(s, m, 0)
    s.advance(3000)
    const second = s.engine.press()
    await answer(s, m, 1, CARD2)
    vi.useRealTimers()
    const b = buildPracticeMoment(s.db, second)
    if (!b.ok) throw new Error(b.reason)
    expect(b.moment.press_mode).toBe('another_angle')
    expect(b.moment.press_detail?.prior).toEqual({ move: 'clarify_current_state', primary_kind: 'ask', primary: 'Who looks at the weekly sample with the platform team?' })
    expect(b.moment.keith_notes).toMatch(/Keith pressed HELP again for another angle/)
    class Capturing extends MockHelpModel {
      users: string[] = []
      override run(req: Parameters<MockHelpModel['run']>[0]) {
        this.users.push(req.user)
        return super.run(req)
      }
    }
    const model = new Capturing(0)
    const res = await runScenario(b.moment, model, DEFAULT_HELP_CONFIG, playbook)
    expect(res.status).toBe('complete')
    expect(model.users[0]).toContain('He already has: MOVE clarify_current_state; ASK "Who looks at the weekly sample with the platform team?"')
    expect(res.card?.move).toBe('identify_owner')
    // The first card was a normal press and replays as one.
    const one = buildPracticeMoment(s.db, first)
    if (!one.ok) throw new Error(one.reason)
    expect(one.moment.press_mode).toBeUndefined()
    // Re-saving keeps it.
    expect(refreshFeedback(one.moment, b.moment).press_mode).toBe('another_angle')

    const o = engineFixture(m, playbook)
    o.memory.setup = { ...o.memory.setup, must_learn: ['who signs off on tooling'] }
    const op = o.engine.press()
    m.calls[2].send(CARD)
    m.calls[2].finish()
    await new Promise((r) => setTimeout(r, 0))
    const ob = buildPracticeMoment(o.db, op)
    if (!ob.ok) throw new Error(ob.reason)
    expect(ob.moment).toMatchObject({ press_mode: 'opening', press_detail: { must_learn: ['who signs off on tooling'] } })
    const model2 = new Capturing(0)
    await runScenario(ob.moment, model2, DEFAULT_HELP_CONFIG, playbook)
    expect(model2.users[0]).toContain('<opening_press>')
    expect(model2.users[0]).toContain('"who signs off on tooling"')
  })
})

describe('in the app', () => {
  it('a passed card is accepted as feedback, never a rating; the review and scorecard show it', () => {
    vi.useRealTimers()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'press-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    help.db.sql.prepare("INSERT INTO sessions (id, started_at, setup_json) VALUES ('s1', 't', '{}')").run()
    const ins = help.db.sql.prepare("INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, card_json, timing_json, prefetch) VALUES (?, 's1', 'help_requested', 't', ?, 'complete', '{}', ?, ?, 0)")
    ins.run('c1', 1000, JSON.stringify({ primary_kind: 'ask', primary: 'One?' }), '{"press_mode":"opening"}')
    ins.run('c2', 2000, JSON.stringify({ primary_kind: 'ask', primary: 'Two?' }), '{"press_mode":"another_angle","angle_of":"c1"}')
    ins.run('c3', 3000, JSON.stringify({ primary_kind: 'say', primary: 'Three.' }), '{"press_mode":"signal","press_signal":"pilot"}')
    expect(help.feedback({ card_id: 'c1', type: 'useful' })).toEqual({ ok: true })
    expect(help.feedback({ card_id: 'c1', type: 'passed' })).toEqual({ ok: true })
    const ended = help as unknown as { endedCall: { sessionId: string; callMs: number } }
    ended.endedCall = { sessionId: 's1', callMs: 60_000 }
    const cards = help.callCards()
    expect(cards.find((c) => c.id === 'c1')).toMatchObject({ rating: 'useful', passed: true })
    expect(cards.find((c) => c.id === 'c2')).not.toHaveProperty('passed')
    const card = buildScorecard(help.db, 's1', 60_000)
    expect(card.presses).toEqual({ opening: 1, signal: 1, another_angle: 1, passed: 1 })
    expect(card.feedback).toMatchObject({ useful: 1, bad: 0, should_have_stayed_quiet: 0 })
    help.shutdown()
  })

  it("keeps the call's latest buying signal for the WRAP tag, from the other side only, and clears it at a new call", () => {
    vi.useRealTimers()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'press-'))
    const logs: Array<[string, Record<string, unknown> | undefined]> = []
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, (e, d) => logs.push([e, d]))
    help.setSettings({ prefetch: false })
    help.createModel = () => new MockHelpModel(0)
    const seen: unknown[] = []
    help.onSignal = (s) => seen.push(s)
    let t = 0
    let n = 0
    const state = (st: string, call: string) => help.onSessionEvent({ type: 'state', state: st, sessionId: call } as SessionEvent, call, () => t)
    const say = (who: 'buyer' | 'keith', text: string, call: string) => {
      const start = t
      t += 5000
      const turn: Turn = {
        turn_id: `t${++n}`, session_id: call, stream: who === 'keith' ? 'local_mic' : 'system_remote', speaker_cluster: who === 'keith' ? null : 'e1:s0',
        speaker_identity_id: null, speaker_role: 'unknown', start_ms: start, end_ms: t, text, final: true, source_word_ids: [], gap_before: null,
      }
      help.onSessionEvent({ type: 'turn', event: { type: 'turn_final', turn } } as SessionEvent, call, () => t)
    }
    state('checking', 'c-1')
    state('live', 'c-1')
    say('keith', 'We could do a pilot if that helps.', 'c-1')
    expect(help.signal).toBeNull()
    say('buyer', 'How much does it cost, roughly?', 'c-1')
    expect(help.signal).toEqual({ kind: 'pricing', at_ms: 5000 })
    say('buyer', 'And could we run a pilot with one team?', 'c-1')
    expect(help.signal).toEqual({ kind: 'pilot', at_ms: 10_000 })
    say('buyer', 'Our pilot of the chatbot went fine.', 'c-1')
    expect(help.signal?.kind).toBe('pilot')
    state('stopping', 'c-1')
    state('stopped', 'c-1')
    expect(help.signal?.kind).toBe('pilot') // still shown until the next call
    state('checking', 'c-2')
    expect(help.signal).toBeNull()
    expect(seen.at(-1)).toBeNull()
    // Logs carry the kind and call time only.
    expect(logs.filter(([e]) => e === 'buying_signal').map(([, d]) => d)).toEqual([{ kind: 'pricing', at_ms: 5000 }, { kind: 'pilot', at_ms: 10_000 }])
    expect(JSON.stringify(logs)).not.toMatch(/cost, roughly|one team|chatbot/)
    help.shutdown()
  })
})
