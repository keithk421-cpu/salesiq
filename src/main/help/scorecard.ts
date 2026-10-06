/**
 * Per-call HELP scorecard: numbers only (counts, timings, cost, feedback taps), never transcript,
 * request or card text. Written to reports/ at Stop, so "Save support files" can include it.
 */
import { RATINGS } from '../../shared/help'
import type { Db } from '../db'
import type { CallNotesStats } from './callNotesKeeper'
import type { WrapupStats } from './wrapup'

export interface HelpScorecard {
  kind: 'help_scorecard'
  session_id: string
  created_at: string
  call_minutes: number
  /** Requests Keith saw: each press, whether answered fresh or from a background candidate. */
  shown: number
  complete: number
  failed: number
  timeout: number
  cancelled: number
  superseded: number
  from_prefetch: number
  /** Press to first usable line, over shown requests that produced one. */
  first_usable_ms: { median: number | null; p95: number | null }
  cards_with_checks: number
  prefetch: { started: number; used: number; unused: number; unused_cost_usd: number }
  cost_usd: number
  tokens: { input: number; output: number; cache_read: number }
  feedback: { useful: number; should_have_stayed_quiet: number; bad: number; bad_reasons: Record<string, number>; used: number; notes: number }
  errors: Record<string, number>
  /** Smarter presses (M3) among the requests Keith saw, and the cards he pressed again on for another angle ("passed": not a rating); plan_item: must-learn clicks (M4). */
  presses: { opening: number; signal: number; another_angle: number; passed: number; plan_item: number }
  /** Background call notes (counts and codes only). cost_usd above is HELP's; total_cost_usd adds the notes. */
  call_notes: { started: number; updated: number; invalid: number; failed: number; cancelled: number; closing: number; capped: number; cost_usd: number; tokens: { input: number; output: number; cache_read: number }; errors: Record<string, number> }
  /** The wrap-up after Stop and the follow-up draft (counts, cost and codes only; null when none was made). total_cost_usd adds both. */
  wrapup: {
    status: string; items: Record<string, number>; confirmed: number; removed: number; added: number; edited: number; dropped: number
    requests: number; build_ms: number | null; cost_usd: number; drafts: number; draft_failed: number; draft_checks: number; draft_cost_usd: number; errors: Record<string, number>
  } | null
  total_cost_usd: number
}

interface Row {
  id: string
  status: string
  prefetch: number
  timing_json: string | null
  usage_json: string | null
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function buildScorecard(db: Db, sessionId: string, callMs: number, now = new Date()): HelpScorecard {
  const rows = db.sql.prepare('SELECT id, status, prefetch, timing_json, usage_json FROM help_requests WHERE session_id = ?').all(sessionId) as unknown as Row[]
  const parse = <T>(s: string | null): Partial<T> => {
    try {
      return s ? (JSON.parse(s) as Partial<T>) : {}
    } catch {
      return {}
    }
  }
  type Timing = { served_from_prefetch: boolean; first_usable_ms: number | null; error_code: string | null; checks: number; press_mode: string }
  type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cost_usd: number }
  const card: HelpScorecard = {
    kind: 'help_scorecard', session_id: sessionId, created_at: now.toISOString(), call_minutes: Math.round(callMs / 6000) / 10,
    shown: 0, complete: 0, failed: 0, timeout: 0, cancelled: 0, superseded: 0, from_prefetch: 0,
    first_usable_ms: { median: null, p95: null }, cards_with_checks: 0,
    prefetch: { started: 0, used: 0, unused: 0, unused_cost_usd: 0 }, cost_usd: 0, tokens: { input: 0, output: 0, cache_read: 0 },
    feedback: { useful: 0, should_have_stayed_quiet: 0, bad: 0, bad_reasons: {}, used: 0, notes: 0 }, errors: {},
    presses: { opening: 0, signal: 0, another_angle: 0, passed: 0, plan_item: 0 },
    call_notes: { started: 0, updated: 0, invalid: 0, failed: 0, cancelled: 0, closing: 0, capped: 0, cost_usd: 0, tokens: { input: 0, output: 0, cache_read: 0 }, errors: {} },
    wrapup: null,
    total_cost_usd: 0,
  }
  const firstUsable: number[] = []
  const shownIds: string[] = []
  for (const r of rows) {
    const t = parse<Timing>(r.timing_json)
    const u = parse<Usage>(r.usage_json)
    const cost = u.cost_usd ?? 0
    card.cost_usd += cost
    card.tokens.input += u.input_tokens ?? 0
    card.tokens.output += u.output_tokens ?? 0
    card.tokens.cache_read += u.cache_read_input_tokens ?? 0
    if (t.error_code) card.errors[t.error_code] = (card.errors[t.error_code] ?? 0) + 1
    if (r.prefetch) {
      card.prefetch.started++
      if (t.served_from_prefetch) card.prefetch.used++
      else card.prefetch.unused_cost_usd += cost
    }
    const shown = !r.prefetch || !!t.served_from_prefetch
    if (!shown) continue
    shownIds.push(r.id)
    card.shown++
    if (t.served_from_prefetch) card.from_prefetch++
    if (r.status === 'complete' || r.status === 'failed' || r.status === 'timeout' || r.status === 'cancelled' || r.status === 'superseded') card[r.status]++
    if (typeof t.first_usable_ms === 'number') firstUsable.push(t.first_usable_ms)
    if ((t.checks ?? 0) > 0) card.cards_with_checks++
    if (t.press_mode === 'opening' || t.press_mode === 'signal' || t.press_mode === 'another_angle') card.presses[t.press_mode]++
    // M4: Keith clicked a must-learn on the plan line for the line that gets there.
    if (t.press_mode === 'plan_item') card.presses.plan_item++
  }
  card.prefetch.unused = card.prefetch.started - card.prefetch.used
  firstUsable.sort((a, b) => a - b)
  card.first_usable_ms = { median: pct(firstUsable, 50), p95: pct(firstUsable, 95) }
  card.cost_usd = Math.round(card.cost_usd * 10000) / 10000
  card.prefetch.unused_cost_usd = Math.round(card.prefetch.unused_cost_usd * 10000) / 10000
  if (shownIds.length) {
    const fb = readFeedback(db, shownIds)
    for (const f of fb.values()) {
      if (f.rating) card.feedback[f.rating]++
      if (f.rating === 'bad') for (const r of f.reasons) card.feedback.bad_reasons[r] = (card.feedback.bad_reasons[r] ?? 0) + 1
      if (f.used) card.feedback.used++
      if (f.note) card.feedback.notes++
      if (f.passed) card.presses.passed++
    }
  }
  // Call notes keep one row per call with running counts (never read the notes text here).
  const notesRow = db.sql.prepare('SELECT stats_json FROM call_notes WHERE session_id = ?').get(sessionId) as { stats_json: string } | undefined
  const ns = parse<CallNotesStats>(notesRow?.stats_json ?? null)
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  card.call_notes = {
    started: num(ns.started), updated: num(ns.updated), invalid: num(ns.invalid), failed: num(ns.failed), cancelled: num(ns.cancelled), closing: num(ns.closing), capped: num(ns.capped),
    cost_usd: Math.round(num(ns.cost_usd) * 10000) / 10000,
    tokens: { input: num(ns.input_tokens), output: num(ns.output_tokens), cache_read: num(ns.cache_read_input_tokens) },
    errors: Object.fromEntries(Object.entries(ns.errors ?? {}).filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && typeof v === 'number')),
  }
  // The wrap-up keeps numbers-only counts beside it (never read the wrap-up or email text here).
  const wrapRow = db.sql.prepare('SELECT stats_json FROM call_wrapups WHERE session_id = ?').get(sessionId) as { stats_json: string } | undefined
  if (wrapRow) {
    const ws = parse<WrapupStats>(wrapRow.stats_json)
    const codes = (o: unknown) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && typeof v === 'number'))
    const usd = (x: unknown) => Math.round(num(x) * 10000) / 10000
    card.wrapup = {
      status: typeof ws.status === 'string' && /^[a-z_]{1,20}$/.test(ws.status) ? ws.status : 'unknown',
      items: codes(ws.items), confirmed: num(ws.confirmed), removed: num(ws.removed), added: num(ws.added), edited: num(ws.edited), dropped: num(ws.dropped),
      requests: num(ws.requests), build_ms: typeof ws.build_ms === 'number' ? ws.build_ms : null, cost_usd: usd(ws.cost_usd),
      drafts: num(ws.drafts), draft_failed: num(ws.draft_failed), draft_checks: num(ws.draft_checks), draft_cost_usd: usd(ws.draft_cost_usd), errors: codes(ws.errors),
    }
  }
  const wrapCost = card.wrapup ? card.wrapup.cost_usd + card.wrapup.draft_cost_usd : 0
  card.total_cost_usd = Math.round((card.cost_usd + card.call_notes.cost_usd + wrapCost) * 10000) / 10000
  return card
}

/**
 * Keith's feedback per card, folded: the last rating counts (Keith can change his mind; "Bad" then a
 * reason is one verdict), the last used/unused counts, the last note counts.
 */
export function readFeedback(db: Db, cardIds: string[]): Map<string, { rating: (typeof RATINGS)[number] | null; reasons: Set<string>; used: boolean; note: string | null; passed?: boolean }> {
  const rows = db.sql.prepare('SELECT card_id, type, bad_reason, note FROM feedback WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(cardIds)) as Array<{ card_id: string; type: string; bad_reason: string | null; note: string | null }>
  const out = new Map<string, { rating: (typeof RATINGS)[number] | null; reasons: Set<string>; used: boolean; note: string | null; passed?: boolean }>()
  for (const r of rows) {
    const f = out.get(r.card_id) ?? { rating: null, reasons: new Set<string>(), used: false, note: null }
    if ((RATINGS as readonly string[]).includes(r.type)) {
      if (f.rating !== r.type) f.reasons = new Set()
      f.rating = r.type as (typeof RATINGS)[number]
      if (r.bad_reason) f.reasons.add(r.bad_reason)
    } else if (r.type === 'used' || r.type === 'unused') f.used = r.type === 'used'
    else if (r.type === 'note') f.note = r.note
    // Keith pressed again for another angle: not a rating, and it never changes one.
    else if (r.type === 'passed') f.passed = true
    out.set(r.card_id, f)
  }
  return out
}
