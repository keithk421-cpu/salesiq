import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Turn } from '../src/shared/contracts'
import type { HelpCardEvent } from '../src/shared/help'
import { CallMemory } from '../src/main/help/callMemory'
import { runScenario } from '../src/main/help/evalRunner'
import { DEFAULT_HELP_CONFIG, MockHelpModel } from '../src/main/help/models'
import { buildPracticeMoment, refreshFeedback } from '../src/main/help/practice'
import { cleanPressDetail, cleanPressMode, decidePress, planItemOf, pressModeOf, pressUserMessage, savedPress } from '../src/main/help/pressModes'
import { loadPlaybook } from '../src/main/help/prompt'
import { buildScorecard } from '../src/main/help/scorecard'
import { isWrapRequest } from '../src/main/help/wrap'
import { HelpService } from '../src/main/helpService'
import type { SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'
import { StagedModel, engineFixture, inventedCall } from './helpers/helpEngine'

// M4: click a must-learn mid-call for the line that gets there. Invented call details only.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const CARD = 'MOVE: clarify_current_state\nASK: Who looks at the weekly sample with the platform team?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'
const PLAN_CARD = 'MOVE: identify_owner\nASK: When a change like that comes up, who has the final say?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'
const ITEM = 'Who signs off on new tools'
const LONG_ANSWER = 'We send a sample of answers to the platform team every Friday and they mark anything that looks wrong, then the product owner reads the notes on Monday and decides what to change in the prompts before the next release goes out to everyone.'

function memoryWith(lines: Array<{ who: 'buyer' | 'keith'; text: string; at: number }>): CallMemory {
  const m = new CallMemory('sess-plan')
  lines.forEach((l, i) => m.upsertTurn({
    id: `t${i}`, stream: l.who === 'keith' ? 'local_mic' : 'system_remote', cluster: l.who === 'keith' ? null : 'e1:s0',
    start_ms: l.at - 3000, end_ms: l.at, text: l.text, available_ms: l.at + 1000,
  }, true))
  return m
}

const pastOpening = () => inventedCall({ transcript: [
  { t: 0, who: 'keith', text: 'How do you review model outputs today?' },
  { t: 4, end: 14, who: 'e1:s0', text: LONG_ANSWER },
  { t: 15, end: 18, who: 'keith', text: 'Got it, thanks.' },
] })

/** The <plan_press> block of a request. */
const block = (u: string) => /<plan_press>[\s\S]*<\/plan_press>/.exec(u)?.[0]

/** A model that records each request and answers with MOCK lines (for replays). */
class Capturing extends MockHelpModel {
  users: string[] = []
  override run(req: Parameters<MockHelpModel['run']>[0]) {
    this.users.push(req.user)
    return super.run(req)
  }
}

describe('which press is a must-learn click', () => {
  const prior = { move: 'clarify_current_state', primary_kind: 'ask' as const, primary: 'How do you review answers today?' }

  it('comes before another angle, closing words, a buying signal and the opening; the WRAP button stays a wrap card', () => {
    const quiet = memoryWith([{ who: 'buyer', text: 'Hi, thanks for making the time.', at: 20_000 }])
    expect(decidePress('help_requested', quiet, 25_000, null, [], ITEM)).toEqual({ wrap: null, mode: 'plan_item', detail: { plan_item: ITEM, mode_facts: expect.any(Object) } })
    const sig = memoryWith([{ who: 'buyer', text: 'Can we do a pilot first?', at: 60_000 }])
    expect(decidePress('help_requested', sig, 65_000, null, [prior], ITEM)).toEqual({ wrap: null, mode: 'plan_item', detail: { plan_item: ITEM, mode_facts: expect.any(Object) } })
    // The same must-learn clicked again for the same moment (the engine decides that): the card he already has comes too.
    expect(decidePress('help_requested', sig, 65_000, prior, [prior], ITEM)).toEqual({ wrap: null, mode: 'plan_item', detail: { plan_item: ITEM, prior, earlier: [prior], mode_facts: expect.any(Object) } })
    const closing = memoryWith([{ who: 'buyer', text: 'This was great. I have a hard stop in two minutes.', at: 60_000 }])
    expect(decidePress('help_requested', closing, 65_000, null, [], ITEM).mode).toBe('plan_item')
    // The WRAP button is its own origin: unchanged.
    expect(decidePress('wrap_requested', sig, 65_000, null, [], ITEM)).toEqual({ wrap: 'button', mode: null, detail: { wrap_signal: { kind: 'pilot', at_ms: 57_000 }, mode_facts: expect.any(Object) } })
    expect(decidePress('coach_proactive', sig, 65_000, null, [], ITEM)).toEqual({ wrap: null, mode: null, detail: {} })
    // No item (or only spaces): the press is decided as before.
    expect(decidePress('help_requested', sig, 65_000, null, [], '   ').mode).toBe('signal')
    expect(decidePress('help_requested', sig, 65_000).mode).toBe('signal')
    // The item is kept the way must-learns are: one line, at most 80 characters.
    expect(decidePress('help_requested', quiet, 25_000, null, [], `  who\n signs   off ${'x'.repeat(100)}`).detail.plan_item).toHaveLength(80)
  })
})

describe('the <plan_press> block', () => {
  const ctx = '<call_setup>x</call_setup>'

  it('asks for one natural way to get there; answer first, let them finish, never "you mentioned"; asked is not answered', () => {
    const u = pressUserMessage(ctx, null, 'plan_item', { plan_item: ITEM })
    expect(u.startsWith(ctx)).toBe(true)
    expect(u).toContain(`<plan_press>\nKeith clicked one of his must-learns for this call: "${ITEM}". He wants one natural way to get there from where the talk is now.`)
    expect(u).toMatch(/If they just asked something or raised a concern, answer or handle that first \(the normal rules\) and put the bridge to it in FOLLOW/)
    // Mid-answer: the question he clicked for stays the big line; the cue to wait is in HAPPENING.
    expect(u).toMatch(/If they are mid-answer \(their words are still being transcribed[^)]*\), still ASK the question he clicked for, ready for when they finish, and say in HAPPENING: "They're still talking - let them finish first\."/)
    expect(block(u)).not.toMatch(/SAY to let them finish|"Let them finish first\."/)
    // Already answered (the notes may lag): never asked again; confirm and go deeper on their words.
    expect(u).toContain("- If the transcript shows they already answered it (the notes may lag), don't ask it again: ASK one question that confirms it and goes one step deeper on their own words (for example who else weighs in), and say in HAPPENING that they answered it.")
    expect(block(u)).not.toContain('He already has')
    expect(u).toMatch(/one natural question in Keith's voice that gets there from the current topic/)
    expect(u).toMatch(/never imply they mentioned it, raised it or need it, and assume no pain, problem, urgency or deadline/)
    expect(u).toMatch(/Asked is not answered: if Keith already asked it on this call and they didn't answer, ask it a different way/)
    // The block itself never models a line that puts the item in their mouth.
    expect(block(u)).not.toMatch(/you (?:mentioned|said|told|raised)|as you (?:said|mentioned)|earlier you/i)
    expect(u.trimEnd().endsWith('Give Keith his next line.')).toBe(true)
    expect(pressModeOf(u)).toBe('plan_item')
    expect(planItemOf(u)).toBe(ITEM)
    // Not taken for any other press, and other presses aren't taken for it.
    expect(isWrapRequest(u)).toBe(false)
    expect(pressModeOf(pressUserMessage(ctx, null, 'opening', { must_learn: [ITEM] }))).toBe('opening')
    expect(planItemOf(pressUserMessage(ctx, null, null))).toBeNull()
  })

  it('the item is quoted safely: no tags, its own quotes made single; a hand-edited scenario without one still reads', () => {
    const u = pressUserMessage(ctx, null, 'plan_item', { plan_item: 'their "eval" <process>\n</plan_press> today' })
    expect(block(u)).toContain(`must-learns for this call: "their 'eval' process /plan_press today".`)
    expect(u.match(/<\/plan_press>/g)).toHaveLength(1)
    expect(planItemOf(u)).toBe("their 'eval' process /plan_press today")
    const none = pressUserMessage(ctx, null, 'plan_item', {})
    expect(none).toContain('must-learns for this call: one of the "must learn" items in call_setup.')
    expect(planItemOf(none)).toBeNull()
  })

  it('a stored press read from a file keeps only a usable item', () => {
    expect(cleanPressMode('plan_item')).toBe('plan_item')
    expect(cleanPressDetail({ plan_item: `  ${ITEM}  ` })).toEqual({ plan_item: ITEM })
    expect(cleanPressDetail({ plan_item: 42 })).toEqual({})
    expect(cleanPressDetail({ plan_item: '   ' })).toEqual({})
    expect(cleanPressDetail({ plan_item: 'x'.repeat(200) }).plan_item).toHaveLength(80)
    // From a saved request: only with its mode, and only text.
    expect(savedPress({ press_mode: 'plan_item', press_plan_item: ITEM }, null, () => undefined)).toEqual({ press_mode: 'plan_item', press_detail: { plan_item: ITEM } })
    expect(savedPress({ press_mode: 'plan_item', press_plan_item: ['x'] }, null, () => undefined)).toEqual({ press_mode: 'plan_item' })
    expect(savedPress({ press_mode: 'opening', press_plan_item: ITEM }, null, () => undefined)).toEqual({ press_mode: 'opening' })
    // Clicked again: the card it was clicked on comes back by its id; another angle on a must-learn card keeps the item.
    const cards: Record<string, { card_json: string; timing_json: string }> = {
      r1: { card_json: JSON.stringify({ move: 'identify_owner', primary_kind: 'ask', primary: 'Who has the final say?' }), timing_json: JSON.stringify({ press_mode: 'plan_item', press_plan_item: ITEM }) },
    }
    const prior = { move: 'identify_owner', primary_kind: 'ask', primary: 'Who has the final say?' }
    expect(savedPress({ press_mode: 'plan_item', press_plan_item: ITEM, angle_of: 'r1' }, null, (id) => cards[id])).toEqual({ press_mode: 'plan_item', press_detail: { plan_item: ITEM, prior } })
    expect(savedPress({ press_mode: 'another_angle', press_plan_item: ITEM, angle_of: 'r1' }, null, (id) => cards[id])).toEqual({ press_mode: 'another_angle', press_detail: { plan_item: ITEM, prior } })
    expect(savedPress({ press_mode: 'plan_item', press_plan_item: ITEM, angle_of: 'gone' }, null, (id) => cards[id])).toEqual({ press_mode: 'plan_item', press_detail: { plan_item: ITEM } })
  })

  it('Practice mode (MOCK) answers it with a line toward the item', async () => {
    const out: string[] = []
    await new MockHelpModel(0).run({ system: '', user: pressUserMessage(ctx, null, 'plan_item', { plan_item: ITEM }), config: DEFAULT_HELP_CONFIG, signal: new AbortController().signal, onText: (c) => out.push(c) })
    expect(out.join('')).toMatch(/^MOVE: clarify_current_state\nASK: \[MOCK\] To get to Who signs off on new tools: how does that work\?\n/)
  })
})

describe('the engine', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function answer(m: StagedModel, i: number, text = CARD) {
    m.calls[i].send(text)
    m.calls[i].finish()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('always a fresh request: a background card waiting for this moment is not served', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening(), prefetch: true })
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(1)
    await answer(m, 0)
    s.advance(1000)
    const id = s.engine.press('help_requested', { planItem: ITEM })
    expect(m.calls).toHaveLength(2)
    expect(pressModeOf(m.calls[1].user)).toBe('plan_item')
    expect(block(m.calls[1].user)).toContain(`"${ITEM}"`)
    await answer(m, 1, PLAN_CARD)
    expect(s.events.at(-1)).toMatchObject({ request_id: id, status: 'complete', press_mode: 'plan_item', timing: { served_from_prefetch: false }, content: { move: 'identify_owner' } })
    // A plain HELP press right after still works as before (no plan block).
    s.advance(30_000)
    s.say('Mostly the platform team, honestly.')
    s.engine.press()
    expect(pressModeOf(m.calls.at(-1)!.user)).toBeNull()
  })

  it('never "another angle": a card on screen for a few seconds gets no passed row, and the request has no another-angle block', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    s.engine.press()
    await answer(m, 0)
    s.advance(3000) // what would be another angle on a HELP press
    const id = s.engine.press('help_requested', { planItem: ITEM })
    expect(m.calls[1].user).not.toContain('<another_angle>')
    expect(pressModeOf(m.calls[1].user)).toBe('plan_item')
    expect(s.db.sql.prepare('SELECT COUNT(*) AS n FROM feedback').get()).toEqual({ n: 0 })
    await answer(m, 1, PLAN_CARD)
    // HELP again a few seconds later is another angle on the must-learn card, as for any card.
    s.advance(3000)
    s.engine.press()
    expect(pressModeOf(m.calls[2].user)).toBe('another_angle')
    // ...and stays on that must-learn.
    expect(m.calls[2].user).toContain(`- That card was his way to get to one of his must-learns: "${ITEM}". Stay on that must-learn: a different way to get there.`)
    expect(planItemOf(m.calls[2].user)).toBeNull()
    expect(s.db.sql.prepare("SELECT card_id FROM feedback WHERE type = 'passed'").all()).toEqual([{ card_id: id }])
    // The WRAP button ignores an item it's given.
    s.engine.press('wrap_requested', { planItem: ITEM })
    expect(isWrapRequest(m.calls[3].user)).toBe(true)
    expect(m.calls[3].user).not.toContain('<plan_press>')
  })

  it('the same must-learn clicked again for the same moment names the line he already has; marks it passed', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    const first = s.engine.press('help_requested', { planItem: ITEM })
    await answer(m, 0, PLAN_CARD)
    s.advance(4000)
    // Matched like the plan line matches it (case and punctuation don't matter).
    const second = s.engine.press('help_requested', { planItem: 'who signs off on new tools?' })
    expect(pressModeOf(m.calls[1].user)).toBe('plan_item')
    expect(block(m.calls[1].user)).toContain('He clicked it again for the same moment: nothing new was said since. He already has: MOVE identify_owner; ASK "When a change like that comes up, who has the final say?"')
    expect(block(m.calls[1].user)).toContain('- Give a different way in to the same must-learn (another angle or a narrower part of it), not a rewording of that line.')
    expect(m.calls[1].user).not.toContain('<another_angle>')
    expect(planItemOf(m.calls[1].user)).toBe('who signs off on new tools?')
    expect(s.db.sql.prepare("SELECT card_id, type FROM feedback").all()).toEqual([{ card_id: first, type: 'passed' }])
    await answer(m, 1, CARD)
    const row = s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(second) as { timing_json: string }
    expect(JSON.parse(row.timing_json)).toMatchObject({ press_mode: 'plan_item', angle_of: first })
    // A third click: the first line is one he passed on too.
    s.advance(3000)
    s.engine.press('help_requested', { planItem: ITEM })
    expect(block(m.calls[2].user)).toContain('He already has: MOVE clarify_current_state; ASK "Who looks at the weekly sample with the platform team?"\nHe already passed on: MOVE identify_owner; ASK "When a change like that comes up, who has the final say?"')
    // Logs carry ids and codes only, never the item or either line.
    expect(s.logs.find((l) => l.e === 'help_press' && l.d?.request_id === second)?.d).toMatchObject({ press_mode: 'plan_item', angle_of: first })
    expect(JSON.stringify(s.logs)).not.toMatch(/signs off|new tools|final say|weekly sample/i)
  })

  it('must not match: a different must-learn, something new said, too soon or too late is a plain must-learn press', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    const plain = (i: number) => {
      expect(pressModeOf(m.calls[i].user)).toBe('plan_item')
      expect(block(m.calls[i].user)).not.toContain('He already has')
    }
    s.engine.press('help_requested', { planItem: ITEM })
    await answer(m, 0, PLAN_CARD)
    s.advance(3000)
    s.engine.press('help_requested', { planItem: 'How evals run today' })
    plain(1)
    await answer(m, 1, PLAN_CARD)
    s.advance(3000)
    s.say('Mostly the platform team, honestly.')
    s.engine.press('help_requested', { planItem: 'How evals run today' })
    plain(2)
    await answer(m, 2, PLAN_CARD)
    s.advance(1000)
    s.engine.press('help_requested', { planItem: 'How evals run today' })
    plain(3)
    await answer(m, 3, PLAN_CARD)
    s.advance(25_000)
    s.engine.press('help_requested', { planItem: 'How evals run today' })
    plain(4)
    expect(s.db.sql.prepare('SELECT COUNT(*) AS n FROM feedback').get()).toEqual({ n: 0 })
  })

  it('keeps the item with the request and logs only the kind of press', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    s.memory.setup = { ...s.memory.setup, must_learn: [ITEM] }
    const id = s.engine.press('help_requested', { planItem: ITEM })
    await answer(m, 0, PLAN_CARD)
    const row = s.db.sql.prepare('SELECT timing_json, request_text FROM help_requests WHERE id = ?').get(id) as { timing_json: string; request_text: string }
    expect(JSON.parse(row.timing_json)).toMatchObject({ press_mode: 'plan_item', press_plan_item: ITEM })
    expect(row.request_text).toContain('<plan_press>')
    expect(s.logs.find((l) => l.e === 'help_press' && l.d?.request_id === id)?.d).toMatchObject({ press_mode: 'plan_item', served_from_prefetch: false })
    expect(s.logs.find((l) => l.e === 'help_done' && l.d?.request_id === id)?.d).toMatchObject({ press_mode: 'plan_item' })
    expect(JSON.stringify(s.logs)).not.toMatch(/signs off|new tools|final say/i)
  })
})

describe('practice moments replay the same must-learn press', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the item comes back from the request (even after Keith changed his list), with the same block', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pastOpening() })
    s.memory.setup = { ...s.memory.setup, must_learn: [ITEM, 'How evals run today'] }
    const id = s.engine.press('help_requested', { planItem: ITEM })
    m.calls[0].send(PLAN_CARD)
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    const b = buildPracticeMoment(s.db, id)
    if (!b.ok) throw new Error(b.reason)
    expect(b.moment).toMatchObject({ press_mode: 'plan_item', press_detail: { plan_item: ITEM } })
    expect(b.moment.keith_notes).toMatch(/Keith clicked one of his must-learns for the line that gets there/)
    const model = new Capturing(0)
    const res = await runScenario(b.moment, model, DEFAULT_HELP_CONFIG, playbook)
    expect(res.status).toBe('complete')
    expect(block(model.users[0])).toBe(block(m.calls[0].user))
    // M5: replayed in its call mode (discovery), as on the call.
    expect(res.card?.primary).toMatch(/^\[MOCK · discovery\] To get to Who signs off/)
    // Re-saving keeps it; a hand-edited moment with a broken item replays without one, still as a must-learn press.
    expect(refreshFeedback({ ...b.moment, press_mode: undefined, press_detail: undefined }, b.moment).press_detail).toEqual({ plan_item: ITEM, mode_facts: expect.any(Object) })
    // A must-learn clicked again replays with the line he already had (from the card it was clicked on).
    s.advance(3000)
    vi.useFakeTimers()
    const again = s.engine.press('help_requested', { planItem: ITEM })
    m.calls[1].send(CARD)
    m.calls[1].finish()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    const a = buildPracticeMoment(s.db, again)
    if (!a.ok) throw new Error(a.reason)
    expect(a.moment).toMatchObject({ press_mode: 'plan_item', press_detail: { plan_item: ITEM, prior: { move: 'identify_owner', primary_kind: 'ask', primary: 'When a change like that comes up, who has the final say?' } } })
    const againModel = new Capturing(0)
    const againRes = await runScenario(a.moment, againModel, DEFAULT_HELP_CONFIG, playbook)
    expect(block(againModel.users[0])).toBe(block(m.calls[1].user))
    expect(againRes.card?.primary).toMatch(/^\[MOCK · discovery\] Another way to Who signs off/)
    const broken = new Capturing(0)
    await runScenario({ ...b.moment, press_detail: { plan_item: 7 as unknown as string } }, broken, DEFAULT_HELP_CONFIG, playbook)
    expect(broken.users[0]).toContain('one of the "must learn" items in call_setup')
  })
})

describe('in the app', () => {
  const ML = [ITEM, 'How evals run today']

  function app() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-press-'))
    const logs: Array<[string, Record<string, unknown> | undefined]> = []
    const events: HelpCardEvent[] = []
    const help = new HelpService(new Storage(dir, plainBox), ROOT, (ev) => events.push(ev), (e, d) => logs.push([e, d]))
    help.setSettings({ prefetch: false, call_notes: false, wrapup: false })
    help.createModel = () => new MockHelpModel(0)
    let t = 0
    const state = (st: string, call = 'c-1') => help.onSessionEvent({ type: 'state', state: st, sessionId: call } as SessionEvent, call, () => t)
    const say = (text: string, call = 'c-1') => {
      const start = t
      t += 5000
      const turn: Turn = {
        turn_id: `t${t}`, session_id: call, stream: 'system_remote', speaker_cluster: 'e1:s0',
        speaker_identity_id: null, speaker_role: 'unknown', start_ms: start, end_ms: t, text, final: true, source_word_ids: [], gap_before: null,
      }
      help.onSessionEvent({ type: 'turn', event: { type: 'turn_final', turn } } as SessionEvent, call, () => t)
    }
    return { help, logs, events, state, say }
  }

  it('only one of this call\'s must-learns, only while live; Practice mode answers it; the scorecard counts it; logs carry no item text', async () => {
    const a = app()
    a.help.setMustLearn(ML)
    // Before Start.
    expect(a.help.pressPlanItem(ITEM)).toEqual({ ok: false, reason: 'Start a call first.' })
    a.state('checking')
    expect(a.help.pressPlanItem(ITEM)).toEqual({ ok: false, reason: 'Start a call first.' })
    a.state('live')
    a.say('We review a sample of answers every Friday with the platform team.')
    // Must not match: not on the list, not text, a part of an item, empty.
    for (const raw of ['Their budget', '', '   ', 42, null, undefined, { item: ITEM }, [ITEM], 'Who signs off', 'x'.repeat(5000)]) {
      expect(a.help.pressPlanItem(raw), String(raw)).toEqual({ ok: false, reason: "That one isn't on this call's must-learn list any more." })
    }
    expect(a.events).toHaveLength(0)
    // Matched the way the plan line matches (case, spacing and punctuation don't matter); the stored wording is sent.
    const r = a.help.pressPlanItem('  who SIGNS off on new-tools? ')
    expect(r).toMatchObject({ ok: true })
    // Wait for the Practice card itself, not a fixed time: GitHub's Windows machine can be far slower.
    await vi.waitFor(() => expect(a.events.at(-1)).toMatchObject({ request_id: r.request_id, status: 'complete' }), { timeout: 10_000 })
    expect(a.events.at(-1)).toMatchObject({ request_id: r.request_id, status: 'complete', mock: true, press_mode: 'plan_item' })
    expect(a.events.at(-1)!.content.primary).toBe('[MOCK · discovery] To get to Who signs off on new tools: how does that work?')
    const row = a.help.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(r.request_id!) as { timing_json: string }
    expect(JSON.parse(row.timing_json)).toMatchObject({ press_mode: 'plan_item', press_plan_item: ITEM })
    // An item removed mid-call can't be pressed any more.
    a.help.setMustLearn([ML[1]])
    expect(a.help.pressPlanItem(ITEM).ok).toBe(false)
    const r2 = a.help.pressPlanItem('how evals run today')
    expect(r2.ok).toBe(true)
    await vi.waitFor(() => expect(a.events.at(-1)).toMatchObject({ request_id: r2.request_id, status: 'complete' }), { timeout: 10_000 })
    // Paused.
    a.state('paused')
    expect(a.help.pressPlanItem(ML[1])).toEqual({ ok: false, reason: 'Paused - resume to use HELP.' })
    a.state('live')
    a.state('stopping')
    expect(a.help.pressPlanItem(ML[1]).ok).toBe(false)
    a.state('stopped')
    expect(a.help.pressPlanItem(ML[1]).ok).toBe(false)
    // The scorecard counts the two must-learn presses (numbers only).
    const card = buildScorecard(a.help.db, 'c-1', 60_000)
    expect(card.presses).toMatchObject({ plan_item: 2, opening: 0, another_angle: 0 })
    expect(JSON.stringify(card)).not.toMatch(/signs off|evals run/i)
    expect(a.logs.filter(([e]) => e === 'help_press').map(([, d]) => d?.press_mode)).toEqual(['plan_item', 'plan_item'])
    expect(JSON.stringify(a.logs)).not.toMatch(/signs off|new tools|evals run|Friday|platform team/i)
    a.help.shutdown()
  })
})
