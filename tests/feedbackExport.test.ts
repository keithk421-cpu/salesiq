// "Export HELP feedback". Every name, company and line here is made up.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/main/db'
import { collectFeedbackCalls, exportFileName, feedbackMarkdown, periodSince, type ExportCall } from '../src/main/help/feedbackExport'
import { HelpService } from '../src/main/helpService'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const NOW = new Date('2026-10-05T18:00:00.000Z')

function seed(db: Db): void {
  const session = db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)')
  session.run('s-new', '2026-10-05T14:00:00.000Z', JSON.stringify({ call_type: 'discovery', account: 'Bluefin Logistics', deployment: 'self_hosted', call_goal: '', desired_outcomes: [] }))
  session.run('s-old', '2026-09-20T15:00:00.000Z', JSON.stringify({ call_type: 'follow_up', account: '', deployment: 'unknown', call_goal: '', desired_outcomes: [] }))
  const req = db.sql.prepare(
    `INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, card_json, timing_json, usage_json, prefetch)
     VALUES (?, ?, 'help_requested', 't', ?, ?, ?, ?, ?, ?, ?)`,
  )
  const model = JSON.stringify({ model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', playbook: 'pb-7' })
  const card = (move: string, kind: string, primary: string, follow: string | null) => JSON.stringify({ move, primary_kind: kind, primary, follow_up: follow, happening: null, source_ids: [], note: null })
  const timing = (usable: number | null, served = false) => JSON.stringify({ first_usable_ms: usable, served_from_prefetch: served, error_code: null, checks: 0 })
  const usage = (cost: number) => JSON.stringify({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: cost })
  req.run('n1', 's-new', 754_000, 'complete', model, card('explore_process', 'ask', 'How does the weekly review decide what gets fixed?', 'Who joins that review?'), timing(1400), usage(0.01), 0)
  req.run('n2', 's-new', 1_260_000, 'complete', model, card('clarify_scale', 'ask', 'Roughly how many conversations a day?', null), timing(0, true), usage(0.02), 1)
  req.run('n3', 's-new', 1_500_000, 'complete', model, card('confirm_next_step', 'say', "Let's book the security review for Thursday.", null), timing(2200), usage(0.01), 0)
  req.run('n4', 's-new', 1_600_000, 'timeout', model, null, timing(null), usage(0.006), 0)
  // A background candidate Keith never saw: costs money, never listed.
  req.run('n5', 's-new', 1_700_000, 'complete', model, card('call_control', 'say', 'UNSEEN BACKGROUND LINE', null), timing(900), usage(0.03), 1)
  req.run('o1', 's-old', 300_000, 'complete', model, card('handle_objection', 'ask', 'What would make the timing work for you?', null), timing(1800), usage(0.01), 0)
  const fb = db.sql.prepare("INSERT INTO feedback (card_id, origin, type, bad_reason, note, ts) VALUES (?, 'help_requested', ?, ?, ?, 't')")
  fb.run('n1', 'useful', null, null)
  fb.run('n1', 'used', null, null)
  fb.run('n1', 'note', null, 'Exactly the right question')
  fb.run('n2', 'bad', null, null)
  fb.run('n2', 'bad', 'already_known', null)
  fb.run('n2', 'note', null, 'They told us the volume five minutes earlier')
  fb.run('o1', 'bad', 'wrong_move', null)
}

describe('HELP feedback export', () => {
  it('collects the cards Keith saw in the period, with his latest feedback, and every request in the cost', () => {
    const db = new Db(':memory:')
    seed(db)
    const calls = collectFeedbackCalls(db, periodSince('7d', NOW), (id) => (id === 's-new' ? 42.4 : null))
    expect(calls).toHaveLength(1)
    const c = calls[0]
    expect(c).toMatchObject({ session_id: 's-new', account: 'Bluefin Logistics', call_type: 'discovery', deployment: 'self_hosted', minutes: 42.4, no_line: 1 })
    expect(c.cost_usd).toBeCloseTo(0.076)
    expect(c.cards.map((x) => [x.at_session_ms, x.move, x.rating, x.bad_reasons, x.used, x.note, x.first_usable_ms, x.from_prefetch])).toEqual([
      [754_000, 'explore_process', 'useful', [], true, 'Exactly the right question', 1400, false],
      [1_260_000, 'clarify_scale', 'bad', ['already_known'], false, 'They told us the volume five minutes earlier', 0, true],
      [1_500_000, 'confirm_next_step', null, [], false, null, 2200, false],
    ])
    expect(collectFeedbackCalls(db, periodSince('all', NOW)).map((x) => x.session_id)).toEqual(['s-old', 's-new'])
    expect(periodSince('30d', NOW)).toBe('2026-09-05T18:00:00.000Z')
  })

  it('writes a Markdown summary, then each call and card, readable by Keith and by a model improving the prompt', () => {
    const db = new Db(':memory:')
    seed(db)
    const md = feedbackMarkdown(collectFeedbackCalls(db, null, (id) => (id === 's-new' ? 42.4 : null)), { period: 'all', now: NOW })
    expect(md.split('\n').slice(0, 3)).toEqual(['# HELP feedback: everything', '', '> This file contains HELP lines and notes from real calls.'])
    expect(md).toContain('Model: Claude Sonnet 5.5. Playbook: pb-7.')
    expect(md).toContain('- Calls: 2')
    expect(md).toContain('- Cards shown: 4 (plus 1 press that ended without a line)')
    expect(md).toContain("- Ratings: Useful 1 · Should've stayed quiet 0 · Bad 2 · not rated 1")
    expect(md).toContain('- Bad reasons: already known 1, wrong move 1')
    expect(md).toContain('- Lines used: 1 of 4')
    expect(md).toContain('- Notes: 2')
    expect(md).toContain('- Median time to first usable line: 1.4 s (over 4 cards)')
    expect(md).toContain('- Total cost: $0.09 (including background prep)')
    expect(md).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Bluefin Logistics · discovery · self-hosted · 42 min/)
    expect(md).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · account not set · follow up · deployment not set\n/)
    expect(md).toContain([
      '### 1. 12:34 into the call · move: explore_process',
      '- Ask: "How does the weekly review decide what gets fixed?"',
      '- Follow-up: "Who joins that review?"',
      '- Rating: Useful · Used: yes · First line: after 1.4 s',
      '- Note: "Exactly the right question"',
    ].join('\n'))
    expect(md).toContain('- Rating: Bad (already known) · Used: no · First line: ready at the press (prepared in the background)')
    expect(md).toContain('- Say: "Let\'s book the security review for Thursday."\n- Rating: not rated · Used: no · First line: after 2.2 s')
    expect(md).toContain('1 more press ended without a line.')
    expect(md).not.toContain('UNSEEN')
  })

  it('says so when there is nothing in the period', () => {
    expect(feedbackMarkdown([], { period: '7d', now: NOW })).toMatch(/- Calls: 0[\s\S]*No calls in this period\./)
    const quiet: ExportCall = { session_id: 's', started_at: '2026-10-05T10:00:00.000Z', account: 'Harbor Mills', call_type: 'demo', deployment: 'saas', minutes: null, cards: [], no_line: 0, cost_usd: 0 }
    expect(feedbackMarkdown([quiet], { period: '7d', now: NOW })).toMatch(/· Harbor Mills · demo · SaaS\n\nNo HELP presses\./)
  })

  it('in the app: one dated file in the chosen folder, never overwriting an earlier export', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'))
    const logs: Array<Record<string, unknown> | undefined> = []
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, (_e, d) => logs.push(d))
    expect(help.exportFeedback('7d', downloads, NOW)).toEqual({ ok: false, reason: 'No calls in the last 7 days.' })
    seed(help.db)
    fs.mkdirSync(path.join(dir, 'reports'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'reports', 'help-scorecard-s-new.json'), JSON.stringify({ call_minutes: 42.4 }))
    const a = help.exportFeedback('7d', downloads, NOW)
    expect(a).toMatchObject({ ok: true, calls: 1, cards: 3, file: path.join(downloads, exportFileName(NOW)) })
    expect(path.basename(a.file!)).toMatch(/^SalesCopilot-feedback-\d{4}-\d{2}-\d{2}\.md$/)
    expect(fs.readFileSync(a.file!, 'utf8')).toMatch(/Bluefin Logistics · discovery · self-hosted · 42 min/)
    const b = help.exportFeedback('nonsense', downloads, NOW)
    expect(b.file).toBe(a.file!.replace(/\.md$/, '-2.md'))
    expect(help.exportFeedback('all', downloads, NOW)).toMatchObject({ ok: true, calls: 2, cards: 4 })
    // Logs: counts only.
    expect(JSON.stringify(logs)).not.toMatch(/Bluefin|weekly review|Exactly/)
    // Nothing written into the data folder.
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('SalesCopilot-feedback'))).toEqual([])
    help.shutdown()
  })
})
