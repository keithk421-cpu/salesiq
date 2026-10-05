/**
 * Per-call HELP scorecard: numbers only (counts, timings, cost, feedback taps), never transcript,
 * request or card text. Written to reports/ at Stop, so "Save support files" can include it.
 */
import type { Db } from '../db'

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
  feedback: { useful: number; should_have_stayed_quiet: number; bad: number; bad_reasons: Record<string, number> }
  errors: Record<string, number>
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
  type Timing = { served_from_prefetch: boolean; first_usable_ms: number | null; error_code: string | null; checks: number }
  type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cost_usd: number }
  const card: HelpScorecard = {
    kind: 'help_scorecard', session_id: sessionId, created_at: now.toISOString(), call_minutes: Math.round(callMs / 6000) / 10,
    shown: 0, complete: 0, failed: 0, timeout: 0, cancelled: 0, superseded: 0, from_prefetch: 0,
    first_usable_ms: { median: null, p95: null }, cards_with_checks: 0,
    prefetch: { started: 0, used: 0, unused: 0, unused_cost_usd: 0 }, cost_usd: 0, tokens: { input: 0, output: 0, cache_read: 0 },
    feedback: { useful: 0, should_have_stayed_quiet: 0, bad: 0, bad_reasons: {} }, errors: {},
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
  }
  card.prefetch.unused = card.prefetch.started - card.prefetch.used
  firstUsable.sort((a, b) => a - b)
  card.first_usable_ms = { median: pct(firstUsable, 50), p95: pct(firstUsable, 95) }
  card.cost_usd = Math.round(card.cost_usd * 10000) / 10000
  card.prefetch.unused_cost_usd = Math.round(card.prefetch.unused_cost_usd * 10000) / 10000
  if (shownIds.length) {
    // One verdict per card: the last tap wins (Keith can change his mind; "Bad" then a reason is one card).
    const fb = db.sql.prepare('SELECT card_id, type, bad_reason FROM feedback WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(shownIds)) as Array<{ card_id: string; type: string; bad_reason: string | null }>
    const last = new Map<string, { type: string; reasons: Set<string> }>()
    for (const f of fb) {
      const prev = last.get(f.card_id)
      const reasons = prev && prev.type === f.type ? prev.reasons : new Set<string>()
      if (f.bad_reason) reasons.add(f.bad_reason)
      last.set(f.card_id, { type: f.type, reasons })
    }
    for (const { type, reasons } of last.values()) {
      if (type === 'useful' || type === 'should_have_stayed_quiet' || type === 'bad') card.feedback[type]++
      if (type === 'bad') for (const r of reasons) card.feedback.bad_reasons[r] = (card.feedback.bad_reasons[r] ?? 0) + 1
    }
  }
  return card
}
