/**
 * Main-process wiring for M1 HELP: local DB, knowledge pack, playbook, settings, per-call
 * memory + engine, Ctrl+Alt+H hotkey, and IPC. Credentials stay in the main process.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BadReason, CallCard, CallSetup, CallType, Deployment, FeedbackType, HelpCardContent, HelpCardEvent, HelpModelConfig, KnowledgeDocMeta, SpeakerLabel } from '../shared/help'
import type { HelpOrigin } from '../shared/help'
import { CALL_TYPES, DEPLOYMENTS } from '../shared/help'
import { accountKey } from '../shared/help'
import type { CallNotesState } from '../shared/help'
import type { CallWrapup } from '../shared/help'
import { Db } from './db'
import { KnowledgeBase, importKnowledgeFiles, removeKnowledgeFile, type KnowledgeImport } from './knowledge'
import { accountMemory } from './help/accountMemory'
import { CallMemory, DEFAULT_SETUP } from './help/callMemory'
import { HelpEngine } from './help/engine'
import { CallNotesKeeper } from './help/callNotesKeeper'
import { WrapupKeeper } from './help/wrapup'
import { latestSignal, signalIn, type SignalSeen } from './help/pressModes'
import { ClaudeHelpModel, DEFAULT_HELP_CONFIG, MockHelpModel, OPUS_HELP_CONFIG, readinessFor, type HelpError, type HelpModel, type HelpReadiness } from './help/models'
import { buildScorecard, readFeedback } from './help/scorecard'
import { loadPlaybook, readPlaybook, type Playbook } from './help/prompt'
import { benchmark, loadScenarios, reportMarkdown } from './help/evalRunner'
import { EXPORT_PERIODS, collectFeedbackCalls, exportFileName, feedbackMarkdown, periodSince, type ExportPeriod } from './help/feedbackExport'
import { MINE_REPORTS, PRACTICE_DIR, buildPracticeMoment, loadPracticeMoments, readSessionGaps, savePracticeMoment, savedRequestIds } from './help/practice'
import type { SessionEvent } from './session'
import type { Storage } from './storage'

export const HELP_HOTKEY = 'Control+Alt+H'

export interface HelpSettings {
  model: 'claude-sonnet-5-5' | 'claude-opus-5-5'
  prefetch: boolean
  /** Keep running call notes during live calls (HELP reads them too). */
  call_notes: boolean
  /** After Stop: finish the notes, then build the wrap-up (what's owed, agreed, still open). */
  wrapup: boolean
}

const DEFAULT_SETTINGS: HelpSettings = { model: 'claude-sonnet-5-5', prefetch: true, call_notes: true, wrapup: true }

/** One ended call's after-call work: its closing notes pass, then its wrap-up. */
interface AfterCall {
  sessionId: string
  callMs: number
  notes: CallNotesKeeper | null
  wrap: WrapupKeeper | null
  /** Deleted, or the app is quitting: nothing more is written for it. */
  cancelled: boolean
  done: boolean
}

/** Which playbook HELP is using, and whether Keith needs to decide anything about it. */
export interface PlaybookInfo {
  using: 'yours' | 'built_in'
  version: string
  built_in_version: string
  /** Keith's edited copy can't be used (shown in Setup; HELP uses the built-in one meanwhile). */
  problem: string | null
  /** A different built-in version shipped since Keith's copy was made, and he hasn't chosen yet. */
  newer_built_in: boolean
  /** "Use the new one" didn't work (e.g. Windows holds the file open); HELP keeps using what it was. */
  error?: string | null
}

export interface HelpReadyState {
  readiness: HelpReadiness
  message: string
}

const READY_TEXT: Record<HelpReadiness, string> = {
  ready: 'HELP ready',
  practice: 'Practice mode: no Claude key, cards are MOCK',
  key_rejected: 'Claude key not working: check Setup, step 3',
  no_credit: 'Anthropic account is out of credit',
  offline: "Can't reach Claude: check the internet",
  busy: 'Claude is busy right now; press HELP again',
  unavailable: "HELP's Claude model isn't available to this key",
  checking: 'Checking HELP…',
}

/**
 * Earlier built-in playbooks, by the fingerprint of their content (JSON, whitespace ignored). A copy
 * in the data folder that still matches one was never edited. Add the outgoing version here whenever
 * config/playbook.json changes.
 */
const EARLIER_BUILT_IN_PLAYBOOKS = new Set([
  // m1-draft-1
  '242186ec247fd3f77036830782fd5407ece10bdf5cae25c451ed4dd91538135a',
])

/** The playbook file is exactly an earlier built-in version (Keith opened it but never changed it). */
export function unchangedBuiltIn(file: string): boolean {
  try {
    return EARLIER_BUILT_IN_PLAYBOOKS.has(playbookFingerprint(fs.readFileSync(file, 'utf8')))
  } catch {
    return false
  }
}

/** sha256 of the playbook's JSON, so re-saving it with other spacing or line endings doesn't count as an edit. */
export function playbookFingerprint(text: string): string {
  return createHash('sha256').update(JSON.stringify(JSON.parse(text.replace(/^\uFEFF/, '')))).digest('hex')
}

const KNOWLEDGE_README = `# Knowledge pack (local, private)

Drop approved Markdown (.md) or text (.txt) files here. HELP searches them during calls.
Nothing here is uploaded anywhere except the matching snippets sent with a HELP request.

Importing a file does NOT approve it. Approve each document in the app (Setup -> Knowledge).
Approval covers that exact content: after any edit, the app asks you to approve it again.
Writing \`approved: true\` in a file does nothing, so nothing can be approved on your behalf.
Keep material that is still waiting for review OUTSIDE this folder (subfolders are not read).

Suggested files:
- arize-product-overview.md      (product + evaluation overview)
- deployment-security.md         (deployment, SSO, data handling answers)
- competitive.md                 (current competitive material)
- objection-handling.md          (your objection notes)

Each "## " section is one answer: a few sentences of claim text, then one paragraph starting
"Source:" with the full reference. HELP sends the whole section and its source to the model.

Optional front matter at the top of a file:

---
title: Security and deployment FAQ
category: deployment_security        # product | deployment_security | competitive | objection_handling | other
source: Arize security team FAQ (Confluence export)
version: 2026-09
review_by: 2027-03-01                # after this date HELP treats it as stale
applies_to: saas                     # saas | self_hosted | all (one per file; split mixed files)
tags: sso, soc2
---
`

export class HelpService {
  readonly db: Db
  readonly kb: KnowledgeBase
  readonly knowledgeDir: string
  private playbook: Playbook
  playbookInfo!: PlaybookInfo
  private settings: HelpSettings
  private setup: CallSetup
  memory: CallMemory | null = null
  engine: HelpEngine | null = null
  /** Running call notes for the current (or just finished) call. */
  notes: CallNotesKeeper | null = null
  onNotes: ((s: CallNotesState | null) => void) | null = null
  private sessionState = 'idle'
  private sessionNow: () => number = () => 0
  /** The call that just ended and how long it ran, so after-call ratings can update its scorecard. */
  private endedCall: { sessionId: string; callMs: number } | null = null
  /** The wrap-up of the call that ended last (null with the setting off, or after a delete). */
  wrap: WrapupKeeper | null = null
  onWrapup: ((w: CallWrapup | null) => void) | null = null
  /**
   * The last ended call's after-call work (closing notes pass, then the wrap-up). A new Start doesn't
   * stop it: it reads only that call's own memory, so it finishes and saves while the next call runs.
   * Only deleting that call or quitting stops it.
   */
  private after: AfterCall | null = null
  /** Earlier ended calls whose after-call work was still running when the next call ended: it finishes out of sight. */
  private background = new Set<AfterCall>()
  private quitting = false
  hotkeyRegistered = false
  /** Ctrl+Alt+W (WRAP) registered with Windows. */
  wrapHotkeyRegistered = false
  ready: HelpReadyState = { readiness: 'checking', message: READY_TEXT.checking }
  onReadiness: ((r: HelpReadyState) => void) | null = null
  /** The latest buying signal of this call (M3): a quiet tag on the WRAP button. Cleared at a new call. */
  signal: SignalSeen | null = null
  onSignal: ((s: SignalSeen | null) => void) | null = null

  constructor(
    private readonly storage: Storage,
    private readonly appPath: string,
    private readonly emit: (ev: HelpCardEvent) => void,
    private readonly log: (event: string, data?: Record<string, unknown>) => void,
  ) {
    this.db = new Db(path.join(storage.root, 'copilot.db'))
    this.kb = new KnowledgeBase(this.db, path.join(appPath, 'config', 'aliases.json'))
    this.knowledgeDir = path.join(storage.root, 'knowledge')
    fs.mkdirSync(this.knowledgeDir, { recursive: true })
    const readme = path.join(this.knowledgeDir, 'README.md')
    // App-written help text: refreshed when the template changes (the indexer never reads it).
    if (!fs.existsSync(readme) || fs.readFileSync(readme, 'utf8') !== KNOWLEDGE_README) fs.writeFileSync(readme, KNOWLEDGE_README)
    this.playbook = this.loadPlaybook()
    // A copy: setSettings changes it, and the defaults must stay the defaults.
    this.settings = storage.readJson('help-settings.json', { ...DEFAULT_SETTINGS })
    // Account, goal, outcomes and deployment belong to one call: if the app quit or crashed without
    // Stop, they'd be the last call's. Only the call type (which often repeats) carries over.
    const saved = storage.readJson<Partial<CallSetup>>('call-setup.json', DEFAULT_SETUP)
    const callType = (CALL_TYPES as readonly string[]).includes(saved.call_type as string) ? (saved.call_type as CallType) : DEFAULT_SETUP.call_type
    this.setup = { ...DEFAULT_SETUP, call_type: callType }
    try {
      this.kb.indexFolder(this.knowledgeDir)
    } catch (err) {
      log('knowledge_index_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  /**
   * Keith's edited playbook (userData) wins over the shipped one while it's valid. A broken edit is
   * reported in Setup and the shipped one is used meanwhile; a newer shipped version is offered.
   */
  private loadPlaybook(): Playbook {
    const builtIn = loadPlaybook(path.join(this.appPath, 'config', 'playbook.json'))
    const user = path.join(this.storage.root, 'playbook.json')
    const choice = this.storage.readJson<{ kept_over?: string }>('playbook-choice.json', {})
    this.playbookInfo = { using: 'built_in', version: builtIn.version, built_in_version: builtIn.version, problem: null, newer_built_in: false }
    if (!fs.existsSync(user)) return builtIn
    const r = readPlaybook(user)
    if (!r.playbook) {
      this.log('playbook_invalid')
      this.playbookInfo.problem = r.problem
      return builtIn
    }
    // A copy Keith never edited (still exactly an earlier built-in) moves to the new built-in by itself.
    if (r.playbook.version !== builtIn.version && unchangedBuiltIn(user) && this.backUpMyPlaybook(user, 'playbook-earlier')) {
      this.log('playbook_auto_updated', { from: r.playbook.version, to: builtIn.version })
      return builtIn
    }
    this.playbookInfo = {
      using: 'yours', version: r.playbook.version, built_in_version: builtIn.version, problem: null,
      newer_built_in: r.playbook.version !== builtIn.version && choice.kept_over !== builtIn.version,
    }
    return r.playbook
  }

  /**
   * Move Keith's copy aside to a dated backup (Windows can refuse a rename while another program has
   * the file open: then copy and delete). False, and his copy stays in use, if neither works.
   */
  private backUpMyPlaybook(user: string, prefix: string, now = new Date()): boolean {
    const backup = path.join(this.storage.root, `${prefix}-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`)
    try {
      fs.renameSync(user, backup)
      return true
    } catch (err) {
      this.log('playbook_rename_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
    try {
      fs.copyFileSync(user, backup)
      fs.unlinkSync(user)
      return true
    } catch (err) {
      this.log('playbook_switch_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      // His copy stays in use, so don't leave a second copy of it lying around.
      try {
        if (fs.existsSync(user)) fs.rmSync(backup, { force: true })
      } catch {
        /* best effort */
      }
      return false
    }
  }

  /** Re-read the playbook (edits apply from the next call; this shows problems right away). */
  reloadPlaybook(): PlaybookInfo {
    this.playbook = this.loadPlaybook()
    return this.playbookInfo
  }

  /** Switch to the shipped playbook; Keith's copy is kept as a dated backup next to it. */
  useBuiltInPlaybook(now = new Date()): PlaybookInfo {
    const user = path.join(this.storage.root, 'playbook.json')
    if (fs.existsSync(user) && !this.backUpMyPlaybook(user, 'playbook-yours', now)) {
      return { ...this.reloadPlaybook(), error: "Couldn't switch: close the playbook file and try again." }
    }
    this.log('playbook_choice', { choice: 'built_in' })
    return { ...this.reloadPlaybook(), error: null }
  }

  /** Keep Keith's copy and stop offering this shipped version. */
  keepMyPlaybook(): PlaybookInfo {
    this.storage.writeJson('playbook-choice.json', { kept_over: this.playbookInfo.built_in_version })
    this.log('playbook_choice', { choice: 'yours' })
    return this.reloadPlaybook()
  }

  playbookPath(): string {
    const user = path.join(this.storage.root, 'playbook.json')
    if (!fs.existsSync(user)) fs.copyFileSync(path.join(this.appPath, 'config', 'playbook.json'), user)
    return user
  }

  hasKey(): boolean {
    return !!this.storage.loadSecret('anthropic')
  }

  modelConfig(): HelpModelConfig {
    return this.settings.model === 'claude-opus-5-5' ? { ...OPUS_HELP_CONFIG } : { ...DEFAULT_HELP_CONFIG }
  }

  createModel(): HelpModel {
    const key = this.storage.loadSecret('anthropic')
    return key ? new ClaudeHelpModel(key) : new MockHelpModel()
  }

  info() {
    const model = this.createModel()
    return {
      hasKey: this.hasKey(), settings: this.settings, setup: this.setup, hotkey: 'Ctrl+Alt+H', hotkeyRegistered: this.hotkeyRegistered,
      modelLabel: model.label(this.modelConfig()), mock: model.mock, playbookVersion: this.playbook.version, knowledgeDir: this.knowledgeDir,
      ready: this.ready, playbook: this.playbookInfo,
      wrapHotkeyRegistered: this.wrapHotkeyRegistered,
    }
  }

  private setReady(readiness: HelpReadiness): void {
    if (this.ready.readiness !== readiness) this.log('help_readiness', { readiness })
    this.ready = { readiness, message: READY_TEXT[readiness] }
    this.onReadiness?.(this.ready)
  }

  /** Bumped by every check and every finished request: only the newest news reaches the light. */
  private readySeq = 0

  /** HELP-ready light: a free check that Claude accepts the saved key (no tokens used). */
  async checkReady(): Promise<HelpReadyState> {
    const seq = ++this.readySeq
    const model = this.createModel()
    if (model.mock) {
      this.setReady('practice')
      return this.ready
    }
    this.setReady('checking')
    const r = await model.check(this.modelConfig())
    // A newer check or a request that finished meanwhile knows better.
    if (seq === this.readySeq) this.setReady(r.readiness)
    return this.ready
  }

  /** Every finished request updates the light, so it never disagrees with what HELP presses see. */
  private onRequestResult(e: HelpError | null): void {
    // Call notes follow HELP's blocked rule: a key/credit/model error stops them, any success restarts them.
    this.notes?.onHelpResult(e)
    const readiness = e ? readinessFor(e) : 'ready'
    if (!readiness) return
    this.readySeq++
    this.setReady(readiness)
  }

  // ---------------------------------------------------------------- settings / setup / knowledge

  setSettings(s: Partial<HelpSettings>): HelpSettings {
    if (s.model === 'claude-sonnet-5-5' || s.model === 'claude-opus-5-5') this.settings.model = s.model
    if (typeof s.prefetch === 'boolean') this.settings.prefetch = s.prefetch
    if (typeof s.call_notes === 'boolean') this.settings.call_notes = s.call_notes
    if (typeof s.wrapup === 'boolean') this.settings.wrapup = s.wrapup
    this.storage.writeJson('help-settings.json', this.settings)
    return this.settings
  }

  setSetup(raw: unknown): CallSetup {
    const r = (raw ?? {}) as Record<string, unknown>
    const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '')
    const setup: CallSetup = {
      call_type: (CALL_TYPES as readonly string[]).includes(r.call_type as string) ? (r.call_type as CallType) : 'discovery',
      call_goal: str(r.call_goal, 300),
      desired_outcomes: Array.isArray(r.desired_outcomes) ? r.desired_outcomes.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 6) : [],
      account: str(r.account, 120),
      deployment: (DEPLOYMENTS as readonly string[]).includes(r.deployment as string) ? (r.deployment as Deployment) : 'unknown',
    }
    this.setup = setup
    this.storage.writeJson('call-setup.json', setup)
    if (this.memory && this.callInProgress()) {
      // Editable mid-call: the next HELP press uses it, and the call's record keeps the latest.
      // After Stop the strip is for the next call; the finished call's record keeps what it was.
      const accountChanged = accountKey(this.memory.setup.account) !== accountKey(setup.account)
      this.memory.setup = setup
      this.db.sql.prepare('UPDATE sessions SET setup_json = ? WHERE id = ?').run(JSON.stringify(setup), this.memory.sessionId)
      // The account is often typed after Start: HELP then gets that account's earlier calls.
      if (accountChanged) this.refreshEarlierCalls()
    }
    return setup
  }

  /** Waiting to go live, live or paused: the call that `memory` belongs to is still going. */
  private callInProgress(): boolean {
    return this.sessionState === 'checking' || this.sessionState === 'live' || this.sessionState === 'paused'
  }

  importKnowledge(picked: string[], fromFolder: boolean): KnowledgeImport & { docs: KnowledgeDocMeta[] } {
    const r = importKnowledgeFiles(this.knowledgeDir, picked, fromFolder)
    this.log('knowledge_import', { added: r.added.length, skipped: r.skipped.length })
    return { ...r, docs: this.reindexKnowledge() }
  }

  removeKnowledge(docId: string): { ok: boolean; docs: KnowledgeDocMeta[] } {
    const doc = this.kb.getDoc(docId)
    const ok = !!doc && removeKnowledgeFile(this.knowledgeDir, doc.file)
    this.log('knowledge_remove', { doc: createHash('sha256').update(docId).digest('hex').slice(0, 8), ok })
    return { ok, docs: this.reindexKnowledge() }
  }

  reindexKnowledge(): KnowledgeDocMeta[] {
    const docs = this.kb.indexFolder(this.knowledgeDir)
    this.log('knowledge_indexed', { docs: docs.length, approved: docs.filter((d) => d.approved).length })
    return docs
  }

  setLabel(raw: unknown): { ok: boolean; reason?: string } {
    const r = (raw ?? {}) as Record<string, unknown>
    if (!this.memory) return { ok: false, reason: 'No call in progress' }
    if (typeof r.cluster !== 'string' || !/^e\d+:s\d+$/.test(r.cluster)) return { ok: false, reason: 'Invalid speaker' }
    const role = r.role === 'buyer' || r.role === 'teammate' ? r.role : 'unknown'
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : null
    const label: SpeakerLabel = { cluster: r.cluster, role, name }
    this.memory.setLabel(label)
    this.relabelSignal()
    return { ok: true }
  }

  labels(): SpeakerLabel[] {
    return this.memory ? [...this.memory.labels.values()] : []
  }

  // ---------------------------------------------------------------- session lifecycle

  /** Called for every session event (main process). */
  onSessionEvent(ev: SessionEvent, sessionId: string | null, nowSessionMs: () => number): void {
    if (ev.type === 'state') {
      this.sessionState = ev.state
      if (ev.state === 'checking' && sessionId) this.startCall(sessionId, nowSessionMs)
      if (ev.state === 'live') {
        this.engine?.resume()
        void this.engine?.prewarm()
      }
      if (ev.state === 'paused') this.engine?.cancelAll('pause')
      if (ev.state === 'stopping' || ev.state === 'stopped' || ev.state === 'idle') this.engine?.cancelAll('stop')
      // Call notes update only while live; Pause cancels one in flight. Stop doesn't: at "stopping" no new
      // update starts, and at "stopped" (the transcript's last lines have all arrived by then: the session
      // flushes them before it says so) the closing pass covers the last minutes (endCall).
      if (ev.state === 'live') this.notes?.resume()
      if (ev.state === 'paused') this.notes?.pause()
      if (ev.state === 'stopping') this.notes?.beginFinish()
      if (ev.state === 'idle') this.notes?.stop()
      if (ev.state === 'stopped') this.endCall()
      return
    }
    const m = this.memory
    if (!m) return
    const now = this.sessionNow()
    switch (ev.type) {
      case 'turn': {
        const t = ev.event.turn
        m.upsertTurn({ id: t.turn_id, stream: t.stream, cluster: t.speaker_cluster, start_ms: t.start_ms, end_ms: t.end_ms, text: t.text, available_ms: now }, ev.event.type === 'turn_final')
        this.engine?.onFinalWords(t.stream)
        if (ev.event.type === 'turn_final') this.notes?.onFinalTurn(t.turn_id)
        if (ev.event.type === 'turn_final') this.noteSignal(signalIn(m, { stream: t.stream, cluster: t.speaker_cluster, text: t.text, start_ms: t.start_ms }))
        break
      }
      case 'interim':
        m.setInterim(ev.stream, ev.text, now)
        break
      case 'gap_open':
      case 'gap_close':
        // Words left mid-transcription when a stream drops will never be finished; don't keep treating them as live speech.
        if (ev.type === 'gap_open') m.setInterim(ev.gap.stream, '', now)
        m.upsertGap({ id: ev.gap.gap_id, stream: ev.gap.stream, cause: ev.gap.cause, start_ms: ev.gap.start_ms, end_ms: ev.gap.end_ms })
        break
      case 'timing':
        if (ev.sttDelayMs !== null) m.lagMs.set(ev.stream, ev.sttDelayMs)
        break
    }
  }

  private startCall(sessionId: string, nowSessionMs: () => number): void {
    // The last call's closing pass or wrap-up, if still running, carries on: it reads only that call's
    // own memory and saves to it (startNotes leaves its notes keeper running).
    this.engine?.dispose()
    // Playbook edits made since the last call apply now, without restarting the app.
    this.playbook = this.loadPlaybook()
    this.sessionNow = nowSessionMs
    // endedCall stays: a Start the buyer never joins goes back to idle, and the review and ratings are
    // still about the call that ended (the next Stop replaces it).
    this.memory = new CallMemory(sessionId, this.db, this.kb.aliasMap)
    this.memory.setup = { ...this.setup }
    this.clearSignal()
    this.db.sql.prepare('INSERT OR REPLACE INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run(sessionId, new Date().toISOString(), JSON.stringify(this.setup))
    this.loadEarlierCalls()
    const model = this.createModel()
    this.engine = new HelpEngine({
      memory: this.memory, kb: this.kb, model, config: this.modelConfig(), playbook: this.playbook, db: this.db,
      sessionNowMs: () => this.sessionNow(), emit: this.emit, log: this.log, prefetch: this.settings.prefetch,
      // Practice mode (no key) stays "Practice mode" whatever the MOCK cards do.
      onResult: model.mock ? undefined : (e) => this.onRequestResult(e),
    })
    this.log('help_ready', { model: model.label(this.modelConfig()), mock: model.mock, prefetch: this.settings.prefetch, playbook: this.playbook.version })
    this.startNotes(model)
    void this.checkReady()
  }

  /**
   * Account memory for HELP: what earlier calls with this call's account left behind (this call left
   * out). Computed at call start, and again if Keith changes the account during the call.
   */
  private loadEarlierCalls(): void {
    const m = this.memory
    if (!m) return
    const t0 = Date.now()
    try {
      const mem = accountMemory(this.db, m.setup.account, m.sessionId)
      m.earlierCalls = (mem?.items ?? []).map(({ kind, text, date }) => ({ kind, text, date }))
      this.log('account_memory', { calls: mem?.calls ?? 0, items: m.earlierCalls.length, ms: Date.now() - t0 })
    } catch (err) {
      // Never stops a call: HELP just goes without it.
      m.earlierCalls = []
      this.log('account_memory_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  /**
   * Look again at the earlier calls for the running call (Keith changed its account, or deleted saved
   * calls during it), so HELP never sends what is gone. A background card built from the old items is
   * dropped too. Does nothing when no call is running.
   */
  refreshEarlierCalls(): void {
    if (!this.memory) return
    this.loadEarlierCalls()
    this.engine?.discardPrefetch()
  }

  /** A buying signal the other side just gave (null: none in those words) becomes the WRAP tag. */
  private noteSignal(s: SignalSeen | null): void {
    if (!s) return
    this.signal = s
    this.log('buying_signal', { kind: s.kind, at_ms: s.at_ms })
    this.onSignal?.(s)
  }

  /**
   * A speaker tagged (or untagged) as a teammate: the tag is what the next WRAP builds on, so it is
   * worked out again the way the press will (latestSignal), from the other side only.
   */
  private relabelSignal(): void {
    if (!this.memory) return
    const s = latestSignal(this.memory, this.sessionNow())
    if (s?.kind === this.signal?.kind && s?.at_ms === this.signal?.at_ms) return
    this.signal = s
    this.onSignal?.(s)
  }

  /** A new call starts without one. */
  private clearSignal(): void {
    if (!this.signal) return
    this.signal = null
    this.onSignal?.(null)
  }

  /** Running call notes for this call: same model and settings as HELP, never while a pressed HELP is answered. */
  private startNotes(model: HelpModel): void {
    const memory = this.memory
    if (!memory) return
    // The ended call's keeper may still be running its closing pass: its after-call work holds it, and
    // it finishes out of sight. Any other keeper is dropped.
    const prev = this.notes
    if (prev && prev !== this.after?.notes) prev.dispose()
    // Its own clock: the next Start replaces this.sessionNow, and a closing pass still running reads this one.
    const clock = this.sessionNow
    const keeper: CallNotesKeeper = new CallNotesKeeper({
      memory, model, config: this.modelConfig(), db: this.db, sessionNowMs: () => clock(),
      // Only the current call's notes reach the panel.
      helpBusy: () => this.engine?.pressInFlight ?? false, emit: (s) => { if (this.notes === keeper) this.onNotes?.(s) }, log: this.log,
      enabled: this.settings.call_notes,
      // Practice mode (no key) stays "Practice mode" whatever the MOCK notes do.
      onResult: model.mock ? undefined : (e) => this.onRequestResult(e),
    })
    this.notes = keeper
    this.log('call_notes_ready', { enabled: this.settings.call_notes, mock: model.mock })
    this.onNotes?.(this.notes.state())
  }

  /** The notes panel: the current or just-finished call's notes (null before the first call). */
  callNotes(): CallNotesState | null {
    return this.notes?.state() ?? null
  }

  /** A deleted call: drop what's still in memory so nothing writes to it again (e.g. a late label). */
  forgetCall(sessionId: string): void {
    if (this.endedCall?.sessionId === sessionId) this.endedCall = null
    // Its after-call work stops, whether it's the last call's or still finishing out of sight.
    for (const a of [this.after, ...this.background]) if (a?.sessionId === sessionId) this.cancelAfterCall(a)
    if (this.memory?.sessionId !== sessionId) return
    this.engine?.dispose()
    this.engine = null
    this.notes?.dispose()
    this.notes = null
    // Its notes went with it: the panel empties.
    this.onNotes?.(null)
    // ...and so does the WRAP tag about it.
    this.clearSignal()
    this.memory = null
  }

  /** Stop: write the numbers-only scorecard, then clear who the call was with so the next call starts clean. */
  private endCall(): void {
    const m = this.memory
    if (m) {
      // The session clock keeps running after Stop; the call's length is what it is now.
      this.endedCall = { sessionId: m.sessionId, callMs: this.sessionNow() }
      // The closing notes pass starts now (with nothing left to cover, the notes are saved at once).
      const closing = this.quitting ? undefined : this.notes?.finish()
      this.writeScorecard(this.endedCall.sessionId, this.endedCall.callMs)
      if (!this.quitting) this.startAfterCall(m, this.endedCall.callMs, this.notes, closing)
    }
    // Account, goal, outcomes and deployment are per call; the call type often repeats. The finished
    // call's own record keeps what it was.
    this.setup = { ...DEFAULT_SETUP, call_type: this.setup.call_type }
    this.storage.writeJson('call-setup.json', this.setup)
  }

  // ---------------------------------------------------------------- after the call: wrap-up and follow-up draft

  /**
   * After Stop: once the closing notes pass is done, the wrap-up is built from the ended call's own
   * memory (its setup, labels, transcript and final notes; the setup strip is already cleared for the
   * next call). The scorecard is written again after each step so their counts and cost land in it.
   */
  private startAfterCall(m: CallMemory, callMs: number, notes: CallNotesKeeper | null, closing: Promise<void> | undefined): void {
    const prev = this.after
    if (prev) {
      // A short call right after the last one: the last call's work, still running, finishes out of sight.
      if (!prev.done || prev.wrap?.busy) this.background.add(prev)
      else prev.wrap?.dispose()
    }
    const run: AfterCall = { sessionId: m.sessionId, callMs, notes, wrap: null, cancelled: false, done: false }
    this.after = run
    this.wrap = null
    if (this.settings.wrapup) {
      const model = this.createModel()
      const wrap: WrapupKeeper = new WrapupKeeper({
        memory: m, model, config: this.modelConfig(), db: this.db, kb: this.kb, log: this.log,
        // Only the wrap-up of the call that ended last reaches the window.
        emit: (w) => { if (this.wrap === wrap) this.onWrapup?.(w) },
        // Practice mode (no key) stays "Practice mode" whatever the MOCK wrap-up does.
        onResult: model.mock ? undefined : (e) => this.onRequestResult(e),
      })
      this.wrap = wrap
      run.wrap = wrap
      wrap.begin()
    } else this.onWrapup?.(null)
    const wrap = run.wrap
    // A call with the same account may already be running (Keith reconnected): it gets this call's
    // final notes and wrap-up as they land, not only what was saved when it started.
    const refreshNext = () => {
      const cur = this.memory
      if (cur && cur.sessionId !== m.sessionId && this.callInProgress() && accountKey(cur.setup.account) === accountKey(m.setup.account)) this.refreshEarlierCalls()
    }
    void (async () => {
      try {
        if (closing) {
          await closing
          if (run.cancelled) return
          this.writeScorecard(m.sessionId, callMs)
          refreshNext()
        }
        if (!wrap) return
        await wrap.build()
        if (run.cancelled) return
        this.writeScorecard(m.sessionId, callMs)
        refreshNext()
      } catch (err) {
        if (!run.cancelled) this.log('after_call_failed', { code: (err as NodeJS.ErrnoException).code ?? (err as Error).name ?? 'unknown' })
      } finally {
        run.done = true
        if (!wrap?.busy) this.background.delete(run)
      }
    })()
  }

  /** A deleted call: stop its after-call work and its wrap-up; nothing more is written for that call. */
  private cancelAfterCall(a: AfterCall): void {
    a.cancelled = true
    this.background.delete(a)
    a.notes?.dispose()
    a.wrap?.dispose()
    if (this.after === a) this.after = null
    if (a.wrap && this.wrap === a.wrap) {
      this.wrap = null
      this.onWrapup?.(null)
    }
  }

  /** The wrap-up of the call that just ended (null before any call ends, with the setting off, or after a delete). */
  wrapup(): CallWrapup | null {
    return this.wrap?.state() ?? null
  }

  /** Keith's changes count in the scorecard straight away (numbers only). */
  private rescoreWrapup(): void {
    const a = this.after
    if (a && this.wrap && a.wrap === this.wrap) this.writeScorecard(a.sessionId, a.callMs)
  }

  updateWrapupItem(raw: unknown): { ok: boolean; wrapup: CallWrapup | null } {
    const ok = this.wrap?.updateItem(raw) ?? false
    if (ok) this.rescoreWrapup()
    return { ok, wrapup: this.wrapup() }
  }

  addWrapupItem(raw: unknown): { ok: boolean; wrapup: CallWrapup | null } {
    const ok = !!this.wrap?.addItem(raw)
    if (ok) this.rescoreWrapup()
    return { ok, wrapup: this.wrapup() }
  }

  /** "Draft follow-up email": only when Keith asks; nothing is sent. */
  async draftFollowup(): Promise<{ ok: boolean; reason?: string; wrapup: CallWrapup | null }> {
    const w = this.wrap
    if (!w) return { ok: false, reason: 'No wrap-up for this call.', wrapup: null }
    const r = await w.draft()
    if (this.wrap === w) this.rescoreWrapup()
    return { ...r, wrapup: this.wrapup() }
  }

  /** "Try again" after the wrap-up couldn't be built. */
  async retryWrapup(): Promise<{ ok: boolean; wrapup: CallWrapup | null }> {
    const w = this.wrap
    const ok = !!w && (await w.retry())
    if (ok && this.wrap === w) this.rescoreWrapup()
    return { ok, wrapup: this.wrapup() }
  }

  /** reports/help-scorecard-<id>.json, numbers only. Rewritten as Keith rates the cards after the call. */
  private writeScorecard(sessionId: string, callMs: number): void {
    try {
      const dir = path.join(this.storage.root, 'reports')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `help-scorecard-${sessionId}.json`), JSON.stringify(buildScorecard(this.db, sessionId, callMs), null, 2))
    } catch (err) {
      this.log('help_scorecard_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  /** HELP (or WRAP) button / hotkey. Never gated by speaker role. */
  press(origin: 'help_requested' | 'wrap_requested' = 'help_requested'): { ok: boolean; reason?: string; request_id?: string } {
    if (!this.engine || this.sessionState !== 'live') {
      return { ok: false, reason: this.sessionState === 'paused' ? `Paused - resume to use ${origin === 'wrap_requested' ? 'WRAP' : 'HELP'}.` : 'Start a call first.' }
    }
    return { ok: true, request_id: this.engine.press(origin) }
  }

  feedback(raw: unknown): { ok: boolean } {
    const r = (raw ?? {}) as Record<string, unknown>
    const types: FeedbackType[] = ['useful', 'should_have_stayed_quiet', 'bad', 'used', 'unused', 'note', 'passed']
    const reasons: BadReason[] = ['wrong_move', 'assumed_too_much', 'already_known', 'too_generic', 'too_late', 'bad_wording', 'unsupported', 'other']
    if (typeof r.card_id !== 'string' || !types.includes(r.type as FeedbackType)) return { ok: false }
    const eng = this.engine
    const cardId = r.card_id.slice(0, 64)
    // The card's own origin, so a WRAP card is rated as a WRAP card.
    const asked = (this.db.sql.prepare('SELECT origin FROM help_requests WHERE id = ?').get(cardId) as { origin?: string } | undefined)?.origin
    const origin: HelpOrigin = asked === 'wrap_requested' || asked === 'coach_proactive' ? asked : 'help_requested'
    const ev = {
      card_id: cardId, origin, type: r.type as FeedbackType,
      bad_reason: reasons.includes(r.bad_reason as BadReason) ? (r.bad_reason as BadReason) : null,
      optional_note: typeof r.note === 'string' && r.note.trim() ? r.note.slice(0, 500) : null,
    }
    if (eng) eng.recordFeedback(ev)
    else this.db.sql.prepare('INSERT INTO feedback (card_id, origin, type, bad_reason, note, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ev.card_id, ev.origin, ev.type, ev.bad_reason, ev.optional_note, new Date().toISOString())
    // The after-call review happens after Stop: bring the finished call's scorecard up to date.
    const ended = this.endedCall
    if (ended && this.db.sql.prepare('SELECT 1 FROM help_requests WHERE id = ? AND session_id = ?').get(ev.card_id, ended.sessionId)) {
      this.writeScorecard(ended.sessionId, ended.callMs)
    }
    return { ok: true }
  }

  /** The last call's cards with Keith's feedback so far, for the after-call review (stays on this PC). */
  callCards(): CallCard[] {
    // Between calls (also after a Start that never went live): the call that ended last.
    const id = this.callInProgress() ? this.memory?.sessionId : (this.endedCall?.sessionId ?? this.memory?.sessionId)
    if (!id) return []
    const rows = this.db.sql.prepare(
      'SELECT id, at_session_ms, status, card_json FROM help_requests WHERE session_id = ? AND card_json IS NOT NULL ORDER BY at_session_ms',
    ).all(id) as Array<{ id: string; at_session_ms: number | null; status: string; card_json: string }>
    const fb = readFeedback(this.db, rows.map((r) => r.id))
    return rows.map((r) => {
      let c: Partial<HelpCardContent> = {}
      try {
        c = JSON.parse(r.card_json) as Partial<HelpCardContent>
      } catch {
        /* unreadable card: shown without its line */
      }
      const f = fb.get(r.id)
      return {
        id: r.id, at_session_ms: r.at_session_ms, status: r.status, primary_kind: c.primary_kind ?? null, primary: c.primary ?? null,
        follow_up: c.follow_up ?? null, rating: f?.rating ?? null, bad_reason: (f && f.rating === 'bad' ? ([...f.reasons].at(-1) ?? null) : null) as BadReason | null,
        used: f?.used ?? false, note: f?.note ?? null,
        ...(f?.passed ? { passed: true } : {}),
      }
    })
  }

  /**
   * In-app speed/quality benchmark: Sonnet 5.5 vs Opus 5.5 on the same scenarios, on Keith's PC
   * and network (what matters for live latency). Uses the locally stored key. Not during a call.
   */
  private benchmarking = false
  async runBenchmark(raw: unknown, progress: (p: { done: number; total: number; scenario: string; ok: boolean }) => void): Promise<{ ok: boolean; reason?: string; reportFile?: string; markdown?: string }> {
    if (this.benchmarking) return { ok: false, reason: 'A benchmark is already running.' }
    if (this.sessionState === 'live' || this.sessionState === 'checking' || this.sessionState === 'paused') return { ok: false, reason: 'Stop the call first.' }
    const r = (raw ?? {}) as Record<string, unknown>
    const repeats = Math.min(3, Math.max(1, Number(r.repeats) || 1))
    const which = Array.isArray(r.models) ? r.models : ['claude-sonnet-5-5', 'claude-opus-5-5']
    const configs = [DEFAULT_HELP_CONFIG, OPUS_HELP_CONFIG].filter((c) => which.includes(c.model))
    const scenarios = loadScenarios(path.join(this.appPath, 'evals', 'scenarios', 'help'))
    if (scenarios.length === 0) return { ok: false, reason: 'No scenarios found.' }
    // Keith's saved moments (real calls) when he ticks the box: reported apart, never gating anything.
    const mine = r.includeMine === true ? loadPracticeMoments(this.practiceDir).moments : []
    const model = this.createModel()
    this.benchmarking = true
    try {
      this.log('help_benchmark_start', { scenarios: scenarios.length, mine: mine.length, repeats, configs: configs.map((c) => c.model), mock: model.mock })
      const report = await benchmark({
        scenarios, mine, model, configs, playbook: this.playbook, repeats,
        onProgress: (done, total, last) => progress({ done, total, scenario: last.scenario_id, ok: last.level1.pass }),
      })
      // reports/mine/, "-mine": the report quotes real calls, so Save support files leaves it behind.
      const dir = path.join(this.storage.root, 'reports', ...(mine.length ? [MINE_REPORTS] : []))
      fs.mkdirSync(dir, { recursive: true })
      const stamp = report.created_at.replace(/[:.]/g, '-')
      const file = path.join(dir, `help-benchmark-${stamp}${model.mock ? '-MOCK' : ''}${mine.length ? '-mine' : ''}.json`)
      fs.writeFileSync(file, JSON.stringify({ ...report, mock: model.mock }, null, 2))
      const md = (model.mock ? '> MOCK RUN - no model was called. Latency and quality numbers are meaningless.\n\n' : '') + reportMarkdown(report)
      fs.writeFileSync(file.replace(/\.json$/, '.md'), md)
      this.log('help_benchmark_done', { file, summaries: report.summaries.map((x) => ({ model: x.model, p50: x.first_usable_median_ms, p95: x.first_usable_p95_ms, l1: x.level1_pass_rate, cost: x.cost_usd })) })
      return { ok: true, reportFile: file, markdown: md }
    } catch (err) {
      // Never leave the button stuck: say what happened (the log keeps only a code).
      this.log('help_benchmark_failed', { code: (err as NodeJS.ErrnoException).code ?? (err as Error).name ?? 'unknown' })
      return { ok: false, reason: `The speed test stopped (${(err as Error).message}). Try again, or send me the support files.` }
    } finally {
      this.benchmarking = false
    }
  }

  // ---------------------------------------------------------------- practice moments, feedback export

  /** Keith's saved practice moments (real call text): in the data folder only. */
  get practiceDir(): string {
    return path.join(this.storage.root, PRACTICE_DIR)
  }

  /** How many moments are saved, and which cards they came from (the review shows those as saved). */
  practiceInfo(): { count: number; saved: string[] } {
    const { moments } = loadPracticeMoments(this.practiceDir)
    return { count: moments.length, saved: moments.map((m) => m.request_id).filter((x): x is string => typeof x === 'string') }
  }

  /**
   * After-call review: save the call as it stood when this card was asked for, as a practice moment.
   * A card already saved keeps its moment; only Keith's current feedback on it is written in (the
   * review calls this again when he changes a saved card's rating, tick or note).
   */
  saveMoment(raw: unknown): { ok: boolean; already?: boolean; updated?: boolean; title?: string; reason?: string } {
    const id = typeof raw === 'string' ? raw.slice(0, 64) : ''
    if (!id) return { ok: false, reason: 'Invalid card' }
    try {
      const already = savedRequestIds(this.practiceDir).has(id)
      const gaps = (sid: string) => (/^[\w-]+$/.test(sid) ? readSessionGaps(path.join(this.storage.root, 'sessions', sid, 'transcript.jsonl')) : [])
      const b = buildPracticeMoment(this.db, id, { gaps })
      if (!b.ok) return already ? { ok: true, already: true } : { ok: false, reason: b.reason }
      const r = savePracticeMoment(this.practiceDir, b.moment, { refresh: true })
      this.log('practice_moment_saved', {
        request_id: id, already: r.already, updated: r.updated === true, lines: b.moment.transcript.length, knowledge: b.moment.knowledge?.length ?? 0,
        acceptable: b.moment.acceptable_moves.length, unacceptable: b.moment.unacceptable_moves?.length ?? 0,
      })
      return { ok: true, already: r.already, ...(r.updated ? { updated: true } : {}), title: b.moment.title }
    } catch (err) {
      this.log('practice_moment_failed', { request_id: id, code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return { ok: false, reason: "Couldn't save this moment. Try again, or send me the support files." }
    }
  }

  /**
   * Diagnostics: write every card Keith saw in the period, with his feedback, to one Markdown file in
   * `outDir` (his Downloads folder). Never overwrites an earlier export.
   */
  exportFeedback(raw: unknown, outDir: string, now = new Date()): { ok: boolean; file?: string; calls?: number; cards?: number; reason?: string } {
    const period: ExportPeriod = typeof raw === 'string' && Object.hasOwn(EXPORT_PERIODS, raw) ? (raw as ExportPeriod) : '7d'
    const minutes = (sid: string): number | null => {
      if (!/^[\w-]+$/.test(sid)) return null
      const card = this.storage.readJson<{ call_minutes?: unknown }>(path.join('reports', `help-scorecard-${sid}.json`), {})
      return typeof card.call_minutes === 'number' ? card.call_minutes : null
    }
    try {
      const calls = collectFeedbackCalls(this.db, periodSince(period, now), minutes)
      if (!calls.length) return { ok: false, reason: period === 'all' ? 'No saved calls yet.' : `No calls in the ${EXPORT_PERIODS[period].label.toLowerCase()}.` }
      const md = feedbackMarkdown(calls, { period, now })
      const base = exportFileName(now).replace(/\.md$/, '')
      fs.mkdirSync(outDir, { recursive: true })
      for (let n = 1; n < 100; n++) {
        const file = path.join(outDir, `${base}${n === 1 ? '' : `-${n}`}.md`)
        try {
          fs.writeFileSync(file, md, { flag: 'wx' })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw err
        }
        const cards = calls.reduce((a, c) => a + c.cards.length, 0)
        this.log('help_feedback_exported', { period, calls: calls.length, cards })
        return { ok: true, file, calls: calls.length, cards }
      }
      return { ok: false, reason: 'Too many exports today in that folder. Move some, then try again.' }
    } catch (err) {
      this.log('help_feedback_export_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return { ok: false, reason: `Couldn't write the file: ${(err as Error).message}` }
    }
  }

  /** App exit. A call that went live and wasn't stopped gets its end-of-call work first. */
  shutdown(): void {
    // Nothing waits for Claude at quit: each ended call's closing pass or wrap-up still running is
    // cancelled, what it has so far is saved (a wrap-up never stays "building"), and that call's
    // scorecard is brought up to date.
    this.quitting = true
    for (const a of [...this.background, this.after]) {
      if (!a) continue
      a.cancelled = true
      const unfinished = !a.done || !!a.wrap?.busy
      a.wrap?.abandon()
      // An update in flight is cancelled and the notes' counts saved before the scorecard is written.
      a.notes?.stop()
      if (unfinished) this.writeScorecard(a.sessionId, a.callMs)
    }
    this.background.clear()
    this.notes?.stop()
    if (this.memory && (this.sessionState === 'live' || this.sessionState === 'paused' || this.sessionState === 'stopping')) {
      try {
        this.endCall()
      } catch (err) {
        this.log('help_end_on_quit_failed', { message: (err as Error).message })
      }
    }
    this.engine?.dispose()
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}
