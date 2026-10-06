// M4 A: must-learn ideas, faster setup (account memory) and "Learn next time". Every company, name and line here is made up.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountMemory, CallNotes, CallWrapup, WrapupItem } from '../src/shared/help'
import { CALL_TYPES, MUST_LEARN_IDEAS_MAX, MUST_LEARN_IDEA_MAX_CHARS } from '../src/shared/help'
import type { Turn } from '../src/shared/contracts'
import { Db } from '../src/main/db'
import { accountMemory, callDay } from '../src/main/help/accountMemory'
import { setAccountNotes } from '../src/main/help/accountNotes'
import { CallMemory } from '../src/main/help/callMemory'
import { EMPTY_NOTES } from '../src/main/help/callNotes'
import { MockHelpModel, type HelpModel, type HelpModelResult, type HelpModelRun, type HelpNotesResult, type HelpNotesRun } from '../src/main/help/models'
import { NOT_COVERED_IDEA, STARTERS, STARTER_MAX_CHARS, ideaDay, mustLearnIdeas, nextCallType, owedTopic } from '../src/main/help/mustLearnIdeas'
import { WRAPUP_SYSTEM_PROMPT, WrapupKeeper } from '../src/main/help/wrapup'
import { HelpService } from '../src/main/helpService'
import type { SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, cost_usd: 0.003 }
const ACCOUNT = 'Thistlewick Robotics (invented)'
const NOW = new Date('2026-10-06T12:00:00')

/** Words a neutral suggestion never uses: no assumed pain, problem, urgency or deadline. */
const NOT_NEUTRAL = /\b(?:pain|problems?|issues?|struggl\w*|challeng\w*|frustrat\w*|broken|fix\w*|urgent\w*|urgency|asap|deadline|hurry|soon|quickly|risk\w*|worr\w*|budget)\b/i

describe('the likely type of the next call', () => {
  it('from the agreed next step: a demo, a technical step or the paperwork; else a follow-up', () => {
    expect(nextCallType(['Demo of the eval workflow for their ML lead next Tuesday'])).toBe('demo')
    expect(nextCallType(['A product demo with their VP on Thursday'])).toBe('demo')
    expect(nextCallType(['Book a demo call for next week'])).toBe('demo')
    expect(nextCallType(['Technical deep-dive next Tuesday at 2'])).toBe('technical_deep_dive')
    expect(nextCallType(['Deep dive on tracing with their platform team'])).toBe('technical_deep_dive')
    expect(nextCallType(['Architecture review with their infra lead'])).toBe('technical_deep_dive')
    expect(nextCallType(['Security review with their CISO'])).toBe('technical_deep_dive')
    expect(nextCallType(['Scope the POC with their data team'])).toBe('technical_deep_dive')
    expect(nextCallType(['A call to agree the pilot scope'])).toBe('technical_deep_dive')
    expect(nextCallType(['Walk through the contract with procurement'])).toBe('negotiation')
    expect(nextCallType(['Send the order form'])).toBe('negotiation')
    expect(nextCallType(['Legal review of the MSA'])).toBe('negotiation')
    // The first agreed step that says something wins.
    expect(nextCallType(['Security review with their CISO', 'A demo for their VP'])).toBe('technical_deep_dive')
    expect(nextCallType(['A demo for their VP', 'Security review with their CISO'])).toBe('demo')
    // Inside one step, the later stage wins.
    expect(nextCallType(['Demo the eval workflow as part of the POC scoping'])).toBe('technical_deep_dive')
    // Their contract with someone else is taken out, Arize's paperwork still counts in the same step.
    expect(nextCallType(['Review their contract redlines'])).toBe('negotiation')
    expect(nextCallType(['Their legal team to review the contract'])).toBe('negotiation')
    expect(nextCallType(['Once their Datadog contract renews, send our order form'])).toBe('negotiation')
    // A demo already held is taken out; a demo still to come counts.
    expect(nextCallType(['Agree the scope of the demo for their VP'])).toBe('demo')
    expect(nextCallType(['Questions from the demo, then a full demo for their VP'])).toBe('demo')
    expect(nextCallType(['Set up the demo call with their team'])).toBe('demo')
  })

  it("must not match: their own demo inside their company, a past demo, a document, a pilot that isn't being scoped", () => {
    for (const t of [
      "They'll demo it to their team internally",
      'Dana will demo Arize to her manager',
      'Their ML lead to demo it for the platform team',
      'An internal demo to their leadership',
      'We demoed tracing on the call',
      'Send the security doc',
      'Share their architecture diagram',
      'Their internal pilot of the chatbot continues',
      'Contractors join the next call',
      'Talk again in two weeks',
      // Their contract with another vendor is not the paperwork with Arize.
      'Reconnect in January after their Datadog contract renews',
      'Revisit once their current contract with Langfuse ends in Q2',
      'Check in when their existing tracing contract is up',
      'Talk again before their renewal in March',
      // A demo already held, or a thing from it.
      'Follow-up call Thursday to answer questions from the demo',
      'Send a recap of the demo and the slides',
      'Keith to send the demo recording',
      'Share the demo deck with their VP',
      '',
    ]) expect(nextCallType([t]), t).toBe('follow_up')
    expect(nextCallType([])).toBe('follow_up')
    expect(nextCallType([42 as unknown as string, null as unknown as string])).toBe('follow_up')
  })
})

describe('starters for the call type', () => {
  it('every call type has some; each at most 28 characters and neutral', () => {
    for (const type of CALL_TYPES) {
      expect(STARTERS[type].length, type).toBeGreaterThan(0)
      for (const s of STARTERS[type]) {
        expect(s.text.length, s.text).toBeLessThanOrEqual(STARTER_MAX_CHARS)
        expect(s.text, s.text).not.toMatch(NOT_NEUTRAL)
      }
    }
    for (const t of Object.values(NOT_COVERED_IDEA)) {
      expect(t.length).toBeLessThanOrEqual(STARTER_MAX_CHARS)
      expect(t).not.toMatch(NOT_NEUTRAL)
    }
  })

  it('a first call: "SaaS or self-hosted" while not sure, then up to 3 starters', () => {
    expect(mustLearnIdeas({ setup: { call_type: 'discovery', deployment: 'unknown' }, memory: null, now: NOW }).map((i) => [i.text, i.source, i.date, i.hint])).toEqual([
      ['SaaS or self-hosted', 'deployment', null, 'Deployment is set to "not sure"'],
      ['what prompted the call', 'starter', null, 'Discovery starter'],
      ['how they test answers today', 'starter', null, 'Discovery starter'],
      ['who signs off', 'starter', null, 'Discovery starter'],
    ])
    // Deployment set: the room goes to the starters, still at most 3 of them.
    expect(mustLearnIdeas({ setup: { call_type: 'discovery', deployment: 'saas' }, memory: null }).map((i) => i.text)).toEqual(['what prompted the call', 'how they test answers today', 'who signs off'])
    expect(mustLearnIdeas({ setup: { call_type: 'other', deployment: 'saas' }, memory: null }).map((i) => i.text)).toEqual(['what they want from today'])
    // Read defensively: no setup, an unknown call type.
    expect(mustLearnIdeas({ setup: null, memory: null }).map((i) => i.source)).toEqual(['deployment', 'starter', 'starter', 'starter'])
    expect(mustLearnIdeas({ setup: { call_type: 'nonsense' as never, deployment: 'saas' }, memory: null })).toHaveLength(3)
  })

  it('skips what is already a must-learn (however it is typed), and one already set makes room for the next', () => {
    const ideas = mustLearnIdeas({ setup: { call_type: 'discovery', deployment: 'saas', must_learn: ['What prompted the call?', 'Who signs off'] }, memory: null })
    expect(ideas.map((i) => i.text)).toEqual(['how they test answers today', 'timeline to decide'])
  })
})

const mem = (o: Partial<AccountMemory> = {}): AccountMemory => ({ account: ACCOUNT, calls: 2, last_call_at: '2026-09-28T15:00:00.000Z', last_setup: null, items: [], ...o })
const it_ = (kind: AccountMemory['items'][number]['kind'], text: string, date = '2026-09-28', extra: Partial<AccountMemory['items'][number]> = {}) => ({ kind, text, date, session_id: 's-1', ...extra })

describe('ideas from the account', () => {
  it('in order: still to learn, what they owe, not covered, confirm, my notes; at most 4, dated, each at most 40 characters', () => {
    const memory = mem({
      items: [
        it_('promised', 'Send the deployment guide'),
        it_('to_learn', 'Who owns the eval dataset'),
        it_('they_owe', 'Dana to share a sample of their eval dataset (Dana, by Friday)'),
        it_('they_owe', 'Loop in their platform lead'),
        it_('they_owe', 'Send over the current rubric', '2026-09-01'),
        it_('fact', 'Use an in-house dashboard today', '2026-09-01', { fact_kind: 'current_tooling' }),
        it_('wants', 'Fewer manual reviews'),
      ],
      last_not_covered: ['timeline'],
    })
    const ideas = mustLearnIdeas({ setup: { call_type: 'follow_up', deployment: 'unknown' }, memory, notesText: 'To learn: eval owner · SaaS or self-hosted', now: NOW })
    expect(ideas.map((i) => [i.text, i.source, i.date])).toEqual([
      ['Who owns the eval dataset', 'still_to_learn', '2026-09-28'],
      ['status of a sample of their eval dataset', 'they_owe', '2026-09-28'],
      // At most two of what they owe, so four chips aren't all the same kind.
      ['status of looping in their platform lead', 'they_owe', '2026-09-28'],
      ['timeline to decide', 'not_covered', callDay('2026-09-28T15:00:00.000Z')],
    ])
    expect(ideas[0].hint).toBe('Still to learn after the Sep 28 call')
    expect(ideas[1].hint).toBe("They said they'd do this on the Sep 28 call: Dana to share a sample of their eval dataset (Dana, by Friday)")
    expect(ideas[3].hint).toBe('Not covered on the Sep 28 call')
    for (const i of ideas) expect(i.text.length).toBeLessThanOrEqual(MUST_LEARN_IDEA_MAX_CHARS)
    expect(ideas).toHaveLength(MUST_LEARN_IDEAS_MAX)
    // With the first ones set as must-learns, the rest come up: confirm, then Keith's own "To learn" lines.
    const later = mustLearnIdeas({
      setup: { call_type: 'follow_up', deployment: 'saas', must_learn: ['who owns the eval dataset', 'status of a sample of their eval dataset', 'Timeline to decide'] },
      memory: mem({ items: memory.items.filter((x) => x.kind !== 'they_owe' || x.text.startsWith('Dana')), last_not_covered: ['timeline'] }),
      notesText: 'Who: Dana, ML lead\nTo learn: eval owner · SaaS or self-hosted [Notion, Oct 2]',
      now: NOW,
    })
    expect(later.map((i) => [i.text, i.source])).toEqual([
      ['Confirm: use an in-house dashboard today', 'confirm'],
      ['eval owner', 'my_notes'],
      ['SaaS or self-hosted', 'my_notes'],
      ['what changed since last call', 'starter'],
    ])
    expect(later[0].hint).toBe('Said on the Sep 1 call, may have changed: Use an in-house dashboard today')
    expect(later[1]).toMatchObject({ date: null, hint: 'From your notes (What I know)' })
  })

  it('a long item is cut at a word; the same idea twice is offered once', () => {
    const ideas = mustLearnIdeas({
      setup: { call_type: 'other', deployment: 'saas' },
      memory: mem({ items: [it_('to_learn', 'How their eval reviewers decide which answers to escalate to the platform team'), it_('to_learn', 'Eval owner', '2026-09-01')] }),
      notesText: 'To learn: eval owner',
    })
    expect(ideas.map((i) => i.text)).toEqual(['How their eval reviewers decide which…', 'Eval owner', 'what they want from today'])
    expect(ideas[0].text.length).toBeLessThanOrEqual(MUST_LEARN_IDEA_MAX_CHARS)
    // A click saves the whole item, never the "…"; one that fits has no second form.
    expect(ideas[0].full).toBe('How their eval reviewers decide which answers to escalate to the platform team')
    expect(ideas[1].full).toBeUndefined()
    // Once set (the whole item), it isn't offered again.
    const after = mustLearnIdeas({
      setup: { call_type: 'other', deployment: 'saas', must_learn: [ideas[0].full!] },
      memory: mem({ items: [it_('to_learn', 'How their eval reviewers decide which answers to escalate to the platform team')] }),
    })
    expect(after.map((i) => i.text)).toEqual(['what they want from today'])
  })

  it('"Confirm:" keeps a name or a product as it was written; a plain first word is lower case', () => {
    const facts = ['Datadog for monitoring today', 'Priya signs off on new tools', 'VP of Engineering signs off', 'Use an in-house dashboard', 'Their CTO decides']
    const ideas = mustLearnIdeas({
      setup: { call_type: 'other', deployment: 'saas' },
      memory: mem({ items: facts.map((t) => it_('fact', t, '2026-09-28', { fact_kind: 'current_tooling' })) }),
    })
    expect(ideas.map((i) => i.text)).toEqual(['Confirm: Datadog for monitoring today', 'Confirm: Priya signs off on new tools', 'what they want from today'])
    const more = mustLearnIdeas({
      setup: { call_type: 'other', deployment: 'saas' },
      memory: mem({ items: facts.slice(2).map((t) => it_('fact', t, '2026-09-28', { fact_kind: 'decision_process' })) }),
    })
    expect(more.map((i) => i.text)).toEqual(['Confirm: VP of Engineering signs off', 'Confirm: use an in-house dashboard', 'what they want from today'])
  })

  it('only decision-process and current-tools facts are offered to confirm', () => {
    const ideas = mustLearnIdeas({
      setup: { call_type: 'other', deployment: 'saas' },
      memory: mem({ items: [
        it_('fact', 'Platform team of six', '2026-09-28', { fact_kind: 'team' }),
        it_('fact', 'Go-live planned for Q1', '2026-09-28', { fact_kind: 'timeline' }),
        it_('fact', 'VP of Engineering signs off', '2026-09-28', { fact_kind: 'decision_process' }),
        it_('fact', 'An older fact with no kind saved'),
      ] }),
    })
    expect(ideas.map((i) => i.text)).toEqual(['Confirm: VP of Engineering signs off', 'what they want from today'])
  })

  it("a topic the last call covered isn't suggested; one it didn't cover isn't offered twice", () => {
    // The last call's notes: only the timeline still not covered. Its starters about tools and sign-off were covered.
    const covered = mustLearnIdeas({ setup: { call_type: 'discovery', deployment: 'saas' }, memory: mem({ last_not_covered: ['timeline'] }) })
    expect(covered.map((i) => i.text)).toEqual(['timeline to decide', 'what prompted the call'])
    // No notes from the last call (or a Practice call): nothing is known to be covered.
    expect(mustLearnIdeas({ setup: { call_type: 'discovery', deployment: 'saas' }, memory: mem() }).map((i) => i.text)).toEqual(['what prompted the call', 'how they test answers today', 'who signs off'])
    // "who signs off and how" (not covered) and the Negotiation starter "who signs and how" are one topic.
    const neg = mustLearnIdeas({ setup: { call_type: 'negotiation', deployment: 'saas' }, memory: mem({ last_not_covered: ['decision_process'] }) })
    expect(neg.map((i) => i.text)).toEqual(['who signs off and how', 'steps left to sign', 'start date they need'])
    // Junk from an older or hand-edited row is ignored.
    expect(mustLearnIdeas({ setup: { call_type: 'other', deployment: 'saas' }, memory: mem({ last_not_covered: ['pain' as never], items: [null as never, { kind: 'to_learn', text: 7 } as never] }) }).map((i) => i.text)).toEqual(['what they want from today'])
  })

  it('what they owed reads as a topic', () => {
    expect(owedTopic('Share their eval dataset (Dana, by Friday)')).toBe('their eval dataset')
    expect(owedTopic("They'll send over the SOC 2 questionnaire.")).toBe('the SOC 2 questionnaire')
    expect(owedTopic('Their platform lead to book a call with our SA')).toBe('booking a call with our SA')
    expect(owedTopic('Eval dataset sample')).toBe('eval dataset sample')
    expect(owedTopic('VP sign-off on the pilot')).toBe('VP sign-off on the pilot')
    // Who goes only when what follows is what to do; an item that starts with what to do stays whole.
    expect(owedTopic('Their CISO to fill in the security questionnaire')).toBe('filling in the security questionnaire')
    expect(owedTopic('Security team to review the DPA')).toBe('reviewing the DPA')
    expect(owedTopic('Dana will intro us to procurement')).toBe('introducing us to procurement')
    expect(owedTopic('Raj will confirm the budget by Q1')).toBe('confirming the budget by Q1')
    // Must not take the first words for a person.
    expect(owedTopic('Introduce Keith to their platform lead (Dana)')).toBe('introducing Keith to their platform lead')
    expect(owedTopic('Speak to legal about the DPA')).toBe('speaking to legal about the DPA')
    expect(owedTopic('Talk to their CISO about SOC 2')).toBe('talking to their CISO about SOC 2')
    expect(owedTopic('Reply to the security questionnaire')).toBe('replying to the security questionnaire')
    expect(owedTopic('Intro to their head of platform')).toBe('intro to their head of platform')
    expect(owedTopic('Approval to start the POC')).toBe('approval to start the POC')
    expect(owedTopic('Budget to be confirmed by Q1')).toBe('budget to be confirmed by Q1')
    // A name or a product keeps its case.
    expect(owedTopic('Datadog access for our SA')).toBe('Datadog access for our SA')
    expect(ideaDay('2026-09-28', NOW)).toBe('Sep 28')
    expect(ideaDay('2025-12-01', NOW)).toBe('Dec 1, 2025')
  })
})

// ---------------------------------------------------------------- account memory: faster setup and ideas

function item(id: string, section: WrapupItem['section'], text: string, state: WrapupItem['state'] = 'pending'): WrapupItem {
  return { id, section, text, who: null, when: null, turn_ids: ['t1'], quote: '', state, added_by_keith: false }
}

/** One saved, held call; optionally its wrap-up and final notes (with the notes' counts). */
function call(db: Db, id: string, at: string, o: { deployment?: string; items?: WrapupItem[]; mock?: boolean; wrapup?: boolean; notes?: Partial<CallNotes>; tokens?: number; planOpen?: string[] } = {}) {
  db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run(id, at, JSON.stringify({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: o.deployment ?? 'unknown' }))
  db.sql.prepare("INSERT INTO turns (session_id, turn_id, stream, start_ms, end_ms, available_ms, text) VALUES (?, 't1', 'system_remote', 0, 1, 1, 'BUYER WORDS')").run(id)
  if (o.notes) db.sql.prepare("INSERT INTO call_notes (session_id, notes_json, as_of_ms, updated_at, stats_json) VALUES (?, ?, 0, 't', ?)").run(id, JSON.stringify({ ...EMPTY_NOTES, ...o.notes }), JSON.stringify({ input_tokens: o.tokens ?? 0 }))
  if (o.wrapup === false) return
  const w: CallWrapup = { session_id: id, status: 'ready', account: ACCOUNT, started_at: at, items: o.items ?? [], email: null, error: null, mock: o.mock ?? false, ...(o.planOpen ? { plan_open: o.planOpen } : {}) }
  db.sql.prepare('INSERT INTO call_wrapups (session_id, wrapup_json, updated_at) VALUES (?, ?, ?)').run(id, JSON.stringify(w), at)
}

describe('account memory for faster setup', () => {
  it('the newest deployment that was set, however far back; the next call type from the newest call; Follow-up by default', () => {
    const db = new Db(':memory:')
    call(db, 's-1', '2026-08-01T15:00:00.000Z', { deployment: 'self_hosted' })
    call(db, 's-2', '2026-09-01T15:00:00.000Z', { deployment: 'saas', items: [item('w1', 'agreed', 'Contract review with procurement')] })
    call(db, 's-3', '2026-09-10T15:00:00.000Z')
    call(db, 's-4', '2026-09-20T15:00:00.000Z')
    call(db, 's-5', '2026-09-28T15:00:00.000Z', { items: [item('w1', 'agreed', 'A demo for their VP', 'removed'), item('w2', 'proposed', 'Security review'), item('w3', 'agreed', 'Technical deep-dive next Tuesday')] })
    const m = accountMemory(db, ACCOUNT)!
    // Outside the last 3 calls still counts for the deployment.
    expect(m.last_deployment).toBe('saas')
    // Removed and only-proposed steps don't count.
    expect(m.next_call_type).toBe('technical_deep_dive')
    expect(accountMemory(db, ACCOUNT, 's-5')!.next_call_type).toBe('follow_up')
    const db2 = new Db(':memory:')
    call(db2, 's-1', '2026-09-28T15:00:00.000Z', { wrapup: false })
    expect(accountMemory(db2, ACCOUNT)).toMatchObject({ next_call_type: 'follow_up' })
    expect(accountMemory(db2, ACCOUNT)!.last_deployment).toBeUndefined()
  })

  it('a Practice-mode (MOCK) wrap-up never sets the next call type, what was not covered, or anything else', () => {
    const db = new Db(':memory:')
    call(db, 's-1', '2026-09-28T15:00:00.000Z', {
      mock: true, items: [item('w1', 'agreed', 'Technical deep-dive next Tuesday')], planOpen: ['[MOCK] something'],
      notes: { not_covered: ['timeline', 'decision_process', 'current_tooling', 'success_criteria'] },
    })
    const m = accountMemory(db, ACCOUNT)!
    expect(m.next_call_type).toBe('follow_up')
    expect(m.last_not_covered).toBeUndefined()
    expect(m.items).toEqual([])
    expect(mustLearnIdeas({ setup: { call_type: 'discovery', deployment: 'saas' }, memory: m }).map((i) => i.source)).toEqual(['starter', 'starter', 'starter'])
  })

  it("what the last call didn't cover: from its final notes, only when they came from Claude", () => {
    const covered = (o: Parameters<typeof call>[3]) => {
      const db = new Db(':memory:')
      call(db, 's-0', '2026-09-01T15:00:00.000Z', { notes: { not_covered: ['success_criteria'] }, tokens: 900 })
      call(db, 's-1', '2026-09-28T15:00:00.000Z', o)
      return accountMemory(db, ACCOUNT)!.last_not_covered
    }
    // A real wrap-up says the call was real.
    expect(covered({ notes: { not_covered: ['timeline', 'timeline', 'nonsense' as never] } })).toEqual(['timeline'])
    expect(covered({ notes: { not_covered: [] } })).toEqual([])
    // A MOCK wrap-up says it was Practice mode.
    expect(covered({ mock: true, notes: { not_covered: ['timeline'] }, tokens: 900 })).toBeUndefined()
    // No wrap-up (the setting off): the notes' counts tell (Practice mode uses no tokens).
    expect(covered({ wrapup: false, notes: { not_covered: ['current_tooling'] }, tokens: 1200 })).toEqual(['current_tooling'])
    expect(covered({ wrapup: false, notes: { not_covered: ['current_tooling'] }, tokens: 0 })).toBeUndefined()
    // No notes on the newest call: nothing, not an older call's.
    expect(covered({})).toBeUndefined()
  })

  it('facts keep what they are about (for "Confirm:")', () => {
    const db = new Db(':memory:')
    call(db, 's-1', '2026-09-28T15:00:00.000Z', { notes: { facts: [{ kind: 'decision_process', text: 'VP of Engineering signs off', turn_ids: ['t1'] }, { kind: 'team', text: 'Platform team of six', turn_ids: ['t1'] }] } })
    expect(accountMemory(db, ACCOUNT)!.items.map((i) => [i.text, i.fact_kind])).toEqual([['VP of Engineering signs off', 'decision_process'], ['Platform team of six', 'team']])
  })
})

// ---------------------------------------------------------------- "Learn next time" in the wrap-up

const CALL_ID = 's-2026-10-06T10-00-00-000Z-learn1'
const PLAN = ['Who signs off on new tools', 'How they score answers today', 'Deep-dive scope']

describe('"Learn next time": WrapupKeeper', () => {
  const keeper = (notes: CallNotes | null, mustLearn = PLAN, log: (e: string, d?: Record<string, unknown>) => void = () => {}) => {
    const m = new CallMemory(CALL_ID)
    m.setup = { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown', must_learn: mustLearn }
    m.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 1000, text: 'Our VP signs off.', available_ms: 1000 }, true)
    if (notes) m.callNotes = { notes, as_of_ms: 0 }
    const w = new WrapupKeeper({ memory: m, model: new MockHelpModel(0), config: { provider: 'mock', model: 'mock', effort: 'low', thinking: 'off', timeout_ms: 1, max_tokens: 1 }, db: null, kb: null, emit: () => {}, log })
    w.begin()
    return w
  }
  const tracked: CallNotes = { ...EMPTY_NOTES, not_covered: ['timeline', 'success_criteria'], plan: [{ item: PLAN[0], status: 'done', turn_ids: ['t1'] }, { item: PLAN[1], status: 'partial', turn_ids: ['t1'] }, { item: PLAN[2], status: 'done', turn_ids: ['t1'] }] }

  it("keeps this call's not-covered topics; Keith adds up to 3 in all; a removed one comes back when added again; kept through the build", async () => {
    const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
    const w = keeper(tracked, PLAN, (e, d) => logs.push({ e, d }))
    expect(w.state()).toMatchObject({ plan_open: [PLAN[1]], not_covered: ['timeline', 'success_criteria'] })
    expect(w.addToLearn('  timeline   to decide ')).toBe(true)
    expect(w.state().plan_open).toEqual([PLAN[1], 'timeline to decide'])
    // Must not add: already listed (however typed), not text, empty.
    for (const raw of ['Timeline to decide!', 'how they SCORE answers today', '', '   ', 42, null, { text: 'x' }]) expect(w.addToLearn(raw), String(raw)).toBe(false)
    expect(w.addToLearn('Eval dataset owner')).toBe(true)
    expect(w.addToLearn('A fourth one')).toBe(false)
    expect(w.state().plan_open).toEqual([PLAN[1], 'timeline to decide', 'Eval dataset owner'])
    // Removed, then added again: back (an open one of the call's, and one he added).
    expect(w.removeToLearn(PLAN[1])).toBe(true)
    expect(w.removeToLearn('Eval dataset owner')).toBe(true)
    expect(w.state().plan_open).toEqual(['timeline to decide'])
    expect(w.addToLearn('eval dataset owner')).toBe(true)
    expect(w.addToLearn(PLAN[1])).toBe(true)
    expect(w.state().plan_open).toEqual([PLAN[1], 'timeline to decide', 'Eval dataset owner'])
    // The build recomputes from the final notes: his additions stay.
    await w.build()
    expect(w.state()).toMatchObject({ status: 'ready', plan_open: [PLAN[1], 'timeline to decide', 'Eval dataset owner'], not_covered: ['timeline', 'success_criteria'] })
    // Logs: codes only.
    expect(logs.filter((l) => l.e === 'wrapup_item').map((l) => l.d)).toEqual([
      { action: 'add', section: 'to_learn' }, { action: 'add', section: 'to_learn' },
      { action: 'remove', section: 'to_learn' }, { action: 'remove', section: 'to_learn' },
      { action: 'add', section: 'to_learn' }, { action: 'add', section: 'to_learn' },
    ])
    expect(JSON.stringify(logs)).not.toMatch(/timeline|eval dataset|score answers|signs off/i)
  })

  it('a removed one frees its place: Keith can add another after removing one of 3 (his own or the call\'s)', () => {
    const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
    // All 3 of the call's must-learns ended open: the list is full until he removes one.
    const allOpen: CallNotes = { ...EMPTY_NOTES, plan: PLAN.map((item) => ({ item, status: 'open' as const, turn_ids: [] })) }
    const w = keeper(allOpen, PLAN, (e, d) => logs.push({ e, d }))
    expect(w.state().plan_open).toEqual(PLAN)
    expect(w.addToLearn('Who runs their evals')).toBe(false)
    expect(w.removeToLearn(PLAN[0])).toBe(true)
    expect(w.addToLearn('Who runs their evals')).toBe(true)
    expect(w.state().plan_open).toEqual([PLAN[1], PLAN[2], 'Who runs their evals'])
    // One he added, then removed, doesn't hold a place either.
    const two = keeper(allOpen, PLAN.slice(0, 2))
    expect(two.state().plan_open).toEqual(PLAN.slice(0, 2))
    expect(two.addToLearn('Timeline to decide')).toBe(true)
    expect(two.removeToLearn('Timeline to decide')).toBe(true)
    expect(two.addToLearn('What good looks like')).toBe(true)
    expect(two.state().plan_open).toEqual([...PLAN.slice(0, 2), 'What good looks like'])
    expect(JSON.stringify(logs)).not.toMatch(/evals|timeline|good looks/i)
  })

  it('works with notes off (nothing tracked) and on older notes without not_covered', () => {
    const w = keeper(null)
    expect(w.state().plan_open).toBeUndefined()
    expect(w.state().not_covered).toBeUndefined()
    expect(w.addToLearn('Who runs their evals')).toBe(true)
    expect(w.state().plan_open).toEqual(['Who runs their evals'])
    const older = keeper({ ...EMPTY_NOTES, not_covered: undefined as never })
    expect(older.state().not_covered).toBeUndefined()
    // A deleted call takes nothing more.
    w.dispose()
    expect(w.addToLearn('Something else')).toBe(false)
  })
})

/** A real-looking (non-mock) model whose structured answers (notes, wrap-up) wait for the test. */
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

function app(model: HelpModel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mli-'))
  const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
  const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, (e, d) => logs.push({ e, d }))
  help.setSettings({ prefetch: false })
  help.createModel = () => model
  const wraps: Array<CallWrapup | null> = []
  help.onWrapup = (w) => wraps.push(w)
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
  return { help, logs, wraps, state, say }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

const notesAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ topic: null, buyer_wants: [], open_questions: [], concerns: [], facts: [], next_steps: [], not_covered: [], ...over })

describe('a call, its wrap-up, and the next call with them', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('what Keith adds to "Learn next time" reaches account memory as still to learn, and the next call\'s ideas and setup', async () => {
    const model = new Scripted()
    const a = app(model)
    a.help.setSetup({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'self_hosted', must_learn: [PLAN[0]] })
    a.state('checking')
    a.state('live')
    a.say('buyer', 'Today we score the answers with a rubric in a shared spreadsheet every week', 21)
    a.say('buyer', 'Our VP of Engineering would sign off on any new tool like this one', 21)
    a.say('buyer', 'Happy to go deeper on tracing with our platform team next Tuesday at two', 21)
    const first = model.of('notes')[0]
    const vp = /\[(L\d+)\][^\n]*VP of Engineering/.exec(first.req.user)![1]
    first.release(notesAnswer({
      facts: [{ kind: 'current_tooling', text: 'Score answers with a rubric in a spreadsheet', lines: ['L1'] }],
      not_covered: ['timeline', 'success_criteria'],
      plan: [{ item: PLAN[0], status: 'done', lines: [vp] }],
    }))
    await flush()
    // While the call runs, the ideas row isn't for this call (the renderer hides it), and the running call is never "last time".
    expect(a.help.mustLearnIdeas().every((i) => i.source !== 'still_to_learn')).toBe(true)
    a.state('stopping')
    a.state('stopped')
    await flush()
    // Nothing new to cover after the last update: the wrap-up request goes straight out.
    const wr = model.of('wrapup')[0]
    const tue = /\[(L\d+)\][^\n]*next Tuesday/.exec(wr.req.user)![1]
    wr.release(JSON.stringify({ we_owe: [], they_owe: [{ text: 'Share their eval rubric', who: null, when: null, lines: [tue] }], agreed: [{ text: 'Deep-dive on tracing next Tuesday at 2', who: null, when: 'next Tuesday at 2', lines: [tue] }], proposed: [], open_questions: [] }))
    await flush()
    expect(a.wraps.at(-1)).toMatchObject({ status: 'ready', not_covered: ['timeline', 'success_criteria'] })
    expect(a.wraps.at(-1)?.plan_open).toBeUndefined()
    // Keith adds one of the topics and one of his own.
    expect(a.help.addWrapupToLearn(NOT_COVERED_IDEA.timeline)).toMatchObject({ ok: true })
    const r = a.help.addWrapupToLearn('Eval dataset owner')
    expect(r.ok).toBe(true)
    expect(r.wrapup?.plan_open).toEqual(['timeline to decide', 'Eval dataset owner'])
    expect(a.help.addWrapupToLearn(42)).toMatchObject({ ok: false })

    // Account memory: still to learn, the deployment, the likely next call, what wasn't covered.
    const m = accountMemory(a.help.db, ACCOUNT)!
    expect(m.items.filter((i) => i.kind === 'to_learn').map((i) => i.text)).toEqual(['timeline to decide', 'Eval dataset owner'])
    expect(m.last_setup?.must_learn).toEqual(['timeline to decide', 'Eval dataset owner'])
    expect(m).toMatchObject({ last_deployment: 'self_hosted', next_call_type: 'technical_deep_dive', last_not_covered: ['timeline', 'success_criteria'] })

    // The next call with them (Stop cleared the strip): typing the account brings the ideas.
    a.help.setSetup({ call_type: 'technical_deep_dive', call_goal: '', desired_outcomes: [], account: ACCOUNT.toUpperCase(), deployment: 'self_hosted' })
    setAccountNotes(a.help.db, ACCOUNT, 'Who: Dana, ML lead\nTo learn: where data must stay')
    const ideas = a.help.mustLearnIdeas()
    expect(ideas.map((i) => [i.text, i.source])).toEqual([
      ['timeline to decide', 'still_to_learn'],
      ['Eval dataset owner', 'still_to_learn'],
      ['status of their eval rubric', 'they_owe'],
      // "what good looks like" (not covered) comes before the fact to confirm and his notes.
      ['what good looks like', 'not_covered'],
    ])
    // Set as must-learns, the rest come up: the fact to confirm, then his notes.
    a.help.setMustLearn(['timeline to decide', 'Eval dataset owner', 'what good looks like'])
    expect(a.help.mustLearnIdeas().map((i) => i.text)).toEqual(['status of their eval rubric', 'Confirm: score answers with a rubric…', 'where data must stay', 'how they send traces today'])
    // The chip is cut; a click saves the whole fact.
    expect(a.help.mustLearnIdeas()[1].full).toBe('Confirm: score answers with a rubric in a spreadsheet')
    // Logs: counts and codes only, never what Keith wanted to learn, the account or the notes.
    expect(JSON.stringify(a.logs)).not.toMatch(/timeline to decide|Eval dataset|rubric|Thistlewick|Dana|data must stay|good looks/i)
    a.help.shutdown()
  })

  it('a Practice-mode (MOCK) call: "Learn next time" works on screen, and still never feeds account memory', async () => {
    const a = app(new MockHelpModel(0))
    a.help.setSetup({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown' })
    a.state('checking')
    a.state('live')
    a.say('buyer', 'We review answers by hand.', 70)
    await flush()
    a.state('stopping')
    a.state('stopped')
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(a.wraps.at(-1)).toMatchObject({ status: 'ready', mock: true, not_covered: ['timeline', 'decision_process', 'current_tooling', 'success_criteria'] })
    expect(a.help.addWrapupToLearn('Eval dataset owner').ok).toBe(true)
    const m = accountMemory(a.help.db, ACCOUNT)!
    expect(m.items).toEqual([])
    expect(m.last_setup?.must_learn).toBeUndefined()
    expect(m.last_not_covered).toBeUndefined()
    expect(m.next_call_type).toBe('follow_up')
    a.help.setSetup({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: ACCOUNT, deployment: 'unknown' })
    expect(a.help.mustLearnIdeas().map((i) => i.source)).toEqual(['deployment', 'starter', 'starter', 'starter'])
    a.help.shutdown()
  })
})
