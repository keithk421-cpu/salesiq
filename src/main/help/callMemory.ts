/**
 * Per-call memory for HELP: turns (with the session time they became available), provisional
 * interim text, gaps, speaker labels and call setup. Live calls feed it from session events;
 * replay feeds it from scenario files. Queries are "as of" a time, so nothing from the future
 * (later transcript, post-call corrections) can leak into a HELP request.
 */
import type { Stream } from '../../shared/contracts'
import type { CallNotes, CallSetup, MemoryGap, MemoryTurn, SpeakerLabel } from '../../shared/help'
import { Db, ftsQuery } from '../db'
import type { EarlierCallItem } from './accountMemory'

export const DEFAULT_SETUP: CallSetup = { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' }

interface Interim {
  text: string
  at_ms: number
}

export class CallMemory {
  setup: CallSetup = { ...DEFAULT_SETUP }
  readonly labels = new Map<string, SpeakerLabel>()
  private turns = new Map<string, MemoryTurn>()
  private interims = new Map<Stream, Interim>()
  private gaps = new Map<string, MemoryGap>()
  /** Latest measured speech-service delay per stream (ms). */
  readonly lagMs = new Map<Stream, number>()
  /** Running call notes (live calls, set by the notes keeper) and the session time they cover up to. */
  callNotes: { notes: CallNotes; as_of_ms: number } | null = null
  /** What earlier calls with this account left behind (account memory), set at call start; this call is never in it. */
  earlierCalls: EarlierCallItem[] = []
  /**
   * There were earlier calls with this account, even if they left nothing for earlierCalls (no wrap-up
   * items, or only must-learns Keith set out to learn again): an opening press is then never a first call.
   */
  hadEarlierCalls = false
  /**
   * "What I know about <account>" (M4): Keith's own notes on this call's account, set at call start and
   * when he saves them or changes the account. HELP may check them as a question, never as said.
   */
  keithNotes = ''
  /**
   * Live calls only: how long (ms) the meeting audio has had sound with no words back from the speech
   * service (session.ts untranscribedMs). Replay and tests leave it unset (heard.ts blindNote).
   */
  untranscribedMs: (() => number) | null = null

  constructor(readonly sessionId: string, private readonly db: Db | null = null, private readonly aliases: Map<string, string[]> = new Map()) {}

  /** Insert or update a turn (open turns grow; finals are indexed for earlier-in-call search). */
  upsertTurn(t: MemoryTurn, final: boolean): void {
    const prev = this.turns.get(t.id)
    // Keep the first availability time of the first words; text/end grow as words arrive.
    const merged: MemoryTurn = prev ? { ...t, available_ms: Math.min(prev.available_ms, t.available_ms) } : t
    this.turns.set(t.id, merged)
    if (final && this.db) {
      this.db.sql.prepare(
        `INSERT OR REPLACE INTO turns (session_id, turn_id, stream, cluster, start_ms, end_ms, available_ms, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(this.sessionId, t.id, t.stream, t.cluster, Math.round(t.start_ms), Math.round(t.end_ms), Math.round(merged.available_ms), t.text)
      this.db.sql.prepare('DELETE FROM turns_fts WHERE session_id = ? AND turn_id = ?').run(this.sessionId, t.id)
      this.db.sql.prepare('INSERT INTO turns_fts (text, session_id, turn_id) VALUES (?, ?, ?)').run(t.text, this.sessionId, t.id)
    }
  }

  setInterim(stream: Stream, text: string, atMs: number): void {
    if (text) this.interims.set(stream, { text, at_ms: atMs })
    else this.interims.delete(stream)
  }

  clearInterims(): void {
    this.interims.clear()
  }

  upsertGap(g: MemoryGap): void {
    this.gaps.set(g.id, g)
  }

  setLabel(label: SpeakerLabel): void {
    this.labels.set(label.cluster, label)
    this.db?.sql.prepare(
      'INSERT OR REPLACE INTO speaker_labels (session_id, cluster, role, name, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(this.sessionId, label.cluster, label.role, label.name, new Date().toISOString())
  }

  /**
   * The other side: meeting audio, except someone Keith tagged as an Arize teammate (an unlabeled
   * speaker counts: usually theirs). Keith's mic never is.
   */
  fromTheirSide(t: { stream: Stream; cluster: string | null }): boolean {
    if (t.stream !== 'system_remote') return false
    return !(t.cluster && this.labels.get(t.cluster)?.role === 'teammate')
  }

  /** Turns whose text was available at `atMs`, ordered by start. */
  turnsAsOf(atMs: number): MemoryTurn[] {
    return [...this.turns.values()].filter((t) => t.available_ms <= atMs).sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id))
  }

  interimsAsOf(atMs: number): Array<{ stream: Stream; text: string }> {
    return [...this.interims.entries()].filter(([, v]) => v.at_ms <= atMs).map(([stream, v]) => ({ stream, text: v.text }))
  }

  gapsAsOf(atMs: number): MemoryGap[] {
    return [...this.gaps.values()].filter((g) => g.start_ms <= atMs)
  }

  /**
   * Earlier-in-call evidence: turns ending before `beforeMs` that match `text`, available at `atMs`.
   * Uses SQLite FTS5 when persisted, otherwise an in-memory term match (replay/tests).
   */
  searchEarlier(text: string, beforeMs: number, atMs: number, limit = 3): MemoryTurn[] {
    const q = ftsQuery(text, this.aliases)
    if (!q) return []
    const eligible = (t: MemoryTurn | undefined): t is MemoryTurn => !!t && t.end_ms < beforeMs && t.available_ms <= atMs
    if (this.db) {
      try {
        const rows = this.db.sql.prepare(
          `SELECT turn_id FROM turns_fts WHERE turns_fts MATCH ? AND session_id = ? ORDER BY bm25(turns_fts) LIMIT 20`,
        ).all(q, this.sessionId) as Array<{ turn_id: string }>
        return rows.map((r) => this.turns.get(r.turn_id)).filter(eligible).slice(0, limit)
      } catch {
        return []
      }
    }
    const terms = q.split(' OR ').map((s) => s.replace(/"/g, ''))
    return [...this.turns.values()]
      .filter(eligible)
      .map((t) => ({ t, score: terms.filter((w) => t.text.toLowerCase().includes(w)).length }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.t)
  }
}
