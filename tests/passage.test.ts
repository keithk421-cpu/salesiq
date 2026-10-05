import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Deployment, HelpCardEvent, HelpModelConfig, KnowledgeChunk } from '../src/shared/help'
import { Db } from '../src/main/db'
import { KnowledgeBase, docMetaFrom, type RankedChunk } from '../src/main/knowledge'
import { CallMemory, DEFAULT_SETUP } from '../src/main/help/callMemory'
import { buildHelpContext } from '../src/main/help/context'
import { HelpEngine } from '../src/main/help/engine'
import { reportMarkdown, runScenario, summarize } from '../src/main/help/evalRunner'
import type { HelpModel, HelpModelResult, HelpModelRun } from '../src/main/help/models'
import {
  PASSAGE_COMMON_SHARE, PASSAGE_MARGIN, PASSAGE_RARE_MAX_SECTIONS, PASSAGE_SNIPPET_CHARS, findApprovedPassage, passageSnippet, strongMatch, type MatchFacts,
} from '../src/main/help/passage'
import { loadPlaybook } from '../src/main/help/prompt'
import type { Scenario } from '../src/main/help/replay'
import { ACK_MAX_WORDS, KNOWLEDGE_KEEP_SHARE, QUESTION_WINDOW_MS, latestQuestion, mergeRanked, questionParts } from '../src/main/help/retrieval'

const ALIASES = fileURLToPath(new URL('../config/aliases.json', import.meta.url))
const playbook = loadPlaybook(fileURLToPath(new URL('../config/playbook.json', import.meta.url)))

// ---------------------------------------------------------------- an invented knowledge pack (no real material)

const SEC = `# Security answers

## Single sign-on with Okta and Entra ID (SAML)
On the Enterprise plan, the platform supports SAML single sign-on with Okta and Entra ID. Users can be created at their first login. Admins can require it for everyone.

Source: Security FAQ (fixture, 2026-09)

## SOC 2 Type II report: how to request it
The SOC 2 Type II report is shared under NDA through the trust portal.

Source: Trust portal page (fixture)

## Data regions: US and EU
Hosted accounts choose a US or EU data region when the account is created.

Source: Regions page (fixture)`

const OBJ = `# Objection handling

## Objection: the tool is too expensive
Ask what they compare the cost with before talking about value.

Source: Objection notes (fixture)

## Objection: security review takes too long (SSO, SOC 2)
Ask which part of their review usually takes longest.

Source: Objection notes (fixture)

## Objection: we already use Datadog
Ask what they look at in Datadog today for their AI features.

Source: Objection notes (fixture)`

const CORE = `# Platform basics

## Tracing with OpenTelemetry
Traces are collected with OpenTelemetry instrumentation.

Source: Product docs (fixture)

## Dashboards and alerts in Slack
Monitors can send alerts to Slack and email.

Source: Product docs (fixture)

## How the platform is different from notebooks
Notebooks run checks by hand; the platform runs them on live traffic.

Source: Product docs (fixture)`

const SELF = `# Self-hosted

## Air-gapped installs
Self-hosted installs can run with no outbound connection.

Source: Self-hosted guide (fixture)

## Running in your own Kubernetes cluster
The self-hosted edition installs into the buyer's own Kubernetes cluster.

Source: Self-hosted guide (fixture)`

function pack(opts: { db?: Db; approveSec?: boolean; secReviewBy?: string } = {}): KnowledgeBase {
  const kb = new KnowledgeBase(opts.db ?? new Db(':memory:'), ALIASES)
  const add = (id: string, meta: Record<string, string>, body: string, approve = true) => {
    kb.addDoc(docMetaFrom(`/k/${id}.md`, meta, body), body)
    if (approve) kb.approve(id, true)
  }
  add('sec', { title: 'Security answers', applies_to: 'saas', tags: 'sso, soc 2, data region', ...(opts.secReviewBy ? { review_by: opts.secReviewBy } : {}) }, SEC, opts.approveSec ?? true)
  add('obj', { title: 'Objection handling', applies_to: 'all', tags: 'expensive, datadog' }, OBJ)
  add('core', { title: 'Platform basics', applies_to: 'all', tags: 'tracing, opentelemetry' }, CORE)
  add('self', { title: 'Self-hosted', applies_to: 'self_hosted', tags: 'air-gapped, kubernetes' }, SELF)
  return kb
}

/** A call where the other side has just said `said`, `atMs` 2 s after it ended. */
function call(said: string, deployment: Deployment = 'unknown', db: Db | null = null): { memory: CallMemory; atMs: number } {
  const memory = new CallMemory('sess', db)
  memory.setup = { ...DEFAULT_SETUP, deployment }
  memory.upsertTurn({ id: 'k1', stream: 'local_mic', cluster: null, start_ms: 40_000, end_ms: 44_000, text: 'What would be most useful to cover today?', available_ms: 45_000 }, true)
  memory.upsertTurn({ id: 'b1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 50_000, end_ms: 55_000, text: said, available_ms: 56_000 }, true)
  return { memory, atMs: 57_000 }
}

const passageFor = (said: string, deployment: Deployment = 'unknown', kb = pack()) => {
  const c = call(said, deployment)
  return findApprovedPassage({ kb, memory: c.memory, atMs: c.atMs, today: new Date('2026-10-05') })
}

// ---------------------------------------------------------------- the question

describe('the question: the other side\'s latest words', () => {
  const turn = (id: string, stream: 'local_mic' | 'system_remote', start: number, end: number, text: string) =>
    ({ id, stream, cluster: stream === 'local_mic' ? null : 'e1:s0', start_ms: start, end_ms: end, text, available_ms: end + 1000 })

  it("is their last turn, even when Keith has started answering since", () => {
    const m = new CallMemory('q')
    m.upsertTurn(turn('a', 'system_remote', 10_000, 14_000, 'Do you have a SOC 2 report?'), true)
    m.upsertTurn(turn('b', 'local_mic', 15_000, 25_000, 'Great question, so the way we usually handle the security review is we start with the questionnaire'), true)
    expect(latestQuestion(m, 27_000)).toBe('Do you have a SOC 2 report?')
  })

  it("keeps their question together across Keith's short acknowledgment and their filler", () => {
    const m = new CallMemory('q')
    m.upsertTurn(turn('a', 'system_remote', 10_000, 14_000, 'Do you have a SOC 2 report?'), true)
    m.upsertTurn(turn('b', 'local_mic', 14_500, 15_500, 'Fair question.'), true)
    m.upsertTurn(turn('c', 'system_remote', 16_000, 17_000, 'So, yeah.'), true)
    expect(latestQuestion(m, 19_000)).toBe('Do you have a SOC 2 report? So, yeah.')
  })

  it('a question or a real answer from Keith ends it: what they said before belongs to an older exchange', () => {
    const m = new CallMemory('q')
    m.upsertTurn(turn('a', 'system_remote', 1_000, 5_000, 'We already use Datadog for everything.'), true)
    m.upsertTurn(turn('b', 'local_mic', 6_000, 8_000, 'Got it. Who owns that?'), true)
    m.upsertTurn(turn('c', 'system_remote', 9_000, 12_000, 'The platform team does.'), true)
    expect(latestQuestion(m, 14_000)).toBe('The platform team does.')
    // Both sides of the acknowledgment length: up to ACK_MAX_WORDS words it doesn't end the question, one more does.
    const ack = Array.from({ length: ACK_MAX_WORDS }, (_, i) => `word${i}`).join(' ')
    const n = new CallMemory('q')
    n.upsertTurn(turn('a', 'system_remote', 1_000, 5_000, 'We already use Datadog.'), true)
    n.upsertTurn(turn('b', 'local_mic', 6_000, 8_000, ack), true)
    n.upsertTurn(turn('c', 'system_remote', 9_000, 12_000, 'So, yeah.'), true)
    expect(latestQuestion(n, 14_000)).toBe('We already use Datadog. So, yeah.')
    n.upsertTurn(turn('b', 'local_mic', 6_000, 8_000, `${ack} more`), true)
    expect(latestQuestion(n, 14_000)).toBe('So, yeah.')
  })

  it('only their turns that ended in the last 30 s count', () => {
    const m = new CallMemory('q')
    m.upsertTurn(turn('a', 'system_remote', 1_000, 10_000, 'Do you have a SOC 2 report?'), true)
    expect(latestQuestion(m, 10_000 + QUESTION_WINDOW_MS)).toBe('Do you have a SOC 2 report?')
    expect(latestQuestion(m, 10_001 + QUESTION_WINDOW_MS)).toBe('')
  })

  it('what they asked last: their newest turn with a question mark and real words, else their newest with real words', () => {
    const m = new CallMemory('q')
    m.upsertTurn(turn('a', 'system_remote', 1_000, 4_000, 'Do you support Okta SSO?'), true)
    m.upsertTurn(turn('b', 'local_mic', 5_000, 7_000, 'Yes, on the Enterprise plan.'), true)
    m.upsertTurn(turn('c', 'system_remote', 8_000, 10_000, 'Great. And what about pricing?'), true)
    expect(questionParts(m, 12_000)).toEqual({ text: 'Do you support Okta SSO? Great. And what about pricing?', latest: 'Great. And what about pricing?' })
    // A remark after the question doesn't replace it; a filler has no words worth searching.
    m.upsertTurn(turn('d', 'system_remote', 10_500, 11_500, 'Sure, take your time.'), true)
    expect(questionParts(m, 13_000).latest).toBe('Great. And what about pricing?')
    const n = new CallMemory('q')
    n.upsertTurn(turn('a', 'system_remote', 1_000, 4_000, 'We already use Datadog.'), true)
    n.upsertTurn(turn('b', 'system_remote', 5_000, 6_000, 'So, yeah.'), true)
    expect(questionParts(n, 8_000).latest).toBe('We already use Datadog.')
  })

  it('words still being transcribed count: a buyer mid-question at the press exists only as provisional text', () => {
    const m = new CallMemory('q')
    m.setInterim('system_remote', 'and do you support single sign-on', 20_000)
    expect(latestQuestion(m, 21_000)).toBe('and do you support single sign-on')
    // After a finished turn of theirs, the provisional words are the rest of it.
    m.upsertTurn(turn('a', 'system_remote', 10_000, 15_000, 'One more thing on security.'), true)
    expect(latestQuestion(m, 21_000)).toBe('One more thing on security. and do you support single sign-on')
    // Keith's own provisional words are not theirs.
    m.setInterim('system_remote', '', 21_000)
    m.setInterim('local_mic', 'let me check', 21_000)
    expect(latestQuestion(m, 22_000)).toBe('One more thing on security.')
  })
})

// ---------------------------------------------------------------- merging the model's knowledge

describe("the model's knowledge: question alone + last 30 s, merged", () => {
  const chunk = (id: string, rank: number): RankedChunk => ({
    chunk_id: id, doc_id: id, title: id, heading: id, text: id, source_ref: '', stale: false, rank, matched: [], in_heading: [],
    meta: { doc_id: id, title: id, category: 'other', source: '', version: '', content_hash: '', approved: true, needs_reapproval: false, approved_by: null, approved_at: null, review_by: null, applies_to: [], tags: [], file: id },
  })
  const ids = (cs: KnowledgeChunk[]) => cs.map((c) => c.chunk_id)

  it('keeps each chunk at its best scaled rank and drops hits well below the best', () => {
    // Each list is scaled to its own best hit: 2.0 and 0.8 both count as 1.0.
    const q = [chunk('q1', 2.0), chunk('keep', 2.0 * KNOWLEDGE_KEEP_SHARE), chunk('drop', 2.0 * KNOWLEDGE_KEEP_SHARE - 0.01)]
    const hot = [chunk('h1', 0.8), chunk('drop', 0.1)]
    // Room for all four: only the threshold leaves one out.
    expect(ids(mergeRanked([q, hot], 4))).toEqual(['q1', 'h1', 'keep'])
    // A chunk weak in one list but strong in the other is kept at its better share.
    expect(ids(mergeRanked([q, [chunk('h1', 0.8), chunk('drop', 0.79)]], 4))).toEqual(['q1', 'h1', 'drop', 'keep'])
  })

  it('caps the sections sent; on a tie the question\'s own hit comes first; no question means the window alone', () => {
    const q = [chunk('q1', 1), chunk('q2', 0.9), chunk('q3', 0.8)]
    const hot = [chunk('h1', 5), chunk('h2', 4.6)]
    expect(ids(mergeRanked([q, hot], 3))).toEqual(['q1', 'h1', 'h2'])
    expect(ids(mergeRanked([null, hot], 3))).toEqual(['h1', 'h2'])
    expect(mergeRanked([null, []], 3)).toEqual([])
  })

  it("the buyer's question gets the first knowledge slot even after a long stretch of Keith's other talk", () => {
    const kb = pack()
    const m = new CallMemory('ctx')
    const keith = 'So the dashboards show every trace, and the monitors send alerts to Slack when the dashboards change, and the traces come in with OpenTelemetry, ' +
      'and the dashboards can be shared, and the alerts can go to Slack or email, and there are more dashboards for traces.'
    m.upsertTurn({ id: 'a', stream: 'local_mic', cluster: null, start_ms: 30_000, end_ms: 50_000, text: keith, available_ms: 51_000 }, true)
    m.upsertTurn({ id: 'b', stream: 'system_remote', cluster: 'e1:s0', start_ms: 51_000, end_ms: 53_000, text: 'Okay. Do you have a SOC 2 report?', available_ms: 54_000 }, true)
    m.upsertTurn({ id: 'c', stream: 'local_mic', cluster: null, start_ms: 54_000, end_ms: 55_000, text: 'Good question.', available_ms: 56_000 }, true)
    m.upsertTurn({ id: 'd', stream: 'system_remote', cluster: 'e1:s0', start_ms: 55_500, end_ms: 56_500, text: 'So, yeah.', available_ms: 57_500 }, true)
    const ctx = buildHelpContext({ memory: m, kb, atMs: 58_000, now: new Date('2026-10-05') })
    expect(ctx.sources.get('K1')?.detail).toMatch(/^SOC 2 Type II report/)
    expect(ctx.refs.knowledge_chunk_ids.length).toBeLessThanOrEqual(3)
  })

  it('a passage on the card is always among the sections the model gets, so "HELP used this" can light up', () => {
    for (const said of ['Do you support single sign-on with Okta?', 'Can it send alerts to Slack?', 'We already use Datadog.', 'Do you have a SOC 2 report?']) {
      const c = call(said)
      const kb = pack()
      const p = findApprovedPassage({ kb, memory: c.memory, atMs: c.atMs, today: new Date('2026-10-05') })
      const ctx = buildHelpContext({ memory: c.memory, kb, atMs: c.atMs, now: new Date('2026-10-05') })
      expect(p, said).not.toBeNull()
      expect(p!.chunk_ids.some((id) => ctx.refs.knowledge_chunk_ids.includes(id)), said).toBe(true)
    }
  })
})

// ---------------------------------------------------------------- strong match (each threshold, both sides)

describe('approved passage: strong-match rules', () => {
  const facts = (over: Partial<MatchFacts> = {}): MatchFacts => ({ concepts: [], sections: 40, topRank: 1, runnerUpRank: null, ...over })
  const c = (sections: number, inHeading = true, named = false, fromLatest = true) => ({ sections, inHeading, named, fromLatest })

  it('two of the question\'s concepts in the heading match; one ordinary word does not', () => {
    expect(strongMatch(facts({ concepts: [c(2), c(5)] }))).toBe(true)
    expect(strongMatch(facts({ concepts: [c(2)] }))).toBe(false)
    // Both must be in the heading.
    expect(strongMatch(facts({ concepts: [c(2), c(5, false)] }))).toBe(false)
  })

  it('a concept many sections mention never counts', () => {
    const many = Math.floor(40 * PASSAGE_COMMON_SHARE) // 13 of 40 is just over a third
    expect(strongMatch(facts({ concepts: [c(2), c(many)] }))).toBe(true)
    expect(strongMatch(facts({ concepts: [c(2), c(many + 1)] }))).toBe(false)
    // In a small pack a rare concept is a big share, but still not common.
    expect(strongMatch(facts({ sections: 4, concepts: [c(PASSAGE_RARE_MAX_SECTIONS), c(1)] }))).toBe(true)
    expect(strongMatch(facts({ sections: 4, concepts: [c(PASSAGE_RARE_MAX_SECTIONS + 1), c(1)] }))).toBe(false)
  })

  it('one rare named term in the heading is enough; a commoner one, an unnamed word or one outside the heading is not', () => {
    expect(strongMatch(facts({ concepts: [c(PASSAGE_RARE_MAX_SECTIONS, true, true)] }))).toBe(true)
    expect(strongMatch(facts({ concepts: [c(PASSAGE_RARE_MAX_SECTIONS + 1, true, true)] }))).toBe(false)
    expect(strongMatch(facts({ concepts: [c(1, true, false)] }))).toBe(false)
    expect(strongMatch(facts({ concepts: [c(1, false, true)] }))).toBe(false)
  })

  it('the heading must name something from what they asked last', () => {
    expect(strongMatch(facts({ concepts: [c(1, true, true, false), c(2, true, false, true)] }))).toBe(true)
    expect(strongMatch(facts({ concepts: [c(1, true, true, false), c(2, true, false, false)] }))).toBe(false)
    // In the text only is not enough.
    expect(strongMatch(facts({ concepts: [c(1, true, true, false), c(2, false, false, true)] }))).toBe(false)
  })

  it('must be clearly ahead of the best match from any other section', () => {
    const ok = facts({ concepts: [c(1, true, true)], topRank: 1.2 })
    expect(strongMatch({ ...ok, runnerUpRank: 1.2 * PASSAGE_MARGIN })).toBe(true)
    expect(strongMatch({ ...ok, runnerUpRank: 1.2 * PASSAGE_MARGIN + 0.01 })).toBe(false)
    expect(strongMatch({ ...ok, runnerUpRank: null })).toBe(true)
  })
})

describe('approved passage: what it shows', () => {
  it('the first sentence or two, about 200 characters; a long first sentence is cut at a word', () => {
    const a = `${'A'.repeat(140)} ends here.`
    expect(passageSnippet(`${a} Second one is short. Third.`)).toBe(`${a} Second one is short.`)
    // The second sentence is left out when both would run well past the limit.
    const long2 = `Then ${'b'.repeat(120)} done.`
    expect(passageSnippet(`${a} ${long2}`)).toBe(a)
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const cut = passageSnippet(`${words}.`)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(PASSAGE_SNIPPET_CHARS + 1)
    // "e.g." and "2.0" don't end a sentence.
    expect(passageSnippet('Supports SAML 2.0 with providers, e.g. Okta or Entra. Users are created at login. Admins can require it.'))
      .toBe('Supports SAML 2.0 with providers, e.g. Okta or Entra. Users are created at login.')
  })

  it("shows the best approved section for what they just asked, with its title, heading, whole text and Source line", () => {
    const p = passageFor('Do you support single sign-on with Okta?')!
    expect(p).toMatchObject({ doc_id: 'sec', title: 'Security answers', heading: 'Single sign-on with Okta and Entra ID (SAML)', applies_to: ['saas'], used_by_card: false })
    expect(p.snippet).toBe('On the Enterprise plan, the platform supports SAML single sign-on with Okta and Entra ID. Users can be created at their first login.')
    expect(p.text).toMatch(/Admins can require it for everyone\.$/)
    expect(p.source_ref).toBe('Source: Security FAQ (fixture, 2026-09)')
  })

  it('two words in the heading are enough without a named term ("alerts" + "Slack")', () => {
    expect(passageFor('Can it send alerts to Slack?')?.heading).toBe('Dashboards and alerts in Slack')
  })

  it('a lone ordinary word in a heading is not enough ("different" for a competitor the pack never mentions)', () => {
    expect(passageFor('How is this different from Braintrust?')).toBeNull()
    expect(passageFor('Thanks, that is really helpful.')).toBeNull()
  })

  it("not for an earlier question Keith already answered in a few words", () => {
    const kb = pack()
    const m = new CallMemory('two')
    const say = (id: string, stream: 'local_mic' | 'system_remote', start: number, text: string) =>
      m.upsertTurn({ id, stream, cluster: stream === 'local_mic' ? null : 'e1:s0', start_ms: start, end_ms: start + 2_000, text, available_ms: start + 3_000 }, true)
    say('a', 'system_remote', 10_000, 'Do you support Okta SSO?')
    say('b', 'local_mic', 13_000, 'Yes, on the Enterprise plan.')
    say('c', 'system_remote', 16_000, 'Great. And what about pricing?')
    expect(findApprovedPassage({ kb, memory: m, atMs: 20_000 })).toBeNull()
    // Their question followed by a remark still gets its note.
    say('b', 'local_mic', 13_000, 'Good question.')
    say('c', 'system_remote', 16_000, 'Sure, no rush.')
    expect(findApprovedPassage({ kb, memory: m, atMs: 20_000 })?.heading).toBe('Single sign-on with Okta and Entra ID (SAML)')
  })

  it('never from an unapproved document', () => {
    expect(passageFor('Do you support single sign-on with Okta?', 'unknown', pack({ approveSec: false }))?.doc_id).not.toBe('sec')
  })

  it('no stand-in: when the best match is stale or for the other deployment, nothing is shown', () => {
    // A self-hosted buyer: the SaaS answer is the best match, and the objection that mentions SSO would only be a stand-in.
    expect(passageFor('Do you support single sign-on with Okta?', 'self_hosted')).toBeNull()
    expect(passageFor('Do you support single sign-on with Okta?', 'saas')?.doc_id).toBe('sec')
    expect(passageFor('Do you support single sign-on with Okta?', 'unknown', pack({ secReviewBy: '2026-01-01' }))).toBeNull()
    // Self-hosted material is shown for a self-hosted buyer.
    expect(passageFor('Does it work air-gapped?', 'self_hosted')?.heading).toBe('Air-gapped installs')
    expect(passageFor('Does it work air-gapped?', 'saas')).toBeNull()
  })

  it('a long section is shown whole, its parts in order (part 10 comes after part 2)', () => {
    const kb = new KnowledgeBase(new Db(':memory:'), ALIASES)
    const paras = Array.from({ length: 11 }, (_, i) => `Part ${i + 1}. ${'Detail about regional hosting options. '.repeat(16)}`)
    const body = `## Data regions: US and EU\n\n${paras.join('\n\n')}\n\nSource: Regions page (fixture)`
    kb.addDoc(docMetaFrom('/k/regions.md', { title: 'Regions', tags: 'data region' }, body), body)
    kb.approve('regions', true)
    const c = call('Do you have an EU data region?')
    const p = findApprovedPassage({ kb, memory: c.memory, atMs: c.atMs })!
    expect(p.chunk_ids.length).toBeGreaterThanOrEqual(10)
    expect(p.chunk_ids.map((id) => Number(id.split('#')[1]))).toEqual(p.chunk_ids.map((_, i) => i + 1))
    expect(p.text.indexOf('Part 2.')).toBeLessThan(p.text.indexOf('Part 10.'))
    expect(p.snippet.startsWith('Part 1.')).toBe(true)
  })

  it('no knowledge, or nothing said by the other side: no passage', () => {
    const c = call('Do you support single sign-on with Okta?')
    expect(findApprovedPassage({ kb: null, memory: c.memory, atMs: c.atMs })).toBeNull()
    expect(findApprovedPassage({ kb: pack(), memory: new CallMemory('empty'), atMs: 60_000 })).toBeNull()
  })
})

// ---------------------------------------------------------------- on the card (engine)

/** Answers when released; cites the K id of the section whose heading matches `cite`, else the first transcript line. */
class CitingModel implements HelpModel {
  readonly mock = false
  calls: Array<{ user: string; release: () => void; fail: (e: Error) => void }> = []
  constructor(private readonly cite: RegExp | null) {}
  label() { return 'citing' }
  async prewarm() {}
  async check() { return { readiness: 'ready' as const } }
  run(req: HelpModelRun): Promise<HelpModelResult> {
    return new Promise((resolve, reject) => {
      const k = this.cite ? new RegExp(`\\[(K\\d+)\\][^\\n]*${this.cite.source}`).exec(req.user)?.[1] : undefined
      req.signal.addEventListener('abort', () => reject(new Error('aborted')))
      this.calls.push({
        user: req.user,
        fail: reject,
        release: () => {
          for (const c of ['MOVE: technical_answer\n', 'SAY: On the Enterprise plan we support single sign-on with Okta.\n', `HAPPENING: -\nFOLLOW: -\nSOURCES: ${k ?? 'T1'}\nNOTE: -\n`]) req.onText(c)
          resolve({ usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 }, stop_reason: 'end_turn', served_model: 'citing', fell_back: false })
        },
      })
    })
  }
}

function engineWith(model: HelpModel, opts: { prefetch?: boolean; said?: string } = {}) {
  const db = new Db(':memory:')
  const kb = pack({ db })
  const { memory } = call(opts.said ?? 'Do you support single sign-on with Okta?', 'unknown', db)
  let sessionMs = 57_000
  const wall = 5_000
  const events: HelpCardEvent[] = []
  const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
  const config: HelpModelConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', thinking: 'off', timeout_ms: 8000, max_tokens: 400 }
  const engine = new HelpEngine({
    memory, kb, model, config, playbook, db, sessionNowMs: () => sessionMs, emit: (e) => events.push(e),
    log: (e, d) => logs.push({ e, d }), prefetch: opts.prefetch ?? false, wallNow: () => wall,
  })
  return {
    db, memory, engine, events, logs,
    say: (text: string, stream: 'system_remote' | 'local_mic' = 'system_remote') => {
      sessionMs += 3000
      memory.upsertTurn({ id: `x${sessionMs}`, stream, cluster: stream === 'local_mic' ? null : 'e1:s0', start_ms: sessionMs - 2000, end_ms: sessionMs - 500, text, available_ms: sessionMs }, true)
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('approved passage on the HELP card', () => {
  it('is in the very first card event of the press and on every event for that request', async () => {
    const m = new CitingModel(/Single sign-on/)
    const s = engineWith(m)
    const id = s.engine.press()
    expect(s.events).toHaveLength(1)
    expect(s.events[0]).toMatchObject({ request_id: id, status: 'pending' })
    expect(s.events[0].passage).toMatchObject({ heading: 'Single sign-on with Okta and Entra ID (SAML)', used_by_card: false })
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.length).toBeGreaterThan(2)
    expect(s.events.every((e) => e.passage?.heading === 'Single sign-on with Okta and Entra ID (SAML)')).toBe(true)
  })

  it('is marked "HELP used this" only when the finished card cites that section', async () => {
    const used = engineWith(new CitingModel(/Single sign-on/))
    used.engine.press()
    ;(used.engine as unknown as { d: { model: CitingModel } }).d.model.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    expect(used.events.at(-1)).toMatchObject({ status: 'complete' })
    expect(used.events.at(-1)!.passage!.used_by_card).toBe(true)
    expect(used.events.filter((e) => e.status !== 'complete').every((e) => !e.passage!.used_by_card)).toBe(true)
    const notUsed = engineWith(new CitingModel(null))
    notUsed.engine.press()
    ;(notUsed.engine as unknown as { d: { model: CitingModel } }).d.model.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    expect(notUsed.events.at(-1)).toMatchObject({ status: 'complete' })
    expect(notUsed.events.at(-1)!.passage!.used_by_card).toBe(false)
  })

  it('stays when Claude fails, times out or is cut off by Pause', async () => {
    const failed = engineWith(new CitingModel(null))
    failed.engine.press()
    ;(failed.engine as unknown as { d: { model: CitingModel } }).d.model.calls[0].fail(new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)
    expect(failed.events.at(-1)).toMatchObject({ status: 'failed' })
    expect(failed.events.at(-1)!.passage?.heading).toBe('Single sign-on with Okta and Entra ID (SAML)')

    const slow = engineWith(new CitingModel(null))
    slow.engine.press()
    await vi.advanceTimersByTimeAsync(8000)
    expect(slow.events.at(-1)).toMatchObject({ status: 'timeout' })
    expect(slow.events.at(-1)!.passage).not.toBeNull()

    const paused = engineWith(new CitingModel(null))
    paused.engine.press()
    paused.engine.cancelAll('pause')
    expect(paused.events.at(-1)).toMatchObject({ status: 'cancelled' })
    expect(paused.events.at(-1)!.passage).not.toBeNull()
  })

  it('a new press replaces it (with nothing when the new moment has no strong match)', async () => {
    const m = new CitingModel(null)
    const s = engineWith(m)
    s.engine.press()
    expect(s.events.at(-1)!.passage).not.toBeNull()
    s.say('Yes, on the Enterprise plan you can use Okta, and admins can require it for everyone.', 'local_mic')
    s.say('Thanks, that is really helpful.')
    s.engine.press()
    const second = s.events.filter((e) => e.seq === 2)
    expect(second.length).toBeGreaterThan(0)
    expect(second.every((e) => !e.passage)).toBe(true)
  })

  it('a prefetched card served at once gets the passage found at the press', async () => {
    const m = new CitingModel(/Single sign-on/)
    const s = engineWith(m, { prefetch: true })
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events).toHaveLength(0)
    const id = s.engine.press()
    expect(s.events).toHaveLength(1)
    expect(s.events[0]).toMatchObject({ request_id: id, status: 'complete', timing: { served_from_prefetch: true, passage_ms: 0 } })
    expect(s.events[0].passage).toMatchObject({ heading: 'Single sign-on with Okta and Entra ID (SAML)', used_by_card: true })
    const row = s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(id) as { timing_json: string }
    expect(JSON.parse(row.timing_json)).toMatchObject({ passage_ms: 0, passage_used: true })
  })

  it('records the stage timings with each request; logs keep numbers, not knowledge names or text', async () => {
    const m = new CitingModel(/Single sign-on/)
    const s = engineWith(m)
    const id = s.engine.press()
    expect(s.events[0].timing).toMatchObject({ passage_ms: 0, context_ms: 0, knowledge_ms: 0 })
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    const t = JSON.parse((s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(id) as { timing_json: string }).timing_json)
    expect(t).toMatchObject({ passage_ms: 0, context_ms: 0, knowledge_ms: 0, passage_used: true })
    expect(t.passage_chunk_ids).toEqual(['k:sec#1'])
    expect(s.logs.find((l) => l.e === 'help_press')?.d).toMatchObject({ passage: true })
    expect(s.logs.find((l) => l.e === 'help_done')?.d).toMatchObject({ passage_ms: 0, passage_used: true, context_ms: 0, knowledge_ms: 0 })
    const logText = JSON.stringify(s.logs)
    expect(logText).not.toMatch(/k:sec|Single sign-on|Security answers/)
    // No passage: the timing says so.
    const none = engineWith(new CitingModel(null), { said: 'Thanks, that is really helpful.' })
    none.engine.press()
    expect(none.events[0].passage).toBeNull()
    expect(none.events[0].timing.passage_ms).toBeNull()
  })

  it('a problem finding the passage never stops HELP', () => {
    const s = engineWith(new CitingModel(null))
    const kb = (s.engine as unknown as { d: { kb: KnowledgeBase } }).d.kb
    const real = kb.searchRanked.bind(kb)
    kb.searchRanked = (text, today, dep, opts) => {
      if (opts?.everyApproved) throw new Error('index busy')
      return real(text, today, dep, opts)
    }
    s.engine.press()
    expect(s.events[0]).toMatchObject({ status: 'pending', passage: null })
    expect(s.logs.some((l) => l.e === 'help_passage_failed')).toBe(true)
  })
})

// ---------------------------------------------------------------- the speed test report

describe('speed test: stages from the press', () => {
  const scenario: Scenario = {
    id: 'unit-passage', category: 'technical', golden_approved: false, call_type: 'discovery', call_goal: '', desired_outcomes: [],
    speakers: { 'e1:s0': { role: 'buyer', name: null } },
    transcript: [
      { t: 0, end: 4, who: 'keith', text: 'What would be most useful to cover today?' },
      { t: 5, end: 9, who: 'e1:s0', text: 'Do you support single sign-on with Okta?' },
    ],
    help_at_s: 11,
    knowledge: [
      { id: 'sso', title: 'Security answers', text: '## Single sign-on with Okta (SAML)\n\nThe platform supports SAML single sign-on with Okta.\n\nSource: fixture' },
      { id: 'dash', title: 'Platform basics', text: '## Dashboards\n\nDashboards show traces.\n\nSource: fixture' },
    ],
    best_moves: ['technical_answer'], acceptable_moves: [], unacceptable_behaviors: [],
  }

  /** Answers straight away. */
  class AnsweringModel extends CitingModel {
    override run(req: HelpModelRun): Promise<HelpModelResult> {
      const p = super.run(req)
      this.calls.at(-1)!.release()
      return p
    }
  }

  it('reports press -> approved note, -> first token, -> first usable line, plus context and knowledge search', async () => {
    vi.useRealTimers()
    const res = await runScenario(scenario, new AnsweringModel(/Single sign-on/), { provider: 'anthropic', model: 'm', effort: 'low', thinking: 'off', timeout_ms: 8000, max_tokens: 400 }, playbook)
    expect(res.passage).toEqual({ title: 'Security answers', heading: 'Single sign-on with Okta (SAML)', cited: true })
    expect(typeof res.passage_ms).toBe('number')
    expect(res.first_token_ms!).toBeGreaterThanOrEqual(res.passage_ms!)
    expect(res.first_usable_ms!).toBeGreaterThanOrEqual(res.first_token_ms!)
    expect(typeof res.context_ms).toBe('number')
    expect(typeof res.knowledge_ms).toBe('number')
    const sum = summarize('m', [res, { ...res, passage: null, passage_ms: null }])
    expect(sum.passage_shown_rate).toBe(0.5)
    expect(sum.passage_cited_rate).toBe(1)
    expect(sum.passage_median_ms).toBe(res.passage_ms)
    const md = reportMarkdown({ created_at: 'x', playbook_version: 'p', scenarios: 1, approved_scenarios: 0, repeats: 1, note: '', summaries: [sum], results: [res] })
    expect(md).toContain('## Speed by stage (from the press)')
    expect(md).toMatch(/\| m \| 50% \| \d+ ms \| \d+ ms \| \d+ ms \| \d+ ms \| \d+ ms \| \d+ ms \| \d+ ms \| 100% \|/)
  })
})
