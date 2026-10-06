/**
 * Account memory: what earlier calls with the same account left behind ("Last time with <account>").
 *
 * Read only, from what the app already saves per call: the call setup (sessions), the wrap-up Keith
 * confirmed (call_wrapups) and the final call notes (call_notes). Calls are grouped by accountKey()
 * of the account Keith typed. Nothing is copied anywhere: deleting a call removes its rows, so it
 * drops out of the memory by itself.
 *
 * HELP gets a compact <earlier_calls> block (earlierCallsBlock), computed once at call start (this
 * call left out). The items are things said on earlier calls, dated, never current fact.
 */
import { CALL_TYPES, NOT_COVERED_TOPICS, accountKey, type AccountMemory, type AccountMemoryKind, type CallNotes, type CallSetup, type CallWrapup, type HelpContextRefs, type NotCoveredTopic, type NoteFactKind, type WrapupItem } from '../../shared/help'
import type { Db } from '../db'
import { mustLearnOf, planKey, sanitizeMustLearn } from './callPlan'
import { nextCallType } from './mustLearnIdeas'

/** One dated item as HELP sees it (no call ids: a saved practice moment carries these as they were). */
export type EarlierCallItem = NonNullable<HelpContextRefs['earlier_calls']>[number]

/** Calls the memory looks back over, newest first. */
export const MEMORY_CALLS = 3
const ITEMS_MAX = 12
const WANTS_MAX = 3
const FACTS_MAX = 4
const ITEM_MAX_CHARS = 160
/** The HELP block, tags included. */
export const EARLIER_CALLS_BLOCK_MAX_CHARS = 700
const BLOCK_ITEM_MAX_CHARS = 110

export const MEMORY_KINDS: readonly AccountMemoryKind[] = ['promised', 'they_owe', 'agreed', 'open', 'to_learn', 'wants', 'fact']
/** Facts about their setup that are worth carrying to the next call (budget and "other" stay with the call). */
const FACT_KINDS = new Set(['current_tooling', 'team', 'timeline', 'decision_process'])
const SECTION_KIND: Record<string, AccountMemoryKind> = { we_owe: 'promised', they_owe: 'they_owe', agreed: 'agreed', open_questions: 'open', proposed: 'open' }

/** How a "to_learn" item reads to the model: Keith's own unmet plan, never something they said (pressModes.ts looks for it). */
export const TO_LEARN_LABEL = 'Keith still wanted to learn'

/** How each kind reads to the model: who said it, in the past tense. */
const BLOCK_LABEL: Record<AccountMemoryKind, string> = {
  promised: 'Arize promised', they_owe: 'They said they would', agreed: 'Agreed next step',
  open: 'Still open', wants: 'They wanted', fact: 'They told us',
  // M3 call plan: filled from CallWrapup.plan_open by the call-plan builder.
  to_learn: TO_LEARN_LABEL,
}

export interface AccountSummary {
  /** As Keith last typed it. */
  account: string
  calls: number
  last_call_at: string
}

interface SessionRow {
  id: string
  started_at: string
  setup_json: string
}

function parse<T>(s: string | null | undefined): T | null {
  try {
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** The calendar day of the call on this PC's clock (YYYY-MM-DD), so the same items always read the same. */
export function callDay(startedAt: string): string {
  const d = new Date(startedAt)
  if (Number.isNaN(d.getTime())) return startedAt.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Saved calls that were actually held (at least one line transcribed), newest first, with the account
 * as typed. A Start that never heard anything isn't "last time".
 */
function heldCalls(db: Db, excludeSessionId: string | null | undefined): Array<SessionRow & { account: string; key: string }> {
  const rows = db.sql.prepare(
    `SELECT id, started_at, setup_json FROM sessions s
     WHERE EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id)
     ORDER BY started_at DESC, id DESC`,
  ).all() as unknown as SessionRow[]
  const out: Array<SessionRow & { account: string; key: string }> = []
  for (const r of rows) {
    if (excludeSessionId && r.id === excludeSessionId) continue
    const raw = parse<Partial<CallSetup>>(r.setup_json)?.account
    const account = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
    const key = accountKey(account)
    if (key) out.push({ ...r, account, key })
  }
  return out
}

/** Accounts of saved calls, newest first: the account box suggests these. */
export function listAccounts(db: Db, excludeSessionId?: string | null): AccountSummary[] {
  const byKey = new Map<string, AccountSummary>()
  for (const c of heldCalls(db, excludeSessionId)) {
    const a = byKey.get(c.key)
    // Newest first, so the first call seen names the account and dates it.
    if (a) a.calls++
    else byKey.set(c.key, { account: c.account, calls: 1, last_call_at: c.started_at })
  }
  return [...byKey.values()]
}

function cleanSetup(raw: Partial<CallSetup> | null): CallSetup | null {
  if (!raw || typeof raw !== 'object') return null
  return {
    call_type: (CALL_TYPES as readonly string[]).includes(raw.call_type as string) ? raw.call_type! : 'discovery',
    call_goal: typeof raw.call_goal === 'string' ? raw.call_goal : '',
    desired_outcomes: Array.isArray(raw.desired_outcomes) ? raw.desired_outcomes.filter((x): x is string => typeof x === 'string') : [],
    account: typeof raw.account === 'string' ? raw.account : '',
    deployment: raw.deployment === 'saas' || raw.deployment === 'self_hosted' ? raw.deployment : 'unknown',
  }
}

/**
 * A wrap-up item's text with who and when as said on the call ("Share their eval dataset (Dana, by
 * Friday)"), unless the text already says them: the deadline is what Keith needs next time. The date
 * the block and the box show keeps a relative "by Friday" tied to the call it was said on.
 */
function withWhoWhen(it: Partial<WrapupItem>): string {
  const text = typeof it.text === 'string' ? it.text : ''
  const extra = [it.who, it.when]
    .filter((x): x is string => typeof x === 'string' && !!x.trim() && !text.toLowerCase().includes(x.trim().toLowerCase()))
    .map((x) => x.trim())
  return extra.length ? `${text.trim()} (${extra.join(', ')})` : text
}

const textOf = (x: unknown): string => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')

/**
 * What the last few calls with this account left behind, newest call first: the wrap-up items Keith
 * didn't remove (what Arize promised, what they owe, the agreed next step, what's still open), and
 * from the notes what they want and facts about their tools, team, timeline and decision process.
 * Null when no earlier call with this account was held.
 */
export function accountMemory(db: Db, account: string, excludeSessionId?: string | null): AccountMemory | null {
  const key = accountKey(account)
  if (!key) return null
  const calls = heldCalls(db, excludeSessionId).filter((c) => c.key === key)
  if (!calls.length) return null
  const wrapStmt = db.sql.prepare('SELECT wrapup_json FROM call_wrapups WHERE session_id = ?')
  const notesStmt = db.sql.prepare('SELECT notes_json FROM call_notes WHERE session_id = ?')
  const items: AccountMemory['items'] = []
  const seen = new Set<string>()
  // Must-learns a newer call set out to learn again: that call's own plan says whether they're still open.
  const planned = new Set<string>()
  /** The last call's must-learns still to learn (at most 3), for "Reuse last setup". */
  let lastOpen: string[] = []
  let wants = 0
  let facts = 0
  const add = (kind: AccountMemoryKind, text: string, date: string, sessionId: string, factKind?: NoteFactKind): void => {
    const t = clip(text, ITEM_MAX_CHARS)
    // The same thing said on two calls is listed once, from the newest.
    const norm = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (!norm || seen.has(norm) || items.length >= ITEMS_MAX) return
    if (kind === 'wants' && wants >= WANTS_MAX) return
    if (kind === 'fact' && facts >= FACTS_MAX) return
    seen.add(norm)
    if (kind === 'wants') wants++
    if (kind === 'fact') facts++
    // M4: what a fact is about, so the must-learn ideas can offer to confirm who decides and what they use.
    items.push({ kind, text: t, date, session_id: sessionId, ...(kind === 'fact' && factKind ? { fact_kind: factKind } : {}) })
  }
  /** M4 faster setup and ideas: the newest call's wrap-up and final notes, as read below. */
  let lastWrap: Partial<CallWrapup> | null = null
  let lastNotes: Partial<CallNotes> | null = null
  for (const c of calls.slice(0, MEMORY_CALLS)) {
    const date = callDay(c.started_at)
    const found: Array<{ kind: AccountMemoryKind; text: string; factKind?: NoteFactKind }> = []
    // A wrap-up still building or that failed has no items yet; one that can't be read is skipped.
    const wrap = parse<Partial<CallWrapup>>((wrapStmt.get(c.id) as { wrapup_json: string } | undefined)?.wrapup_json)
    // A Practice-mode (MOCK) wrap-up holds placeholders, not anything said: never "last time".
    for (const it of wrap && wrap.mock !== true && Array.isArray(wrap.items) ? wrap.items : []) {
      const kind = it && typeof it === 'object' ? SECTION_KIND[it.section] : undefined
      if (kind && it.state !== 'removed' && textOf(it)) found.push({ kind, text: withWhoWhen(it) })
    }
    // M3 call plan: what Keith still wanted to learn when this call ended (same rule: never from a MOCK wrap-up).
    const verdict = !!wrap && wrap.mock !== true
    const open = verdict ? sanitizeMustLearn(wrap!.plan_open) : []
    if (c === calls[0]) lastOpen = open
    for (const t of open) if (!planned.has(planKey(t))) found.push({ kind: 'to_learn', text: t })
    const notes = parse<Partial<CallNotes>>((notesStmt.get(c.id) as { notes_json: string | null } | undefined)?.notes_json)
    if (c === calls[0]) {
      lastWrap = wrap
      lastNotes = notes
    }
    // Only a must-learn this call's notes tracked, with a real wrap-up, settles an older one: no wrap-up,
    // a MOCK one or notes that never tracked it say nothing about it.
    const tracked = new Set((verdict && Array.isArray(notes?.plan) ? notes.plan : []).map((p) => (p && typeof p.item === 'string' ? planKey(p.item) : '')))
    for (const t of mustLearnOf(parse<Partial<CallSetup>>(c.setup_json))) if (tracked.has(planKey(t))) planned.add(planKey(t))
    for (const w of Array.isArray(notes?.buyer_wants) ? notes.buyer_wants : []) if (textOf(w)) found.push({ kind: 'wants', text: textOf(w) })
    for (const f of Array.isArray(notes?.facts) ? notes.facts : []) if (f && FACT_KINDS.has(f.kind) && textOf(f)) found.push({ kind: 'fact', text: textOf(f), factKind: f.kind })
    // Within a call: what was promised and agreed first, then what they want and told us.
    found.sort((a, b) => MEMORY_KINDS.indexOf(a.kind) - MEMORY_KINDS.indexOf(b.kind))
    for (const f of found) add(f.kind, f.text, date, c.id, f.factKind)
  }
  const last = calls[0]
  const lastSetup = cleanSetup(parse<Partial<CallSetup>>(last.setup_json))
  // "Reuse last setup" brings over what the last call still had to learn, not everything it set out to.
  if (lastSetup && lastOpen.length) lastSetup.must_learn = lastOpen
  const lastNotCovered = notCoveredOf(db, last.id, lastWrap, lastNotes)
  return {
    account: last.account,
    calls: calls.length,
    last_call_at: last.started_at,
    last_setup: lastSetup,
    items,
    // M4 faster setup: the deployment Keith last set for them, and the likely type of the next call.
    ...lastDeploymentOf(calls),
    next_call_type: nextCallTypeOf(lastWrap),
    ...(lastNotCovered ? { last_not_covered: lastNotCovered } : {}),
  }
}

/** The newest call with this account whose deployment was set (not "not sure"), however far back. */
function lastDeploymentOf(calls: readonly SessionRow[]): Pick<AccountMemory, 'last_deployment'> {
  for (const c of calls) {
    const d = parse<Partial<CallSetup>>(c.setup_json)?.deployment
    if (d === 'saas' || d === 'self_hosted') return { last_deployment: d }
  }
  return {}
}

/**
 * From the newest call's agreed next steps Keith didn't remove (mustLearnIdeas.ts nextCallType). A
 * Practice-mode (MOCK) wrap-up holds placeholders: Follow-up, as with no wrap-up at all.
 */
function nextCallTypeOf(wrap: Partial<CallWrapup> | null): AccountMemory['next_call_type'] {
  if (!wrap || wrap.mock === true || !Array.isArray(wrap.items)) return 'follow_up'
  return nextCallType(wrap.items.filter((it) => it && typeof it === 'object' && it.section === 'agreed' && it.state !== 'removed').map(textOf))
}

/**
 * The topics the newest call's final notes listed as not covered, only when those notes came from
 * Claude: Practice mode's (MOCK) notes list every topic. call_notes has no MOCK mark of its own, so: the
 * call's wrap-up says (its mock flag), and without a wrap-up, the notes' counts show a model answered
 * (Practice mode uses no tokens). Null when that can't be told, or there are no notes.
 */
function notCoveredOf(db: Db, sessionId: string, wrap: Partial<CallWrapup> | null, notes: Partial<CallNotes> | null): NotCoveredTopic[] | null {
  if (!notes || !Array.isArray(notes.not_covered)) return null
  let real: boolean
  if (wrap) real = wrap.mock !== true
  else {
    const stats = parse<{ input_tokens?: unknown }>((db.sql.prepare('SELECT stats_json FROM call_notes WHERE session_id = ?').get(sessionId) as { stats_json: string } | undefined)?.stats_json)
    real = typeof stats?.input_tokens === 'number' && stats.input_tokens > 0
  }
  if (!real) return null
  return [...new Set(notes.not_covered.filter((x): x is NotCoveredTopic => (NOT_COVERED_TOPICS as readonly unknown[]).includes(x)))]
}

/** Keep only well-formed items (a saved practice moment can be hand-edited). */
export function cleanEarlierItems(raw: unknown): EarlierCallItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is EarlierCallItem => !!x && typeof x === 'object' && MEMORY_KINDS.includes(x.kind) && typeof x.text === 'string' && typeof x.date === 'string' && !!x.text.trim())
    .map((x) => ({ kind: x.kind, text: x.text, date: x.date }))
}

/**
 * The HELP block: dated items, newest call first, at most about 700 characters with its tags. Returns
 * the items it used too, so the request records exactly what HELP saw (a practice moment replays it).
 */
export function earlierCallsBlock(items: readonly EarlierCallItem[]): { text: string; used: EarlierCallItem[] } | null {
  const head = '<earlier_calls note="what was said on earlier calls with this account; past statements, not current fact">'
  const tail = '</earlier_calls>'
  let room = EARLIER_CALLS_BLOCK_MAX_CHARS - head.length - tail.length - 1
  const lines: string[] = []
  const used: EarlierCallItem[] = []
  for (const it of items) {
    const line = `${it.date} · ${BLOCK_LABEL[it.kind] ?? 'Said'}: ${clip(it.text, BLOCK_ITEM_MAX_CHARS)}`
    if (line.length + 1 > room) continue
    room -= line.length + 1
    lines.push(line)
    used.push({ kind: it.kind, text: it.text, date: it.date })
  }
  if (!lines.length) return null
  return { text: `${head}\n${lines.join('\n')}\n${tail}`, used }
}
