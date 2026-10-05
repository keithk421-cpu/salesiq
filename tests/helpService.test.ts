import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/main/db'
import { buildScorecard } from '../src/main/help/scorecard'
import { HelpService } from '../src/main/helpService'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }

function req(db: Db, id: string, o: { prefetch?: boolean; served?: boolean; status?: string; usable?: number | null; cost?: number; code?: string | null; checks?: number; session?: string }) {
  db.sql.prepare(
    `INSERT INTO help_requests (id, session_id, origin, created_at, status, model_json, request_text, card_json, timing_json, usage_json, prefetch)
     VALUES (?, ?, 'help_requested', 't', ?, '{}', 'BUYER WORDS', '{"primary":"CARD WORDS"}', ?, ?, ?)`,
  ).run(
    id, o.session ?? 's1', o.status ?? 'complete',
    JSON.stringify({ served_from_prefetch: !!o.served, first_usable_ms: o.usable ?? null, error_code: o.code ?? null, checks: o.checks ?? 0 }),
    JSON.stringify({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cost_usd: o.cost ?? 0.01 }),
    o.prefetch ? 1 : 0,
  )
}

describe('HELP scorecard', () => {
  it('counts presses, speed, background cost and feedback per card; no conversation text', () => {
    const db = new Db(':memory:')
    req(db, 'a', { usable: 800 })
    req(db, 'b', { usable: 1200, checks: 1 })
    req(db, 'c', { status: 'failed', code: 'rate_limited' })
    req(db, 'd', { prefetch: true, served: true, usable: 0 })
    req(db, 'e', { prefetch: true, served: false, cost: 0.02 })
    req(db, 'other-call', { session: 's2' })
    const fb = db.sql.prepare("INSERT INTO feedback (card_id, origin, type, bad_reason, note, ts) VALUES (?, 'help_requested', ?, ?, ?, 't')")
    fb.run('a', 'useful', null, null)
    fb.run('b', 'bad', null, null)
    fb.run('b', 'bad', 'too_generic', 'NOTE WORDS')
    fb.run('d', 'bad', null, null)
    fb.run('d', 'useful', null, null) // changed his mind
    const s = buildScorecard(db, 's1', 30 * 60_000, new Date('2026-10-05T12:00:00Z'))
    expect(s).toMatchObject({
      call_minutes: 30, shown: 4, complete: 3, failed: 1, from_prefetch: 1, cards_with_checks: 1,
      first_usable_ms: { median: 800, p95: 1200 },
      prefetch: { started: 2, used: 1, unused: 1, unused_cost_usd: 0.02 },
      cost_usd: 0.06, tokens: { input: 500, output: 50, cache_read: 250 },
      feedback: { useful: 2, should_have_stayed_quiet: 0, bad: 1, bad_reasons: { too_generic: 1 } },
      errors: { rate_limited: 1 },
    })
    expect(JSON.stringify(s)).not.toMatch(/BUYER|CARD|NOTE/)
  })

  it('Stop writes the scorecard and clears who the call was with, keeping the call type', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    help.setSetup({ call_type: 'demo', call_goal: 'Show tracing', desired_outcomes: ['next step'], account: 'Northwind', deployment: 'saas' })
    let t = 0
    const clock = () => t // the session's clock, as the app passes it
    help.onSessionEvent({ type: 'state', state: 'checking', sessionId: 's-1' }, 's-1', clock)
    help.onSessionEvent({ type: 'state', state: 'live', sessionId: 's-1' }, 's-1', clock)
    // Mid-call edit is kept on the call's record.
    help.setSetup({ call_type: 'demo', call_goal: 'Show tracing', desired_outcomes: [], account: 'Northwind Health', deployment: 'self_hosted' })
    t = 60_000
    help.onSessionEvent({ type: 'state', state: 'stopping', sessionId: 's-1' }, 's-1', clock)
    help.onSessionEvent({ type: 'state', state: 'stopped', sessionId: 's-1' }, 's-1', clock)
    expect(help.info().setup).toEqual({ call_type: 'demo', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' })
    const rec = help.db.sql.prepare('SELECT setup_json FROM sessions WHERE id = ?').get('s-1') as { setup_json: string }
    expect(JSON.parse(rec.setup_json)).toMatchObject({ account: 'Northwind Health', deployment: 'self_hosted' })
    const card = JSON.parse(fs.readFileSync(path.join(dir, 'reports', 'help-scorecard-s-1.json'), 'utf8'))
    expect(card).toMatchObject({ kind: 'help_scorecard', session_id: 's-1', call_minutes: 1, shown: 0 })
    help.shutdown()
  })
})

describe('playbook choice', () => {
  const built = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'playbook.json'), 'utf8')) as { version: string }

  it("uses Keith's edited copy, reports a broken edit plainly, and offers a different built-in version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    expect(help.playbookInfo).toMatchObject({ using: 'built_in', version: built.version, problem: null, newer_built_in: false })
    // "Edit sales playbook" makes his copy; same version, nothing to decide.
    const mine = help.playbookPath()
    expect(help.reloadPlaybook()).toMatchObject({ using: 'yours', newer_built_in: false })
    // A typo: HELP falls back to the built-in one and says why.
    fs.writeFileSync(mine, '{ "version": "mine-1", ')
    expect(help.reloadPlaybook()).toMatchObject({ using: 'built_in', problem: expect.stringMatching(/isn't valid JSON/) })
    fs.writeFileSync(mine, JSON.stringify({ ...built, version: 'mine-1', principles: 'be nice' }))
    expect(help.reloadPlaybook().problem).toBe('"principles" must be a list of sentences')
    // His copy is from an older build: offer the shipped one; "Keep mine" stops asking for this version.
    fs.writeFileSync(mine, JSON.stringify({ ...built, version: 'older-draft' }))
    expect(help.reloadPlaybook()).toMatchObject({ using: 'yours', version: 'older-draft', newer_built_in: true })
    expect(help.keepMyPlaybook()).toMatchObject({ using: 'yours', newer_built_in: false })
    // "Use the new one" keeps a dated backup of his copy.
    expect(help.useBuiltInPlaybook(new Date('2026-10-05T12:00:00Z'))).toMatchObject({ using: 'built_in', version: built.version })
    expect(fs.existsSync(path.join(dir, 'playbook-yours-2026-10-05-12-00-00.json'))).toBe(true)
    help.shutdown()
  })
})

describe('after-call review', () => {
  it("lists the call's cards with Keith's latest rating, whether he used the line, and his note", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    help.onSessionEvent({ type: 'state', state: 'checking', sessionId: 's-9' }, 's-9', () => 0)
    const ins = help.db.sql.prepare(
      "INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, card_json, timing_json, prefetch) VALUES (?, 's-9', 'help_requested', 't', ?, 'complete', '{}', ?, '{}', 0)",
    )
    ins.run('c2', 90_000, JSON.stringify({ primary_kind: 'say', primary: 'Second line', follow_up: null }))
    ins.run('c1', 30_000, JSON.stringify({ primary_kind: 'ask', primary: 'First line?', follow_up: 'Then this' }))
    // A background candidate never shown has no card and is not listed.
    help.db.sql.prepare("INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, prefetch) VALUES ('p1', 's-9', 'help_requested', 't', 60000, 'complete', '{}', 1)").run()
    for (const fb of [
      { card_id: 'c1', type: 'bad' }, { card_id: 'c1', type: 'useful' }, { card_id: 'c1', type: 'used' }, { card_id: 'c1', type: 'note', note: 'Good, but slower please' },
      { card_id: 'c2', type: 'used' }, { card_id: 'c2', type: 'unused' }, { card_id: 'c2', type: 'bad', bad_reason: 'too_generic' },
    ]) expect(help.feedback(fb).ok).toBe(true)
    expect(help.feedback({ card_id: 'c1', type: 'something_else' }).ok).toBe(false)
    expect(help.callCards()).toEqual([
      { id: 'c1', at_session_ms: 30_000, status: 'complete', primary_kind: 'ask', primary: 'First line?', follow_up: 'Then this', rating: 'useful', bad_reason: null, used: true, note: 'Good, but slower please' },
      { id: 'c2', at_session_ms: 90_000, status: 'complete', primary_kind: 'say', primary: 'Second line', follow_up: null, rating: 'bad', bad_reason: 'too_generic', used: false, note: null },
    ])
    expect(buildScorecard(help.db, 's-9', 60_000).feedback).toEqual({ useful: 1, should_have_stayed_quiet: 0, bad: 1, bad_reasons: { too_generic: 1 }, used: 1, notes: 1 })
    help.shutdown()
  })
})
