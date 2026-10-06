/**
 * Keith's call plan (M3): up to 3 things he must learn on this call, in his own words, tracked
 * Open / Partial / Done from the call notes.
 *
 * - The must-learns are typed in the setup strip (sanitizeMustLearn) and travel with the call setup.
 * - Each notes update returns how far each one got; mergePlan keeps only Keith's items (matched by
 *   text), needs a cited line of the other side's for "done" (else "partial"), and keeps an item's
 *   last status when the model leaves it out. Asked is not answered: Keith asking is not the other
 *   side answering.
 * - planNow lines the statuses up with the must-learns as they are now (one added mid-call starts
 *   open; one removed drops out); planOpen is what the call ended without (the wrap-up's "Still to learn").
 * - HELP sees the ones still open in its notes block (PLAN_SECTION_LABEL); WRAP asks one of them.
 * Pure functions: logs carry counts only, never the items.
 */
import type { PlanItemStatus, PlanStatus } from '../../shared/help'

/** At most this many must-learns, each at most MUST_LEARN_MAX_CHARS characters. */
export const MUST_LEARN_MAX = 3
export const MUST_LEARN_MAX_CHARS = 80

/** The notes block's plan section; wrap.ts looks for it to know a must-learn is still open. */
export const PLAN_SECTION_LABEL = 'Keith still wants to learn (his plan for this call)'
/**
 * The notes block's note when no notes ran yet (or notes are off): the plan is listed, all open, but
 * nothing tracked it, so wrap.ts doesn't take it as still open.
 */
export const PLAN_UNTRACKED_NOTE = 'no notes yet: only what Keith wants to learn on this call'

const PLAN_STATUSES: readonly PlanStatus[] = ['open', 'partial', 'done']

/** One line, no angle brackets (the prompt's tags), single spaces. */
function oneLine(s: string): string {
  return s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
}

/** How two must-learns are compared: case, spacing and punctuation don't matter. */
export function planKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * What the setup strip sent, made safe to keep and to send: a list of strings, each trimmed and at
 * most MUST_LEARN_MAX_CHARS characters (a ';' becomes ','), empty ones and repeats dropped, at most MUST_LEARN_MAX.
 * Anything else (older setups, a broken message) is no must-learns.
 */
export function sanitizeMustLearn(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (typeof x !== 'string') continue
    // ';' separates the must-learns in the requests (and '|' might one day): one item stays one item.
    const t = oneLine(x.slice(0, 2000).replace(/\s*[;|]/g, ',')).slice(0, MUST_LEARN_MAX_CHARS).trim()
    const k = planKey(t)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= MUST_LEARN_MAX) break
  }
  return out
}

/** The must-learns of a setup, read defensively (older setups and saved moments have none). */
export function mustLearnOf(setup: { must_learn?: unknown } | null | undefined): string[] {
  return sanitizeMustLearn(setup?.must_learn)
}

/**
 * The call_setup block's must-learn line ("\nmust learn: a; b"), or nothing when Keith set none, so a
 * setup without them reads exactly as before.
 */
export function mustLearnLine(setup: { must_learn?: unknown } | null | undefined): string {
  const ml = mustLearnOf(setup)
  return ml.length ? `\nmust learn: ${ml.join('; ')}` : ''
}

/**
 * The model's plan answer checked against Keith's must-learns (`raw` is the answer's `plan`; anything
 * but a list counts as leaving every item out):
 * - only Keith's items, matched by text; anything else the model lists is dropped;
 * - "done" needs at least one cited line that was sent and, given `theirs`, said by the other side,
 *   else it is "partial" (unclear stays partial; Keith or a teammate asking is not their answer);
 * - "open" rests on nothing, so it cites nothing;
 * - an item the model leaves out keeps its previous status (or starts open).
 * Returned in Keith's order, with his own wording.
 */
export function mergePlan(
  mustLearn: readonly string[],
  raw: unknown,
  previous: readonly PlanItemStatus[] | null | undefined,
  lineIds: ReadonlyMap<string, string>,
  /** Whether a turn is the other side's (CallMemory.fromTheirSide); without it any cited line counts. */
  theirs?: (turnId: string) => boolean,
): PlanItemStatus[] {
  const given = new Map<string, PlanItemStatus>()
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || typeof x !== 'object') continue
    const o = x as { item?: unknown; status?: unknown; lines?: unknown }
    if (typeof o.item !== 'string') continue
    const k = planKey(o.item)
    if (!k || given.has(k)) continue
    const ids = Array.isArray(o.lines)
      ? [...new Set(o.lines.map((l) => (typeof l === 'string' ? lineIds.get(l.replace(/[[\]\s]/g, '')) : undefined)).filter((v): v is string => !!v))]
      : []
    let status: PlanStatus = (PLAN_STATUSES as readonly unknown[]).includes(o.status) ? (o.status as PlanStatus) : 'partial'
    // Done only when their answer settles it, and the lines say where. Asked is not answered: lines
    // that are only Keith's (or a teammate's) question make it partial at most; the lines stay for the hover.
    if (status === 'done' && !(theirs ? ids.some(theirs) : ids.length)) status = 'partial'
    given.set(k, { item: o.item, status, turn_ids: status === 'open' ? [] : ids })
  }
  const before = new Map((previous ?? []).map((p) => [planKey(p.item), p]))
  return mustLearn.map((item) => {
    const k = planKey(item)
    const g = given.get(k) ?? before.get(k)
    return g ? { item, status: g.status, turn_ids: [...g.turn_ids] } : { item, status: 'open', turn_ids: [] }
  })
}

/**
 * Keith's must-learns as they are now, each with the status the latest notes gave it: one he added
 * since starts open, one he removed is gone. Reads older notes (no plan) as every item open.
 */
export function planNow(mustLearn: readonly string[], plan: readonly PlanItemStatus[] | null | undefined): PlanItemStatus[] {
  const by = new Map<string, PlanItemStatus>()
  for (const p of Array.isArray(plan) ? plan : []) {
    if (!p || typeof p.item !== 'string' || !(PLAN_STATUSES as readonly unknown[]).includes(p.status)) continue
    const k = planKey(p.item)
    if (!by.has(k)) by.set(k, p)
  }
  return mustLearn.map((item) => {
    const p = by.get(planKey(item))
    return p ? { item, status: p.status, turn_ids: Array.isArray(p.turn_ids) ? p.turn_ids.filter((x) => typeof x === 'string') : [] } : { item, status: 'open', turn_ids: [] }
  })
}

/**
 * Earlier calls' "Keith still wanted to learn" items, minus the ones he set out to learn again on this
 * call: this call's plan tracks those now, so an answer here isn't undone by the old line.
 */
export function notPlannedNow<T extends { kind: string; text: string }>(items: readonly T[], setup: { must_learn?: unknown } | null | undefined): T[] {
  const now = new Set(mustLearnOf(setup).map(planKey))
  return now.size ? items.filter((it) => it.kind !== 'to_learn' || !now.has(planKey(it.text))) : [...items]
}

/** What the call ended without (open or partial), in Keith's words. With no plan in the notes, every must-learn. */
export function planOpen(mustLearn: readonly string[], plan: readonly PlanItemStatus[] | null | undefined): string[] {
  return planNow(mustLearn, plan).filter((p) => p.status !== 'done').map((p) => p.item)
}

/** Numbers only, for logs and the scorecard. */
export function planCounts(plan: readonly PlanItemStatus[] | null | undefined): { open: number; partial: number; done: number } {
  const out = { open: 0, partial: 0, done: 0 }
  for (const p of plan ?? []) if (p && (PLAN_STATUSES as readonly unknown[]).includes(p.status)) out[p.status]++
  return out
}

/** The marks on screen: ○ open, ◐ partial, ● done. */
export const PLAN_MARK: Record<PlanStatus, string> = { open: '○', partial: '◐', done: '●' }

/** A must-learn shortened for the one-line plan (Keith's words, cut at a word). */
export function shortItem(item: string, max = 28): string {
  const t = oneLine(item)
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** The quiet plan line: "○ who signs off · ◐ eval process · ● deep-dive scope". */
export function planLineText(plan: readonly PlanItemStatus[]): string {
  return plan.map((p) => `${PLAN_MARK[p.status]} ${shortItem(p.item)}`).join(' · ')
}
