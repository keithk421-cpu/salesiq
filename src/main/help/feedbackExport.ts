/**
 * "Export HELP feedback" (Diagnostics): one Markdown file with every HELP card Keith saw on his calls
 * in a period, and his ratings, used ticks and notes. Written to be read by Keith and by whoever (or
 * whichever model) improves HELP's prompt next.
 *
 * It holds lines and notes from real calls, so it's written only to a file Keith exports (his
 * Downloads folder), never to the data folder that "Save support files" copies from.
 * collectFeedbackCalls reads the database; feedbackMarkdown is pure.
 */
import type { CallSetup, HelpCardContent, HelpTiming, HelpUsage } from '../../shared/help'
import type { Db } from '../db'
import { fmtClock } from './context'
import { readFeedback } from './scorecard'
import { heardSummary, savedHeard } from './heard'

export const EXPORT_PERIODS = { '7d': { days: 7, label: 'Last 7 days' }, '30d': { days: 30, label: 'Last 30 days' }, all: { days: null, label: 'Everything' } } as const
export type ExportPeriod = keyof typeof EXPORT_PERIODS

export interface ExportCard {
  at_session_ms: number | null
  /** A WRAP press ('button'), or a HELP press as the call sounded like it was ending ('closing'). */
  wrap: 'button' | 'closing' | null
  move: string | null
  primary_kind: 'ask' | 'say' | null
  primary: string | null
  follow_up: string | null
  /** Press to first usable line; 0-ish when a background candidate was ready. */
  first_usable_ms: number | null
  from_prefetch: boolean
  model: string | null
  playbook: string | null
  rating: string | null
  bad_reasons: string[]
  used: boolean
  note: string | null
  /** What the card showed it was answering (M3); absent on older cards. */
  heard?: string | null
}

export interface ExportCall {
  session_id: string
  started_at: string
  account: string
  call_type: string
  deployment: string
  /** Call length from its scorecard, when there is one. */
  minutes: number | null
  /** Cards Keith saw that had a line, in call order. */
  cards: ExportCard[]
  /** Presses Keith saw that ended without a line (failed, timed out, cancelled). */
  no_line: number
  /** Every request of the call, including background prep Keith never saw. */
  cost_usd: number
}

function parse<T>(s: string | null | undefined): Partial<T> {
  try {
    return s ? (JSON.parse(s) as Partial<T>) : {}
  } catch {
    return {}
  }
}

/** The oldest call start included for a period (ISO), or null for everything. */
export function periodSince(period: ExportPeriod, now = new Date()): string | null {
  const days = EXPORT_PERIODS[period].days
  return days === null ? null : new Date(now.getTime() - days * 86_400_000).toISOString()
}

/** Calls started since `sinceIso` (all calls when null), oldest first, with the cards Keith saw and his feedback. */
export function collectFeedbackCalls(db: Db, sinceIso: string | null, callMinutes: (sessionId: string) => number | null = () => null): ExportCall[] {
  const sessions = db.sql.prepare('SELECT id, started_at, setup_json FROM sessions WHERE ? IS NULL OR started_at >= ? ORDER BY started_at, id')
    .all(sinceIso, sinceIso) as Array<{ id: string; started_at: string; setup_json: string }>
  const reqs = db.sql.prepare(
    'SELECT id, origin, at_session_ms, model_json, card_json, timing_json, usage_json, prefetch FROM help_requests WHERE session_id = ? ORDER BY at_session_ms, created_at, id',
  )
  return sessions.map((s) => {
    const setup = parse<CallSetup>(s.setup_json)
    const rows = reqs.all(s.id) as Array<{ id: string; origin: string; at_session_ms: number | null; model_json: string; card_json: string | null; timing_json: string | null; usage_json: string | null; prefetch: number }>
    let cost = 0
    let noLine = 0
    const shown: Array<{ id: string; row: (typeof rows)[number]; timing: Partial<HelpTiming & { wrap: string }> }> = []
    for (const r of rows) {
      cost += parse<HelpUsage>(r.usage_json).cost_usd ?? 0
      const timing = parse<HelpTiming & { wrap: string }>(r.timing_json)
      if (r.prefetch && !timing.served_from_prefetch) continue
      if (r.card_json) shown.push({ id: r.id, row: r, timing })
      else noLine++
    }
    const fb = readFeedback(db, shown.map((x) => x.id))
    const cards = shown.map(({ id, row, timing }): ExportCard => {
      const c = parse<HelpCardContent>(row.card_json)
      const m = parse<{ label: string; model: string; playbook: string }>(row.model_json)
      const f = fb.get(id)
      return {
        at_session_ms: row.at_session_ms,
        wrap: timing.wrap === 'button' || timing.wrap === 'closing' ? timing.wrap : row.origin === 'wrap_requested' ? 'button' : null,
        move: c.move ?? null,
        primary_kind: c.primary_kind ?? null,
        primary: c.primary ?? null,
        follow_up: c.follow_up ?? null,
        first_usable_ms: typeof timing.first_usable_ms === 'number' ? timing.first_usable_ms : null,
        from_prefetch: !!timing.served_from_prefetch,
        model: m.label ?? m.model ?? null,
        playbook: m.playbook ?? null,
        rating: f?.rating ?? null,
        bad_reasons: f?.rating === 'bad' ? [...f.reasons] : [],
        used: f?.used ?? false,
        note: f?.note ?? null,
        heard: ((h) => (h ? heardSummary(h) : null))(savedHeard((timing as { heard?: unknown }).heard)),
      }
    })
    return {
      session_id: s.id, started_at: s.started_at, account: typeof setup.account === 'string' ? setup.account : '', call_type: setup.call_type ?? 'other',
      deployment: setup.deployment ?? 'unknown', minutes: callMinutes(s.id), cards, no_line: noLine, cost_usd: cost,
    }
  })
}

const RATING: Record<string, string> = { useful: 'Useful', should_have_stayed_quiet: "Should've stayed quiet", bad: 'Bad' }
const DEPLOYMENT: Record<string, string> = { saas: 'SaaS', self_hosted: 'self-hosted', unknown: 'deployment not set' }
const words = (x: string) => x.replace(/_/g, ' ')

/** "2026-10-05 14:32" in the PC's local time. */
export function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** File name for an export made at `now` (local date). */
export function exportFileName(now = new Date()): string {
  return `SalesCopilot-feedback-${localStamp(now).slice(0, 10)}.md`
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.ceil(s.length / 2) - 1]
}

const secs = (ms: number | null) => (ms === null ? 'unknown' : `${(ms / 1000).toFixed(1)} s`)
const quote = (s: string) => `"${s.replace(/\s+/g, ' ').trim()}"`

export function feedbackMarkdown(calls: ExportCall[], opts: { period: ExportPeriod; now?: Date }): string {
  const now = opts.now ?? new Date()
  const cards = calls.flatMap((c) => c.cards)
  const count = (pred: (c: ExportCard) => boolean) => cards.filter(pred).length
  const reasons = new Map<string, number>()
  for (const c of cards) for (const r of c.bad_reasons) reasons.set(r, (reasons.get(r) ?? 0) + 1)
  const noLine = calls.reduce((a, c) => a + c.no_line, 0)
  const cost = calls.reduce((a, c) => a + c.cost_usd, 0)
  const fu = cards.map((c) => c.first_usable_ms).filter((x): x is number => x !== null)
  const models = [...new Set(cards.map((c) => c.model).filter((x): x is string => !!x))]
  const playbooks = [...new Set(cards.map((c) => c.playbook).filter((x): x is string => !!x))]

  const out: string[] = [
    `# HELP feedback: ${EXPORT_PERIODS[opts.period].label.toLowerCase()}`,
    '',
    '> This file contains HELP lines and notes from real calls.',
    '',
    `Exported ${localStamp(now)} from Sales Copilot.${models.length ? ` Model: ${models.join(', ')}.` : ''}${playbooks.length ? ` Playbook: ${playbooks.join(', ')}.` : ''}`,
    'Move = the sales move HELP chose (not shown on the card). Rating = Keith\'s last tap. Used = he ticked "I used this line".',
    'Times are when HELP read the call: for a card prepared in the background, a little before Keith pressed HELP.',
    '',
    '## Summary',
    '',
    `- Calls: ${calls.length}`,
    `- Cards shown: ${cards.length}${noLine ? ` (plus ${noLine} press${noLine === 1 ? '' : 'es'} that ended without a line)` : ''}`,
    `- Ratings: Useful ${count((c) => c.rating === 'useful')} · Should've stayed quiet ${count((c) => c.rating === 'should_have_stayed_quiet')} · Bad ${count((c) => c.rating === 'bad')} · not rated ${count((c) => !c.rating)}`,
    `- Bad reasons: ${reasons.size ? [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r, n]) => `${words(r)} ${n}`).join(', ') : 'none'}`,
    `- Lines used: ${count((c) => c.used)} of ${cards.length}`,
    `- Notes: ${count((c) => !!c.note)}`,
    `- Median time to first usable line: ${secs(median(fu))}${fu.length ? ` (over ${fu.length} card${fu.length === 1 ? '' : 's'})` : ''}`,
    `- Total cost: $${cost.toFixed(2)} (including background prep)`,
    '',
  ]
  if (!calls.length) out.push('No calls in this period.', '')

  for (const call of calls) {
    const head = [
      localStamp(new Date(call.started_at)),
      call.account.trim() || 'account not set',
      words(call.call_type),
      DEPLOYMENT[call.deployment] ?? words(call.deployment),
      ...(call.minutes !== null ? [`${Math.round(call.minutes)} min`] : []),
    ]
    out.push(`## ${head.join(' · ')}`, '')
    if (!call.cards.length) out.push(call.no_line ? `No cards with a line (${call.no_line} press${call.no_line === 1 ? '' : 'es'} ended without one).` : 'No HELP presses.', '')
    call.cards.forEach((c, i) => {
      const kind = c.wrap === 'button' ? ' · WRAP' : c.wrap === 'closing' ? ' · HELP as the call was ending' : ''
      out.push(`### ${i + 1}. ${c.at_session_ms === null ? 'time unknown' : `${fmtClock(c.at_session_ms)} into the call`}${kind}${c.move ? ` · move: ${c.move}` : ''}`)
      if (c.heard) out.push(`- Heard: ${c.heard}`)
      out.push(`- ${c.primary_kind === 'say' ? 'Say' : 'Ask'}: ${c.primary ? quote(c.primary) : '(no line)'}`)
      if (c.follow_up) out.push(`- Follow-up: ${quote(c.follow_up)}`)
      const rating = c.rating ? `${RATING[c.rating] ?? c.rating}${c.bad_reasons.length ? ` (${c.bad_reasons.map(words).join(', ')})` : ''}` : 'not rated'
      // A background card is served even while still coming in: "ready" only when it was complete.
      const first = c.first_usable_ms === null ? 'unknown' : c.from_prefetch && c.first_usable_ms === 0 ? 'ready at the press' : `after ${secs(c.first_usable_ms)}`
      const prepared = c.from_prefetch ? ' (prepared in the background)' : ''
      out.push(`- Rating: ${rating} · Used: ${c.used ? 'yes' : 'no'} · First line: ${first}${prepared}`)
      if (c.note) out.push(`- Note: ${quote(c.note)}`)
      out.push('')
    })
    if (call.cards.length && call.no_line) out.push(`${call.no_line} more press${call.no_line === 1 ? '' : 'es'} ended without a line.`, '')
  }
  return out.join('\n')
}
