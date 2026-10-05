import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { HelpCardEvent, HelpModelConfig } from '../src/shared/help'
import { Db } from '../src/main/db'
import { KnowledgeBase, chunkBody, parseFrontMatter, docMetaFrom } from '../src/main/knowledge'
import { CallMemory } from '../src/main/help/callMemory'
import { buildHelpContext } from '../src/main/help/context'
import { HelpEngine } from '../src/main/help/engine'
import { MockHelpModel, type HelpModel, type HelpModelRun, type HelpModelResult } from '../src/main/help/models'
import { buildSystemPrompt, loadPlaybook } from '../src/main/help/prompt'
import { LineProtocolParser, isUsableLine, validateCard } from '../src/main/help/protocol'
import { replayAt, type Scenario } from '../src/main/help/replay'

const playbook = loadPlaybook(fileURLToPath(new URL('../config/playbook.json', import.meta.url)))
const limits = playbook.card_limits

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'unit', category: 'neutral_discovery', golden_approved: false, call_type: 'discovery', call_goal: 'Understand their LLM eval process',
    desired_outcomes: ['Map the review process'], speakers: { 'e1:s0': { role: 'buyer', name: 'Dana' }, 'e1:s1': { role: 'unknown', name: null } },
    transcript: [
      { t: 0, who: 'keith', text: 'How do you review model outputs today?' },
      { t: 4, end: 14, who: 'e1:s0', text: 'So the platform team owns it, we kind of split it with the applied folks, they look at samples every week.' },
      { t: 15, end: 18, who: 'e1:s1', text: 'Yeah and I pull the samples from the logs.' },
      { t: 30, end: 40, who: 'e1:s0', text: 'Actually the bigger thing is we are moving to a new vendor next quarter for everything.' },
    ],
    help_at_s: 20, best_moves: ['clarify_current_state'], acceptable_moves: ['explore_process'], unacceptable_behaviors: [],
    ...over,
  }
}

describe('replay exposes only what was available at the HELP time', () => {
  it('hides future lines and shows in-progress speech only as provisional text', () => {
    const s = scenario()
    const r = replayAt(s, 34) // line 3 started at 30 s and is still being spoken
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toContain('platform team owns it')
    expect(ctx.text).toContain('(still being transcribed, may be inaccurate) Remote: Actually the bigger')
    expect(ctx.text).not.toContain('next quarter') // not said yet at 33 s (heard until help - 1 s)
    expect(r.hiddenLineIndexes).toEqual([3])
    expect(ctx.refs.provisional_text).toBe(true)
  })

  it('a finished line is not visible until ~1 s after it ended', () => {
    const s = scenario()
    const before = buildHelpContext({ memory: replayAt(s, 18.5).memory, kb: null, atMs: 18500 })
    expect(before.text).not.toContain('I pull the samples from the logs')
    const after = buildHelpContext({ memory: replayAt(s, 19.5).memory, kb: null, atMs: 19500 })
    expect(after.text).toContain('I pull the samples from the logs')
  })

  it('future gaps are not visible; past gaps are surfaced as warnings', () => {
    const s = scenario({ gaps: [{ start: 10, end: 13, stream: 'system_remote', cause: 'provider_disconnect' }, { start: 25, end: 27, stream: 'local_mic', cause: 'device_lost' }] })
    const r = replayAt(s, 20)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.warnings.join(' ')).toMatch(/Gap 0:10–0:13 \(meeting audio\) — HELP didn't hear that part/)
    expect(ctx.text).toMatch(/Transcript gap 0:10–0:13/)
    expect(ctx.text).not.toMatch(/0:25/)
  })
})

describe('context assembly', () => {
  it('uses all speakers; unknown speakers are labelled, never excluded', () => {
    const r = replayAt(scenario(), 20)
    const ctx = buildHelpContext({ memory: r.memory, kb: null, atMs: r.atMs })
    expect(ctx.text).toContain('Dana (buyer): So the platform team')
    expect(ctx.text).toContain('Speaker 1 (unlabeled): Yeah and I pull')
    expect(ctx.text).toMatch(/not labeled - roles unknown \(that is normal\)/)
  })

  it('includes relevant earlier-in-call evidence beyond the last 30 s and thread window', () => {
    const s = scenario({
      transcript: [
        { t: 60, end: 70, who: 'e1:s0', text: 'Our compliance deadline for the audit is March and Priya signs off on vendors.' },
        ...Array.from({ length: 12 }, (_, i) => ({ t: 300 + i * 20, end: 315 + i * 20, who: i % 2 ? 'keith' : 'e1:s0', text: `Filler conversation number ${i} about dashboards and charts and colors.` })),
        { t: 600, end: 608, who: 'e1:s0', text: 'Anyway, for the audit we need to know who signs off.' },
      ],
      help_at_s: 612,
    })
    const r = replayAt(s)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toMatch(/<earlier_in_call[^>]*>\n\[T\d+\] \(1:00\) Dana \(buyer\): Our compliance deadline/)
  })

  it('approved current knowledge is usable; unapproved is never sent; stale is title-only', () => {
    const s = scenario({
      knowledge: [
        { id: 'sso', title: 'SSO setup', text: 'SSO via SAML is supported for enterprise workspaces.', approved: true },
        { id: 'draft', title: 'Draft SSO notes', text: 'SSO SCIM provisioning maybe next year.', approved: false },
        { id: 'old', title: 'Old security FAQ', text: 'SSO and SAML details from last year.', approved: true, review_by: '2020-01-01' },
      ],
      transcript: [{ t: 0, end: 5, who: 'e1:s0', text: 'Do you support SSO with SAML?' }],
      help_at_s: 8,
    })
    const r = replayAt(s)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toContain('[K1] SSO setup')
    expect(ctx.text).not.toContain('SCIM')
    expect(ctx.text).toContain('"Old security FAQ" exists but is past its review date')
    expect(ctx.text).not.toContain('details from last year')
  })

  it('without knowledge, HELP is told to ask or follow up instead of stating facts', () => {
    const ctx = buildHelpContext({ memory: replayAt(scenario()).memory, kb: null, atMs: 20000 })
    expect(ctx.text).toMatch(/approved_knowledge>\(none relevant\) - do not state Arize product facts/)
  })
})

describe('knowledge import', () => {
  it('importing is not approval; front matter is preserved', () => {
    const { meta, body } = parseFrontMatter('---\ntitle: Security FAQ\ncategory: deployment_security\nversion: 2026-06\napplies_to: self_hosted, saas\n---\n# Security\n\nWe do X.')
    const doc = docMetaFrom('/k/security-faq.md', meta, body)
    expect(doc).toMatchObject({ title: 'Security FAQ', category: 'deployment_security', version: '2026-06', approved: false, applies_to: ['self_hosted', 'saas'] })
  })

  it('in-app approval applies to that exact version only', () => {
    const db = new Db(':memory:')
    const kb = new KnowledgeBase(db, null)
    const doc = docMetaFrom('/k/a.md', { version: 'v1' }, '# A\n\nAlpha bravo charlie delta.')
    kb.addDoc(doc, '# A\n\nAlpha bravo charlie delta.')
    expect(kb.search('bravo charlie').usable).toHaveLength(0)
    kb.approve(doc.doc_id, true)
    expect(kb.search('bravo charlie').usable).toHaveLength(1)
    // New version of the same document: approval does not carry over.
    db.sql.exec('DELETE FROM knowledge_docs; DELETE FROM knowledge_chunks; DELETE FROM knowledge_fts;')
    kb.addDoc({ ...doc, version: 'v2' }, '# A\n\nAlpha bravo charlie delta echo.')
    expect(kb.search('bravo charlie').usable).toHaveLength(0)
  })

  it('aliases widen search (FTS5, no embeddings)', () => {
    const db = new Db(':memory:')
    const kb = new KnowledgeBase(db, fileURLToPath(new URL('../config/aliases.json', import.meta.url)))
    kb.addDoc({ ...docMetaFrom('/k/otel.md', {}, 'x'), approved: true }, 'Tracing uses OpenTelemetry instrumentation.')
    expect(kb.search('do you support otel').usable).toHaveLength(1)
  })

  it("a doc's tags do not drown out the section that names the subject", () => {
    const db = new Db(':memory:')
    const kb = new KnowledgeBase(db, null)
    const sections = ['Braintrust', 'LangSmith', 'Langfuse', 'Weave'].map((c) => `## ${c} vs Arize\n\nWhere Arize differs from ${c}: tracing differs and evals differ.`)
    const body = `# Competitive\n\n${sections.join('\n\n')}\n\n## Galileo strengths\n\nGalileo is strong on guardrails.`
    // An untagged doc with an identical title and section is indexed first, so without the tag boost it wins the tie.
    kb.addDoc({ ...docMetaFrom('/k/other.md', { title: 'Competitive' }, 'x'), approved: true }, '## Galileo strengths\n\nGalileo is strong on guardrails.')
    kb.addDoc({ ...docMetaFrom('/k/competitive.md', { tags: 'braintrust, langsmith, langfuse, galileo, weave' }, body), approved: true }, body)
    expect(kb.search('how is this different from Galileo').usable.map((c) => c.heading).slice(0, 2)).toEqual(['Galileo strengths', 'Galileo strengths'])
    // Tags still break ties between documents.
    expect(kb.search('Galileo guardrails').usable[0].meta.doc_id).toBe('competitive')
  })

  it('chunks by headings', () => {
    const c = chunkBody('# Title\n\nIntro.\n\n## Deploy\n\nSelf-hosted notes.\n\n## Security\n\nSSO notes.')
    expect(c.map((x) => x.heading)).toEqual(['Title', 'Deploy', 'Security'])
  })
})

describe('line protocol', () => {
  it('first usable only after a complete, valid primary line that follows MOVE', () => {
    let now = 0
    const p = new LineProtocolParser(() => now)
    now = 100
    p.feed('MOVE: clarify_current_state\nASK: How does that')
    expect(p.firstUsableAt).toBeNull() // half a sentence is not usable
    now = 250
    p.feed(' arrangement work in practice?\nHAPPENING: They described ownership.\n')
    expect(p.firstUsableAt).toBe(250)
    expect(p.partial()).toMatchObject({ move: 'clarify_current_state', primary_kind: 'ask', primary: 'How does that arrangement work in practice?' })
  })

  it('headings, fragments and placeholders are not usable', () => {
    expect(isUsableLine('Ask:')).toBe(false)
    expect(isUsableLine('**Next**')).toBe(false)
    expect(isUsableLine('So what about...')).toBe(false)
    expect(isUsableLine('How does that work in practice?')).toBe(true)
  })

  it('validation removes unknown sources, flags invented numbers, enforces limits', () => {
    const p = new LineProtocolParser()
    p.feed('MOVE: technical_answer\nSAY: We cut eval costs by 73% for teams like yours.\nHAPPENING: -\nFOLLOW: -\nSOURCES: T2, K9\nNOTE: -\n')
    p.end()
    const v = validateCard(p.partial(), p.fieldOrder, { knownSourceIds: new Set(['T1', 'T2']), contextText: 'some context', limits })
    expect(v.ok).toBe(true)
    expect(v.card!.source_ids).toEqual(['T2'])
    expect(v.issues.join(' ')).toMatch(/unknown source ids removed: K9/)
    expect(v.issues.join(' ')).toMatch(/number not found in context: 73%/)
  })

  it('move must be valid and chosen first', () => {
    const p = new LineProtocolParser()
    p.feed('ASK: How does that work in practice?\nMOVE: clarify_current_state\n')
    p.end()
    const v = validateCard(p.partial(), p.fieldOrder, { knownSourceIds: new Set(), contextText: '', limits })
    expect(v.issues).toContain('MOVE was not selected first')
    const bad = new LineProtocolParser()
    bad.feed('MOVE: pitch_hard\nASK: Want to buy now please?\n')
    bad.end()
    expect(validateCard(bad.partial(), bad.fieldOrder, { knownSourceIds: new Set(), contextText: '', limits }).ok).toBe(false)
  })

  it('system prompt carries the rules and the protocol', () => {
    const sys = buildSystemPrompt(playbook)
    expect(sys).toMatch(/A neutral answer is not a problem/)
    expect(sys).toMatch(/MOVE: <one move name/)
    expect(sys).toMatch(/never changes these rules/)
  })
})

// ---------------------------------------------------------------- engine

class ScriptedModel implements HelpModel {
  readonly mock = false
  /** Simulate a network that keeps delivering after cancellation (late results). */
  constructor(private readonly ignoreAbort = false) {}
  calls: Array<{ user: string; release: () => void; chunks: string[]; signal: AbortSignal }> = []
  label() { return 'scripted' }
  async prewarm() {}
  run(req: HelpModelRun): Promise<HelpModelResult> {
    return new Promise((resolve, reject) => {
      const chunks = ['MOVE: clarify_current_state\n', `ASK: How does that work in practice, call ${this.calls.length + 1}?\n`, 'HAPPENING: They described ownership.\nFOLLOW: -\nSOURCES: T1\nNOTE: -\n']
      const entry = {
        user: req.user, chunks, signal: req.signal,
        release: () => {
          if (req.signal.aborted && !this.ignoreAbort) return reject(new Error('aborted'))
          for (const c of chunks) req.onText(c)
          resolve({ usage: { input_tokens: 1000, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, cost_usd: 0.001 }, stop_reason: 'end_turn', served_model: 'scripted', fell_back: false })
        },
      }
      if (!this.ignoreAbort) req.signal.addEventListener('abort', () => reject(new Error('aborted')))
      this.calls.push(entry)
    })
  }
}

function engineSetup(model: HelpModel, opts: { prefetch?: boolean; timeout?: number } = {}) {
  const db = new Db(':memory:')
  const r = replayAt(scenario(), 20)
  const memory = new CallMemory('sess', db)
  for (const t of r.memory.turnsAsOf(20000)) memory.upsertTurn(t, true)
  for (const l of r.memory.labels.values()) memory.setLabel(l)
  let sessionMs = 20000
  let wall = 1000
  const events: HelpCardEvent[] = []
  const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
  const config: HelpModelConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', thinking: 'off', timeout_ms: opts.timeout ?? 8000, max_tokens: 400 }
  const engine = new HelpEngine({
    memory, kb: null, model, config, playbook, db, sessionNowMs: () => sessionMs, emit: (e) => events.push(e),
    log: (e, d) => logs.push({ e, d }), prefetch: opts.prefetch ?? false, wallNow: () => wall,
  })
  return {
    db, memory, engine, events, logs,
    advance: (ms: number) => { wall += ms; sessionMs += ms },
    addTurn: (text: string) => memory.upsertTurn({ id: `x${sessionMs}`, stream: 'system_remote', cluster: 'e1:s0', start_ms: sessionMs - 2000, end_ms: sessionMs - 500, text, available_ms: sessionMs }, true),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HELP engine', () => {
  it('measures hotkey -> first usable and -> validated card; persists everything locally', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m)
    const id = s.engine.press()
    s.advance(900)
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    const last = s.events.at(-1)!
    expect(last.status).toBe('complete')
    expect(last.content.primary).toBe('How does that work in practice, call 1?')
    expect(last.timing.first_usable_ms).toBe(900)
    expect(last.timing.complete_ms).toBe(900)
    expect(last.sources[0]).toMatchObject({ kind: 'turn' })
    const row = s.db.sql.prepare('SELECT * FROM help_requests WHERE id = ?').get(id) as Record<string, string>
    expect(row.status).toBe('complete')
    expect(JSON.parse(row.model_json)).toMatchObject({ model: 'claude-sonnet-5-5', playbook: playbook.version })
    expect(JSON.parse(row.context_refs_json).hot_turn_ids.length).toBeGreaterThan(0)
    expect(row.request_text).toContain('<last_30_seconds>')
    expect(JSON.parse(row.usage_json)).toMatchObject({ input_tokens: 1000, cost_usd: 0.001 })
    // Diagnostics never carry transcript or card text.
    expect(JSON.stringify(s.logs)).not.toContain('platform team')
    expect(JSON.stringify(s.logs)).not.toContain('practice')
  })

  it('a new press supersedes the pending one; the older response never reaches the screen', async () => {
    const m = new ScriptedModel(true)
    const s = engineSetup(m)
    s.engine.press()
    s.engine.press()
    m.calls[1].release()
    await vi.advanceTimersByTimeAsync(0)
    m.calls[0].release() // late result of the first press
    await vi.advanceTimersByTimeAsync(0)
    const shown = s.events.filter((e) => e.content.primary)
    expect(shown.every((e) => e.seq === 2)).toBe(true)
    expect(s.events.at(-1)!.content.primary).toContain('call 2')
  })

  it('a completed card is never rewritten by anything but a new press', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m, { prefetch: true })
    s.engine.press()
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    const n = s.events.length
    s.addTurn('A new thing they said')
    s.engine.onFinalWords()
    await vi.advanceTimersByTimeAsync(1000)
    m.calls.at(-1)!.release() // background prefetch completes
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.length).toBe(n)
  })

  it('pause/stop cancel pending HELP and suppress late results', async () => {
    const m = new ScriptedModel(true)
    const s = engineSetup(m)
    s.engine.press()
    s.engine.cancelAll('pause')
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.some((e) => e.status === 'complete')).toBe(false)
    expect(s.events.at(-1)!.status).toBe('cancelled')
  })

  it('prefetch makes an unchanged moment instant; new speech forces a fresh request', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m, { prefetch: true })
    s.engine.onFinalWords()
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(1) // background candidate requested
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events).toHaveLength(0) // never shown unless Keith presses
    s.advance(3000)
    s.engine.press()
    const shown = s.events.at(-1)!
    expect(shown.status).toBe('complete')
    expect(shown.timing.served_from_prefetch).toBe(true)
    expect(shown.timing.first_usable_ms).toBe(0)
    // Someone says something new -> the old candidate must not be used.
    s.addTurn('We actually have no budget this year')
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(false)
  })

  it('times out cleanly and records it', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m, { timeout: 3000 })
    s.engine.press()
    await vi.advanceTimersByTimeAsync(3100)
    expect(s.events.at(-1)!.status).toBe('timeout')
    expect(s.logs.find((l) => l.e === 'help_done')?.d?.status).toBe('timeout')
  })

  it('garbage output fails validation instead of showing a broken card', async () => {
    const bad: HelpModel = {
      mock: false, label: () => 'bad', prewarm: async () => {},
      run: async (req) => { req.onText('Sure! Here is some advice: be nice.\n'); return { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 }, stop_reason: 'end_turn', served_model: 'x', fell_back: false } },
    }
    const s = engineSetup(bad)
    s.engine.press()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)!.status).toBe('failed')
  })

  it('mock output is labelled as mock', async () => {
    const s = engineSetup(new MockHelpModel(10))
    s.engine.press()
    await vi.advanceTimersByTimeAsync(50)
    const e = s.events.at(-1)!
    expect(e.mock).toBe(true)
    expect(e.model_label).toMatch(/MOCK/)
    expect(e.content.primary).toMatch(/^\[MOCK\]/)
  })

  it('feedback is stored with its origin (HELP-requested, not proactive Coach)', () => {
    const s = engineSetup(new MockHelpModel(10))
    s.engine.recordFeedback({ card_id: 'c1', origin: 'help_requested', type: 'should_have_stayed_quiet', bad_reason: null, optional_note: null })
    const row = s.db.sql.prepare('SELECT origin, type FROM feedback').get() as Record<string, string>
    expect(row).toEqual({ origin: 'help_requested', type: 'should_have_stayed_quiet' })
  })
})

describe('replay of a real saved session', () => {
  it('rebuilds the call as of any moment, with gaps and nothing from later', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const { scenarioFromSession } = await import('../src/main/help/replay')
    const dir = fs.mkdtempSync(`${os.tmpdir()}/sess-`)
    const file = `${dir}/transcript.jsonl`
    fs.writeFileSync(file, [
      { kind: 'turn', stream: 'local_mic', speaker_cluster: null, start_ms: 1000, end_ms: 3000, text: 'How do you review outputs?' },
      { kind: 'turn', stream: 'system_remote', speaker_cluster: 'e1:s0', start_ms: 4000, end_ms: 9000, text: 'Mostly spot checks each week.' },
      { kind: 'gap_close', stream: 'system_remote', cause: 'provider_disconnect', start_ms: 10000, end_ms: 12000 },
      { kind: 'turn', stream: 'system_remote', speaker_cluster: 'e2:s0', start_ms: 30000, end_ms: 34000, text: 'Later we will move vendors.' },
    ].map((x) => JSON.stringify(x)).join('\n'))
    const s = scenarioFromSession(file, 15)
    const r = replayAt(s)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toContain('Mostly spot checks each week.')
    expect(ctx.text).not.toContain('move vendors')
    expect(ctx.warnings.join(' ')).toMatch(/Gap 0:10–0:12/)
  })
})
