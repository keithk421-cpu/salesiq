/**
 * HELP engine: manual, unrestricted by speaker role.
 *
 * Request rules (Keith's M1 corrections):
 * - A new press supersedes any pending request; an older response can never overwrite a newer one.
 * - A completed card is never rewritten; only a new press replaces it.
 * - Pause/Stop cancel pending work and suppress late results.
 * - Timing: hotkey -> first complete usable line, hotkey -> fully validated card; tokens + cost recorded.
 *
 * Latency levers:
 * - Prefetch: after someone finishes speaking, a candidate card is prepared in the background
 *   (never shown unless Keith presses, and only used if nothing new was said since).
 * - Cache/connection pre-warm at session start and keep-warm while live.
 * - Approved passage: found at the press and sent with its very first card event, so something
 *   trustworthy is on screen before Claude answers (passage.ts). It stays if Claude fails.
 */
import { randomUUID } from 'node:crypto'
import type { ApprovedPassage, Deployment, FeedbackEvent, HelpCardContent, HelpCardEvent, HelpModelConfig, HelpOrigin, HelpStatus, HelpTiming, HelpUsage, PressMode } from '../../shared/help'
import type { HeardLine } from '../../shared/help'
import type { Stream } from '../../shared/contracts'
import type { Db } from '../db'
import type { KnowledgeBase } from '../knowledge'
import type { CallMemory } from './callMemory'
import { buildHelpContext, type BuiltContext } from './context'
import { describeError, type HelpError, type HelpModel } from './models'
import { findApprovedPassage } from './passage'
import { buildSystemPrompt, type Playbook } from './prompt'
import { LineProtocolParser, cardChecks, issueKind, streamingChecks, validateCard } from './protocol'
import { planStillOpen, type WrapWhy } from './wrap'
import { blindNote, heardLine, keithFiller, theyAsked, withoutTrailingFiller } from './heard'
import { keithNotesChecks } from './keithNotes'
import { ANGLE_EARLIER_MAX, anotherAngleOk, decidePress, pressUserMessage, type PressDecision, type PressDetail, type PriorCard } from './pressModes'

export interface HelpEngineDeps {
  memory: CallMemory
  kb: KnowledgeBase | null
  model: HelpModel
  config: HelpModelConfig
  playbook: Playbook
  db: Db | null
  /** Current session time (ms) - the "as of" time for context. */
  sessionNowMs: () => number
  emit: (ev: HelpCardEvent) => void
  /** Diagnostics: ids, timings, statuses, token counts only - never transcript or card text. */
  log: (event: string, data?: Record<string, unknown>) => void
  prefetch?: boolean
  /** Wall clock in ms (injectable for tests). */
  wallNow?: () => number
  /** A key, credit or model-access problem that pressing again won't fix (background work stops). */
  onBlocked?: (e: HelpError | null) => void
  /**
   * Every finished request, shown or background: null when Claude answered, else the error. Not called
   * for HELP's own deadline or a cancel (they say nothing about the key or the connection).
   */
  onResult?: (e: HelpError | null) => void
}

interface Run {
  id: string
  seq: number
  origin: HelpOrigin
  prefetch: boolean
  /** Signature of the final transcript the context was built from. */
  snapshotKey: string
  ctx: BuiltContext
  parser: LineProtocolParser
  abort: AbortController
  status: HelpStatus
  startedWall: number
  /** When Keith pressed (for prefetch adoption: the press time, not the prefetch start). */
  pressedWall: number | null
  firstTokenWall: number | null
  completeWall: number | null
  content: Partial<HelpCardContent>
  card: HelpCardContent | null
  issues: string[]
  usage: HelpUsage | null
  /** Plain words for Keith; errorCode is what logs keep. */
  error: string | null
  errorCode: string | null
  /** Plain-language warnings about the finished card (an unbacked number or claim). */
  checks: string[]
  /** Who the call is with, as set when the request was built. */
  setup: { account: string; deployment: Deployment }
  /** The other side's words the card answers, as at the press (null: none, or a background run nobody pressed for). */
  heard: HeardLine | null
  raw: string
  done: Promise<void>
  /** The approved passage found when Keith pressed (null: none, or a background run nobody pressed for). */
  passage: ApprovedPassage | null
  /** When the first event carrying the passage went out. */
  passageShownWall: number | null
  /** Stage timings (ms): building the context, and the knowledge search inside it. */
  contextMs: number
  knowledgeMs: number
  /** Asked for a wrap card (the WRAP button, or closing words before a HELP press); null: a normal card. */
  wrap: WrapWhy | null
  /** A smarter press (M3, pressModes.ts): the opening, a buying signal's next step, or another angle; null: none. */
  mode: PressMode | null
  /** What that press's block shows (the signal, the line already given, the must-learns, WRAP's latest signal). */
  detail: PressDetail
  /** Another angle: the card it was asked on (its id, kept with the request). */
  angleOf: string | null
  /** Approved knowledge was in this request's context (so the card could still cite it). */
  knowledgeInContext: boolean
  /** How many checks were on screen while the line was still streaming (diagnostics). */
  earlyChecks: number
}

const PREFETCH_DEBOUNCE_MS = 700
const PREFETCH_MAX_AGE_MS = 25_000
/** Background candidates are capped so a fast back-and-forth can't run up cost. */
const PREFETCH_PER_MINUTE = 4
const KEEP_WARM_MS = 4 * 60_000

export class HelpEngine {
  private seq = 0
  /** The run currently shown (or being shown) to Keith. */
  private current: Run | null = null
  private prefetchRun: Run | null = null
  private prefetchTimer: NodeJS.Timeout | null = null
  private warmTimer: NodeJS.Timeout | null = null
  private lastRequestWall = 0
  private cancelled = false
  private prefetchStarts: number[] = []
  /** Set by a key/credit/model-access error: no background work until a request succeeds again. */
  private blocked: HelpError | null = null
  private readonly system: string
  private readonly wallNow: () => number

  constructor(private readonly d: HelpEngineDeps) {
    this.system = buildSystemPrompt(d.playbook)
    this.wallNow = d.wallNow ?? (() => performance.now())
  }

  get modelLabel(): string {
    return this.d.model.label(this.d.config)
  }

  /** A request Keith pressed for is still being answered (background call notes wait for it). */
  get pressInFlight(): boolean {
    const r = this.current
    return !!r && (r.status === 'pending' || r.status === 'streaming')
  }

  /** Keith pressed HELP (hotkey or button). Returns the request id. */
  press(origin: HelpOrigin = 'help_requested'): string {
    this.cancelled = false
    const pressedWall = this.wallNow()
    const key = this.snapshotKey()
    // Any words still being transcribed (even a short "No, not yet") mean the moment moved on since a prefetch,
    // except Keith's own short filler ("Great question, so…"; heard.ts). Sound with no words back yet means
    // it may have too: a fresh request is told so (context.ts).
    const liveSpeech = this.blindAtPress() || this.d.memory.interimsAsOf(this.d.sessionNowMs()).some((i) => i.text.trim().length > 0 && !keithFiller(i))
    if (this.current && this.current.status !== 'complete' && this.current.status !== 'failed' && this.current.status !== 'timeout') {
      this.finish(this.current, 'superseded')
    }
    // Found now (also for a prefetched card), so it goes out with this press's very first event.
    const passage = this.findPassage()
    // Another angle on the card on screen (nothing new said since): a fresh request, never the candidate.
    const angle = origin === 'help_requested' ? this.angleOn(pressedWall, key, liveSpeech) : null
    // Which press this is (pressModes.ts): WRAP, or HELP while the call sounds like it's ending, is always
    // a fresh request for a next-step card; an opening or buying-signal press can use a candidate built for it.
    const decision = decidePress(origin, this.d.memory, this.d.sessionNowMs(), angle?.prior ?? null, angle?.earlier)
    const wrap = decision.wrap
    if (angle) this.recordFeedback({ card_id: angle.run.id, origin: angle.run.origin, type: 'passed', bad_reason: null, optional_note: null })

    // Reuse a prefetched candidate only if nothing new was said since it was built.
    const pf = this.prefetchRun
    if (pf && !wrap && !angle && pf.mode === decision.mode && JSON.stringify(pf.detail) === JSON.stringify(decision.detail) && !liveSpeech && pf.snapshotKey === key && pressedWall - pf.startedWall < PREFETCH_MAX_AGE_MS && pf.status !== 'failed' && pf.status !== 'timeout' && pf.status !== 'cancelled') {
      this.prefetchRun = null
      pf.seq = ++this.seq
      pf.origin = origin
      pf.pressedWall = pressedWall
      pf.passage = passage
      pf.heard = heardLine(this.d.memory, this.d.sessionNowMs())
      this.current = pf
      this.d.log('help_press', { request_id: pf.id, seq: pf.seq, served_from_prefetch: true, prefetch_status: pf.status, passage: !!passage, press_mode: pf.mode, signal: pf.detail.signal ?? null })
      // On screen first; shown now, so its request is kept like any pressed request.
      this.emit(pf)
      this.persist(pf, this.userMessage(pf))
      return pf.id
    }
    this.abortPrefetch()
    const run = this.start(origin, false, pressedWall, passage, wrap, decision, angle?.run.id ?? null)
    this.d.log('help_press', {
      request_id: run.id, seq: run.seq, served_from_prefetch: false, passage: !!passage, wrap: wrap !== null, closing: wrap === 'closing',
      press_mode: decision.mode, signal: decision.detail.signal ?? null, angle_of: run.angleOf, wrap_signal: decision.detail.wrap_signal?.kind ?? null,
    })
    return run.id
  }

  /**
   * The card Keith would get another angle on: the one on screen, finished, shown for ~2-20 s, and
   * built from the same transcript as now with no words still being transcribed (nothing new said).
   * When that card was itself another angle, the ones he passed on before it come too (the last 2).
   */
  private angleOn(pressedWall: number, key: string, liveSpeech: boolean): { run: Run; prior: PriorCard; earlier: PriorCard[] } | null {
    const r = this.current
    if (!r || r.status !== 'complete' || !r.card || r.completeWall === null) return null
    // Never on a wrap card: HELP again as the call ends goes back through WRAP or closing words for a next step.
    if (r.wrap !== null) return null
    // On screen from when it finished, or from the press that showed an already finished candidate.
    const shownWall = Math.max(r.completeWall, r.pressedWall ?? r.completeWall)
    if (!anotherAngleOk(shownWall, pressedWall, !liveSpeech && r.snapshotKey === key)) return null
    const earlier = r.mode === 'another_angle' ? [...(r.detail.earlier ?? []), ...(r.detail.prior ? [r.detail.prior] : [])].slice(-ANGLE_EARLIER_MAX) : []
    return { run: r, prior: { move: r.card.move, primary_kind: r.card.primary_kind, primary: r.card.primary }, earlier }
  }

  /** The approved passage for what the other side just said; a problem finding it never stops HELP. */
  private findPassage(): ApprovedPassage | null {
    try {
      return findApprovedPassage({ kb: this.d.kb, memory: this.d.memory, atMs: this.d.sessionNowMs() })
    } catch (err) {
      this.d.log('help_passage_failed', { message: (err as Error).message })
      return null
    }
  }

  /**
   * Call when new final transcript words arrive. After the other side speaks, schedules a background
   * candidate; Keith's own words only cancel a pending one (he's talking, so it would be stale).
   * `text` is the turn's words: Keith's short filler ("Mm-hmm.") cancels nothing, as at a press (heard.ts).
   */
  onFinalWords(stream: Stream = 'system_remote', text?: string): void {
    if (!this.d.prefetch || this.d.model.mock || this.cancelled || this.blocked) return
    // His "Mm-hmm" often comes back inside the 700 ms debounce: the card waiting for it must still start,
    // or there's no ready card for the filler rule to keep.
    if (text !== undefined && keithFiller({ stream, text })) return
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer)
    this.prefetchTimer = null
    if (stream !== 'system_remote') return
    this.prefetchTimer = setTimeout(() => this.prefetchNow(), PREFETCH_DEBOUNCE_MS)
  }

  /**
   * The speech service says the other side finished speaking (Deepgram speech_final or UtteranceEnd on
   * the meeting audio): the background card waiting for its debounce starts now. Nothing waiting (Keith
   * spoke since, or it already started) means nothing to do; the debounce stays the fallback.
   * speech_final comes after any 300 ms pause, often mid-explanation, and each early start counts toward
   * the per-minute cap: so it starts early only when their last words were a question (heard.ts).
   */
  onSpeechEnd(stream: Stream, signal: 'speech_final' | 'utterance_end' = 'speech_final'): void {
    if (stream !== 'system_remote' || !this.prefetchTimer) return
    if (signal === 'speech_final' && !theyAsked(this.d.memory, this.d.sessionNowMs())) return
    clearTimeout(this.prefetchTimer)
    this.d.log('help_prefetch_early', { signal })
    this.prefetchNow()
  }

  /** Start the background candidate, unless one for this moment exists or the per-minute cap is reached. */
  private prefetchNow(): void {
    this.prefetchTimer = null
    if (this.cancelled || this.blocked) return
    const key = this.snapshotKey()
    if (this.prefetchRun && this.prefetchRun.snapshotKey === key) return
    const now = this.wallNow()
    this.prefetchStarts = this.prefetchStarts.filter((t) => now - t < 60_000)
    if (this.prefetchStarts.length >= PREFETCH_PER_MINUTE) {
      this.d.log('help_prefetch_capped', { per_minute: PREFETCH_PER_MINUTE })
      return
    }
    this.prefetchStarts.push(now)
    this.abortPrefetch()
    // Built for the press it would serve: an opening or buying-signal press gets its block (never a wrap card).
    const d = decidePress('help_requested', this.d.memory, this.d.sessionNowMs())
    this.prefetchRun = this.start('help_requested', true, null, null, null, d.wrap ? undefined : d)
  }

  /** The meeting audio is untranscribed at the press (heard.ts): logged as a number only. */
  private blindAtPress(): boolean {
    const b = blindNote(this.d.memory)
    if (b) this.d.log('help_listening_blind', { blind_ms: b.ms })
    return !!b
  }

  /** Pause/Stop: cancel all pending work and suppress late results. */
  cancelAll(reason: 'pause' | 'stop' | 'shutdown'): void {
    this.cancelled = true
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer)
    this.prefetchTimer = null
    this.abortPrefetch()
    if (this.current && (this.current.status === 'pending' || this.current.status === 'streaming')) this.finish(this.current, 'cancelled')
    this.stopKeepWarm()
    this.d.log('help_cancel_all', { reason })
  }

  resume(): void {
    this.cancelled = false
  }

  /** Warm the connection + cached system prompt, then keep it warm while live. */
  async prewarm(): Promise<void> {
    if (this.d.model.mock) return
    try {
      const t0 = this.wallNow()
      await this.d.model.prewarm(this.system, this.d.config)
      this.d.log('help_prewarm', { ms: Math.round(this.wallNow() - t0) })
    } catch (err) {
      this.d.log('help_prewarm_failed', { message: (err as Error).message })
    }
    this.lastRequestWall = this.wallNow()
    this.startKeepWarm()
  }

  private startKeepWarm(): void {
    this.stopKeepWarm()
    this.warmTimer = setInterval(() => {
      if (this.cancelled || this.blocked || this.wallNow() - this.lastRequestWall < KEEP_WARM_MS) return
      void this.prewarm()
    }, 60_000)
  }

  private stopKeepWarm(): void {
    if (this.warmTimer) clearInterval(this.warmTimer)
    this.warmTimer = null
  }

  recordFeedback(f: Omit<FeedbackEvent, 'timestamp'>): FeedbackEvent {
    const ev: FeedbackEvent = { ...f, timestamp: new Date().toISOString() }
    this.d.db?.sql.prepare('INSERT INTO feedback (card_id, origin, type, bad_reason, note, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ev.card_id, ev.origin, ev.type, ev.bad_reason, ev.optional_note, ev.timestamp)
    this.d.log('help_feedback', { card_id: ev.card_id, origin: ev.origin, type: ev.type, bad_reason: ev.bad_reason })
    return ev
  }

  dispose(): void {
    this.cancelAll('shutdown')
  }

  // ------------------------------------------------------------------ internals

  /** Signature of the final transcript as of now (what the context would be built from); Keith's trailing filler isn't new (heard.ts). */
  private snapshotKey(): string {
    const turns = withoutTrailingFiller(this.d.memory.turnsAsOf(this.d.sessionNowMs())).slice(-6)
    const gaps = this.d.memory.gapsAsOf(this.d.sessionNowMs()).map((g) => `${g.id}:${g.end_ms ?? 'open'}`).join(',')
    const labels = [...this.d.memory.labels.values()].map((l) => `${l.cluster}=${l.role}/${l.name ?? ''}`).join(',')
    return `${turns.map((t) => `${t.id}:${t.text.length}`).join('|')}#${gaps}#${labels}`
  }

  private start(origin: HelpOrigin, prefetch: boolean, pressedWall: number | null, passage: ApprovedPassage | null = null, wrap: WrapWhy | null = null, press?: PressDecision, angleOf: string | null = null): Run {
    const atMs = this.d.sessionNowMs()
    const c0 = this.wallNow()
    const ctx = buildHelpContext({ memory: this.d.memory, kb: this.d.kb, atMs, clock: this.wallNow })
    const contextMs = Math.max(0, Math.round(this.wallNow() - c0))
    const run: Run = {
      id: randomUUID(),
      seq: prefetch ? 0 : ++this.seq,
      origin,
      prefetch,
      snapshotKey: this.snapshotKey(),
      ctx,
      parser: new LineProtocolParser(this.wallNow),
      abort: new AbortController(),
      status: 'pending',
      startedWall: this.wallNow(),
      pressedWall,
      firstTokenWall: null,
      completeWall: null,
      content: {},
      card: null,
      issues: [],
      usage: null,
      error: null,
      errorCode: null,
      checks: [],
      setup: { account: this.d.memory.setup.account, deployment: this.d.memory.setup.deployment },
      heard: prefetch ? null : heardLine(this.d.memory, atMs),
      raw: '',
      done: Promise.resolve(),
      passage,
      passageShownWall: null,
      contextMs,
      knowledgeMs: ctx.knowledge_ms,
      wrap,
      mode: press?.mode ?? null,
      detail: press?.detail ?? {},
      angleOf,
      knowledgeInContext: [...ctx.sources.values()].some((x) => x.kind === 'knowledge'),
      earlyChecks: 0,
    }
    if (!prefetch) this.current = run
    this.lastRequestWall = run.startedWall
    // The first card (with any approved passage) goes on screen before the request is written to disk.
    if (!prefetch) this.emit(run)
    this.persist(run, this.userMessage(run))
    run.done = this.execute(run)
    return run
  }

  /** What this run sends: the call context, then the HELP, wrap-card or press instruction (also what is kept on disk). */
  private userMessage(run: Run): string {
    return pressUserMessage(run.ctx.text, run.wrap, run.mode, run.detail)
  }

  private async execute(run: Run): Promise<void> {
    const user = this.userMessage(run)
    const timer = setTimeout(() => run.abort.abort(new Error('timeout')), this.d.config.timeout_ms)
    try {
      const res = await this.d.model.run({
        system: this.system,
        user,
        config: this.d.config,
        signal: run.abort.signal,
        onText: (chunk) => {
          if (this.isDead(run)) return
          if (run.firstTokenWall === null) run.firstTokenWall = this.wallNow()
          run.raw += chunk
          if (run.status === 'pending') run.status = 'streaming'
          if (run.parser.feed(chunk)) {
            run.content = run.parser.partial()
            // Keith may read the line before the card finishes: what's already certain goes up with it.
            run.checks = streamingChecks(run.content, { contextText: run.ctx.text, knowledgeInContext: run.knowledgeInContext })
            run.earlyChecks = Math.max(run.earlyChecks, run.checks.length)
            this.emit(run)
          }
        },
      })
      if (this.isDead(run)) return
      run.parser.end()
      run.content = run.parser.partial()
      run.usage = res.usage
      this.setBlocked(null)
      this.d.onResult?.(null)
      if (res.stop_reason === 'refusal') {
        run.error = 'Claude declined to answer this one. Press HELP again.'
        run.errorCode = 'refusal'
        this.finish(run, 'failed')
        return
      }
      const v = validateCard(run.content, run.parser.fieldOrder, {
        knownSourceIds: new Set(run.ctx.sources.keys()),
        contextText: run.ctx.text,
        limits: this.d.playbook.card_limits,
      })
      run.issues = v.issues
      if (!v.ok || !v.card) {
        run.error = "HELP's answer didn't pass its checks. Press HELP again."
        run.errorCode = 'invalid'
        this.finish(run, 'failed')
        return
      }
      run.card = v.card
      run.content = v.card
      run.checks = cardChecks(v.card, v.issues, new Map([...run.ctx.sources].map(([id, x]) => [id, x.kind])))
      run.checks.push(...keithNotesChecks(v.card, run.ctx.text))
      run.completeWall = this.wallNow()
      this.finish(run, 'complete')
    } catch (err) {
      if (this.isDead(run)) return
      const timedOut = run.abort.signal.aborted && (run.abort.signal.reason as Error | undefined)?.message === 'timeout'
      if (timedOut) {
        run.error = `No complete answer within ${Math.round(this.d.config.timeout_ms / 1000)} s. Press HELP again.`
        run.errorCode = 'timeout'
      } else {
        const e = describeError(err)
        run.error = e.message
        run.errorCode = e.code
        if (e.blocking) this.setBlocked(e)
        this.d.onResult?.(e)
      }
      this.finish(run, timedOut ? 'timeout' : 'failed')
    } finally {
      clearTimeout(timer)
    }
  }

  private setBlocked(e: HelpError | null): void {
    if ((this.blocked?.code ?? null) === (e?.code ?? null)) return
    this.blocked = e
    if (e) {
      if (this.prefetchTimer) clearTimeout(this.prefetchTimer)
      this.prefetchTimer = null
      this.abortPrefetch()
    }
    this.d.log('help_blocked', { code: e?.code ?? null })
    this.d.onBlocked?.(e)
  }

  /** A run whose results must be ignored (superseded, cancelled, or a discarded prefetch). */
  private isDead(run: Run): boolean {
    return run.status === 'superseded' || run.status === 'cancelled'
  }

  private finish(run: Run, status: HelpStatus): void {
    if (this.isDead(run) || run.status === 'complete' || run.status === 'failed' || run.status === 'timeout') return
    run.status = status
    if (status === 'superseded' || status === 'cancelled') run.abort.abort(new Error(status))
    // Checks belong to a finished card; a line that never finished is shown struck through instead.
    if (status !== 'complete') run.checks = []
    this.persist(run)
    const t = this.timing(run)
    this.d.log(run.prefetch && run.pressedWall === null ? 'help_prefetch_done' : 'help_done', {
      request_id: run.id, seq: run.seq, status, origin: run.origin, model: this.d.config.model,
      first_usable_ms: t.first_usable_ms, complete_ms: t.complete_ms, first_token_ms: t.first_token_ms,
      served_from_prefetch: t.served_from_prefetch, input_tokens: run.usage?.input_tokens, output_tokens: run.usage?.output_tokens,
      cache_read: run.usage?.cache_read_input_tokens, cost_usd: run.usage?.cost_usd, issues: run.issues.length, error: run.errorCode,
      passage_ms: t.passage_ms, passage_used: run.passage ? this.passageUsed(run) : null, context_ms: t.context_ms, knowledge_ms: t.knowledge_ms,
      wrap: run.wrap, early_checks: run.earlyChecks, checks: run.checks.length, press_mode: run.mode,
    })
    // A finished prefetch nobody pressed for stays in memory, unseen.
    if (run.pressedWall !== null || !run.prefetch) this.emit(run)
  }

  /** Drop the background candidate (what it was built from changed, e.g. earlier calls were deleted). */
  discardPrefetch(): void {
    this.abortPrefetch()
  }

  private abortPrefetch(): void {
    const pf = this.prefetchRun
    this.prefetchRun = null
    if (pf && (pf.status === 'pending' || pf.status === 'streaming')) {
      pf.status = 'cancelled'
      pf.abort.abort(new Error('prefetch discarded'))
      this.persist(pf)
    }
  }

  private timing(run: Run): HelpTiming {
    const pressed = run.pressedWall ?? run.startedWall
    const rel = (t: number | null) => (t === null ? null : Math.max(0, Math.round(t - pressed)))
    return {
      pressed_at_wall: pressed,
      first_usable_ms: rel(run.parser.firstUsableAt),
      complete_ms: run.status === 'complete' ? rel(run.completeWall) : null,
      first_token_ms: rel(run.firstTokenWall),
      served_from_prefetch: run.prefetch && run.pressedWall !== null,
      passage_ms: run.passage ? rel(run.passageShownWall) : null,
      context_ms: run.contextMs,
      knowledge_ms: run.knowledgeMs,
    }
  }

  /** The finished card cites a chunk of the approved passage's section. */
  private passageUsed(run: Run): boolean {
    const p = run.passage
    if (!p || run.status !== 'complete' || !run.card) return false
    return run.card.source_ids.some((s) => {
      const src = run.ctx.sources.get(s)
      return src?.kind === 'knowledge' && p.chunk_ids.includes(src.id)
    })
  }

  private emit(run: Run): void {
    // Never let an older request reach the screen once a newer one exists.
    if (this.current !== run || run.seq !== this.seq) return
    if (run.passage && run.passageShownWall === null) run.passageShownWall = this.wallNow()
    const sources = (run.content.source_ids ?? [])
      .map((s) => run.ctx.sources.get(s))
      .filter((x): x is NonNullable<typeof x> => !!x)
    const ev: HelpCardEvent = {
      request_id: run.id,
      seq: run.seq,
      origin: run.origin,
      status: run.status,
      content: run.content,
      warnings: run.ctx.warnings,
      timing: this.timing(run),
      model_label: this.d.model.label(this.d.config),
      mock: this.d.model.mock,
      error: run.error,
      checks: run.checks,
      setup: run.setup,
      ...(run.heard ? { heard: run.heard } : {}),
      sources,
      passage: run.passage ? { ...run.passage, used_by_card: this.passageUsed(run) } : null,
      ...(run.wrap ? { wrap: true } : {}),
      ...(run.mode ? { press_mode: run.mode } : {}),
    }
    this.d.emit(ev)
  }

  private persist(run: Run, requestText?: string): void {
    const db = this.d.db
    if (!db) return
    const t = this.timing(run)
    // A background prefetch Keith never saw keeps timings, cost and source ids, not the conversation text.
    const shown = !run.prefetch || run.pressedWall !== null
    // Nor what earlier calls left behind: those copies would outlive deleting the earlier call. Once
    // shown, the row is written again with them (a practice moment saved from it replays them).
    const { earlier_calls: _earlier, ...unseenRefs } = run.ctx.refs
    // Nor Keith's own notes (M4): they're his, kept with a request only once he saw its card.
    delete unseenRefs.keith_notes
    db.sql.prepare(
      `INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, context_refs_json, request_text, output_raw, card_json, timing_json, usage_json, error, prefetch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, origin = excluded.origin, request_text = COALESCE(excluded.request_text, help_requests.request_text),
         output_raw = excluded.output_raw, card_json = excluded.card_json, context_refs_json = excluded.context_refs_json,
         timing_json = excluded.timing_json, usage_json = excluded.usage_json, error = excluded.error`,
    ).run(
      run.id, this.d.memory.sessionId, run.origin, new Date().toISOString(), run.ctx.refs.at_session_ms, run.status,
      JSON.stringify({ ...this.d.config, label: this.d.model.label(this.d.config), mock: this.d.model.mock, playbook: this.d.playbook.version }),
      JSON.stringify(shown ? run.ctx.refs : unseenRefs), shown ? (requestText ?? null) : null, shown ? run.raw || null : null, shown && run.card ? JSON.stringify(run.card) : null,
      // Issue details can quote the model's output; an unseen request keeps only what kind they were.
      JSON.stringify({
        ...t, issues: shown ? run.issues : run.issues.map(issueKind), error_code: run.errorCode, checks: run.checks.length,
        // What the card answered (their words, speaker, how long before): only once shown, like the request text.
        ...(shown && run.heard ? { heard: run.heard } : {}),
        // Which approved passage Keith saw at the press, and whether the finished card cited it.
        passage_chunk_ids: run.passage?.chunk_ids ?? null, passage_used: run.passage ? this.passageUsed(run) : null,
        // A wrap card ('button' or 'closing'), so the feedback export and practice moments can tell them apart.
        ...(run.wrap ? { wrap: run.wrap } : {}),
        // A smarter press (codes, ids and call times only), so a practice moment replays the same block.
        ...(run.mode ? { press_mode: run.mode } : {}),
        ...(run.detail.signal ? { press_signal: run.detail.signal } : {}),
        ...(run.angleOf ? { angle_of: run.angleOf } : {}),
        ...(run.detail.earlier_calls ? { press_earlier: true } : {}),
        ...(run.detail.wrap_signal ? { wrap_signal: run.detail.wrap_signal } : {}),
        // WRAP asked a must-learn the notes still had open (a replay has no notes to tell).
        ...(run.wrap === 'button' && planStillOpen(run.ctx.text) ? { wrap_plan: true } : {}),
      }),
      run.usage ? JSON.stringify(run.usage) : null, run.error, run.prefetch ? 1 : 0,
    )
  }
}
