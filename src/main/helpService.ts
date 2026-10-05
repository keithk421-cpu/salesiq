/**
 * Main-process wiring for M1 HELP: local DB, knowledge pack, playbook, settings, per-call
 * memory + engine, Ctrl+Alt+H hotkey, and IPC. Credentials stay in the main process.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CallSetup, CallType, Deployment, FeedbackType, BadReason, HelpCardEvent, HelpModelConfig, KnowledgeDocMeta, SpeakerLabel } from '../shared/help'
import { CALL_TYPES, DEPLOYMENTS } from '../shared/help'
import { Db } from './db'
import { KnowledgeBase, importKnowledgeFiles, removeKnowledgeFile, type KnowledgeImport } from './knowledge'
import { CallMemory, DEFAULT_SETUP } from './help/callMemory'
import { HelpEngine } from './help/engine'
import { ClaudeHelpModel, DEFAULT_HELP_CONFIG, MockHelpModel, OPUS_HELP_CONFIG, type HelpModel } from './help/models'
import { loadPlaybook, type Playbook } from './help/prompt'
import { benchmark, loadScenarios, reportMarkdown } from './help/evalRunner'
import type { SessionEvent } from './session'
import type { Storage } from './storage'

export const HELP_HOTKEY = 'Control+Alt+H'

export interface HelpSettings {
  model: 'claude-sonnet-5-5' | 'claude-opus-5-5'
  prefetch: boolean
}

const DEFAULT_SETTINGS: HelpSettings = { model: 'claude-sonnet-5-5', prefetch: true }

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
  private settings: HelpSettings
  private setup: CallSetup
  memory: CallMemory | null = null
  engine: HelpEngine | null = null
  private sessionState = 'idle'
  private sessionNow: () => number = () => 0
  hotkeyRegistered = false

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
    this.settings = storage.readJson('help-settings.json', DEFAULT_SETTINGS)
    // Older saved setups have no deployment field; missing fields fall back to the defaults.
    this.setup = { ...DEFAULT_SETUP, ...storage.readJson('call-setup.json', DEFAULT_SETUP) }
    try {
      this.kb.indexFolder(this.knowledgeDir)
    } catch (err) {
      log('knowledge_index_failed', { message: (err as Error).message })
    }
  }

  /** User-edited playbook in userData wins over the shipped draft. */
  private loadPlaybook(): Playbook {
    const user = path.join(this.storage.root, 'playbook.json')
    try {
      if (fs.existsSync(user)) return loadPlaybook(user)
    } catch (err) {
      this.log('playbook_invalid', { message: (err as Error).message })
    }
    return loadPlaybook(path.join(this.appPath, 'config', 'playbook.json'))
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
    }
  }

  // ---------------------------------------------------------------- settings / setup / knowledge

  setSettings(s: Partial<HelpSettings>): HelpSettings {
    if (s.model === 'claude-sonnet-5-5' || s.model === 'claude-opus-5-5') this.settings.model = s.model
    if (typeof s.prefetch === 'boolean') this.settings.prefetch = s.prefetch
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
    if (this.memory) this.memory.setup = setup
    return setup
  }

  importKnowledge(picked: string[], fromFolder: boolean): KnowledgeImport & { docs: KnowledgeDocMeta[] } {
    const r = importKnowledgeFiles(this.knowledgeDir, picked, fromFolder)
    this.log('knowledge_import', { added: r.added.length, skipped: r.skipped.length })
    return { ...r, docs: this.reindexKnowledge() }
  }

  removeKnowledge(docId: string): { ok: boolean; docs: KnowledgeDocMeta[] } {
    const doc = this.kb.getDoc(docId)
    const ok = !!doc && removeKnowledgeFile(this.knowledgeDir, doc.file)
    this.log('knowledge_remove', { doc_id: docId, ok })
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
      return
    }
    const m = this.memory
    if (!m) return
    const now = this.sessionNow()
    switch (ev.type) {
      case 'turn': {
        const t = ev.event.turn
        m.upsertTurn({ id: t.turn_id, stream: t.stream, cluster: t.speaker_cluster, start_ms: t.start_ms, end_ms: t.end_ms, text: t.text, available_ms: now }, ev.event.type === 'turn_final')
        this.engine?.onFinalWords()
        break
      }
      case 'interim':
        m.setInterim(ev.stream, ev.text, now)
        break
      case 'gap_open':
      case 'gap_close':
        m.upsertGap({ id: ev.gap.gap_id, stream: ev.gap.stream, cause: ev.gap.cause, start_ms: ev.gap.start_ms, end_ms: ev.gap.end_ms })
        break
      case 'timing':
        if (ev.sttDelayMs !== null) m.lagMs.set(ev.stream, ev.sttDelayMs)
        break
    }
  }

  private startCall(sessionId: string, nowSessionMs: () => number): void {
    this.engine?.dispose()
    this.sessionNow = nowSessionMs
    this.memory = new CallMemory(sessionId, this.db, this.kb.aliasMap)
    this.memory.setup = { ...this.setup }
    this.db.sql.prepare('INSERT OR REPLACE INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run(sessionId, new Date().toISOString(), JSON.stringify(this.setup))
    const model = this.createModel()
    this.engine = new HelpEngine({
      memory: this.memory, kb: this.kb, model, config: this.modelConfig(), playbook: this.playbook, db: this.db,
      sessionNowMs: () => this.sessionNow(), emit: this.emit, log: this.log, prefetch: this.settings.prefetch,
    })
    this.log('help_ready', { model: model.label(this.modelConfig()), mock: model.mock, prefetch: this.settings.prefetch, playbook: this.playbook.version })
  }

  /** HELP button / hotkey. Never gated by speaker role. */
  press(): { ok: boolean; reason?: string; request_id?: string } {
    if (!this.engine || this.sessionState !== 'live') {
      return { ok: false, reason: this.sessionState === 'paused' ? 'Paused - resume to use HELP.' : 'Start a call first.' }
    }
    return { ok: true, request_id: this.engine.press('help_requested') }
  }

  feedback(raw: unknown): { ok: boolean } {
    const r = (raw ?? {}) as Record<string, unknown>
    const types: FeedbackType[] = ['useful', 'should_have_stayed_quiet', 'bad']
    const reasons: BadReason[] = ['wrong_move', 'assumed_too_much', 'already_known', 'too_generic', 'too_late', 'bad_wording', 'unsupported', 'other']
    if (typeof r.card_id !== 'string' || !types.includes(r.type as FeedbackType)) return { ok: false }
    const eng = this.engine
    const ev = {
      card_id: r.card_id.slice(0, 64), origin: 'help_requested' as const, type: r.type as FeedbackType,
      bad_reason: reasons.includes(r.bad_reason as BadReason) ? (r.bad_reason as BadReason) : null,
      optional_note: typeof r.note === 'string' && r.note.trim() ? r.note.slice(0, 500) : null,
    }
    if (eng) eng.recordFeedback(ev)
    else this.db.sql.prepare('INSERT INTO feedback (card_id, origin, type, bad_reason, note, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ev.card_id, ev.origin, ev.type, ev.bad_reason, ev.optional_note, new Date().toISOString())
    return { ok: true }
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
    const model = this.createModel()
    this.benchmarking = true
    try {
      this.log('help_benchmark_start', { scenarios: scenarios.length, repeats, configs: configs.map((c) => c.model), mock: model.mock })
      const report = await benchmark({
        scenarios, model, configs, playbook: this.playbook, repeats,
        onProgress: (done, total, last) => progress({ done, total, scenario: last.scenario_id, ok: last.level1.pass }),
      })
      const dir = path.join(this.storage.root, 'reports')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = report.created_at.replace(/[:.]/g, '-')
      const file = path.join(dir, `help-benchmark-${stamp}${model.mock ? '-MOCK' : ''}.json`)
      fs.writeFileSync(file, JSON.stringify({ ...report, mock: model.mock }, null, 2))
      const md = (model.mock ? '> MOCK RUN - no model was called. Latency and quality numbers are meaningless.\n\n' : '') + reportMarkdown(report)
      fs.writeFileSync(file.replace(/\.json$/, '.md'), md)
      this.log('help_benchmark_done', { file, summaries: report.summaries.map((x) => ({ model: x.model, p50: x.first_usable_median_ms, p95: x.first_usable_p95_ms, l1: x.level1_pass_rate, cost: x.cost_usd })) })
      return { ok: true, reportFile: file, markdown: md }
    } finally {
      this.benchmarking = false
    }
  }

  shutdown(): void {
    this.engine?.dispose()
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}
