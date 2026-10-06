/**
 * Keith's practice moments: one real HELP press saved as a replayable scenario, in the same format
 * as evals/scenarios/help (SCHEMA.md), so the speed test can re-run HELP on it later.
 *
 * Built from the call as it stood at the press, so replay stays time-honest:
 * - only turns HELP could see then (available_ms <= the press); words spoken after the press are cut;
 *   every kept line is timed so replay shows it as a finished line, as the live request did;
 * - speaker labels and the call setup (type, goal, outcomes, account, deployment) the request was
 *   built with (both can change later in the call; older rows fall back to the call's latest, noted);
 * - the knowledge sections the request used that are still approved and unchanged, copied in
 *   (approved, with source, version and scope) so later edits to the knowledge folder don't change
 *   the moment. Review dates are dropped: the moment replays as it was then.
 * - what earlier calls with this account left behind, as the request showed it (<earlier_calls>).
 * Expected moves come only from Keith's own feedback, conservatively (see expectedFrom). Saving the
 * same card again refreshes only what his feedback decides (see refreshFeedback).
 *
 * Saved as <userData>/practice/<id>.json. They hold real call text: never in the repo, never copied
 * by "Save support files" (nor are speed-test reports that replayed them, kept in reports/mine/).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Stream } from '../../shared/contracts'
import type { CallSetup, HelpCardContent, HelpContextRefs, HelpTiming, KnowledgeDocMeta } from '../../shared/help'
import { CALL_TYPES, DEPLOYMENTS } from '../../shared/help'
import type { Db } from '../db'
import { KnowledgeBase } from '../knowledge'
import { cleanEarlierItems } from './accountMemory'
import { DEFAULT_SETUP } from './callMemory'
import { mustLearnOf } from './callPlan'
import { fmtClock } from './context'
import { localStamp } from './feedbackExport'
import { savedPress } from './pressModes'
import { FINAL_DELAY_MS, type ObservedCard, type Scenario } from './replay'
import { readFeedback } from './scorecard'
import { heardSummary, savedHeard } from './heard'

/** Folder under the app's data folder. */
export const PRACTICE_DIR = 'practice'
/** Speed-test reports from runs that included these moments: reports/mine/ (never in support files). */
export const MINE_REPORTS = 'mine'

/** A transcript gap as the call's transcript.jsonl records it (session ms). */
export interface PracticeGap {
  stream: Stream
  cause: string
  start_ms: number
  end_ms: number | null
}

export type PracticeBuild = { ok: true; moment: Scenario } | { ok: false; reason: string }

const PRESS_TEXT: Record<string, string> = {
  opening: 'Keith pressed HELP at the start of the call',
  signal: 'Keith pressed HELP after they asked about a next step (pilot, rollout, pricing or something for their boss)',
  another_angle: 'Keith pressed HELP again for another angle',
}

const RATING_TEXT: Record<string, string> = { useful: 'Useful', should_have_stayed_quiet: "Should've stayed quiet", bad: 'Bad' }

interface RequestRow {
  id: string
  session_id: string | null
  created_at: string
  at_session_ms: number | null
  model_json: string
  context_refs_json: string | null
  card_json: string | null
  timing_json: string | null
}

function parse<T>(s: string | null | undefined): Partial<T> {
  try {
    return s ? (JSON.parse(s) as Partial<T>) : {}
  } catch {
    return {}
  }
}

/** Notes lines that come from Keith's feedback: a re-save rewrites only these. */
const FEEDBACK_NOTE = /^(Keith's feedback|Expected moves):/
/** The behavior a Bad: wrong move rating adds (a re-save replaces only these). */
const WRONG_MOVE_BEHAVIOR = /^Picks the move HELP gave on the call \(/

/** File-safe id that only depends on the request (never on time zone or later setup edits). */
export function practiceId(requestId: string, createdAt: string): string {
  const stamp = createdAt.replace(/\.\d+Z$/, '').replace(/[^0-9]/g, '').slice(0, 14)
  return `real-${stamp || 'call'}-${requestId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`
}

/**
 * What Keith's feedback says about the card's move, and nothing more: Useful or "I used this line"
 * makes it acceptable; Bad with "wrong move" makes it wrong; both at once, or anything else, sets nothing.
 */
export function expectedFrom(move: string | null, f: { rating: string | null; reasons: Set<string>; used: boolean } | undefined): {
  acceptable: string[]
  unacceptable: string[]
  why: string
} {
  const none = (why: string) => ({ acceptable: [], unacceptable: [], why })
  if (!move) return none("Expected moves: none (the card had no move), so this moment checks speed and Level 1 only.")
  const good = f?.rating === 'useful' || !!f?.used
  const wrong = f?.rating === 'bad' && f.reasons.has('wrong_move')
  if (good && wrong) return none(`Expected moves: none derived (mixed feedback: rated Bad: wrong move, but marked as used), so this moment checks speed and Level 1 only.`)
  if (good) {
    const because = f?.rating === 'useful' && f.used ? 'rated the card Useful and used the line' : f?.rating === 'useful' ? 'rated the card Useful' : 'used the line'
    return { acceptable: [move], unacceptable: [], why: `Expected moves: only "${move}" is marked acceptable, because Keith ${because}. No best move was derived: add one if this moment should judge HELP's choice.` }
  }
  if (wrong) return { acceptable: [], unacceptable: [move], why: `Expected moves: "${move}" is marked wrong, because Keith rated the card Bad: wrong move. No good move was derived.` }
  return none("Expected moves: none derived from Keith's feedback, so this moment checks speed and Level 1 only.")
}

/**
 * Build the practice moment for one HELP request from the database. `gaps` gives the call's
 * transcript gaps (from its transcript.jsonl) when they're still on disk.
 */
export function buildPracticeMoment(db: Db, requestId: string, opts: { gaps?: (sessionId: string) => PracticeGap[] } = {}): PracticeBuild {
  const row = db.sql.prepare(
    'SELECT id, session_id, created_at, at_session_ms, model_json, context_refs_json, card_json, timing_json FROM help_requests WHERE id = ?',
  ).get(requestId) as RequestRow | undefined
  if (!row || !row.session_id) return { ok: false, reason: "That card isn't saved any more." }
  if (row.at_session_ms === null || !row.card_json) return { ok: false, reason: 'This card has no line to practice on.' }
  const atMs = row.at_session_ms
  const sid = row.session_id
  const refs = parse<HelpContextRefs>(row.context_refs_json)
  const notes: string[] = []

  // The call setup the request was built with. Older rows didn't record it: the call's latest then.
  const atPress = refs.call_setup && typeof refs.call_setup === 'object' ? refs.call_setup : null
  const session = atPress ? undefined : (db.sql.prepare('SELECT setup_json FROM sessions WHERE id = ?').get(sid) as { setup_json: string } | undefined)
  const raw: Partial<CallSetup> = atPress ?? parse<CallSetup>(session?.setup_json)
  if (!atPress) notes.push("The call setup is the call's latest (older versions of the app didn't record it with each press): it may have changed after this press.")
  const setup: CallSetup = {
    ...DEFAULT_SETUP,
    call_type: (CALL_TYPES as readonly string[]).includes(raw.call_type ?? '') ? raw.call_type! : DEFAULT_SETUP.call_type,
    call_goal: typeof raw.call_goal === 'string' ? raw.call_goal : '',
    desired_outcomes: Array.isArray(raw.desired_outcomes) ? raw.desired_outcomes.filter((x): x is string => typeof x === 'string') : [],
    account: typeof raw.account === 'string' ? raw.account : '',
    deployment: (DEPLOYMENTS as readonly string[]).includes(raw.deployment ?? '') ? raw.deployment! : 'unknown',
  }

  // Turns HELP could see at the press. A turn still being spoken is cut at the press (by time, as
  // replay does), and every kept line ends over a second before it, so replay shows it as finished.
  const turns = db.sql.prepare(
    'SELECT stream, cluster, start_ms, end_ms, text FROM turns WHERE session_id = ? AND available_ms <= ? ORDER BY start_ms, turn_id',
  ).all(sid, atMs) as Array<{ stream: string; cluster: string | null; start_ms: number; end_ms: number; text: string }>
  const lastEnd = Math.max(0, atMs - FINAL_DELAY_MS - 1)
  let cut = 0
  const transcript: Scenario['transcript'] = []
  for (const t of turns) {
    let text = t.text.trim()
    if (t.end_ms > atMs) {
      const words = text.split(/\s+/)
      const frac = Math.min(1, Math.max(0, (atMs - t.start_ms) / Math.max(1, t.end_ms - t.start_ms)))
      text = words.slice(0, Math.max(1, Math.floor(words.length * frac))).join(' ')
      cut++
    }
    if (!text) continue
    const end = Math.min(t.end_ms, lastEnd)
    const start = Math.min(t.start_ms, end)
    transcript.push({ t: start / 1000, end: end / 1000, who: t.stream === 'local_mic' ? 'keith' : (t.cluster ?? 'remote'), text })
  }
  if (cut) notes.push(`${cut} line(s) still being spoken at the press are cut at the press.`)
  if (refs.provisional_text) notes.push("Words still being transcribed at the press aren't saved, so they aren't in this moment.")

  // Labels as the request had them; unlabeled speakers stay unknown. Older rows didn't record them:
  // the call's labels then, minus any set or changed after the press (only the latest is kept).
  const speakers: Scenario['speakers'] = {}
  const label = (l: { cluster?: unknown; role?: unknown; name?: unknown }) => {
    if (typeof l.cluster !== 'string') return
    speakers[l.cluster] = { role: l.role === 'buyer' || l.role === 'teammate' ? l.role : 'unknown', name: typeof l.name === 'string' ? l.name : null }
  }
  if (Array.isArray(refs.labels)) refs.labels.forEach(label)
  else {
    const labels = db.sql.prepare('SELECT cluster, role, name, updated_at FROM speaker_labels WHERE session_id = ? ORDER BY cluster').all(sid) as Array<{ cluster: string; role: string; name: string | null; updated_at: string }>
    const later = labels.filter((l) => l.updated_at > row.created_at)
    labels.filter((l) => !later.includes(l)).forEach(label)
    if (later.length) notes.push(`${later.length} speaker label(s) were set or changed after this press and are left unlabeled (older versions of the app didn't record labels with each press).`)
  }
  for (const l of transcript) if (l.who !== 'keith' && l.who !== 'remote' && !speakers[l.who]) speakers[l.who] = { role: 'unknown', name: null }

  // The press time (unless it came within the first second: then just late enough to show the lines).
  const helpAtS = Math.max(atMs, lastEnd + FINAL_DELAY_MS + 1) / 1000
  // Gaps that had started by the press. One still open then keeps an end after the press (replay
  // treats it as open), so when it closed is never written.
  const gaps = (opts.gaps?.(sid) ?? [])
    .filter((g) => g.cause !== 'pause' && g.start_ms <= atMs)
    .map((g) => ({ start: g.start_ms / 1000, end: g.end_ms !== null && g.end_ms <= atMs ? g.end_ms / 1000 : helpAtS + 1, stream: g.stream, cause: g.cause }))

  // Approved knowledge the request used, copied as it is now. A section that's gone, changed or no
  // longer approved since the call is left out (revoking always wins: replay would approve it again).
  const chunkIds = Array.isArray(refs.knowledge_chunk_ids) ? refs.knowledge_chunk_ids : []
  const hashes = Array.isArray(refs.knowledge_hashes) ? refs.knowledge_hashes : null
  const knowledge: NonNullable<Scenario['knowledge']> = []
  let missing = 0
  let changed = 0
  let revoked = 0
  const kb = new KnowledgeBase(db, null)
  const chunkStmt = db.sql.prepare(
    'SELECT c.chunk_id, c.doc_id, c.heading, c.text, c.source_ref, d.meta_json FROM knowledge_chunks c JOIN knowledge_docs d ON d.doc_id = c.doc_id WHERE c.chunk_id = ?',
  )
  chunkIds.forEach((id, i) => {
    const c = chunkStmt.get(id) as { chunk_id: string; doc_id: string; heading: string; text: string; source_ref: string; meta_json: string } | undefined
    if (!c) {
      missing++
      return
    }
    const meta = parse<KnowledgeDocMeta>(c.meta_json)
    if (hashes && hashes[i] !== meta.content_hash) {
      changed++
      return
    }
    if (!kb.getDoc(c.doc_id)?.approved) {
      revoked++
      return
    }
    knowledge.push({
      id: c.chunk_id.replace(/^k:/, '').replace(/[^a-z0-9-]+/gi, '-'),
      title: meta.title ?? 'Knowledge',
      // Pack format, so replay indexes it as the same one section with its whole "Source:" paragraph.
      text: [c.heading ? `## ${c.heading}` : '', c.text, c.source_ref].filter(Boolean).join('\n\n'),
      category: meta.category,
      ...(meta.vendor ? { vendor: meta.vendor } : {}),
      source: meta.source,
      version: meta.version,
      approved: true,
      applies_to: meta.applies_to ?? [],
    })
  })
  if (knowledge.length) notes.push(`Knowledge: the ${knowledge.length} approved section(s) HELP used are copied in (review dates left out, so it replays as it was then).`)
  if (knowledge.length && !hashes) notes.push("This card came from an older version of the app: the knowledge copied in couldn't be checked against what HELP used on the call.")
  if (changed) notes.push(`${changed} knowledge section(s) HELP used were edited since the call and are left out.`)
  if (missing) notes.push(`${missing} knowledge section(s) HELP used are no longer in the knowledge folder and are left out.`)
  if (revoked) notes.push(`${revoked} knowledge section(s) HELP used are no longer approved and are left out.`)

  // What earlier calls with this account left behind, as the request showed it (older rows: none).
  const earlierCalls = cleanEarlierItems(refs.earlier_calls)
  if (earlierCalls.length) notes.push(`Earlier calls: the ${earlierCalls.length} item(s) from earlier calls with this account that HELP saw are copied in.`)

  // The card HELP gave, and Keith's feedback on it.
  const card = parse<HelpCardContent>(row.card_json)
  const fb = readFeedback(db, [row.id]).get(row.id)
  const model = parse<{ label: string; model: string }>(row.model_json)
  const observed: ObservedCard = {
    move: typeof card.move === 'string' ? card.move : null,
    primary_kind: card.primary_kind ?? null,
    primary: card.primary ?? null,
    follow_up: card.follow_up ?? null,
    model: model.label ?? model.model ?? null,
    rating: fb?.rating ?? null,
    bad_reasons: fb?.rating === 'bad' ? [...fb.reasons] : [],
    used: fb?.used ?? false,
    note: fb?.note ?? null,
  }
  const expected = expectedFrom(observed.move, fb)

  const pressed = new Date(row.created_at)
  const title = `${setup.account.trim() || 'Call'} · ${Number.isNaN(pressed.getTime()) ? row.created_at : localStamp(pressed)}`
  // A card prepared in the background was built from the call a little before Keith pressed.
  const timing = parse<HelpTiming & { wrap?: string; press_mode?: string; press_signal?: string; angle_of?: string; wrap_signal?: unknown; press_earlier?: unknown; wrap_plan?: unknown }>(row.timing_json)
  const wrap = timing.wrap === 'button' || timing.wrap === 'closing' ? timing.wrap : undefined
  // A smarter press replays with the block it had: its mode, and what the block showed.
  const pressInfo = savedPress(timing, atPress, (id) => db.sql.prepare('SELECT card_json, timing_json FROM help_requests WHERE id = ? AND session_id = ?').get(id, sid) as { card_json: string | null; timing_json: string | null } | undefined)
  const press = wrap === 'button' ? 'Keith pressed WRAP' : wrap === 'closing' ? 'Keith pressed HELP as the call sounded like it was ending' : pressInfo.press_mode ? PRESS_TEXT[pressInfo.press_mode] : 'Keith pressed HELP'
  const built = timing.served_from_prefetch
    ? `HELP's card was prepared at ${fmtClock(atMs)} into the call and shown when Keith pressed HELP shortly after`
    : `HELP's context was built at ${fmtClock(atMs)} into the call, when ${press}`
  const said = observed.primary ? `${observed.primary_kind === 'say' ? 'Say' : 'Ask'} "${observed.primary}"${observed.follow_up ? `, then "${observed.follow_up}"` : ''}` : '(no line)'
  const keithNotes = [
    `Saved from a real call: ${title}. ${built}.`,
    `On the call HELP said: ${said}${observed.move ? ` (move: ${observed.move})` : ''}.`,
    // What the card showed it was answering (M3 heard line); absent on older cards.
    ...((h) => (h ? [`The card answered: ${heardSummary(h)}.`] : []))(savedHeard((timing as { heard?: unknown }).heard)),
    feedbackLine(observed),
    expected.why,
    ...notes,
  ].join('\n')

  const moment: Scenario = {
    id: practiceId(row.id, row.created_at),
    title,
    category: 'real_call',
    tags: ['real_call'],
    golden_approved: false,
    synthetic: false,
    source: 'real_call',
    request_id: row.id,
    call_type: setup.call_type,
    call_goal: setup.call_goal,
    desired_outcomes: setup.desired_outcomes,
    account: setup.account,
    deployment: setup.deployment,
    // Keith's must-learns as the request had them (the setup at the press only, never the call's latest),
    // so the replay's notes block and WRAP see his plan too.
    ...((ml) => (ml.length ? { must_learn: ml } : {}))(mustLearnOf(atPress)),
    speakers,
    transcript,
    gaps,
    help_at_s: helpAtS,
    knowledge,
    ...(earlierCalls.length ? { earlier_calls: earlierCalls } : {}),
    ...(wrap ? { wrap } : {}),
    ...pressInfo,
    best_moves: [],
    acceptable_moves: expected.acceptable,
    ...(expected.unacceptable.length ? { unacceptable_moves: expected.unacceptable } : {}),
    unacceptable_behaviors: expected.unacceptable.map(wrongMoveBehavior),
    silence_preferred: false,
    observed,
    keith_notes: keithNotes,
  }
  return { ok: true, moment }
}

function feedbackLine(o: ObservedCard): string {
  const rating = o.rating ? `${RATING_TEXT[o.rating] ?? o.rating}${o.bad_reasons.length ? ` (${o.bad_reasons.map((r) => r.replace(/_/g, ' ')).join(', ')})` : ''}` : 'not rated'
  return `Keith's feedback: ${rating}${o.used ? '; used the line' : ''}${o.note ? `; note: "${o.note.replace(/\s+/g, ' ')}"` : ''}.`
}

const wrongMoveBehavior = (m: string) => `Picks the move HELP gave on the call (${m}), which Keith rated Bad: wrong move`

/**
 * A saved moment with Keith's current feedback on its card. Only what his feedback decides changes:
 * `observed`, the move it marked fine or wrong, that "wrong move" behavior, and the feedback and
 * expected-moves lines of the notes. Everything else (best moves, moves or notes he added, the
 * transcript and knowledge as saved) is kept.
 */
export function refreshFeedback(saved: Scenario, fresh: Scenario): Scenario {
  const before = saved.observed?.move ?? null
  const now = fresh.observed?.move ?? null
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [])
  const merge = (mine: unknown, derived: unknown) => {
    const kept = list(mine).filter((m) => m !== before && m !== now)
    return [...kept, ...list(derived).filter((m) => !kept.includes(m))]
  }
  const unacceptable = merge(saved.unacceptable_moves, fresh.unacceptable_moves)
  const lines = typeof saved.keith_notes === 'string' && saved.keith_notes ? saved.keith_notes.split('\n') : []
  const fb = (fresh.keith_notes ?? '').split('\n').filter((l) => FEEDBACK_NOTE.test(l))
  const at = lines.findIndex((l) => FEEDBACK_NOTE.test(l))
  const others = lines.filter((l) => !FEEDBACK_NOTE.test(l))
  const notes = at < 0 ? [...others, ...fb] : [...others.slice(0, at), ...fb, ...others.slice(at)]
  const out: Scenario = {
    ...saved,
    observed: fresh.observed,
    acceptable_moves: merge(saved.acceptable_moves, fresh.acceptable_moves),
    unacceptable_moves: unacceptable,
    unacceptable_behaviors: [...list(saved.unacceptable_behaviors).filter((b) => !WRONG_MOVE_BEHAVIOR.test(b)), ...fresh.unacceptable_behaviors.filter((b) => WRONG_MOVE_BEHAVIOR.test(b))],
    keith_notes: notes.join('\n'),
    ...(fresh.wrap ? { wrap: fresh.wrap } : {}),
    ...(fresh.press_mode ? { press_mode: fresh.press_mode } : {}),
    ...(fresh.press_detail ? { press_detail: fresh.press_detail } : {}),
    ...(fresh.must_learn ? { must_learn: fresh.must_learn } : {}),
  }
  if (!unacceptable.length) delete out.unacceptable_moves
  return out
}

/** Gaps from a call's transcript.jsonl (gap_close records, plus any gap still open when the call ended). */
export function readSessionGaps(transcriptJsonl: string): PracticeGap[] {
  let lines: string[]
  try {
    lines = fs.readFileSync(transcriptJsonl, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const byId = new Map<string, PracticeGap>()
  for (const l of lines) {
    try {
      const r = JSON.parse(l) as { kind?: string; gap_id?: string; stream?: Stream; cause?: string; start_ms?: number; end_ms?: number | null }
      if ((r.kind !== 'gap_open' && r.kind !== 'gap_close') || typeof r.start_ms !== 'number' || !r.stream) continue
      const id = r.gap_id ?? `${r.stream}:${r.start_ms}`
      const prev = byId.get(id)
      byId.set(id, { stream: r.stream, cause: r.cause ?? prev?.cause ?? 'unknown', start_ms: r.start_ms, end_ms: typeof r.end_ms === 'number' ? r.end_ms : (prev?.end_ms ?? null) })
    } catch {
      /* a torn last line */
    }
  }
  return [...byId.values()].sort((a, b) => a.start_ms - b.start_ms)
}

/** Enough shape to replay without throwing (a hand-edited or half-copied file must not stop the speed test). */
function replayable(m: Partial<Scenario>): boolean {
  const str = (x: unknown) => typeof x === 'string'
  const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
  if (!str(m.id) || typeof m.help_at_s !== 'number' || !obj(m.speakers) || !Array.isArray(m.transcript)) return false
  if (!m.transcript.every((l) => obj(l) && typeof l.t === 'number' && str(l.who) && str(l.text) && (l.end === undefined || typeof l.end === 'number'))) return false
  if (m.knowledge !== undefined && !(Array.isArray(m.knowledge) && m.knowledge.every((k) => obj(k) && str(k.id) && str(k.title) && str(k.text)))) return false
  if (m.gaps !== undefined && !(Array.isArray(m.gaps) && m.gaps.every((g) => obj(g) && typeof g.start === 'number' && typeof g.end === 'number'))) return false
  return true
}

function readMoment(file: string): Scenario | null {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Scenario>
    if (!replayable(m)) return null
    return {
      ...(m as Scenario),
      category: typeof m.category === 'string' ? m.category : 'real_call',
      call_goal: m.call_goal ?? '',
      desired_outcomes: Array.isArray(m.desired_outcomes) ? m.desired_outcomes : [],
      best_moves: Array.isArray(m.best_moves) ? m.best_moves : [],
      acceptable_moves: Array.isArray(m.acceptable_moves) ? m.acceptable_moves : [],
      unacceptable_behaviors: Array.isArray(m.unacceptable_behaviors) ? m.unacceptable_behaviors : [],
      // Drafts from real calls: never approved Golden material, whatever the file says.
      golden_approved: false,
    }
  } catch {
    return null
  }
}

function readAll(dir: string): { found: Array<{ file: string; moment: Scenario }>; skipped: number } {
  let files: string[] = []
  try {
    files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []
  } catch {
    return { found: [], skipped: 0 }
  }
  const found: Array<{ file: string; moment: Scenario }> = []
  let skipped = 0
  for (const f of files) {
    const moment = readMoment(path.join(dir, f))
    if (moment) found.push({ file: path.join(dir, f), moment })
    else skipped++
  }
  return { found, skipped }
}

/** Keith's saved moments, by file name. A file that can't be read (hand-edited, half-copied) is skipped and counted. */
export function loadPracticeMoments(dir: string): { moments: Scenario[]; skipped: number } {
  const r = readAll(dir)
  return { moments: r.found.map((x) => x.moment), skipped: r.skipped }
}

/** Request ids already saved as practice moments (for the review's "Saved" state). */
export function savedRequestIds(dir: string): Set<string> {
  return new Set(loadPracticeMoments(dir).moments.map((m) => m.request_id).filter((x): x is string => typeof x === 'string'))
}

/**
 * Write a new moment. Never replaces a file: the same card saved again reports it's already saved
 * and, with `refresh`, updates only Keith's feedback in it (refreshFeedback), wherever it is now.
 */
export function savePracticeMoment(dir: string, m: Scenario, opts: { refresh?: boolean } = {}): { already: boolean; updated?: boolean; file: string } {
  fs.mkdirSync(dir, { recursive: true })
  const existing = readAll(dir).found.find((x) => m.request_id && x.moment.request_id === m.request_id)
  if (existing && opts.refresh) {
    // As written in the file (readMoment fills defaults the file may not have).
    const saved = JSON.parse(fs.readFileSync(existing.file, 'utf8')) as Scenario
    const tmp = `${existing.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(refreshFeedback(saved, m), null, 2))
    fs.renameSync(tmp, existing.file)
    return { already: true, updated: true, file: existing.file }
  }
  if (existing) return { already: true, file: existing.file }
  const file = path.join(dir, `${m.id}.json`)
  try {
    fs.writeFileSync(file, JSON.stringify(m, null, 2), { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { already: true, file }
    throw err
  }
  return { already: false, file }
}
