/**
 * Keith's practice moments: one real HELP press saved as a replayable scenario, in the same format
 * as evals/scenarios/help (SCHEMA.md), so the speed test can re-run HELP on it later.
 *
 * Built from the call as it stood at the press, so replay stays time-honest:
 * - only turns HELP could see then (available_ms <= the press); words spoken after the press are cut;
 *   every kept line is timed so replay shows it as a finished line, as the live request did;
 * - speaker labels set by then, the call setup (type, goal, outcomes, account, deployment);
 * - the approved knowledge sections the request used, copied in (approved, with source, version and
 *   scope) so later edits to the knowledge folder don't change the moment. Review dates are dropped:
 *   the moment replays as it was then.
 * Expected moves come only from Keith's own feedback, conservatively (see expectedFrom).
 *
 * Saved as <userData>/practice/<id>.json. They hold real call text: never in the repo, never copied
 * by "Save support files".
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Stream } from '../../shared/contracts'
import type { CallSetup, HelpCardContent, HelpContextRefs, KnowledgeDocMeta } from '../../shared/help'
import { CALL_TYPES, DEPLOYMENTS } from '../../shared/help'
import type { Db } from '../db'
import { DEFAULT_SETUP } from './callMemory'
import { fmtClock } from './context'
import { localStamp } from './feedbackExport'
import { FINAL_DELAY_MS, type ObservedCard, type Scenario } from './replay'
import { readFeedback } from './scorecard'

/** Folder under the app's data folder. */
export const PRACTICE_DIR = 'practice'

/** A transcript gap as the call's transcript.jsonl records it (session ms). */
export interface PracticeGap {
  stream: Stream
  cause: string
  start_ms: number
  end_ms: number | null
}

export type PracticeBuild = { ok: true; moment: Scenario } | { ok: false; reason: string }

const RATING_TEXT: Record<string, string> = { useful: 'Useful', should_have_stayed_quiet: "Should've stayed quiet", bad: 'Bad' }

interface RequestRow {
  id: string
  session_id: string | null
  created_at: string
  at_session_ms: number | null
  model_json: string
  context_refs_json: string | null
  card_json: string | null
}

function parse<T>(s: string | null | undefined): Partial<T> {
  try {
    return s ? (JSON.parse(s) as Partial<T>) : {}
  } catch {
    return {}
  }
}


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
    'SELECT id, session_id, created_at, at_session_ms, model_json, context_refs_json, card_json FROM help_requests WHERE id = ?',
  ).get(requestId) as RequestRow | undefined
  if (!row || !row.session_id) return { ok: false, reason: "That card isn't saved any more." }
  if (row.at_session_ms === null || !row.card_json) return { ok: false, reason: 'This card has no line to practice on.' }
  const atMs = row.at_session_ms
  const sid = row.session_id
  const session = db.sql.prepare('SELECT setup_json FROM sessions WHERE id = ?').get(sid) as { setup_json: string } | undefined
  const raw = parse<CallSetup>(session?.setup_json)
  const setup: CallSetup = {
    ...DEFAULT_SETUP,
    call_type: (CALL_TYPES as readonly string[]).includes(raw.call_type ?? '') ? raw.call_type! : DEFAULT_SETUP.call_type,
    call_goal: typeof raw.call_goal === 'string' ? raw.call_goal : '',
    desired_outcomes: Array.isArray(raw.desired_outcomes) ? raw.desired_outcomes.filter((x): x is string => typeof x === 'string') : [],
    account: typeof raw.account === 'string' ? raw.account : '',
    deployment: (DEPLOYMENTS as readonly string[]).includes(raw.deployment ?? '') ? raw.deployment! : 'unknown',
  }
  const refs = parse<HelpContextRefs>(row.context_refs_json)
  const notes: string[] = []

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

  // Labels as they were at the press (the request's context was built then); unlabeled speakers stay unknown.
  const speakers: Scenario['speakers'] = {}
  const labels = db.sql.prepare('SELECT cluster, role, name, updated_at FROM speaker_labels WHERE session_id = ? ORDER BY cluster').all(sid) as Array<{ cluster: string; role: string; name: string | null; updated_at: string }>
  for (const l of labels) {
    if (l.updated_at > row.created_at) continue
    speakers[l.cluster] = { role: l.role === 'buyer' || l.role === 'teammate' ? l.role : 'unknown', name: l.name }
  }
  for (const l of transcript) if (l.who !== 'keith' && l.who !== 'remote' && !speakers[l.who]) speakers[l.who] = { role: 'unknown', name: null }

  // The press time (unless it came within the first second: then just late enough to show the lines).
  const helpAtS = Math.max(atMs, lastEnd + FINAL_DELAY_MS + 1) / 1000
  // Gaps that had started by the press. One still open then keeps an end after the press (replay
  // treats it as open), so when it closed is never written.
  const gaps = (opts.gaps?.(sid) ?? [])
    .filter((g) => g.cause !== 'pause' && g.start_ms <= atMs)
    .map((g) => ({ start: g.start_ms / 1000, end: g.end_ms !== null && g.end_ms <= atMs ? g.end_ms / 1000 : helpAtS + 1, stream: g.stream, cause: g.cause }))

  // Approved knowledge the request used, copied as it is now. A section that's gone or changed since the call is left out.
  const chunkIds = Array.isArray(refs.knowledge_chunk_ids) ? refs.knowledge_chunk_ids : []
  const hashes = Array.isArray(refs.knowledge_hashes) ? refs.knowledge_hashes : null
  const knowledge: NonNullable<Scenario['knowledge']> = []
  let missing = 0
  let changed = 0
  const chunkStmt = db.sql.prepare(
    'SELECT c.chunk_id, c.heading, c.text, c.source_ref, d.meta_json FROM knowledge_chunks c JOIN knowledge_docs d ON d.doc_id = c.doc_id WHERE c.chunk_id = ?',
  )
  chunkIds.forEach((id, i) => {
    const c = chunkStmt.get(id) as { chunk_id: string; heading: string; text: string; source_ref: string; meta_json: string } | undefined
    if (!c) {
      missing++
      return
    }
    const meta = parse<KnowledgeDocMeta>(c.meta_json)
    if (hashes && hashes[i] !== meta.content_hash) {
      changed++
      return
    }
    knowledge.push({
      id: c.chunk_id.replace(/^k:/, '').replace(/[^a-z0-9-]+/gi, '-'),
      title: meta.title ?? 'Knowledge',
      // Pack format, so replay indexes it as the same one section with its whole "Source:" paragraph.
      text: [c.heading ? `## ${c.heading}` : '', c.text, c.source_ref].filter(Boolean).join('\n\n'),
      category: meta.category,
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
  const said = observed.primary ? `${observed.primary_kind === 'say' ? 'Say' : 'Ask'} "${observed.primary}"${observed.follow_up ? `, then "${observed.follow_up}"` : ''}` : '(no line)'
  const rating = observed.rating ? `${RATING_TEXT[observed.rating] ?? observed.rating}${observed.bad_reasons.length ? ` (${observed.bad_reasons.map((r) => r.replace(/_/g, ' ')).join(', ')})` : ''}` : 'not rated'
  const keithNotes = [
    `Saved from a real call: ${title}, HELP pressed at ${fmtClock(atMs)} into the call.`,
    `On the call HELP said: ${said}${observed.move ? ` (move: ${observed.move})` : ''}.`,
    `Keith's feedback: ${rating}${observed.used ? '; used the line' : ''}${observed.note ? `; note: "${observed.note}"` : ''}.`,
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
    speakers,
    transcript,
    gaps,
    help_at_s: helpAtS,
    knowledge,
    best_moves: [],
    acceptable_moves: expected.acceptable,
    ...(expected.unacceptable.length ? { unacceptable_moves: expected.unacceptable } : {}),
    unacceptable_behaviors: expected.unacceptable.map((m) => `Picks the move HELP gave on the call (${m}), which Keith rated Bad: wrong move`),
    silence_preferred: false,
    observed,
    keith_notes: keithNotes,
  }
  return { ok: true, moment }
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

function readMoment(file: string): Scenario | null {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Scenario>
    if (typeof m.id !== 'string' || !Array.isArray(m.transcript) || typeof m.help_at_s !== 'number' || typeof m.speakers !== 'object' || !m.speakers) return null
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

/** Write a new moment. Never overwrites: the same card saved twice reports it's already saved. */
export function savePracticeMoment(dir: string, m: Scenario): { already: boolean; file: string } {
  fs.mkdirSync(dir, { recursive: true })
  const existing = readAll(dir).found.find((x) => m.request_id && x.moment.request_id === m.request_id)
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
