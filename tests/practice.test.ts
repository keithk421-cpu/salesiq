// Practice moments saved from a real call. Every name, company and line here is made up.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/main/db'
import { KnowledgeBase, docMetaFrom, parseFrontMatter } from '../src/main/knowledge'
import { CallMemory } from '../src/main/help/callMemory'
import { buildHelpContext } from '../src/main/help/context'
import { benchmark, moveOk, reportMarkdown, runScenario, toBaseline } from '../src/main/help/evalRunner'
import { DEFAULT_HELP_CONFIG, MockHelpModel } from '../src/main/help/models'
import { loadPlaybook } from '../src/main/help/prompt'
import { buildPracticeMoment, expectedFrom, loadPracticeMoments, readSessionGaps, refreshFeedback, savePracticeMoment } from '../src/main/help/practice'
import { loadScenario, replayAt, type Scenario } from '../src/main/help/replay'
import { HelpService } from '../src/main/helpService'
import { Storage } from '../src/main/storage'
import { saveSupportFiles } from '../src/main/support'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const REQ = 'a1b2c3d4-5e6f-4a1b-9c2d-0123456789ab'
const PRESSED = '2026-10-05T14:32:10.000Z'

const SSO_DOC = `---
title: SSO FAQ (illustrative fixture, not verified)
category: deployment_security
vendor: arize
source: Security answers (test fixture)
version: 2026-09
review_by: 2027-03-01
applies_to: saas
---
## Single sign-on

Single sign-on works with Okta through SAML in the hosted product.

Source: Security answers, SSO section (test fixture).
`

const SETUP = { call_type: 'technical_deep_dive', call_goal: 'Confirm SSO and the pilot owner', desired_outcomes: ['SSO requirement captured'], account: 'Bluefin Logistics', deployment: 'saas' }
/** Refs a request from an older build has: no call setup or labels recorded with it. */
const OLDER = { call_setup: undefined, labels: undefined }

/**
 * One made-up call: four lines HELP could see at the press (the last still being spoken), one it
 * couldn't. The request records the setup and labels it was built with, as live requests do now.
 */
function seedCall(db: Db, refs: Record<string, unknown> = {}, feedback: Array<[string, string | null, string | null]> = [['useful', null, null], ['used', null, null], ['note', null, 'Good line, I said it almost word for word']]) {
  const kb = new KnowledgeBase(db, null)
  const { meta, body } = parseFrontMatter(SSO_DOC)
  const doc = docMetaFrom('/k/sso-faq.md', meta, body)
  kb.addDoc(doc, body)
  kb.approve(doc.doc_id, true)
  db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run('s-1', '2026-10-05T14:00:00.000Z', JSON.stringify(SETUP))
  const turn = db.sql.prepare('INSERT INTO turns (session_id, turn_id, stream, cluster, start_ms, end_ms, available_ms, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  turn.run('s-1', 't1', 'local_mic', null, 0, 4000, 5000, 'So walk me through how releases get checked today.')
  turn.run('s-1', 't2', 'system_remote', 'e1:s0', 5000, 15000, 15500, 'We run a weekly review of sampled traces with the platform team.')
  turn.run('s-1', 't3', 'system_remote', 'e1:s1', 16000, 24000, 24200, 'Our security team needs single sign-on with Okta before any pilot.')
  // Still being spoken at the press (25 s): its first words were on screen, the rest came later.
  turn.run('s-1', 't4', 'system_remote', 'e1:s0', 24200, 27200, 24800, 'And honestly the budget sits with the platform group not my team')
  // Said after the press: HELP never saw it.
  turn.run('s-1', 't5', 'system_remote', 'e1:s1', 25300, 28000, 28500, 'SECRET LATER WORDS about the renewal date')
  const label = db.sql.prepare('INSERT INTO speaker_labels (session_id, cluster, role, name, updated_at) VALUES (?, ?, ?, ?, ?)')
  label.run('s-1', 'e1:s0', 'buyer', 'Dana Reyes (Head of ML Platform)', '2026-10-05T14:31:00.000Z')
  label.run('s-1', 'e1:s1', 'teammate', 'Sam Okafor', '2026-10-05T14:40:00.000Z') // tagged after the press
  const card = { move: 'clarify_requirement', primary_kind: 'ask', primary: 'Which identity provider setup does security need to sign off on?', happening: null, follow_up: 'Who on security owns that review?', source_ids: ['T3'], note: null }
  db.sql.prepare(
    `INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, context_refs_json, card_json, timing_json, prefetch)
     VALUES (?, 's-1', 'help_requested', ?, 25000, 'complete', ?, ?, ?, '{}', 0)`,
  ).run(
    REQ, PRESSED, JSON.stringify({ model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', playbook: 'pb-test' }),
    JSON.stringify({
      at_session_ms: 25000, hot_turn_ids: ['t3', 't4'], knowledge_chunk_ids: ['k:sso-faq#1'], knowledge_hashes: [kb.getDoc('sso-faq')!.content_hash], provisional_text: true,
      call_setup: SETUP, labels: [{ cluster: 'e1:s0', role: 'buyer', name: 'Dana Reyes (Head of ML Platform)' }], ...refs,
    }),
    JSON.stringify(card),
  )
  const fb = db.sql.prepare("INSERT INTO feedback (card_id, origin, type, bad_reason, note, ts) VALUES (?, 'help_requested', ?, ?, ?, 't')")
  for (const [type, reason, note] of feedback) fb.run(REQ, type, reason, note)
  return kb
}

function build(db: Db, gaps = () => [] as ReturnType<typeof readSessionGaps>): Scenario {
  const b = buildPracticeMoment(db, REQ, { gaps })
  if (!b.ok) throw new Error(b.reason)
  return b.moment
}

describe('practice moment from a real call', () => {
  it('keeps only what HELP could see at the press, labels as they were, the call setup and the knowledge it used', async () => {
    const db = new Db(':memory:')
    seedCall(db)
    const m = build(db)
    expect(m).toMatchObject({
      category: 'real_call', synthetic: false, source: 'real_call', golden_approved: false, request_id: REQ, help_at_s: 25,
      call_type: 'technical_deep_dive', call_goal: 'Confirm SSO and the pilot owner', desired_outcomes: ['SSO requirement captured'], account: 'Bluefin Logistics', deployment: 'saas',
    })
    expect(m.title).toMatch(/^Bluefin Logistics · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(m.id).toBe('real-20261005143210-a1b2c3d4')
    // Time-honest: the line said after the press is not in the file at all, and the line still being
    // spoken stops at the press.
    expect(m.transcript.map((l) => [l.who, l.text])).toEqual([
      ['keith', 'So walk me through how releases get checked today.'],
      ['e1:s0', 'We run a weekly review of sampled traces with the platform team.'],
      ['e1:s1', 'Our security team needs single sign-on with Okta before any pilot.'],
      ['e1:s0', 'And honestly the'],
    ])
    expect(JSON.stringify(m)).not.toMatch(/SECRET|renewal|budget sits/)
    // Labels set after the press are not used; that speaker is just unlabeled.
    expect(m.speakers).toEqual({ 'e1:s0': { role: 'buyer', name: 'Dana Reyes (Head of ML Platform)' }, 'e1:s1': { role: 'unknown', name: null } })
    // The approved section HELP used, copied in with its source, version and scope; no review date.
    expect(m.knowledge).toEqual([{
      id: 'sso-faq-1', title: 'SSO FAQ (illustrative fixture, not verified)', category: 'deployment_security', vendor: 'arize', source: 'Security answers (test fixture)', version: '2026-09',
      approved: true, applies_to: ['saas'],
      text: '## Single sign-on\n\nSingle sign-on works with Okta through SAML in the hosted product.\n\nSource: Security answers, SSO section (test fixture).',
    }])
    // Replays with every saved line visible, as the live request saw them, with the same setup and knowledge.
    const r = replayAt(m)
    expect(r.hiddenLineIndexes).toEqual([])
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toContain('account: Bluefin Logistics')
    expect(ctx.text).toContain("deployment: Arize's SaaS")
    expect(ctx.text).toContain('Dana Reyes (Head of ML Platform) (buyer): We run a weekly review')
    expect(ctx.text).not.toContain('Sam Okafor')
    expect(ctx.text).toMatch(/\[K1\] SSO FAQ \(illustrative fixture, not verified\) - Single sign-on \(about: Arize; applies to: Arize's SaaS; version 2026-09\): Single sign-on works with Okta/)
    // What HELP said and what Keith thought of it.
    expect(m.observed).toEqual({
      move: 'clarify_requirement', primary_kind: 'ask', primary: 'Which identity provider setup does security need to sign off on?', follow_up: 'Who on security owns that review?',
      model: 'Claude Sonnet 5.5', rating: 'useful', bad_reasons: [], used: true, note: 'Good line, I said it almost word for word',
    })
    expect(m.best_moves).toEqual([])
    expect(m.acceptable_moves).toEqual(['clarify_requirement'])
    expect(m.unacceptable_moves).toBeUndefined()
    expect(m.keith_notes).toMatch(/Keith's feedback: Useful; used the line; note: "Good line/)
    expect(m.keith_notes).toMatch(/only "clarify_requirement" is marked acceptable, because Keith rated the card Useful and used the line/)
    expect(m.keith_notes).toMatch(/1 line\(s\) still being spoken at the press are cut/)
    expect(m.keith_notes).toMatch(/Words still being transcribed at the press aren't saved/)
    expect(m.keith_notes).toMatch(/HELP's context was built at 0:25 into the call, when Keith pressed HELP/)
    expect(m.keith_notes).not.toMatch(/call setup is the call's latest|left unlabeled/)
    // Level 1 runs on it like any scenario.
    const res = await runScenario(m, new MockHelpModel(0), DEFAULT_HELP_CONFIG, playbook)
    expect(res.status).toBe('complete')
    expect(res.level1).toEqual({ pass: true, failures: [] })
    // Keith only said the call's move was fine; a different move isn't judged either way.
    expect(res.move_ok).toBeNull()
    expect(moveOk(m, 'clarify_requirement')).toBe(true)
  })

  it('gaps from the call: those that had started by the press, never when a still-open one closed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'))
    const file = path.join(dir, 'transcript.jsonl')
    const rec = (o: Record<string, unknown>) => JSON.stringify({ at: 'x', ...o })
    fs.writeFileSync(file, [
      rec({ kind: 'turn', text: 'not a gap' }),
      rec({ kind: 'gap_open', gap_id: 'g1', stream: 'system_remote', cause: 'provider_disconnect', start_ms: 8000, end_ms: null }),
      rec({ kind: 'gap_close', gap_id: 'g1', stream: 'system_remote', cause: 'provider_disconnect', start_ms: 8000, end_ms: 9500 }),
      rec({ kind: 'gap_open', gap_id: 'g2', stream: 'local_mic', cause: 'device_lost', start_ms: 24500, end_ms: null }),
      rec({ kind: 'gap_close', gap_id: 'g2', stream: 'local_mic', cause: 'device_lost', start_ms: 24500, end_ms: 40000 }),
      rec({ kind: 'gap_close', gap_id: 'g3', stream: 'system_remote', cause: 'pause', start_ms: 1000, end_ms: 2000 }),
      rec({ kind: 'gap_close', gap_id: 'g4', stream: 'system_remote', cause: 'provider_disconnect', start_ms: 26000, end_ms: 27000 }),
      '{"torn',
    ].join('\n'))
    const db = new Db(':memory:')
    seedCall(db)
    const m = build(db, () => readSessionGaps(file))
    expect(m.gaps).toEqual([
      { start: 8, end: 9.5, stream: 'system_remote', cause: 'provider_disconnect' },
      { start: 24.5, end: 26, stream: 'local_mic', cause: 'device_lost' },
    ])
    expect(JSON.stringify(m.gaps)).not.toContain('40')
    const r = replayAt(m)
    expect(buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs }).warnings.join(' ')).toMatch(/Gap 0:24–now \(Keith's mic\)/)
  })

  it("keeps the setup and labels the request used, even when they're edited later in the call", () => {
    // Keith set the deployment and named the buyer, HELP was pressed, then he changed both.
    const later = (db: Db) => {
      db.sql.prepare('UPDATE sessions SET setup_json = ?').run(JSON.stringify({ ...SETUP, account: 'Bluefin Logistics Group', deployment: 'self_hosted' }))
      db.sql.prepare("UPDATE speaker_labels SET name = 'Dana Reyes (VP Platform)', updated_at = '2026-10-05T14:45:00.000Z' WHERE cluster = 'e1:s0'").run()
    }
    const db = new Db(':memory:')
    seedCall(db)
    later(db)
    const m = build(db)
    expect(m).toMatchObject({ account: 'Bluefin Logistics', deployment: 'saas' })
    expect(m.title).toMatch(/^Bluefin Logistics · /)
    expect(m.speakers['e1:s0']).toEqual({ role: 'buyer', name: 'Dana Reyes (Head of ML Platform)' })
    // So it replays as the live request did: the SaaS-only section is still offered as [K1].
    const r = replayAt(m)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toContain("deployment: Arize's SaaS")
    expect(ctx.text).toMatch(/\[K1\] SSO FAQ/)
    expect(ctx.text).not.toContain('<other_deployment>')
    expect(ctx.text).toContain('Dana Reyes (Head of ML Platform) (buyer)')

    // Older rows didn't record them: the call's latest setup, and labels changed since are dropped, both noted.
    const older = new Db(':memory:')
    seedCall(older, OLDER)
    later(older)
    const o = build(older)
    expect(o).toMatchObject({ account: 'Bluefin Logistics Group', deployment: 'self_hosted' })
    expect(o.keith_notes).toMatch(/The call setup is the call's latest .*: it may have changed after this press\./)
    expect(o.speakers).toEqual({ 'e1:s0': { role: 'unknown', name: null }, 'e1:s1': { role: 'unknown', name: null } })
    expect(o.keith_notes).toMatch(/2 speaker label\(s\) were set or changed after this press and are left unlabeled/)
  })

  it('knowledge edited or removed since the call is left out and said so; older rows without a check keep it with a note', () => {
    const edited = new Db(':memory:')
    seedCall(edited, { knowledge_hashes: ['hash-of-an-earlier-version'] })
    const a = build(edited)
    expect(a.knowledge).toEqual([])
    expect(a.keith_notes).toMatch(/1 knowledge section\(s\) HELP used were edited since the call and are left out/)

    const gone = new Db(':memory:')
    seedCall(gone, { knowledge_chunk_ids: ['k:retired-doc#1'], knowledge_hashes: ['x'] })
    expect(build(gone).keith_notes).toMatch(/1 knowledge section\(s\) HELP used are no longer in the knowledge folder/)

    const older = new Db(':memory:')
    seedCall(older, { knowledge_hashes: undefined })
    const c = build(older)
    expect(c.knowledge).toHaveLength(1)
    expect(c.keith_notes).toMatch(/older version of the app: the knowledge copied in couldn't be checked/)
  })

  it('knowledge Keith revoked since the call is left out (revoking always wins, even in practice)', () => {
    for (const refs of [{}, { knowledge_hashes: undefined }]) {
      const db = new Db(':memory:')
      const kb = seedCall(db, refs)
      kb.approve('sso-faq', false)
      const m = build(db)
      expect(m.knowledge).toEqual([])
      expect(m.keith_notes).toMatch(/1 knowledge section\(s\) HELP used are no longer approved and are left out/)
      const r = replayAt(m)
      expect(buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs }).text).not.toContain('Okta through SAML')
    }
  })

  it('a card prepared in the background says when its context was built', () => {
    const db = new Db(':memory:')
    seedCall(db)
    db.sql.prepare('UPDATE help_requests SET timing_json = ?').run(JSON.stringify({ served_from_prefetch: true, first_usable_ms: 0 }))
    expect(build(db).keith_notes).toMatch(/HELP's card was prepared at 0:25 into the call and shown when Keith pressed HELP shortly after/)
  })

  it('live requests record which version of each knowledge section they used, and the setup and labels then', () => {
    const db = new Db(':memory:')
    const kb = seedCall(db)
    const memory = new CallMemory('live', null)
    memory.setup = { ...SETUP, call_type: 'technical_deep_dive', deployment: 'saas', desired_outcomes: [...SETUP.desired_outcomes] }
    memory.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana Reyes' })
    memory.upsertTurn({ id: 'x1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 4000, text: 'Does single sign-on work with Okta?', available_ms: 4500 }, true)
    const ctx = buildHelpContext({ memory, kb, atMs: 6000 })
    expect(ctx.refs.knowledge_chunk_ids).toEqual(['k:sso-faq#1'])
    expect(ctx.refs.knowledge_hashes).toEqual([kb.getDoc('sso-faq')!.content_hash])
    expect(ctx.refs.call_setup).toEqual(SETUP)
    expect(ctx.refs.labels).toEqual([{ cluster: 'e1:s0', role: 'buyer', name: 'Dana Reyes' }])
    // A copy: editing the setup or a label later in the call doesn't change what this request recorded.
    memory.setup.desired_outcomes.push('pilot owner named')
    memory.setup.deployment = 'self_hosted'
    memory.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana Reyes (VP)' })
    expect(ctx.refs.call_setup).toEqual(SETUP)
    expect(ctx.refs.labels).toEqual([{ cluster: 'e1:s0', role: 'buyer', name: 'Dana Reyes' }])
  })

  it("expected moves come only from Keith's feedback, conservatively", () => {
    const f = (rating: string | null, reasons: string[] = [], used = false) => ({ rating, reasons: new Set(reasons), used })
    expect(expectedFrom('explore_process', f('useful'))).toMatchObject({ acceptable: ['explore_process'], unacceptable: [] })
    expect(expectedFrom('explore_process', f(null, [], true))).toMatchObject({ acceptable: ['explore_process'], unacceptable: [] })
    expect(expectedFrom('explore_process', f('bad', ['wrong_move']))).toMatchObject({ acceptable: [], unacceptable: ['explore_process'] })
    expect(expectedFrom('explore_process', f('bad', ['wrong_move'], true))).toMatchObject({ acceptable: [], unacceptable: [], why: expect.stringMatching(/mixed feedback/) })
    for (const other of [f('bad', ['too_generic']), f('should_have_stayed_quiet'), f(null), undefined]) {
      expect(expectedFrom('explore_process', other)).toMatchObject({ acceptable: [], unacceptable: [], why: expect.stringMatching(/none derived/) })
    }

    const db = new Db(':memory:')
    seedCall(db, {}, [['bad', null, null], ['bad', 'wrong_move', null]])
    const m = build(db)
    expect(m).toMatchObject({ acceptable_moves: [], unacceptable_moves: ['clarify_requirement'], unacceptable_behaviors: [expect.stringMatching(/clarify_requirement.*Bad: wrong move/)] })
    expect(m.observed).toMatchObject({ rating: 'bad', bad_reasons: ['wrong_move'], used: false })
    // The Level 3 signal: the move Keith called wrong disagrees; with nothing expected, nothing is judged.
    expect(moveOk(m, 'clarify_requirement')).toBe(false)
    expect(moveOk(m, 'explore_process')).toBeNull()
    expect(moveOk({ ...m, unacceptable_moves: undefined }, 'clarify_requirement')).toBeNull()
    // Once Keith adds best moves to his copy, other moves are judged like a built-in scenario.
    expect(moveOk({ ...m, best_moves: ['identify_owner'] }, 'explore_process')).toBe(false)
    expect(moveOk({ ...m, best_moves: ['identify_owner'] }, 'identify_owner')).toBe(true)
    const builtIn = loadScenario(path.join(ROOT, 'evals', 'scenarios', 'help', 'answered-01-volume-fully-answered.json'))
    expect(moveOk(builtIn, 'handle_objection')).toBe(false)
    expect(moveOk(builtIn, 'explore_process')).toBe(true)
  })

  it('a card that is gone, or has no line, is not saved', () => {
    const db = new Db(':memory:')
    expect(buildPracticeMoment(db, 'nope')).toEqual({ ok: false, reason: "That card isn't saved any more." })
    seedCall(db)
    db.sql.prepare('UPDATE help_requests SET card_json = NULL').run()
    expect(buildPracticeMoment(db, REQ)).toEqual({ ok: false, reason: 'This card has no line to practice on.' })
  })
})

describe('saving practice moments', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.SALES_COPILOT_ANTHROPIC_KEY
    delete process.env.SALES_COPILOT_ANTHROPIC_KEY // the speed test below must use the offline mock
  })
  afterEach(() => {
    if (saved !== undefined) process.env.SALES_COPILOT_ANTHROPIC_KEY = saved
  })

  it('goes to practice/ in the data folder; the same card twice says it is already saved and never replaces the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    seedCall(help.db)
    fs.mkdirSync(path.join(dir, 'sessions', 's-1'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sessions', 's-1', 'transcript.jsonl'), JSON.stringify({ kind: 'gap_close', gap_id: 'g', stream: 'system_remote', cause: 'provider_disconnect', start_ms: 8000, end_ms: 9000 }) + '\n')
    expect(help.practiceInfo()).toEqual({ count: 0, saved: [] })
    const first = help.saveMoment(REQ)
    expect(first).toMatchObject({ ok: true, already: false, title: expect.stringMatching(/^Bluefin Logistics · /) })
    const files = fs.readdirSync(path.join(dir, 'practice'))
    expect(files).toEqual(['real-20261005143210-a1b2c3d4.json'])
    const file = path.join(dir, 'practice', files[0])
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).gaps).toEqual([{ start: 8, end: 9, stream: 'system_remote', cause: 'provider_disconnect' }])
    // Keith edits his copy (adds a best move); saving the card again keeps his edit.
    const edited = { ...JSON.parse(fs.readFileSync(file, 'utf8')), best_moves: ['identify_owner'] }
    fs.writeFileSync(file, JSON.stringify(edited))
    expect(help.saveMoment(REQ)).toMatchObject({ ok: true, already: true, updated: true })
    expect(savePracticeMoment(help.practiceDir, build(help.db)).already).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).best_moves).toEqual(['identify_owner'])
    expect(fs.readdirSync(path.join(dir, 'practice'))).toHaveLength(1)
    expect(help.practiceInfo()).toEqual({ count: 1, saved: [REQ] })
    // Renamed by Keith: still recognized as this card.
    fs.renameSync(file, path.join(dir, 'practice', 'sso-question.json'))
    expect(savePracticeMoment(help.practiceDir, build(help.db))).toEqual({ already: true, file: path.join(dir, 'practice', 'sso-question.json') })
    expect(fs.readdirSync(path.join(dir, 'practice'))).toEqual(['sso-question.json'])
    // A file already at that name (whatever is in it) is never replaced.
    fs.writeFileSync(file, '{"id": "hand-written"}')
    expect(savePracticeMoment(help.practiceDir, { ...build(help.db), request_id: 'another-card' })).toEqual({ already: true, file })
    expect(fs.readFileSync(file, 'utf8')).toBe('{"id": "hand-written"}')
    expect(help.saveMoment(42)).toEqual({ ok: false, reason: 'Invalid card' })
    help.shutdown()
  })

  it('saved before rating: saving again (or rating a saved card) writes in only what the feedback decides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    seedCall(help.db, {}, [])
    expect(help.saveMoment(REQ)).toMatchObject({ ok: true, already: false })
    const file = path.join(help.practiceDir, 'real-20261005143210-a1b2c3d4.json')
    const first = JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario
    expect(first.observed).toMatchObject({ rating: null, used: false, note: null })
    expect(first.acceptable_moves).toEqual([])
    expect(first.keith_notes).toMatch(/Keith's feedback: not rated\./)
    // Keith adds his own judgement to the file.
    fs.writeFileSync(file, JSON.stringify({
      ...first, best_moves: ['identify_owner'], acceptable_moves: ['explore_process'], unacceptable_behaviors: ['Re-asks who owns security'],
      keith_notes: `${first.keith_notes}\nMy note: they had already named the security owner.`,
    }))
    // Then rates it Bad: wrong move, and the review saves it again.
    const fb = help.db.sql.prepare("INSERT INTO feedback (card_id, origin, type, bad_reason, note, ts) VALUES (?, 'help_requested', ?, ?, ?, 't')")
    fb.run(REQ, 'bad', 'wrong_move', null)
    fb.run(REQ, 'note', null, 'Should have asked who signs off')
    expect(help.saveMoment(REQ)).toMatchObject({ ok: true, already: true, updated: true })
    const a = JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario
    expect(a.observed).toMatchObject({ rating: 'bad', bad_reasons: ['wrong_move'], note: 'Should have asked who signs off' })
    expect(a.unacceptable_moves).toEqual(['clarify_requirement'])
    expect(a.best_moves).toEqual(['identify_owner'])
    expect(a.acceptable_moves).toEqual(['explore_process'])
    expect(a.unacceptable_behaviors).toEqual(['Re-asks who owns security', expect.stringMatching(/^Picks the move HELP gave on the call \(clarify_requirement\)/)])
    expect(a.keith_notes).toMatch(/Keith's feedback: Bad \(wrong move\); note: "Should have asked who signs off"\./)
    expect(a.keith_notes).toMatch(/Expected moves: "clarify_requirement" is marked wrong/)
    expect(a.keith_notes).toMatch(/My note: they had already named the security owner\./)
    expect(a.keith_notes).not.toMatch(/not rated|none derived/)
    // Everything else as first saved.
    expect({ ...a, observed: null, acceptable_moves: null, unacceptable_moves: null, unacceptable_behaviors: null, keith_notes: null, best_moves: null })
      .toEqual({ ...first, observed: null, acceptable_moves: null, unacceptable_moves: null, unacceptable_behaviors: null, keith_notes: null, best_moves: null })
    // Changes his mind: Useful. The wrong-move entries go, his own stay.
    fb.run(REQ, 'useful', null, null)
    help.saveMoment(REQ)
    const b = JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario
    expect(b.unacceptable_moves).toBeUndefined()
    expect(b.acceptable_moves).toEqual(['explore_process', 'clarify_requirement'])
    expect(b.unacceptable_behaviors).toEqual(['Re-asks who owns security'])
    expect(b.keith_notes!.split('\n').filter((l) => /^Keith's feedback|^Expected moves/.test(l))).toHaveLength(2)
    expect(fs.readdirSync(help.practiceDir)).toEqual(['real-20261005143210-a1b2c3d4.json'])
    // A moment whose card is gone (call deleted) is left as it is.
    help.db.sql.prepare('DELETE FROM help_requests').run()
    expect(help.saveMoment(REQ)).toEqual({ ok: true, already: true })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(b)
    help.shutdown()
  })

  it('refreshing a hand-written moment without notes or lists still works', () => {
    const db = new Db(':memory:')
    seedCall(db)
    const fresh = build(db)
    const bare = { ...fresh, keith_notes: undefined, acceptable_moves: 'oops', unacceptable_behaviors: undefined } as unknown as Scenario
    const r = refreshFeedback(bare, fresh)
    expect(r.acceptable_moves).toEqual(['clarify_requirement'])
    expect(r.unacceptable_behaviors).toEqual([])
    expect(r.keith_notes!.split('\n')).toEqual([expect.stringMatching(/^Keith's feedback: Useful/), expect.stringMatching(/^Expected moves:/)])
  })

  it('loading skips broken files and never treats a moment as approved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'))
    const db = new Db(':memory:')
    seedCall(db)
    const m = build(db)
    savePracticeMoment(dir, { ...m, golden_approved: true })
    fs.writeFileSync(path.join(dir, 'half-copied.json'), '{"id": "x", "transcr')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a moment')
    // Valid JSON that replay would trip on: a line without text, a knowledge entry without text, gaps not a list.
    const put = (name: string, x: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(x))
    put('no-text.json', { ...m, id: 'no-text', request_id: 'r2', transcript: [{ t: 1, who: 'e1:s0' }] })
    put('no-time.json', { ...m, id: 'no-time', request_id: 'r3', transcript: [{ who: 'keith', text: 'Hi' }] })
    put('bad-knowledge.json', { ...m, id: 'bad-knowledge', request_id: 'r4', knowledge: [{ id: 'k', title: 'K' }] })
    put('bad-gaps.json', { ...m, id: 'bad-gaps', request_id: 'r5', gaps: 'none' })
    const r = loadPracticeMoments(dir)
    expect(r.skipped).toBe(5)
    expect(r.moments.map((m) => [m.id, m.golden_approved])).toEqual([['real-20261005143210-a1b2c3d4', false]])
    expect(loadPracticeMoments(path.join(dir, 'missing'))).toEqual({ moments: [], skipped: 0 })
  })

  it('the speed test replays saved moments alongside the built-in ones and reports them apart', async () => {
    const db = new Db(':memory:')
    seedCall(db)
    const mine = build(db)
    const builtIn = loadScenario(path.join(ROOT, 'evals', 'scenarios', 'help', 'answered-01-volume-fully-answered.json'))
    const report = await benchmark({ scenarios: [builtIn], mine: [mine], model: new MockHelpModel(0), configs: [DEFAULT_HELP_CONFIG], playbook, repeats: 1 })
    expect(report.results.map((r) => r.scenario_id)).toEqual([builtIn.id])
    expect(report.summaries[0].runs).toBe(1)
    expect(report.mine?.results.map((r) => r.scenario_id)).toEqual([mine.id])
    expect(report.mine?.summaries[0].runs).toBe(1)
    expect(Object.keys(toBaseline(report).models[DEFAULT_HELP_CONFIG.model].scenarios)).toEqual([builtIn.id])
    const md = reportMarkdown(report)
    expect(md).toMatch(/Plus 1 of your saved moments, reported separately/)
    expect(md).toMatch(/## Your saved moments \(1, from real calls\)/)
    expect(md).toMatch(/never part of the numbers above/)
    expect(md).toMatch(/\| Bluefin Logistics · [\d-]+ [\d:]+ \| claude-sonnet-5-5 \| [\d.]+ s \| pass \| clarify_current_state \| clarify_requirement \| not judged \|/)
    // A run without them has no such section.
    expect(reportMarkdown(await benchmark({ scenarios: [builtIn], model: new MockHelpModel(0), configs: [DEFAULT_HELP_CONFIG], playbook, repeats: 1 }))).not.toMatch(/saved moments/)
  })

  it("one of Keith's moments that can't be replayed is reported as failed; the built-in results still come out", async () => {
    const db = new Db(':memory:')
    seedCall(db)
    const good = build(db)
    const broken = { ...good, id: 'broken', transcript: [{ t: 1, who: 'e1:s0' }] } as unknown as Scenario
    const builtIn = loadScenario(path.join(ROOT, 'evals', 'scenarios', 'help', 'answered-01-volume-fully-answered.json'))
    const report = await benchmark({ scenarios: [builtIn], mine: [broken, good], model: new MockHelpModel(0), configs: [DEFAULT_HELP_CONFIG], playbook, repeats: 1 })
    expect(report.results.map((r) => [r.scenario_id, r.status])).toEqual([[builtIn.id, 'complete']])
    expect(report.mine?.results.map((r) => [r.scenario_id, r.status])).toEqual([['broken', 'failed'], [good.id, 'complete']])
    expect(report.mine?.results[0].level1).toEqual({ pass: false, failures: [expect.stringMatching(/^could not replay: /)] })
    expect(reportMarkdown(report)).toMatch(/could not replay/)
  })

  it('in the app: the box adds them, the report goes to reports/mine/ as "-mine", and Save support files leaves it and practice/ behind', async () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'))
    fs.cpSync(path.join(ROOT, 'config'), path.join(app, 'config'), { recursive: true })
    fs.mkdirSync(path.join(app, 'evals', 'scenarios', 'help'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'evals', 'scenarios', 'help', 'answered-01-volume-fully-answered.json'), path.join(app, 'evals', 'scenarios', 'help', 'a.json'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
    const help = new HelpService(new Storage(dir, plainBox), app, () => {}, () => {})
    seedCall(help.db)
    expect(help.saveMoment(REQ).ok).toBe(true)
    const opts = { repeats: 1, models: ['claude-sonnet-5-5'] }
    const plain = await help.runBenchmark(opts, () => {})
    expect(plain.reportFile).toMatch(/help-benchmark-[\dTZ-]+-MOCK\.json$/)
    expect(plain.markdown).not.toMatch(/saved moments/)
    const progress: string[] = []
    const withMine = await help.runBenchmark({ ...opts, includeMine: true }, (p) => progress.push(`${p.done}/${p.total}`))
    expect(progress).toEqual(['1/2', '2/2'])
    // In reports/mine/: Save support files only reads files directly in reports/.
    expect(path.relative(dir, withMine.reportFile!).split(path.sep).join('/')).toMatch(/^reports\/mine\/help-benchmark-[\dTZ-]+-MOCK-mine\.json$/)
    expect(fs.existsSync(withMine.reportFile!.replace(/\.json$/, '.md'))).toBe(true)
    expect(withMine.markdown).toMatch(/## Your saved moments \(1, from real calls\)/)
    expect(fs.readFileSync(withMine.reportFile!, 'utf8')).toContain('Bluefin Logistics')
    const out = saveSupportFiles(dir, fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')))
    const names = out.files.map((f) => f.split(path.sep).join('/'))
    expect(names).toContain(`reports/${path.basename(plain.reportFile!)}`)
    expect(names.filter((f) => /-mine|practice/.test(f))).toEqual([])
    const copied = fs.readdirSync(out.dir, { recursive: true }).map((f) => path.join(out.dir, String(f))).filter((f) => fs.statSync(f).isFile())
    for (const f of copied) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/Bluefin|single sign-on with Okta/)
    help.shutdown()
  })

  it('a speed test that fails says so instead of leaving the button stuck', async () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'))
    fs.cpSync(path.join(ROOT, 'config'), path.join(app, 'config'), { recursive: true })
    fs.mkdirSync(path.join(app, 'evals', 'scenarios', 'help'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'evals', 'scenarios', 'help', 'answered-01-volume-fully-answered.json'), path.join(app, 'evals', 'scenarios', 'help', 'a.json'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
    const logs: Array<[string, Record<string, unknown> | undefined]> = []
    const help = new HelpService(new Storage(dir, plainBox), app, () => {}, (e, d) => logs.push([e, d]))
    fs.writeFileSync(path.join(dir, 'reports'), 'a file where the reports folder should be')
    const r = await help.runBenchmark({ repeats: 1, models: ['claude-sonnet-5-5'] }, () => {})
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/^The speed test stopped \(.+\)\. Try again, or send me the support files\.$/) })
    expect(logs.find(([e]) => e === 'help_benchmark_failed')?.[1]).toEqual({ code: expect.any(String) })
    // Not stuck "already running".
    expect((await help.runBenchmark({ repeats: 1, models: ['claude-sonnet-5-5'] }, () => {})).reason).not.toMatch(/already running/)
    help.shutdown()
  })
})

describe('a practice moment from a WRAP press', () => {
  it('remembers the WRAP and replays with the same wrap instruction', async () => {
    const db = new Db(':memory:')
    seedCall(db)
    db.sql.prepare(`UPDATE help_requests SET origin = 'wrap_requested', timing_json = '{"wrap":"button"}' WHERE id = ?`).run(REQ)
    const m = build(db)
    expect(m.wrap).toBe('button')
    expect(m.keith_notes).toMatch(/when Keith pressed WRAP/)
    // Replay sends the wrap instruction (stored, not detected again).
    class Capturing extends MockHelpModel {
      users: string[] = []
      override run(req: Parameters<MockHelpModel['run']>[0]) {
        this.users.push(req.user)
        return super.run(req)
      }
    }
    const model = new Capturing(0)
    const res = await runScenario(m, model, DEFAULT_HELP_CONFIG, playbook)
    expect(res.status).toBe('complete')
    expect(model.users[0]).toContain('<wrap_card>')
    expect(model.users[0]).toContain('Keith pressed WRAP')
    // A plain HELP moment replays without it.
    db.sql.prepare(`UPDATE help_requests SET origin = 'help_requested', timing_json = '{}' WHERE id = ?`).run(REQ)
    const plain = build(db)
    expect(plain.wrap).toBeUndefined()
    const model2 = new Capturing(0)
    await runScenario(plain, model2, DEFAULT_HELP_CONFIG, playbook)
    expect(model2.users[0]).not.toContain('<wrap_card>')
    // Re-saving keeps it.
    expect(refreshFeedback(plain, m).wrap).toBe('button')
  })
})
