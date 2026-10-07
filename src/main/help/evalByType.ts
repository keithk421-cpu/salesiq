/**
 * M5 speed test: the "By call type" table. Each call type now has its own mode (discovery asks,
 * pricing holds back, and so on), so one overall number can hide a mode that went wrong. This splits
 * the built-in results by the call type each scenario was set up with, per model, and lists Keith's
 * saved moments in the same table under "Your moments", apart from the rows that decide anything.
 *
 * Counts, rates and timings only: no card or transcript text goes in the table.
 */
import { CALL_TYPES, CALL_TYPE_LABELS, type CallType } from '../../shared/help'
import type { ScenarioResult } from './evalRunner'

export interface CallTypeRow {
  /** The scenario's call type ('' when the result doesn't say: an older or hand-edited one). */
  call_type: string
  model: string
  /** Different scenarios in the group (repeats count once). */
  scenarios: number
  runs: number
  level1_pass_rate: number
  /**
   * Built-in rows: share of unapproved-draft runs whose move was right (null: no drafts), as in the
   * main table. Your moments: share of the runs your feedback could judge (null: none judged).
   * Step-2 moments are left out until step 2 ships (a v1 card can't make that move).
   */
  move_agreement: number | null
  /** Cards by line: ASK, SAY, and Hold (MOVE no_move, a line to say at the pause). */
  ask: number
  say: number
  hold: number
  /** Runs with a Level 1 failure from the price check (a price or discount not from approved pricing). */
  price_hits: number
  first_usable_median_ms: number | null
}

/**
 * The words every price-check failure carries: the plan's fixed check text (M5 plan section 1.5,
 * "Price or discount not from approved pricing: don't say it"), which the Level 1 failure reuses.
 */
export const PRICE_CHECK_WORDS = 'not from approved pricing'

/**
 * A Level 1 failure from the price check, read from those words so the table works with or without
 * that check; a forbidden-pattern failure only quotes the scenario's own pattern, so it never counts.
 */
export function isPriceCheckFailure(failure: string): boolean {
  return !failure.startsWith('matched forbidden pattern') && failure.toLowerCase().includes(PRICE_CHECK_WORDS)
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.ceil(s.length / 2) - 1]
}

/** Call types in the setup strip's order, then any others the results name, then results without one. */
function typeOrder(types: Set<string>): string[] {
  const known = CALL_TYPES.filter((t) => types.has(t))
  const other = [...types].filter((t) => t && !(CALL_TYPES as readonly string[]).includes(t)).sort()
  return [...known, ...other, ...(types.has('') ? [''] : [])]
}

/** One row per call type and model, for built-in results (`mine` false) or your saved moments. */
export function byCallType(results: ScenarioResult[], mine = false): CallTypeRow[] {
  const typeOf = (r: ScenarioResult) => (typeof r.call_type === 'string' ? r.call_type : '')
  const models = [...new Set(results.map((r) => r.model))]
  const rows: CallTypeRow[] = []
  for (const type of typeOrder(new Set(results.map(typeOf)))) {
    for (const model of models) {
      const rs = results.filter((r) => typeOf(r) === type && r.model === model)
      if (!rs.length) continue
      const judged = (mine ? rs.filter((r) => r.move_ok !== null) : rs.filter((r) => !r.approved)).filter((r) => !r.step_2)
      const cards = rs.map((r) => r.card).filter((c): c is NonNullable<ScenarioResult['card']> => !!c)
      const hold = cards.filter((c) => c.move === 'no_move').length
      rows.push({
        call_type: type,
        model,
        scenarios: new Set(rs.map((r) => r.scenario_id)).size,
        runs: rs.length,
        level1_pass_rate: rs.filter((r) => r.level1.pass).length / rs.length,
        move_agreement: judged.length ? judged.filter((r) => r.move_ok).length / judged.length : null,
        ask: cards.filter((c) => c.move !== 'no_move' && c.primary_kind === 'ask').length,
        say: cards.filter((c) => c.move !== 'no_move' && c.primary_kind === 'say').length,
        hold,
        price_hits: rs.filter((r) => r.level1.failures.some(isPriceCheckFailure)).length,
        first_usable_median_ms: median(rs.map((r) => r.first_usable_ms).filter((x): x is number => x !== null)),
      })
    }
  }
  return rows
}

function typeLabel(type: string): string {
  if (!type) return 'Not set'
  return CALL_TYPE_LABELS[type as CallType] ?? type
}

/** The report section (markdown). `mine`: your saved moments' results, when the run included them. */
export function byCallTypeMarkdown(results: ScenarioResult[], mine?: ScenarioResult[]): string {
  const pc = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`)
  const s = (x: number | null) => (x === null ? '–' : `${(x / 1000).toFixed(2)} s`)
  const row = (r: CallTypeRow) =>
    `| ${typeLabel(r.call_type)} | ${r.model} | ${r.scenarios} | ${pc(r.level1_pass_rate)} | ${pc(r.move_agreement)} | ${r.ask} / ${r.say} / ${r.hold} | ${r.price_hits} | ${s(r.first_usable_median_ms)} |`
  const lines = byCallType(results).map(row)
  const mineRows = mine?.length ? byCallType(mine, true) : []
  if (mineRows.length) lines.push('| **Your moments** (never pick the model) | | | | | | | |', ...mineRows.map(row))
  return `## By call type

Each call type has its own mode. "Move agree" is on the unapproved drafts (your moments: only where your rating judged the move), leaving out step-2 moments until step 2 ships.
"Ask / Say / Hold" counts the cards; Hold is a line kept for the pause. "Price check" counts runs that failed it.

| Call type | Model | Scenarios | Level 1 pass | Move agree (drafts) | Ask / Say / Hold | Price check | First usable p50 |
|---|---|---|---|---|---|---|---|
${lines.join('\n') || '| – | – | 0 | – | – | 0 / 0 / 0 | 0 | – |'}`
}
