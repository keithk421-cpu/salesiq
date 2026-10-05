/**
 * Keeps the running call notes up to date during a live call, in the background.
 *
 * Update rules:
 * - One request at a time, only while live, after enough NEW finished speech from the other side.
 * - Never starts while a HELP request Keith pressed is being answered: HELP always wins. (One already
 *   running is left to finish: it's a separate request, and stopping it would waste what it cost.)
 * - Spread out: at most one start every NOTES_MIN_GAP_MS (20 an hour), so a talkative call keeps
 *   updating to the end instead of using up the hour early. Every start counts, so a failing model
 *   or connection is retried at that pace too.
 * - Pause cancels an update in flight and drops its late answer; the notes stay on screen.
 * - Stop doesn't cancel: the last minutes (when next steps and promises are made) are what the notes
 *   most often miss. At "stopping" no new regular update starts; at "stopped", once the transcript's
 *   last lines are in, finish() waits for an update in flight, then runs closing updates over every
 *   line still queued (no minimum talk, no spacing; at most 3 passes, 90 s in all).
 * - A key, credit or model-access error stops updates until a request (HELP or notes) succeeds again,
 *   like HELP's own background work.
 * - Delta-only: each request carries the previous notes, the finished lines since them (oldest first,
 *   up to a size cap; the rest waits for the next update) and the call setup, never the whole call.
 * - Any failure keeps the previous notes, and those lines stay queued so nothing is skipped.
 * Logs and the stored counts carry ids, counts, timings, tokens, cost and codes only, never note text.
 */
import type { CallNotesState, HelpModelConfig, HelpUsage, MemoryTurn } from '../../shared/help'
import type { Db } from '../db'
import type { CallMemory } from './callMemory'
import { NOTES_SCHEMA, NOTES_SYSTEM_PROMPT, notesForModel, validateNotes, type CallNotesSnapshot } from './callNotes'
import { fmtClock, speakerName } from './context'
import { describeError, type HelpError, type HelpModel } from './models'

/** About a minute of new talk from the other side, by time or by words (either is enough). */
export const NOTES_MIN_REMOTE_SPEECH_MS = 60_000
export const NOTES_MIN_REMOTE_WORDS = 150
/** Updates per hour at most, so a long call can't run up cost. */
export const NOTES_MAX_PER_HOUR = 20
/**
 * Spread evenly: at most one start every 3 minutes. A rolling-hour limit ran out by minute 40 on a
 * call where the buyer talks half the time, and next steps are mostly agreed near the end.
 */
export const NOTES_MIN_GAP_MS = 3_600_000 / NOTES_MAX_PER_HOUR
export const NOTES_TIMEOUT_MS = 30_000
/**
 * A ceiling, not spend: full notes run to ~1,700 output tokens, and Opus's thinking counts too. A cut-off
 * answer is unusable and would be retried with the same lines, so leave plenty of room.
 */
export const NOTES_MAX_TOKENS = 4000
/** New lines per update, by size (oldest first); a backlog catches up over the next updates. */
export const NOTES_MAX_DELTA_CHARS = 12_000
/** The closing pass after Stop: a few updates at most, and never longer than this in all. */
export const NOTES_CLOSING_MAX_PASSES = 3
export const NOTES_CLOSING_BUDGET_MS = 90_000

/** Per-call counts for the scorecard (numbers and codes only). */
export interface CallNotesStats {
  /** Requests sent. */
  started: number
  /** Answers that replaced the notes. */
  updated: number
  /** Answers that didn't pass the checks (previous notes kept). */
  invalid: number
  /** Errors and timeouts (previous notes kept). */
  failed: number
  /** Stopped by Pause, a quit or a deleted call. */
  cancelled: number
  /** Closing updates run after Stop. */
  closing: number
  /** Times an update was due but waited for the spacing (once per wait). */
  capped: number
  cost_usd: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /** Failure and invalid-answer codes. */
  errors: Record<string, number>
}

export interface CallNotesDeps {
  memory: CallMemory
  model: HelpModel
  config: HelpModelConfig
  db: Db | null
  sessionNowMs: () => number
  /** Keith pressed HELP and it's still being answered. */
  helpBusy: () => boolean
  emit: (s: CallNotesState) => void
  /** Diagnostics: counts, timings, tokens, codes only. */
  log: (event: string, data?: Record<string, unknown>) => void
  /** Setup: "Keep running call notes". */
  enabled: boolean
  /** Wall clock, epoch ms (injectable for tests). */
  now?: () => number
  /** Every finished request except a cancel: null when Claude answered, else the error (HELP-ready light). */
  onResult?: (e: HelpError | null) => void
}

export class CallNotesKeeper {
  private snap: CallNotesSnapshot | null = null
  private updatedAt: number | null = null
  /** ending: Stop was pressed (no new regular updates); finishing: the closing pass is running. */
  private phase: 'not_live' | 'live' | 'paused' | 'ending' | 'finishing' | 'stopped' = 'not_live'
  private run: { seq: number; abort: AbortController } | null = null
  /** The update in flight, so the closing pass can wait for it. */
  private runDone: Promise<unknown> | null = null
  /** The call was deleted or replaced: nothing is written or shown for it again. */
  private disposed = false
  private finishing: Promise<void> | null = null
  private seq = 0
  /** Finished turns not in the notes yet, in the order they finished. */
  private pending: string[] = []
  private included = new Set<string>()
  /** Turn id <-> the short line id the model sees ("L7"), stable for the call. */
  private lineOf = new Map<string, string>()
  private turnOf = new Map<string, string>()
  /** Wall clock of the last start (any outcome counts toward the spacing). */
  private lastStart: number | null = null
  private capHeld = false
  private blocked: HelpError | null = null
  readonly stats: CallNotesStats = {
    started: 0, updated: 0, invalid: 0, failed: 0, cancelled: 0, closing: 0, capped: 0,
    cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, errors: {},
  }
  private readonly now: () => number

  constructor(private readonly d: CallNotesDeps) {
    this.now = d.now ?? (() => Date.now())
  }

  private get on(): boolean {
    return this.d.enabled && typeof this.d.model.notes === 'function'
  }

  state(): CallNotesState {
    const status: CallNotesState['status'] = !this.on ? 'off'
      : this.phase === 'stopped' ? 'stopped'
      : this.blocked ? 'blocked'
      : this.phase === 'ending' || this.phase === 'finishing' ? 'finishing'
      : this.phase === 'paused' ? 'paused'
      : this.run ? 'updating'
      : 'waiting'
    return {
      status, notes: this.snap?.notes ?? null, updated_at: this.updatedAt, as_of_ms: this.snap?.as_of_ms ?? null,
      updates: this.stats.updated, mock: this.d.model.mock, problem: this.blocked?.message ?? null,
    }
  }

  /** A transcript turn finished (either side). */
  onFinalTurn(turnId: string): void {
    if (!this.included.has(turnId) && !this.pending.includes(turnId)) this.pending.push(turnId)
    this.maybeUpdate()
  }

  /** The call went live (first time or after Pause). */
  resume(): void {
    if (this.phase !== 'not_live' && this.phase !== 'paused' && this.phase !== 'live') return
    this.phase = 'live'
    this.emit()
    this.maybeUpdate()
  }

  pause(): void {
    if (this.phase !== 'not_live' && this.phase !== 'live') return
    this.cancel('pause')
    this.phase = 'paused'
    this.emit()
  }

  /** Stop was pressed: no new regular update starts, and one in flight is left to finish. */
  beginFinish(): void {
    if (this.phase === 'stopped' || this.phase === 'finishing') return
    this.phase = 'ending'
    this.emit()
  }

  /**
   * After Stop, once the transcript's last lines have arrived: wait for an update in flight, then
   * cover every line still queued, then stop. Skipped (just stops) when notes are off or blocked. With
   * nothing to do it stops straight away, so the notes read "call ended" as soon as Stop is done.
   */
  finish(): Promise<void> {
    if (this.finishing) return this.finishing
    if (this.phase === 'stopped') return Promise.resolve()
    const work = this.on && !this.blocked && (!!this.run || this.pendingTurns().length > 0)
    if (!work) {
      this.stop()
      return Promise.resolve()
    }
    this.phase = 'finishing'
    this.emit()
    this.finishing = this.closingPass()
    return this.finishing
  }

  /** Quit (or a call that never went live): cancel an update in flight; the notes stay readable. */
  stop(): void {
    if (this.phase === 'stopped') return
    this.cancel('stop')
    this.phase = 'stopped'
    this.persist()
    this.emit()
  }

  /** Drop everything without writing (the call was deleted, or a new call replaces this one). */
  dispose(): void {
    this.disposed = true
    const r = this.run
    this.run = null
    r?.abort.abort(new Error('dispose'))
    this.phase = 'stopped'
  }

  /** A HELP request's outcome: any success lifts a block; a key/credit/model-access error sets one. */
  onHelpResult(e: HelpError | null): void {
    if (!e) this.setBlocked(null)
    else if (e.blocking) this.setBlocked(e)
  }

  // ------------------------------------------------------------------ internals

  private emit(): void {
    this.d.emit(this.state())
  }

  private setBlocked(e: HelpError | null): void {
    if ((this.blocked?.code ?? null) === (e?.code ?? null)) return
    this.blocked = e
    this.d.log('call_notes_blocked', { code: e?.code ?? null })
    this.emit()
  }

  private shortId(turnId: string): string {
    let s = this.lineOf.get(turnId)
    if (!s) {
      s = `L${this.lineOf.size + 1}`
      this.lineOf.set(turnId, s)
      this.turnOf.set(s, turnId)
    }
    return s
  }

  /** Queued turns as they read now (text grows until a turn is final; finals are what's queued). */
  private pendingTurns(): MemoryTurn[] {
    const byId = new Map(this.d.memory.turnsAsOf(this.d.sessionNowMs()).map((t) => [t.id, t]))
    return this.pending.map((id) => byId.get(id)).filter((t): t is MemoryTurn => !!t)
  }

  private maybeUpdate(): void {
    if (!this.on || this.phase !== 'live' || this.blocked || this.run) return
    // HELP always wins: the next finished line checks again.
    if (this.d.helpBusy()) return
    const now = this.now()
    const turns = this.pendingTurns()
    const remote = turns.filter((t) => t.stream === 'system_remote')
    const speechMs = remote.reduce((a, t) => a + Math.max(0, t.end_ms - t.start_ms), 0)
    const words = remote.reduce((a, t) => a + t.text.split(/\s+/).filter(Boolean).length, 0)
    if (speechMs < NOTES_MIN_REMOTE_SPEECH_MS && words < NOTES_MIN_REMOTE_WORDS) return
    // Spread out: the next finished line after the gap starts it.
    if (this.lastStart !== null && now - this.lastStart < NOTES_MIN_GAP_MS) {
      if (!this.capHeld) {
        this.capHeld = true
        this.stats.capped++
        this.d.log('call_notes_capped', { per_hour: NOTES_MAX_PER_HOUR, wait_ms: Math.round(NOTES_MIN_GAP_MS - (now - this.lastStart)) })
      }
      return
    }
    this.capHeld = false
    this.lastStart = now
    void this.track(this.update(turns, { speechMs, words }))
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.runDone = p
    return p
  }

  /** The closing pass (see finish()). Counts, timings and codes are logged, never note text. */
  private async closingPass(): Promise<void> {
    const t0 = this.now()
    const queuedBefore = this.pending.length
    let passes = 0
    let last: 'updated' | 'invalid' | 'failed' | 'dropped' | null = null
    this.d.log('call_notes_closing_start', { queued: queuedBefore, in_flight: !!this.run })
    if (this.run && this.runDone) await this.runDone
    while (!this.disposed && this.phase === 'finishing' && !this.blocked && passes < NOTES_CLOSING_MAX_PASSES) {
      const turns = this.pendingTurns()
      const left = NOTES_CLOSING_BUDGET_MS - (this.now() - t0)
      // Too little time left for a request to finish: what's noted so far stands.
      if (!turns.length || left < 5_000) break
      passes++
      this.stats.closing++
      const remote = turns.filter((t) => t.stream === 'system_remote')
      last = await this.track(this.update(turns, {
        speechMs: remote.reduce((a, t) => a + Math.max(0, t.end_ms - t.start_ms), 0),
        words: remote.reduce((a, t) => a + t.text.split(/\s+/).filter(Boolean).length, 0),
      }, { closing: true, timeoutMs: Math.min(NOTES_TIMEOUT_MS, left) }))
    }
    this.finishing = null
    // Deleted or replaced meanwhile (or the app quit): nothing more is written or shown for it.
    if (this.disposed || this.phase !== 'finishing') return
    this.d.log('call_notes_closing_done', { passes, last, queued_before: queuedBefore, queued_left: this.pending.length, ms: Math.round(this.now() - t0), blocked: !!this.blocked })
    this.phase = 'stopped'
    this.persist()
    this.emit()
  }

  private async update(queued: MemoryTurn[], heard: { speechMs: number; words: number }, o: { closing?: boolean; timeoutMs?: number } = {}): Promise<'updated' | 'invalid' | 'failed' | 'dropped'> {
    const delta: MemoryTurn[] = []
    let chars = 0
    for (const t of queued) {
      chars += t.text.length + 40
      if (delta.length && chars > NOTES_MAX_DELTA_CHARS) break
      delta.push(t)
    }
    const seq = ++this.seq
    const abort = new AbortController()
    this.run = { seq, abort }
    // Notes built from these lines may be used from when the last of them was available (as-of, like HELP).
    const asOf = Math.max(...delta.map((t) => t.available_ms))
    const user = this.userMessage(delta)
    this.stats.started++
    const t0 = this.now()
    const timeoutMs = o.timeoutMs ?? NOTES_TIMEOUT_MS
    this.d.log('call_notes_start', { seq, lines: delta.length, queued: queued.length, remote_words: heard.words, remote_speech_ms: Math.round(heard.speechMs), ...(o.closing ? { closing: true } : {}) })
    this.emit()
    const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs)
    let status: 'updated' | 'invalid' | 'failed' = 'failed'
    let code: string | null = null
    let usage: HelpUsage | null = null
    try {
      const res = await this.d.model.notes!({
        system: NOTES_SYSTEM_PROMPT, user, schema: NOTES_SCHEMA, config: this.d.config, signal: abort.signal,
        max_tokens: NOTES_MAX_TOKENS, timeout_ms: timeoutMs,
      })
      // Paused, quit or deleted meanwhile: the answer is dropped.
      if (this.run?.seq !== seq) return 'dropped'
      usage = res.usage
      this.setBlocked(null)
      this.d.onResult?.(null)
      const v = res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens' ? { ok: false as const, code: res.stop_reason } : validateNotes(res.text, this.turnOf)
      if (v.ok) {
        status = 'updated'
        this.snap = { notes: v.notes, as_of_ms: asOf }
        this.d.memory.callNotes = this.snap
        this.updatedAt = this.now()
        for (const t of delta) this.included.add(t.id)
        this.pending = this.pending.filter((id) => !this.included.has(id))
      } else {
        status = 'invalid'
        code = v.code
      }
    } catch (err) {
      if (this.run?.seq !== seq) return 'dropped'
      if (abort.signal.aborted && (abort.signal.reason as Error | undefined)?.message === 'timeout') code = 'timeout'
      else {
        const e = describeError(err)
        code = e.code
        if (e.blocking) this.setBlocked(e)
        this.d.onResult?.(e)
      }
    } finally {
      clearTimeout(timer)
    }
    this.run = null
    if (usage) {
      this.stats.cost_usd += usage.cost_usd
      this.stats.input_tokens += usage.input_tokens
      this.stats.output_tokens += usage.output_tokens
      this.stats.cache_read_input_tokens += usage.cache_read_input_tokens
      this.stats.cache_creation_input_tokens += usage.cache_creation_input_tokens
    }
    this.stats[status]++
    // The lines stay queued: the next update (after the spacing) tries them again.
    if (code) this.stats.errors[code] = (this.stats.errors[code] ?? 0) + 1
    this.persist()
    const n = this.snap?.notes
    this.d.log('call_notes_done', {
      seq, status, error: code, ms: Math.round(this.now() - t0), model: this.d.config.model,
      input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens, cache_read: usage?.cache_read_input_tokens, cost_usd: usage?.cost_usd,
      items: n ? { topic: n.topic ? 1 : 0, wants: n.buyer_wants.length, open_questions: n.open_questions.length, concerns: n.concerns.length, facts: n.facts.length, next_steps: n.next_steps.length, not_covered: n.not_covered.length } : null,
    })
    this.emit()
    // A backlog (or talk that arrived meanwhile) may already be enough for the next one.
    if (status === 'updated') this.maybeUpdate()
    return status
  }

  private cancel(reason: 'pause' | 'stop'): void {
    const r = this.run
    if (!r) return
    this.run = null
    r.abort.abort(new Error(reason))
    this.stats.cancelled++
    this.d.log('call_notes_done', { seq: r.seq, status: 'cancelled', reason })
    this.persist()
  }

  /** Call setup + previous notes + the new lines only. */
  private userMessage(delta: MemoryTurn[]): string {
    const m = this.d.memory
    const s = m.setup
    const dep = s.deployment === 'saas' ? "Arize's SaaS" : s.deployment === 'self_hosted' ? 'self-hosted' : 'not known (SaaS or self-hosted)'
    const lines = delta.map((t) => `[${this.shortId(t.id)}] (${fmtClock(t.start_ms)}) ${speakerName(m, t)}: ${t.text}`)
    const from = Math.min(...delta.map((t) => t.start_ms))
    const to = Math.max(...delta.map((t) => t.end_ms))
    const gaps = m.gapsAsOf(this.d.sessionNowMs())
      .filter((g) => g.cause !== 'pause' && g.start_ms <= to && (g.end_ms ?? to) >= from)
      .map((g) => `Gap ${fmtClock(g.start_ms)}–${g.end_ms === null ? 'now' : fmtClock(g.end_ms)} on ${g.stream === 'local_mic' ? "Keith's mic" : 'meeting audio'}: nothing was heard then.`)
    const parts = [
      `<call_setup>\ntype: ${s.call_type}\ngoal: ${s.call_goal || '(not set)'}\ndesired outcomes: ${s.desired_outcomes.join('; ') || '(not set)'}\naccount: ${s.account || '(not set)'}\ndeployment: ${dep}\n</call_setup>`,
      `<previous_notes>\n${this.snap ? JSON.stringify(notesForModel(this.snap.notes, (id) => this.lineOf.get(id))) : '(none yet)'}\n</previous_notes>`,
      `<new_lines note="finished lines said since the previous notes, oldest first">\n${lines.join('\n')}\n</new_lines>`,
    ]
    if (gaps.length) parts.push(`<transcript_status>\n${gaps.join('\n')}\n</transcript_status>`)
    parts.push('Return the complete updated notes.')
    return parts.join('\n\n')
  }

  /** The call's latest notes and counts (one row per call; deleting the call deletes it). */
  private persist(): void {
    try {
      this.d.db?.sql.prepare(
        `INSERT INTO call_notes (session_id, notes_json, as_of_ms, updated_at, stats_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET notes_json = excluded.notes_json, as_of_ms = excluded.as_of_ms,
           updated_at = excluded.updated_at, stats_json = excluded.stats_json`,
      ).run(
        this.d.memory.sessionId, this.snap ? JSON.stringify(this.snap.notes) : null, this.snap ? Math.round(this.snap.as_of_ms) : null,
        this.updatedAt === null ? null : new Date(this.updatedAt).toISOString(), JSON.stringify(this.stats),
      )
    } catch (err) {
      this.d.log('call_notes_save_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }
}
