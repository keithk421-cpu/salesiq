// Account memory ("Last time with <account>"). Every company, name and line here is made up.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CallWrapup, WrapupItem } from '../src/shared/help'
import { Db } from '../src/main/db'
import { EARLIER_CALLS_BLOCK_MAX_CHARS, accountMemory, callDay, earlierCallsBlock, listAccounts } from '../src/main/help/accountMemory'
import { CallMemory } from '../src/main/help/callMemory'
import { buildHelpContext } from '../src/main/help/context'
import { buildPracticeMoment } from '../src/main/help/practice'
import { buildSystemPrompt, loadPlaybook } from '../src/main/help/prompt'
import { replayAt, type Scenario } from '../src/main/help/replay'
import { HelpService } from '../src/main/helpService'
import { deleteCall } from '../src/main/retention'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }

function item(id: string, section: WrapupItem['section'], text: string, state: WrapupItem['state'] = 'pending'): WrapupItem {
  return { id, section, text, who: null, when: null, turn_ids: ['t1'], quote: '', state, added_by_keith: false }
}

/** One saved call: its setup, a transcribed line, and optionally its wrap-up and final notes. */
function call(db: Db, id: string, startedAt: string, account: string, o: { items?: WrapupItem[]; wrapup?: string; status?: CallWrapup['status']; notes?: unknown; heard?: boolean; goal?: string } = {}) {
  const setup = { call_type: 'discovery', call_goal: o.goal ?? `Goal of ${id}`, desired_outcomes: ['Pilot scoped'], account, deployment: 'self_hosted' }
  db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run(id, startedAt, JSON.stringify(setup))
  if (o.heard !== false) db.sql.prepare("INSERT INTO turns (session_id, turn_id, stream, start_ms, end_ms, available_ms, text) VALUES (?, 't1', 'system_remote', 0, 1, 1, 'BUYER WORDS')").run(id)
  if (o.items || o.wrapup !== undefined) {
    const w: CallWrapup = { session_id: id, status: o.status ?? 'ready', account, started_at: startedAt, items: o.items ?? [], email: null, error: null, mock: false }
    db.sql.prepare('INSERT INTO call_wrapups (session_id, wrapup_json, updated_at) VALUES (?, ?, ?)').run(id, o.wrapup ?? JSON.stringify(w), startedAt)
  }
  if (o.notes !== undefined) {
    db.sql.prepare("INSERT INTO call_notes (session_id, notes_json, as_of_ms, updated_at, stats_json) VALUES (?, ?, 0, 't', '{}')").run(id, typeof o.notes === 'string' ? o.notes : JSON.stringify(o.notes))
  }
}

const notes = (wants: string[], facts: Array<[string, string]>) => ({
  topic: null, buyer_wants: wants.map((text) => ({ text, turn_ids: ['t1'] })), open_questions: [], concerns: [],
  facts: facts.map(([kind, text]) => ({ kind, text, turn_ids: ['t1'] })), next_steps: [], not_covered: [],
})

describe('account memory', () => {
  it('lists accounts of held calls grouped however they were typed, newest first, named as last typed', () => {
    const db = new Db(':memory:')
    call(db, 's-a1', '2026-09-01T15:00:00.000Z', 'northwind  traders')
    call(db, 's-b1', '2026-09-10T15:00:00.000Z', 'Fernhollow Bio')
    call(db, 's-a2', '2026-09-20T15:00:00.000Z', ' Northwind Traders ')
    call(db, 's-x', '2026-09-25T15:00:00.000Z', '   ') // no account
    call(db, 's-c', '2026-09-28T15:00:00.000Z', 'Quillmere', { heard: false }) // Start, nothing ever heard
    db.sql.prepare("INSERT INTO sessions (id, started_at, setup_json) VALUES ('s-bad', '2026-09-29T00:00:00.000Z', '{not json')").run()
    db.sql.prepare("INSERT INTO turns (session_id, turn_id, stream, start_ms, end_ms, available_ms, text) VALUES ('s-bad', 't1', 'local_mic', 0, 1, 1, 'x')").run()
    expect(listAccounts(db)).toEqual([
      { account: 'Northwind Traders', calls: 2, last_call_at: '2026-09-20T15:00:00.000Z' },
      { account: 'Fernhollow Bio', calls: 1, last_call_at: '2026-09-10T15:00:00.000Z' },
    ])
    // The call running now is never "last time".
    expect(listAccounts(db, 's-a2')).toEqual([
      { account: 'Fernhollow Bio', calls: 1, last_call_at: '2026-09-10T15:00:00.000Z' },
      { account: 'northwind traders', calls: 1, last_call_at: '2026-09-01T15:00:00.000Z' },
    ])
  })

  it('collects what the last 3 calls left behind, newest first, skipping removed items and unreadable rows', () => {
    const db = new Db(':memory:')
    // Oldest: outside the last 3 calls, so never shown.
    call(db, 's-1', '2026-08-01T15:00:00.000Z', 'Northwind', { items: [item('w1', 'we_owe', 'TOO OLD promise')] })
    call(db, 's-2', '2026-09-01T15:00:00.000Z', 'Northwind', {
      items: [item('w1', 'they_owe', 'Share their eval dataset'), item('w2', 'agreed', 'Security review with their CISO')],
      notes: notes(['Fewer manual trace reviews'], [['current_tooling', 'Use an in-house dashboard today'], ['budget', 'BUDGET FACT']]),
    })
    // A wrap-up that failed, and notes that can't be read: the call still counts.
    call(db, 's-3', '2026-09-15T15:00:00.000Z', 'Northwind', { wrapup: '{"status":"failed"', notes: '{oops' })
    call(db, 's-4', '2026-09-28T15:00:00.000Z', 'NORTHWIND', {
      items: [
        item('w1', 'open_questions', 'Does the self-hosted install support SSO?'),
        item('w2', 'we_owe', 'Send the deployment guide'),
        item('w3', 'proposed', 'A two-week pilot'),
        item('w4', 'we_owe', 'REMOVED promise', 'removed'),
        item('w5', 'agreed', 'security review with their CISO.'), // said again: listed once, from the newest call
      ],
      notes: notes(['Fewer manual trace reviews', 'Catch regressions before release'], [['team', 'Platform team of six'], ['other', 'OTHER FACT']]),
    })
    call(db, 's-other', '2026-09-29T15:00:00.000Z', 'Fernhollow', { items: [item('w1', 'we_owe', 'OTHER ACCOUNT promise')] })
    const m = accountMemory(db, ' northwind ')!
    expect(m).toMatchObject({ account: 'NORTHWIND', calls: 4, last_call_at: '2026-09-28T15:00:00.000Z' })
    expect(m.last_setup).toEqual({ call_type: 'discovery', call_goal: 'Goal of s-4', desired_outcomes: ['Pilot scoped'], account: 'NORTHWIND', deployment: 'self_hosted' })
    const d4 = callDay('2026-09-28T15:00:00.000Z')
    const d2 = callDay('2026-09-01T15:00:00.000Z')
    expect(m.items.map((i) => [i.kind, i.text, i.date, i.session_id])).toEqual([
      ['promised', 'Send the deployment guide', d4, 's-4'],
      ['agreed', 'security review with their CISO.', d4, 's-4'],
      ['open', 'Does the self-hosted install support SSO?', d4, 's-4'],
      ['open', 'A two-week pilot', d4, 's-4'],
      ['wants', 'Fewer manual trace reviews', d4, 's-4'],
      ['wants', 'Catch regressions before release', d4, 's-4'],
      ['fact', 'Platform team of six', d4, 's-4'],
      ['they_owe', 'Share their eval dataset', d2, 's-2'],
      ['fact', 'Use an in-house dashboard today', d2, 's-2'],
    ])
    expect(JSON.stringify(m)).not.toMatch(/TOO OLD|REMOVED|BUDGET|OTHER/)
    // Leaving out the call in progress makes the one before it "last time".
    expect(accountMemory(db, 'Northwind', 's-4')).toMatchObject({ calls: 3, last_call_at: '2026-09-15T15:00:00.000Z' })
    expect(accountMemory(db, 'Quillmere')).toBeNull()
    expect(accountMemory(db, '  ')).toBeNull()
  })

  it('keeps at most 12 items, 3 of what they want and 4 facts', () => {
    const db = new Db(':memory:')
    const many = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
    call(db, 's-1', '2026-09-28T15:00:00.000Z', 'Northwind', {
      items: many(10, (i) => `Promise number ${i}`).map((t, i) => item(`w${i}`, 'we_owe', t)),
      notes: notes(many(5, (i) => `Want ${i}`), many(6, (i) => ['team', `Fact ${i}`] as [string, string])),
    })
    const m = accountMemory(db, 'Northwind')!
    expect(m.items).toHaveLength(12)
    expect(m.items.filter((i) => i.kind === 'wants').map((i) => i.text)).toEqual(['Want 0', 'Want 1'])
    const db2 = new Db(':memory:')
    call(db2, 's-1', '2026-09-28T15:00:00.000Z', 'Northwind', { notes: notes(many(5, (i) => `Want ${i}`), many(6, (i) => ['timeline', `Fact ${i}`] as [string, string])) })
    const m2 = accountMemory(db2, 'Northwind')!
    expect(m2.items.filter((i) => i.kind === 'wants')).toHaveLength(3)
    expect(m2.items.filter((i) => i.kind === 'fact')).toHaveLength(4)
  })

  it('a deleted call drops out of the memory by itself', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-'))
    const db = new Db(':memory:')
    call(db, 's-2026-09-01T15-00-00-000Z-aaaaaa', '2026-09-01T15:00:00.000Z', 'Northwind', { items: [item('w1', 'we_owe', 'Send the pricing sheet')] })
    call(db, 's-2026-09-20T15-00-00-000Z-bbbbbb', '2026-09-20T15:00:00.000Z', 'Northwind', { items: [item('w1', 'they_owe', 'GONE share their architecture diagram')] })
    expect(accountMemory(db, 'Northwind')!.calls).toBe(2)
    expect(deleteCall(root, db, 's-2026-09-20T15-00-00-000Z-bbbbbb')).toBe(true)
    const m = accountMemory(db, 'Northwind')!
    expect(m).toMatchObject({ calls: 1, last_call_at: '2026-09-01T15:00:00.000Z' })
    expect(JSON.stringify(m)).not.toMatch(/GONE/)
    expect(listAccounts(db)).toEqual([{ account: 'Northwind', calls: 1, last_call_at: '2026-09-01T15:00:00.000Z' }])
    deleteCall(root, db, 's-2026-09-01T15-00-00-000Z-aaaaaa')
    expect(accountMemory(db, 'Northwind')).toBeNull()
  })
})

describe('the <earlier_calls> block HELP gets', () => {
  const items = [
    { kind: 'promised' as const, text: 'Send the deployment guide', date: '2026-09-28' },
    { kind: 'open' as const, text: 'Does the self-hosted install support SSO?', date: '2026-09-28' },
    { kind: 'they_owe' as const, text: 'Share their eval dataset', date: '2026-09-01' },
  ]

  it('dated items, newest call first, about 700 characters at most', () => {
    const b = earlierCallsBlock(items)!
    expect(b.text).toBe(
      '<earlier_calls note="what was said on earlier calls with this account; past statements, not current fact">\n' +
        '2026-09-28 · Arize promised: Send the deployment guide\n2026-09-28 · Still open: Does the self-hosted install support SSO?\n' +
        '2026-09-01 · They said they would: Share their eval dataset\n</earlier_calls>',
    )
    expect(b.used).toEqual(items)
    const long = Array.from({ length: 12 }, (_, i) => ({ kind: 'fact' as const, text: `A long fact about their platform team and rollout plan, number ${i}, with more words to fill it up`, date: '2026-09-28' }))
    const capped = earlierCallsBlock(long)!
    expect(capped.text.length).toBeLessThanOrEqual(EARLIER_CALLS_BLOCK_MAX_CHARS)
    expect(capped.used.length).toBeGreaterThan(3)
    expect(capped.used.length).toBeLessThan(12)
    expect(earlierCallsBlock([])).toBeNull()
  })

  it('goes in the user message with the items recorded on the request; nothing without memory', () => {
    const memory = new CallMemory('s-now')
    memory.setup = { call_type: 'follow_up', call_goal: '', desired_outcomes: [], account: 'Northwind', deployment: 'unknown' }
    memory.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 3000, available_ms: 3500, text: 'So where did we land on the pilot?' }, true)
    const none = buildHelpContext({ memory, kb: null, atMs: 5000 })
    expect(none.text).not.toContain('<earlier_calls')
    expect(none.refs.earlier_calls).toBeUndefined()
    memory.earlierCalls = items
    const ctx = buildHelpContext({ memory, kb: null, atMs: 5000 })
    expect(ctx.text).toContain(earlierCallsBlock(items)!.text)
    expect(ctx.refs.earlier_calls).toEqual(items)
  })

  it('the prompt says they are past statements, asked about, never stated as current fact', () => {
    const sys = buildSystemPrompt(loadPlaybook(path.join(ROOT, 'config', 'playbook.json')))
    expect(sys).toMatch(/earlier_calls .*past statements, not current fact/)
    expect(sys).toMatch(/never state it as true today/)
    expect(sys).not.toContain('<earlier_calls')
  })

  it('a practice moment saved from such a press replays the same block; older moments still replay', () => {
    const db = new Db(':memory:')
    db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run('s-now', '2026-10-05T14:00:00.000Z', JSON.stringify({ call_type: 'follow_up', call_goal: '', desired_outcomes: [], account: 'Northwind', deployment: 'unknown' }))
    const memory = new CallMemory('s-now', db)
    memory.setup = { call_type: 'follow_up', call_goal: '', desired_outcomes: [], account: 'Northwind', deployment: 'unknown' }
    memory.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 3000, available_ms: 3500, text: 'So where did we land on the pilot?' }, true)
    memory.earlierCalls = items
    const live = buildHelpContext({ memory, kb: null, atMs: 5000 })
    const card = { move: 'confirm_next_step', primary_kind: 'ask', primary: 'Last time you mentioned SSO, is that still a must?', happening: null, follow_up: null, source_ids: [], note: null }
    db.sql.prepare(
      `INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, context_refs_json, card_json, timing_json, prefetch)
       VALUES ('r1', 's-now', 'help_requested', '2026-10-05T14:00:05.000Z', 5000, 'complete', '{}', ?, ?, '{}', 0)`,
    ).run(JSON.stringify(live.refs), JSON.stringify(card))
    const b = buildPracticeMoment(db, 'r1')
    if (!b.ok) throw new Error(b.reason)
    expect(b.moment.earlier_calls).toEqual(items)
    expect(b.moment.keith_notes).toMatch(/Earlier calls: the 3 item\(s\)/)
    // Through a file, as the speed test reads it.
    const saved = JSON.parse(JSON.stringify(b.moment)) as Scenario
    const r = replayAt(saved)
    const again = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(again.text).toContain(earlierCallsBlock(items)!.text)
    // An older moment (no earlier calls) and a hand-edited one with junk both replay without the block.
    const { earlier_calls: _drop, ...older } = saved
    for (const m of [older as Scenario, { ...saved, earlier_calls: [{ kind: 'nonsense', text: 1 }] } as unknown as Scenario]) {
      const o = replayAt(m)
      expect(buildHelpContext({ memory: o.memory, kb: o.kb, atMs: o.atMs }).text).not.toContain('<earlier_calls')
    }
  })
})

describe('at call start', () => {
  it('HELP gets the account memory without this call; a mid-call account change reloads it; logs carry counts only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amhs-'))
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = []
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, (event, data) => logs.push({ event, data }))
    call(help.db, 's-old', '2026-09-28T15:00:00.000Z', 'Northwind', {
      items: [item('w1', 'we_owe', 'Send the zebrafinch deployment guide')],
      notes: notes(['Quokkaline regression alerts'], [['team', 'Marmoset platform team of six']]),
    })
    call(help.db, 's-fern', '2026-09-29T15:00:00.000Z', 'Fernhollow', { items: [item('w1', 'they_owe', 'Share the pangolin dataset')] })
    help.setSetup({ call_type: 'follow_up', call_goal: '', desired_outcomes: [], account: 'northwind', deployment: 'unknown' })
    help.onSessionEvent({ type: 'state', state: 'checking', sessionId: 's-new' }, 's-new', () => 0)
    // Its first words are saved: the running call still never counts as an earlier one.
    help.db.sql.prepare("INSERT INTO turns (session_id, turn_id, stream, start_ms, end_ms, available_ms, text) VALUES ('s-new', 't1', 'local_mic', 0, 1, 1, 'hi')").run()
    expect(help.memory!.earlierCalls.map((i) => i.text)).toEqual(['Send the zebrafinch deployment guide', 'Quokkaline regression alerts', 'Marmoset platform team of six'])
    help.setSetup({ call_type: 'follow_up', call_goal: 'Pilot plan', desired_outcomes: [], account: 'Fernhollow', deployment: 'unknown' })
    expect(help.memory!.earlierCalls.map((i) => i.text)).toEqual(['Share the pangolin dataset'])
    help.setSetup({ call_type: 'follow_up', call_goal: 'Pilot plan', desired_outcomes: [], account: 'Brand New Co', deployment: 'unknown' })
    expect(help.memory!.earlierCalls).toEqual([])
    const mem = logs.filter((l) => l.event === 'account_memory')
    expect(mem.map((l) => [l.data?.calls, l.data?.items])).toEqual([[1, 3], [1, 1], [0, 0]])
    expect(JSON.stringify(logs)).not.toMatch(/zebrafinch|Quokkaline|Marmoset|pangolin|Northwind|Fernhollow/i)
    help.shutdown()
  })
})
