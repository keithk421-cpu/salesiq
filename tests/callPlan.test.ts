// Keith's call plan (M3 C): must-learns tracked Open / Partial / Done. Every company, name and line here is made up.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallNotes, CallNotesState, CallWrapup, PlanItemStatus } from '../src/shared/help'
import type { Turn } from '../src/shared/contracts'
import { Db } from '../src/main/db'
import { accountMemory, cleanEarlierItems, earlierCallsBlock } from '../src/main/help/accountMemory'
import { CallMemory } from '../src/main/help/callMemory'
import { CALL_NOTES_BLOCK_MAX_CHARS, EMPTY_NOTES, NOTES_SCHEMA, NOTES_SYSTEM_PROMPT, PLAN_BLOCK_MAX_CHARS, callNotesBlock, notesForModel, validateNotes } from '../src/main/help/callNotes'
import { MUST_LEARN_MAX_CHARS, PLAN_SECTION_LABEL, mergePlan, mustLearnLine, notPlannedNow, planLineText, planNow, planOpen, sanitizeMustLearn, shortItem } from '../src/main/help/callPlan'
import { buildHelpContext } from '../src/main/help/context'
import { MockHelpModel, type HelpModel, type HelpModelResult, type HelpModelRun, type HelpNotesResult, type HelpNotesRun } from '../src/main/help/models'
import { buildSystemPrompt, loadPlaybook } from '../src/main/help/prompt'
import { planStillOpen, wrapUserMessage } from '../src/main/help/wrap'
import { WRAPUP_SYSTEM_PROMPT, WrapupKeeper, wrapupUserMessage } from '../src/main/help/wrapup'
import { HelpService } from '../src/main/helpService'
import type { SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, cost_usd: 0.003 }
const CALL_ID = 's-2026-10-06T10-00-00-000Z-plan01'
const ACCOUNT = 'Larkspur Health (invented)'
const PLAN = ['Who signs off on new tools', 'How they score answers today', 'Deep-dive scope']

const notesAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ topic: null, buyer_wants: [], open_questions: [], concerns: [], facts: [], next_steps: [], not_covered: [], ...over })

describe('must-learns from the setup strip', () => {
  it('at most 3, each trimmed and at most 80 characters, repeats and empty ones dropped', () => {
    expect(sanitizeMustLearn(['  Who signs off  on new tools ', '', '   ', 'who signs off on NEW tools?', 'How they score answers today', 'Deep-dive scope', 'A fourth one'])).toEqual(
      ['Who signs off on new tools', 'How they score answers today', 'Deep-dive scope'],
    )
    const long = sanitizeMustLearn(['x'.repeat(300)])
    expect(long[0].length).toBe(MUST_LEARN_MAX_CHARS)
    // Angle brackets would break the prompt's tags.
    expect(sanitizeMustLearn(['<b>Budget</b> owner'])).toEqual(['bBudget/b owner'])
  })

  it("a ';' inside one must-learn can't split it into two in the requests", () => {
    const ml = sanitizeMustLearn(['eval process; who runs it', 'Who signs off | when'])
    expect(ml).toEqual(['eval process, who runs it', 'Who signs off, when'])
    const line = mustLearnLine({ must_learn: ml })
    expect(line).toBe('\nmust learn: eval process, who runs it; Who signs off, when')
    expect(line.split(';')).toHaveLength(2)
    // An answer that copies the item either way still matches Keith's.
    expect(mergePlan(ml, [{ item: 'eval process; who runs it', status: 'done', lines: ['L1'] }], null, new Map([['L1', 't1']]))[0]).toMatchObject({ status: 'done' })
  })

  it('anything that is not a list of strings is no must-learns (older setups, a broken message)', () => {
    for (const raw of [undefined, null, 'Who signs off', 42, { 0: 'x' }]) expect(sanitizeMustLearn(raw)).toEqual([])
    expect(sanitizeMustLearn([7, null, 'Rollout timing', { a: 1 }])).toEqual(['Rollout timing'])
  })
})

describe('the plan from the notes', () => {
  const lineIds = new Map([['L1', 't1'], ['L2', 't2'], ['L3', 't3']])

  it("only Keith's items, in his words and order; done needs a cited line; open cites nothing; left out keeps its last status", () => {
    const previous: PlanItemStatus[] = [{ item: 'Deep-dive scope', status: 'partial', turn_ids: ['t0'] }]
    const plan = mergePlan(PLAN, [
      { item: 'how they score answers TODAY', status: 'done', lines: ['L2', '[L3]'] },
      { item: 'Who signs off on new tools', status: 'done', lines: ['L99'] }, // no line that was sent
      { item: 'Their budget for next year', status: 'done', lines: ['L1'] }, // not Keith's
    ], previous, lineIds)
    expect(plan).toEqual([
      { item: 'Who signs off on new tools', status: 'partial', turn_ids: [] },
      { item: 'How they score answers today', status: 'done', turn_ids: ['t2', 't3'] },
      { item: 'Deep-dive scope', status: 'partial', turn_ids: ['t0'] },
    ])
  })

  it('an unknown status is unclear (partial); open never rests on lines; no answer at all keeps everything as it was', () => {
    expect(mergePlan(['Rollout timing'], [{ item: 'Rollout timing', status: 'mostly', lines: ['L1'] }], null, lineIds)).toEqual([{ item: 'Rollout timing', status: 'partial', turn_ids: ['t1'] }])
    expect(mergePlan(['Rollout timing'], [{ item: 'Rollout timing', status: 'open', lines: ['L1'] }], null, lineIds)).toEqual([{ item: 'Rollout timing', status: 'open', turn_ids: [] }])
    const before: PlanItemStatus[] = [{ item: 'Rollout timing', status: 'done', turn_ids: ['t1'] }]
    expect(mergePlan(['Rollout timing', 'Who signs off'], undefined, before, lineIds)).toEqual([
      { item: 'Rollout timing', status: 'done', turn_ids: ['t1'] },
      { item: 'Who signs off', status: 'open', turn_ids: [] },
    ])
  })

  it("asked is not answered: \"done\" resting only on Keith's or a teammate's lines is partial; their answer settles it", () => {
    const m = new CallMemory('sess-plan')
    m.setLabel({ cluster: 'e1:s1', role: 'teammate', name: 'Sam' })
    m.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana' })
    const turn = (id: string, stream: 'local_mic' | 'system_remote', cluster: string | null) => ({ id, stream, cluster })
    const turns = new Map([
      ['t-keith', turn('t-keith', 'local_mic', null)], ['t-sam', turn('t-sam', 'system_remote', 'e1:s1')],
      ['t-dana', turn('t-dana', 'system_remote', 'e1:s0')], ['t-who', turn('t-who', 'system_remote', 'e1:s9')],
    ])
    const theirs = (id: string) => { const t = turns.get(id); return !!t && m.fromTheirSide(t) }
    const ids = new Map([['L1', 't-keith'], ['L2', 't-sam'], ['L3', 't-dana'], ['L4', 't-who']])
    const done = (lines: string[]) => mergePlan(['Who signs off on new tools'], [{ item: 'Who signs off on new tools', status: 'done', lines }], null, ids, theirs)[0]
    // Keith asked; nobody answered: partial at most, and the line stays for the hover.
    expect(done(['L1'])).toEqual({ item: 'Who signs off on new tools', status: 'partial', turn_ids: ['t-keith'] })
    expect(done(['L2'])).toMatchObject({ status: 'partial' })
    expect(done(['L1', 'L3'])).toEqual({ item: 'Who signs off on new tools', status: 'done', turn_ids: ['t-keith', 't-dana'] })
    // An unlabeled remote speaker is usually theirs.
    expect(done(['L4'])).toMatchObject({ status: 'done' })
    // Through validateNotes, as the keeper calls it.
    const v = validateNotes(notesAnswer({ plan: [{ item: 'Who signs off on new tools', status: 'done', lines: ['L1'] }] }), ids, { mustLearn: ['Who signs off on new tools'], theirs })
    expect(v.ok && v.notes.plan?.[0].status).toBe('partial')
  })

  it('validateNotes carries the plan only when Keith set must-learns, and a broken plan never fails the notes', () => {
    const answer = notesAnswer({ topic: { text: 'Their review process', lines: ['L1'] }, plan: [{ item: 'Deep-dive scope', status: 'done', lines: ['L1'] }] })
    const without = validateNotes(answer, lineIds)
    expect(without.ok && without.notes.plan).toBeUndefined()
    const withPlan = validateNotes(answer, lineIds, { mustLearn: PLAN })
    expect(withPlan.ok && withPlan.notes.plan).toEqual([
      { item: PLAN[0], status: 'open', turn_ids: [] }, { item: PLAN[1], status: 'open', turn_ids: [] }, { item: PLAN[2], status: 'done', turn_ids: ['t1'] },
    ])
    // The MOCK model answers without a plan: the last statuses stand.
    const prev: PlanItemStatus[] = [{ item: PLAN[0], status: 'partial', turn_ids: ['t2'] }]
    const mock = validateNotes(notesAnswer({ plan: 'nonsense' }), lineIds, { mustLearn: [PLAN[0]], previous: prev })
    expect(mock.ok && mock.notes.plan).toEqual(prev)
  })

  it('the next update sees the plan with line ids, like every other note', () => {
    const n: CallNotes = { ...EMPTY_NOTES, plan: [{ item: PLAN[1], status: 'done', turn_ids: ['t2'] }] }
    expect(notesForModel(n, (id) => (id === 't2' ? 'L2' : undefined)).plan).toEqual([{ item: PLAN[1], status: 'done', lines: ['L2'] }])
    expect(notesForModel(EMPTY_NOTES, () => undefined).plan).toEqual([])
  })

  it('planNow follows the must-learns as they are now; planOpen is what the call ended without', () => {
    const plan: PlanItemStatus[] = [{ item: 'Who signs off on new tools', status: 'done', turn_ids: ['t1'] }, { item: 'Removed by Keith', status: 'partial', turn_ids: ['t2'] }]
    expect(planNow(['who signs off on new tools', 'Rollout timing'], plan)).toEqual([
      { item: 'who signs off on new tools', status: 'done', turn_ids: ['t1'] },
      { item: 'Rollout timing', status: 'open', turn_ids: [] },
    ])
    expect(planOpen(PLAN, [{ item: PLAN[0], status: 'partial', turn_ids: ['t1'] }, { item: PLAN[1], status: 'done', turn_ids: ['t2'] }])).toEqual([PLAN[0], PLAN[2]])
    // Older notes have no plan: every must-learn is still to learn.
    expect(planOpen(PLAN, undefined)).toEqual(PLAN)
    expect(planOpen([], undefined)).toEqual([])
  })

  it('the quiet line: ○ open, ◐ partial, ● done, in Keith\'s words, shortened at a word', () => {
    expect(planLineText([
      { item: 'Who signs off', status: 'open', turn_ids: [] },
      { item: 'Eval process', status: 'partial', turn_ids: ['t1'] },
      { item: 'Deep-dive scope and who should join it from their side', status: 'done', turn_ids: ['t2'] },
    ])).toBe('○ Who signs off · ◐ Eval process · ● Deep-dive scope and who…')
    expect(shortItem('Who signs off')).toBe('Who signs off')
  })
})

describe('the notes request', () => {
  it('the schema asks for the plan; the cached system prompt explains it, stays the same for every call and is long enough to cache', () => {
    expect((NOTES_SCHEMA.required as string[])).toContain('plan')
    expect(NOTES_SYSTEM_PROMPT).toMatch(/plan: one entry for each "must learn" item/)
    expect(NOTES_SYSTEM_PROMPT).toMatch(/Asked is not answered: Keith or a teammate asking about it is not the other side answering/)
    expect(NOTES_SYSTEM_PROMPT).toMatch(/Use "done" only when lines where the other side answered settle it, and cite those lines; when in doubt, "partial"/)
    expect(NOTES_SYSTEM_PROMPT).not.toMatch(/Who signs off|Larkspur/)
    // Sonnet caches 512 tokens or more: about 4 characters a token.
    expect(NOTES_SYSTEM_PROMPT.length / 4).toBeGreaterThan(900)
  })
})

describe('HELP sees the must-learns still open', () => {
  const memory = () => {
    const m = new CallMemory('sess-1')
    m.setup = { call_type: 'discovery', call_goal: 'Learn how they review answers', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown', must_learn: PLAN }
    m.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 5000, text: 'Our VP signs off, but procurement has a say.', available_ms: 5000 }, true)
    m.upsertTurn({ id: 't2', stream: 'system_remote', cluster: 'e1:s0', start_ms: 6000, end_ms: 9000, text: 'We score answers with a rubric in a spreadsheet.', available_ms: 9000 }, true)
    return m
  }
  const opts = { ref: () => 'T1', clock: () => '1:00' }

  it('they lead the notes block (partial ones say so, done ones are left out) and the first always fits', () => {
    const big = { ...EMPTY_NOTES, open_questions: Array.from({ length: 6 }, (_, i) => ({ text: `Question ${i} with plenty of words in it to take up the room`, turn_ids: ['t1'] })),
      plan: [{ item: PLAN[0], status: 'partial' as const, turn_ids: ['t1'] }, { item: PLAN[1], status: 'done' as const, turn_ids: ['t2'] }] }
    const block = callNotesBlock({ notes: big, as_of_ms: 10_000 }, 20_000, { ...opts, mustLearn: PLAN })!
    expect(block.split('\n')[1]).toBe(`${PLAN_SECTION_LABEL}: Who signs off on new tools (partly answered) [T1]; Deep-dive scope`)
    expect(block).not.toContain('How they score answers today')
    expect(block.length).toBeLessThanOrEqual(CALL_NOTES_BLOCK_MAX_CHARS + PLAN_BLOCK_MAX_CHARS)
  })

  it("Keith's plan has room of its own: a full set of notes keeps every item it had, and all 3 must-learns fit", () => {
    const it = (text: string) => ({ text, turn_ids: ['t1'] })
    const full: CallNotes = {
      ...EMPTY_NOTES,
      topic: it('How they review chatbot answers before release'),
      open_questions: [it('Do you integrate with their tracing setup, or do they need to change code?'), it('Can it run inside our private cloud on their side?')],
      facts: [
        { kind: 'current_tooling' as const, ...it('They score answers with a rubric in a shared spreadsheet') },
        { kind: 'team' as const, ...it('Four people on the platform team look after the chatbot') },
        { kind: 'timeline' as const, ...it('They want something in place before the spring launch') },
      ],
      concerns: [it('Worried about another tool for the platform team to run'), it('Their security review takes about six weeks')],
      buyer_wants: [it('Catch wrong answers before customers see them')],
      next_steps: [{ status: 'proposed' as const, ...it('A deep-dive with their platform lead next week') }],
      not_covered: ['decision_process'],
    }
    const plan = [
      'Who signs off on new tools and how long procurement usually takes for them',
      'How they score chatbot answers today and who looks at the scores each week',
      'Deep-dive scope: which teams join, and what a good result looks like to them',
    ]
    const snap = { notes: full, as_of_ms: 10_000 }
    const without = callNotesBlock(snap, 20_000, opts)!
    const withPlan = callNotesBlock(snap, 20_000, { ...opts, mustLearn: plan })!
    const lines = withPlan.split('\n')
    expect(lines[1]).toBe(`${PLAN_SECTION_LABEL}: ${sanitizeMustLearn(plan).join('; ')}`)
    // The rest is exactly what HELP got without a plan: the buyer's questions and facts aren't pushed out.
    expect([lines[0], ...lines.slice(2)].join('\n')).toBe(without)
    expect(without).toContain('Can it run inside our private cloud')
    expect(without.length).toBeLessThanOrEqual(CALL_NOTES_BLOCK_MAX_CHARS)
    expect(withPlan.length).toBeLessThanOrEqual(CALL_NOTES_BLOCK_MAX_CHARS + PLAN_BLOCK_MAX_CHARS)
  })

  it('before the first notes (or with notes off) HELP still gets the plan, all open; notes built after the press are not used', () => {
    const block = callNotesBlock(null, 20_000, { ...opts, mustLearn: PLAN })!
    expect(block).toBe(`<call_notes note="no notes yet: only what Keith wants to learn on this call">\n${PLAN_SECTION_LABEL}: ${PLAN.join('; ')}\n</call_notes>`)
    const later = { notes: { ...EMPTY_NOTES, plan: [{ item: PLAN[0], status: 'done' as const, turn_ids: ['t1'] }] }, as_of_ms: 30_000 }
    expect(callNotesBlock(later, 20_000, { ...opts, mustLearn: PLAN })).toContain(PLAN[0])
    // Without must-learns nothing changes.
    expect(callNotesBlock(null, 20_000, opts)).toBeNull()
    expect(callNotesBlock(null, 20_000, { ...opts, mustLearn: [] })).toBeNull()
  })

  it('in the HELP context, from the setup as it is at the press; never in the cached system prompt', () => {
    const m = memory()
    m.callNotes = { notes: { ...EMPTY_NOTES, plan: [{ item: PLAN[1], status: 'done', turn_ids: ['t2'] }] }, as_of_ms: 9000 }
    const ctx = buildHelpContext({ memory: m, kb: null, atMs: 10_000 })
    expect(ctx.text).toContain(`${PLAN_SECTION_LABEL}: Who signs off on new tools; Deep-dive scope`)
    expect(ctx.refs.call_setup?.must_learn).toEqual(PLAN)
    const system = buildSystemPrompt(playbook)
    expect(system).not.toContain('call_notes')
    expect(system).not.toContain('Who signs off')
    // The rule: steer toward one only in a lull or a long tangent, never over what they just raised.
    expect(system).toMatch(/what Keith still wants to learn on this call: his own plan, not something anyone said\. Steer toward one only in a lull or after a long tangent/)
    expect(system).toMatch(/never over a question or concern the other side just raised, and never treat it as answered unless the transcript shows the other side answered it/)
    // An earlier call's "Keith still wanted to learn" is his own plan, never "you mentioned".
    expect(system).toMatch(/A "Keith still wanted to learn" line is his own unmet plan from that call, not anything they said: never say "you mentioned" it/)
  })

  it("an earlier call's \"still wanted to learn\" drops out of HELP's context once this call sets out to learn it again", () => {
    const m = memory()
    const earlier = [
      { kind: 'to_learn' as const, text: 'who signs off on NEW tools?', date: '2026-09-29' },
      { kind: 'to_learn' as const, text: 'Rollout timing', date: '2026-09-29' },
      { kind: 'promised' as const, text: 'Who signs off on new tools', date: '2026-09-29' },
    ]
    m.earlierCalls = earlier
    // Done now: neither the notes block nor the earlier calls bring it back.
    m.callNotes = { notes: { ...EMPTY_NOTES, plan: [{ item: PLAN[0], status: 'done', turn_ids: ['t1'] }] }, as_of_ms: 9000 }
    const ctx = buildHelpContext({ memory: m, kb: null, atMs: 10_000 })
    expect(ctx.text).not.toContain('Keith still wanted to learn: who signs off')
    expect(ctx.text).toContain('Keith still wanted to learn: Rollout timing')
    // Only "to learn" items go; something Arize promised stays whatever its words.
    expect(ctx.text).toContain('Arize promised: Who signs off on new tools')
    expect(ctx.refs.earlier_calls).toEqual([earlier[1], earlier[2]])
    // Must not change: no must-learns now, nothing is dropped.
    expect(notPlannedNow(earlier, { must_learn: [] })).toEqual(earlier)
    expect(notPlannedNow(earlier, null)).toEqual(earlier)
  })

  it('a setup without must-learns builds exactly the context it did before', () => {
    const m = memory()
    m.setup = { ...m.setup, must_learn: undefined }
    expect(buildHelpContext({ memory: m, kb: null, atMs: 10_000 }).text).not.toContain('<call_notes')
  })
})

describe('WRAP with a must-learn still open', () => {
  const ctx = (block: string | null) => `<call_setup>\ntype: discovery\n</call_setup>${block ? `\n\n${block}` : ''}\n\n<last_30_seconds>\n[T1] (9:00) Speaker 0 (unlabeled): We have a hard stop in five.\n</last_30_seconds>`
  const planBlock = `<call_notes note="running summary of the call up to 9:00; may lag; the transcript wins if they disagree">\n${PLAN_SECTION_LABEL}: Who signs off on new tools\nTopic now: Pricing tiers\n</call_notes>`

  it('FOLLOW asks it naturally instead of the recap of what Keith owes them', () => {
    const msg = wrapUserMessage(ctx(planBlock), 'button')
    expect(msg).toContain('- FOLLOW: instead of a recap, one thing Keith still wants to learn (listed first in call_notes) that the transcript does not show they answered')
    // Not one they said they'd come back on, and not at all when they said not now or are mid-thought.
    expect(msg).toContain('that they did not say they would come back to him on, asked as one short natural question in Keith\'s voice')
    expect(msg).toContain('If none is left, or they said not now or not interested, or they are mid-thought: what Keith still owes them')
  })

  it('must not change: no plan, every must-learn done, or closing words on a HELP press', () => {
    const plain = wrapUserMessage(ctx(null), 'button')
    expect(plain).toContain("- FOLLOW: what Keith still owes them from this call, as a short line in Keith's voice")
    expect(plain).not.toContain('Keith still wants to learn')
    const notesOnly = `<call_notes note="running summary">\nTopic now: Pricing tiers\n</call_notes>`
    expect(wrapUserMessage(ctx(notesOnly), 'button')).toBe(wrapUserMessage(ctx(null), 'button').replace(ctx(null), ctx(notesOnly)))
    expect(wrapUserMessage(ctx(planBlock), 'closing')).toContain('- FOLLOW: the next-step question, when the line answers something else; otherwise what Keith still owes them')
  })

  it('with call notes off (or before the first notes) nothing tracked the plan: FOLLOW keeps the recap of what Keith owes', () => {
    const m = new CallMemory('sess-wrap')
    m.setup = { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown', must_learn: [PLAN[0]] }
    m.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 296_000, end_ms: 305_000, text: 'Our VP of engineering, Priya, signs off on anything over fifty thousand.', available_ms: 306_000 }, true)
    m.upsertTurn({ id: 't2', stream: 'system_remote', cluster: 'e1:s0', start_ms: 2_390_000, end_ms: 2_398_000, text: 'This was great, we have a hard stop in a minute.', available_ms: 2_399_000 }, true)
    const ctx = buildHelpContext({ memory: m, kb: null, atMs: 2_400_000 }).text
    // HELP still sees the plan, all open...
    expect(ctx).toContain(`${PLAN_SECTION_LABEL}: ${PLAN[0]}`)
    // ...but WRAP can't tell it's still open (the answer from minute 5 may well be out of the window).
    expect(planStillOpen(ctx)).toBe(false)
    const msg = wrapUserMessage(ctx, 'button')
    expect(msg).toContain("- FOLLOW: what Keith still owes them from this call, as a short line in Keith's voice")
    expect(msg).not.toContain('instead of a recap')
    // A saved WRAP press that did ask it replays asking it (replays have no notes to read it from).
    expect(wrapUserMessage(ctx, 'button', true)).toContain('- FOLLOW: instead of a recap, one thing Keith still wants to learn')
    expect(wrapUserMessage(ctx, 'closing', true)).not.toContain('instead of a recap')
  })

  it("planStillOpen reads only the notes block: the label said in the transcript doesn't count", () => {
    expect(planStillOpen(ctx(planBlock))).toBe(true)
    expect(planStillOpen(ctx(null))).toBe(false)
    const said = `<last_30_seconds>\n${PLAN_SECTION_LABEL}: budget\n</last_30_seconds>`
    expect(planStillOpen(said)).toBe(false)
    expect(planStillOpen(`[T4] (1:00) Keith: ${PLAN_SECTION_LABEL}: budget`)).toBe(false)
  })
})

// ---------------------------------------------------------------- the whole call, through the app

/** A real-looking (non-mock) model whose structured answers wait for the test. */
class Scripted implements HelpModel {
  readonly mock = false
  calls: Array<{ req: HelpNotesRun; kind: 'notes' | 'wrapup'; release: (text: string) => void }> = []
  label() { return 'scripted' }
  async prewarm() {}
  async check() { return { readiness: 'ready' as const } }
  run(_req: HelpModelRun): Promise<HelpModelResult> { throw new Error('not used') }
  notes(req: HelpNotesRun): Promise<HelpNotesResult> {
    const kind = req.system === WRAPUP_SYSTEM_PROMPT ? 'wrapup' : 'notes'
    return new Promise((resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
      this.calls.push({ req, kind, release: (text) => resolve({ text, usage: USAGE, stop_reason: 'end_turn' }) })
    })
  }
  of(kind: 'notes' | 'wrapup') {
    return this.calls.filter((c) => c.kind === kind)
  }
}

function app(model: HelpModel = new Scripted()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'))
  const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
  const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, (e, d) => logs.push({ e, d }))
  help.setSettings({ prefetch: false })
  help.createModel = () => model
  const wraps: Array<CallWrapup | null> = []
  help.onWrapup = (w) => wraps.push(w)
  const panel: Array<CallNotesState | null> = []
  help.onNotes = (s) => panel.push(s)
  let t = 0
  let n = 0
  const state = (st: string, call = CALL_ID) => help.onSessionEvent({ type: 'state', state: st, sessionId: call } as SessionEvent, call, () => t)
  const say = (who: 'buyer' | 'keith', text: string, secs = 5, call = CALL_ID): string => {
    const start = t
    t += secs * 1000
    const turn: Turn = {
      turn_id: `t${++n}`, session_id: call, stream: who === 'keith' ? 'local_mic' : 'system_remote', speaker_cluster: who === 'keith' ? null : 'e1:s0',
      speaker_identity_id: null, speaker_role: 'unknown', start_ms: start, end_ms: t, text, final: true, source_word_ids: [], gap_before: null,
    }
    help.onSessionEvent({ type: 'turn', event: { type: 'turn_final', turn } }, call, () => t)
    return turn.turn_id
  }
  return { help, logs, wraps, panel, state, say, model: model as Scripted }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('a call with a plan, start to finish', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saved with the setup, tracked by the notes, changed mid-call, cleared at Stop, "Still to learn" after, and remembered for next time', async () => {
    const a = app()
    a.help.setSetup({ call_type: 'discovery', call_goal: 'Learn how they review answers', desired_outcomes: [], account: ACCOUNT, deployment: 'self_hosted' })
    expect(a.help.setMustLearn([...PLAN, 'A fourth one']).must_learn).toEqual(PLAN)
    // The strip's other fields save without the must-learns: they stay.
    a.help.setSetup({ call_type: 'discovery', call_goal: 'Learn how they review chatbot answers', desired_outcomes: [], account: ACCOUNT, deployment: 'self_hosted' })
    expect(a.help.info().setup.must_learn).toEqual(PLAN)
    a.state('checking')
    a.state('live')
    const row = () => JSON.parse((a.help.db.sql.prepare('SELECT setup_json FROM sessions WHERE id = ?').get(CALL_ID) as { setup_json: string }).setup_json)
    expect(row().must_learn).toEqual(PLAN)

    a.say('buyer', 'Today we score the answers with a rubric in a shared spreadsheet every week', 21)
    a.say('keith', 'Who would sign off on bringing in a new tool?', 5)
    a.say('buyer', 'Probably our VP of Engineering, though procurement has a say as well', 21)
    a.say('buyer', 'And the platform team would run whatever we pick, so they get a vote too', 21)
    const first = a.model.of('notes')[0]
    expect(first.req.user).toContain('deployment: self-hosted\nmust learn: Who signs off on new tools; How they score answers today; Deep-dive scope\n</call_setup>')
    first.release(notesAnswer({
      topic: { text: 'How they review answers', lines: ['L1'] },
      plan: [
        { item: 'Who signs off on new tools', status: 'done', lines: [] }, // no line cited: only partial
        { item: 'How they score answers today', status: 'done', lines: ['L1'] },
        { item: 'Their budget', status: 'done', lines: ['L3'] }, // not Keith's
      ],
    }))
    await flush()
    const plan = () => a.panel.at(-1)?.notes?.plan?.map((p) => [p.item, p.status])
    expect(plan()).toEqual([['Who signs off on new tools', 'partial'], ['How they score answers today', 'done'], ['Deep-dive scope', 'open']])

    // HELP now: the ones still open lead the notes block.
    const ctx = buildHelpContext({ memory: a.help.memory!, kb: null, atMs: 70_000 })
    expect(ctx.text).toContain(`${PLAN_SECTION_LABEL}: Who signs off on new tools (partly answered); Deep-dive scope`)

    // Mid-call: one removed, one added. The panel shows it straight away; the call's record keeps the latest;
    // a background card built on the old plan is dropped (only when the plan really changed).
    const discard = vi.spyOn(a.help.engine!, 'discardPrefetch')
    a.help.setMustLearn(['Who signs off on new tools', 'How they score answers today', 'Rollout timing'])
    expect(discard).toHaveBeenCalledTimes(1)
    a.help.setMustLearn(['Who signs off on new tools', 'How they score answers today', 'Rollout timing'])
    a.help.setSetup({ call_type: 'discovery', call_goal: 'Learn how they review chatbot answers', desired_outcomes: [], account: ACCOUNT, deployment: 'self_hosted' })
    expect(discard).toHaveBeenCalledTimes(1)
    expect(plan()).toEqual([['Who signs off on new tools', 'partial'], ['How they score answers today', 'done'], ['Rollout timing', 'open']])
    expect(row().must_learn).toEqual(['Who signs off on new tools', 'How they score answers today', 'Rollout timing'])
    // Every one removed: no plan on screen; put back, they read as they did.
    a.help.setMustLearn([])
    expect(a.panel.at(-1)?.notes).toBeTruthy()
    expect(a.panel.at(-1)?.notes?.plan).toBeUndefined()
    a.help.setMustLearn(['Who signs off on new tools', 'How they score answers today', 'Rollout timing'])
    expect(plan()).toEqual([['Who signs off on new tools', 'partial'], ['How they score answers today', 'done'], ['Rollout timing', 'open']])

    a.say('buyer', 'Rollout would be after our Q1 planning, so maybe March.', 6)
    a.state('stopping')
    a.state('stopped')
    // Stop clears them with the rest of the per-call setup.
    expect(a.help.info().setup.must_learn).toBeUndefined()
    // The closing pass: the answer in the last minute settles "Rollout timing" (the other items are left out: they stand).
    const closing = a.model.of('notes')[1]
    expect(closing.req.user).toContain('must learn: Who signs off on new tools; How they score answers today; Rollout timing')
    const rollout = /\[(L\d+)\][^\n]*Rollout would be after our Q1 planning/.exec(closing.req.user)![1]
    // While it runs, the wrap-up already lists what the last update had open.
    expect(a.wraps.at(-1)).toMatchObject({ status: 'building', plan_open: ['Who signs off on new tools', 'Rollout timing'] })
    closing.release(notesAnswer({ topic: { text: 'Rollout timing', lines: [rollout] }, plan: [{ item: 'Rollout timing', status: 'done', lines: [rollout] }] }))
    await flush()
    expect(plan()).toEqual([['Who signs off on new tools', 'partial'], ['How they score answers today', 'done'], ['Rollout timing', 'done']])

    // The wrap-up request carries them; "Still to learn" is what the call ended without, after the closing pass.
    const wr = a.model.of('wrapup')[0]
    expect(wr.req.user).toContain('must learn: Who signs off on new tools; How they score answers today; Rollout timing')
    wr.release(JSON.stringify({ we_owe: [], they_owe: [], agreed: [], proposed: [], open_questions: [] }))
    await flush()
    expect(a.wraps.at(-1)).toMatchObject({ status: 'ready', plan_open: ['Who signs off on new tools'] })

    // Logs carry counts only, never what Keith wanted to learn.
    expect(a.logs.find((l) => l.e === 'call_notes_done' && (l.d as { plan?: unknown }).plan)?.d).toMatchObject({ plan: { open: 1, partial: 1, done: 1 } })
    expect(a.logs.find((l) => l.e === 'wrapup_done')?.d).toMatchObject({ plan_open: 1 })

    // Next time with this account: "Still to learn", and "Reuse last setup" brings it over.
    const mem = accountMemory(a.help.db, 'larkspur health (INVENTED)')!
    expect(mem.items.filter((i) => i.kind === 'to_learn').map((i) => i.text)).toEqual(['Who signs off on new tools'])
    expect(mem.last_setup?.must_learn).toEqual(['Who signs off on new tools'])
    expect(earlierCallsBlock(mem.items.map(({ kind, text, date }) => ({ kind, text, date })))?.text).toMatch(/· Keith still wanted to learn: Who signs off on new tools\n/)

    // Keith knows he got it after all: removed in the wrap-up, nothing is carried.
    expect(a.help.removeWrapupToLearn('Who signs off on new tools').ok).toBe(true)
    expect(a.wraps.at(-1)?.plan_open).toBeUndefined()
    const after = accountMemory(a.help.db, ACCOUNT)!
    expect(after.items.filter((i) => i.kind === 'to_learn')).toEqual([])
    expect(after.last_setup?.must_learn).toBeUndefined()
    expect(a.help.removeWrapupToLearn('Who signs off on new tools').ok).toBe(false)
    expect(JSON.stringify(a.logs)).not.toMatch(/signs off|score answers|Rollout|Deep-dive|Larkspur|budget|fourth/i)
    a.help.shutdown()
  })

  it("the notes keeper never takes Keith's own question as their answer", async () => {
    const a = app()
    a.help.setSetup({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown' })
    a.help.setMustLearn([PLAN[0]])
    a.state('checking')
    a.state('live')
    a.say('buyer', 'Today we score the answers with a rubric in a shared spreadsheet every week', 21)
    a.say('keith', 'Who would sign off on bringing in a new tool like this?', 5)
    a.say('buyer', 'Anyway, the bigger issue is the spreadsheet gets out of date fast', 21)
    a.say('buyer', 'And the platform team keeps asking for a better way to track it', 21)
    const first = a.model.of('notes')[0]
    const keith = /\[(L\d+)\][^\n]*Who would sign off/.exec(first.req.user)![1]
    first.release(notesAnswer({ plan: [{ item: PLAN[0], status: 'done', lines: [keith] }] }))
    await flush()
    expect(a.panel.at(-1)?.notes?.plan?.map((p) => p.status)).toEqual(['partial'])
    a.help.shutdown()
  })

  it('a broken setup message falls back to the default setup and keeps the must-learns set', () => {
    const a = app()
    a.help.setMustLearn(PLAN)
    for (const raw of ['x', 42, null, undefined, true]) expect(a.help.setSetup(raw)).toEqual({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown', must_learn: PLAN })
    expect(a.help.setMustLearn('not a list').must_learn).toBeUndefined()
    a.help.shutdown()
  })

  it('a call with no must-learns works as before: no plan in the notes, no "Still to learn"', async () => {
    const a = app(new MockHelpModel(0))
    a.help.setSetup({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown' })
    a.state('checking')
    a.state('live')
    a.say('buyer', 'We review answers by hand.', 70)
    await flush()
    expect(a.model.mock).toBe(true)
    a.state('stopping')
    a.state('stopped')
    await flush()
    expect(a.help.callNotes()?.notes?.plan).toBeUndefined()
    expect(a.wraps.at(-1)?.status).toBe('ready')
    expect(a.wraps.at(-1)?.plan_open).toBeUndefined()
    a.help.shutdown()
  })
})

describe('after Stop', () => {
  const keeper = (mustLearn: string[] | undefined, notes: CallNotes | null, log: (e: string, d?: Record<string, unknown>) => void = () => {}) => {
    const m = new CallMemory(CALL_ID)
    m.setup = { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown', ...(mustLearn ? { must_learn: mustLearn } : {}) }
    m.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 1000, text: 'Our VP signs off.', available_ms: 1000 }, true)
    if (notes) m.callNotes = { notes, as_of_ms: 0 }
    const w = new WrapupKeeper({ memory: m, model: new MockHelpModel(0), config: { provider: 'mock', model: 'mock', effort: 'low', thinking: 'off', timeout_ms: 1, max_tokens: 1 }, db: null, kb: null, emit: () => {}, log })
    w.begin()
    return w
  }
  const tracked: CallNotes = { ...EMPTY_NOTES, plan: [{ item: PLAN[0], status: 'done', turn_ids: ['t1'] }, { item: PLAN[1], status: 'partial', turn_ids: ['t2'] }] }

  it('the wrap-up keeps open and partial ones; nothing when the notes never tracked them (notes off) or Keith set none', () => {
    expect(keeper(PLAN, tracked).state().plan_open).toEqual([PLAN[1], PLAN[2]])
    // Notes off, or no update since he set them: nothing says they weren't learned, so nothing is claimed or carried.
    expect(keeper(PLAN, EMPTY_NOTES).state().plan_open).toBeUndefined()
    expect(keeper(PLAN, null).state().plan_open).toBeUndefined()
    expect(keeper(undefined, tracked).state().plan_open).toBeUndefined()
  })

  it('Keith can remove a "Still to learn" item; building the wrap-up or Try again does not bring it back', async () => {
    const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
    const w = keeper(PLAN, tracked, (e, d) => logs.push({ e, d }))
    expect(w.removeToLearn('deep-dive SCOPE')).toBe(true)
    expect(w.state().plan_open).toEqual([PLAN[1]])
    await w.build()
    expect(w.state()).toMatchObject({ status: 'ready', plan_open: [PLAN[1]] })
    // Must not match: not listed, not text, or already gone.
    for (const raw of ['Their budget', '', 42, null, { item: PLAN[1] }, 'Deep-dive scope']) expect(w.removeToLearn(raw)).toBe(false)
    expect(w.removeToLearn(PLAN[1])).toBe(true)
    expect(w.state().plan_open).toBeUndefined()
    // Counts and codes only in the log.
    expect(logs.filter((l) => l.e === 'wrapup_item')).toEqual([{ e: 'wrapup_item', d: { action: 'remove', section: 'to_learn' } }, { e: 'wrapup_item', d: { action: 'remove', section: 'to_learn' } }])
    // M4 "Learn next time": one Keith adds is logged the same way (a code, never the text).
    expect(w.addToLearn('Deep-dive scope')).toBe(true)
    expect(logs.filter((l) => l.e === 'wrapup_item').at(-1)).toEqual({ e: 'wrapup_item', d: { action: 'add', section: 'to_learn' } })
    expect(JSON.stringify(logs)).not.toMatch(/score answers|Deep-dive|signs off/i)
  })

  it('the wrap-up request may cite the lines the plan rests on', () => {
    const m = new CallMemory(CALL_ID)
    m.setup = { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown', must_learn: [PLAN[0]] }
    m.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 1000, text: 'Our VP signs off.', available_ms: 1000 }, true)
    const input = wrapupUserMessage(m, { ...EMPTY_NOTES, plan: [{ item: PLAN[0], status: 'done', turn_ids: ['t1'] }] })
    expect(input.user).toContain('must learn: Who signs off on new tools')
    expect(input.user).toContain('"plan":[{"item":"Who signs off on new tools","status":"done","lines":["L1"]}]')
    expect(input.lineIds.get('L1')).toBe('t1')
  })

  describe('account memory', () => {
    const call = (db: Db, id: string, at: string, o: { planOpen?: unknown; mock?: boolean; mustLearn?: string[]; wrapup?: boolean; tracked?: boolean } = {}) => {
      db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run(id, at, JSON.stringify({ call_type: 'discovery', call_goal: `Goal of ${id}`, desired_outcomes: [], account: ACCOUNT, deployment: 'self_hosted', ...(o.mustLearn ? { must_learn: o.mustLearn } : {}) }))
      db.sql.prepare("INSERT INTO turns (session_id, turn_id, stream, start_ms, end_ms, available_ms, text) VALUES (?, 't1', 'system_remote', 0, 1, 1, 'BUYER WORDS')").run(id)
      // The notes tracked every must-learn unless the call had notes off.
      if (o.mustLearn && o.tracked !== false) {
        const plan = o.mustLearn.map((item) => ({ item, status: Array.isArray(o.planOpen) && o.planOpen.includes(item) ? 'open' : 'done', turn_ids: [] }))
        db.sql.prepare("INSERT INTO call_notes (session_id, notes_json, as_of_ms, updated_at, stats_json) VALUES (?, ?, 0, 't', '{}')").run(id, JSON.stringify({ ...EMPTY_NOTES, plan }))
      }
      if (o.wrapup === false) return
      const w = { session_id: id, status: 'ready', account: ACCOUNT, started_at: at, items: [], email: null, error: null, mock: o.mock ?? false, ...(o.planOpen !== undefined ? { plan_open: o.planOpen } : {}) }
      db.sql.prepare('INSERT INTO call_wrapups (session_id, wrapup_json, updated_at) VALUES (?, ?, ?)').run(id, JSON.stringify(w), at)
    }

    it('"Still to learn" from earlier calls; a Practice-mode (MOCK) wrap-up never counts; a newer call that set out to learn it again decides', () => {
      const db = new Db(':memory:')
      call(db, 's-1', '2026-09-01T15:00:00.000Z', { planOpen: ['Who signs off on new tools', 'Rollout timing'], mustLearn: ['Who signs off on new tools', 'Rollout timing'] })
      call(db, 's-2', '2026-09-10T15:00:00.000Z', { planOpen: ['[MOCK] something'], mock: true })
      // The newest call asked about who signs off again and got it: only what it still had open counts.
      call(db, 's-3', '2026-09-20T15:00:00.000Z', { planOpen: ['Eval dataset owner'], mustLearn: ['Who signs off on new tools', 'Eval dataset owner'] })
      const mem = accountMemory(db, ACCOUNT)!
      expect(mem.items.filter((i) => i.kind === 'to_learn').map((i) => [i.text, i.session_id])).toEqual([['Eval dataset owner', 's-3'], ['Rollout timing', 's-1']])
      expect(mem.last_setup?.must_learn).toEqual(['Eval dataset owner'])
      // A saved practice moment keeps them.
      expect(cleanEarlierItems([{ kind: 'to_learn', text: 'Rollout timing', date: '2026-09-01' }])).toEqual([{ kind: 'to_learn', text: 'Rollout timing', date: '2026-09-01' }])
    })

    it("a newer call that can't say how its plan ended (no wrap-up, Practice mode, notes off) doesn't wipe an older \"Still to learn\"", () => {
      for (const newer of [{ wrapup: false }, { mock: true, planOpen: [] }, { tracked: false }] as const) {
        const db = new Db(':memory:')
        call(db, 's-1', '2026-09-01T15:00:00.000Z', { planOpen: ['Who signs off on new tools'], mustLearn: ['Who signs off on new tools'] })
        // Reuse brought it over, and the next call was held without a usable verdict on it.
        call(db, 's-2', '2026-09-10T15:00:00.000Z', { mustLearn: ['Who signs off on new tools'], ...newer })
        const mem = accountMemory(db, ACCOUNT)!
        expect(mem.items.filter((i) => i.kind === 'to_learn').map((i) => [i.text, i.session_id])).toEqual([['Who signs off on new tools', 's-1']])
      }
    })

    it('older wrap-ups (no plan_open) and broken ones add nothing, and Reuse brings no must-learns', () => {
      const db = new Db(':memory:')
      call(db, 's-1', '2026-09-01T15:00:00.000Z', { planOpen: 'not a list' })
      call(db, 's-2', '2026-09-02T15:00:00.000Z')
      const mem = accountMemory(db, ACCOUNT)!
      expect(mem.items.filter((i) => i.kind === 'to_learn')).toEqual([])
      expect(mem.last_setup?.must_learn).toBeUndefined()
    })

    it('the last call held in Practice mode: Reuse brings no must-learns over', () => {
      const db = new Db(':memory:')
      call(db, 's-1', '2026-09-01T15:00:00.000Z', { planOpen: ['Rollout timing'], mock: true })
      expect(accountMemory(db, ACCOUNT)?.last_setup?.must_learn).toBeUndefined()
    })
  })
})
