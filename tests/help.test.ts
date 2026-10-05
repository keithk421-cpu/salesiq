import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HelpCardContent, HelpCardEvent, HelpModelConfig } from '../src/shared/help'
import { Db, ftsConcepts } from '../src/main/db'
import { KNOWLEDGE_TEXT_MAX, KnowledgeBase, chunkBody, loadAliases, parseFrontMatter, docMetaFrom, importKnowledgeFiles, removeKnowledgeFile } from '../src/main/knowledge'
import { CallMemory } from '../src/main/help/callMemory'
import { buildHelpContext } from '../src/main/help/context'
import { HelpEngine } from '../src/main/help/engine'
import { MockHelpModel, describeError, type HelpError, type HelpModel, type HelpModelRun, type HelpModelResult } from '../src/main/help/models'
import { buildSystemPrompt, loadPlaybook } from '../src/main/help/prompt'
import { LineProtocolParser, cardChecks, isUsableLine, validateCard } from '../src/main/help/protocol'
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

describe('knowledge in the final model context', () => {
  const ask = (text: string) => [{ t: 0, end: 5, who: 'e1:s0', text }]

  it('reaches the model whole: the full claim, its qualifier and the exact source reference', () => {
    const claim = `Self-hosted deployment is available on the Enterprise plan. ${'It runs in the customer VPC on Kubernetes. '.repeat(14)}Qualifier: Enterprise plan only.`
    const ref = `Source: Arize self-hosted page (arize.com/products/self-hosted, retrieved 2026-10-04); Security RFP KB (Notion: Solutions / Security, edited 2026-05-08); full-ref-end`
    expect(claim.length).toBeGreaterThan(650)
    expect(claim.length).toBeLessThanOrEqual(KNOWLEDGE_TEXT_MAX)
    const r = replayAt(scenario({ knowledge: [{ id: 'sh', title: 'Self-hosted', text: `## Self-hosted deployment\n\n${claim}\n\n${ref}` }], transcript: ask('Can we run a self-hosted deployment in our VPC?'), help_at_s: 8 }))
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toContain(claim)
    expect(ctx.text).toContain(ref)
    expect(ctx.sources.get('K1')?.detail).toContain(ref)
  })

  it('deployment scope: SaaS-only knowledge is never stated for a self-hosted buyer; unknown deployment carries the scope', () => {
    const knowledge = [{ id: 'sig', title: 'Signal', text: "## Signal\n\nSignal runs automatically every 6 hours on Arize's SaaS.\n\nSource: Signal docs", applies_to: ['saas'] }]
    const base = { knowledge, transcript: ask('Does Signal run automatically for us?'), help_at_s: 8 }
    const selfHosted = replayAt(scenario({ ...base, deployment: 'self_hosted' }))
    const sh = buildHelpContext({ memory: selfHosted.memory, kb: selfHosted.kb, atMs: selfHosted.atMs })
    expect(sh.text).not.toContain('every 6 hours')
    expect(sh.text).toMatch(/<other_deployment>\n"Signal" covers Arize's SaaS only, not this buyer's deployment: do not state it for them; offer to check\./)
    expect(sh.text).toContain('deployment: self-hosted')
    const unknown = replayAt(scenario(base))
    const un = buildHelpContext({ memory: unknown.memory, kb: unknown.kb, atMs: unknown.atMs })
    expect(un.text).toMatch(/\[K1\] Signal - Signal \(applies to: Arize's SaaS; version fixture\): Signal runs automatically/)
    expect(un.text).toContain('deployment: not known (SaaS or self-hosted)')
    const saas = replayAt(scenario({ ...base, deployment: 'saas' }))
    expect(buildHelpContext({ memory: saas.memory, kb: saas.kb, atMs: saas.atMs }).text).toContain('every 6 hours')
  })
})

describe('knowledge import', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'))
  const file = (dir: string, name: string, front: string, body: string) =>
    fs.writeFileSync(path.join(dir, name), `---\ntitle: Doc\ncategory: product\nsource: test\nversion: 2026-10-04\n${front}---\n\n${body}`)

  it('importing is not approval; front matter is preserved; approved: true in a file approves nothing', () => {
    const { meta, body } = parseFrontMatter('---\ntitle: Security FAQ\ncategory: deployment_security\nversion: 2026-06\napplies_to: self_hosted, saas\napproved: true\n---\n# Security\n\nWe do X.')
    const doc = docMetaFrom('/k/security-faq.md', meta, body)
    expect(doc).toMatchObject({ title: 'Security FAQ', category: 'deployment_security', version: '2026-06', approved: false, applies_to: ['self_hosted', 'saas'] })
    const kb = new KnowledgeBase(new Db(':memory:'), null)
    kb.addDoc(doc, body)
    expect(kb.getDoc(doc.doc_id)?.approved).toBe(false)
    expect(kb.search('we do x').usable).toHaveLength(0)
  })

  it('approval is bound to the reviewed content: an edit with the same readable version needs approval again', () => {
    const dir = tmp()
    const kb = new KnowledgeBase(new Db(':memory:'), null)
    file(dir, 'a.md', '', '## Retention\n\nRetention is 30 days.\n\nSource: pricing page')
    kb.indexFolder(dir)
    kb.approve('a', true)
    expect(kb.search('retention days').usable.map((c) => c.text)).toEqual(['Retention is 30 days.'])
    // Same version string, new claim: not usable, and flagged for re-approval.
    file(dir, 'a.md', '', '## Retention\n\nRetention is 365 days on every plan.\n\nSource: pricing page')
    expect(kb.indexFolder(dir)[0]).toMatchObject({ approved: false, needs_reapproval: true })
    expect(kb.search('retention days').usable).toHaveLength(0)
    // A material metadata change (scope) also needs re-approval, even with an identical body.
    file(dir, 'a.md', 'applies_to: self_hosted\n', '## Retention\n\nRetention is 30 days.\n\nSource: pricing page')
    expect(kb.indexFolder(dir)[0]).toMatchObject({ approved: false, needs_reapproval: true })
    // Restoring exactly what Keith approved restores the approval; approving new content works.
    file(dir, 'a.md', '', '## Retention\n\nRetention is 30 days.\n\nSource: pricing page')
    expect(kb.indexFolder(dir)[0]).toMatchObject({ approved: true, needs_reapproval: false })
  })

  it('explicit revocation wins, whatever the file says', () => {
    const dir = tmp()
    const kb = new KnowledgeBase(new Db(':memory:'), null)
    file(dir, 'b.md', 'approved: true\napproved_by: someone\n', '## Plans\n\nAll plans include SSO.\n\nSource: x')
    expect(kb.indexFolder(dir)[0].approved).toBe(false)
    kb.approve('b', true)
    expect(kb.getDoc('b')?.approved).toBe(true)
    kb.approve('b', false)
    expect(kb.getDoc('b')).toMatchObject({ approved: false, needs_reapproval: false })
    expect(kb.search('plans include sso').usable).toHaveLength(0)
    expect(kb.indexFolder(dir)[0].approved).toBe(false)
  })

  it('unapproved matches cannot crowd out an approved answer', () => {
    const dir = tmp()
    const kb = new KnowledgeBase(new Db(':memory:'), null)
    for (let i = 0; i < 35; i++) file(dir, `u${i}.md`, '', `## Galileo guardrails ${i}\n\nGalileo guardrails Galileo guardrails Galileo.\n\nSource: x`)
    file(dir, 'ok.md', '', '## Notes\n\nSome long text about many things, and Galileo is mentioned once here among other words.\n\nSource: x')
    kb.indexFolder(dir)
    kb.approve('ok', true)
    expect(kb.search('Galileo guardrails').usable.map((c) => c.doc_id)).toEqual(['ok'])
  })

  it('"Add a folder" on an unzipped review pack copies only the live candidates, unapproved', () => {
    const pack = tmp()
    const kdir = tmp()
    fs.writeFileSync(path.join(pack, 'START_HERE.md'), '# Start here\n\nSteps.')
    fs.writeFileSync(path.join(pack, 'REVIEW_SHEET.md'), '# Review sheet')
    fs.mkdirSync(path.join(pack, '1-live-candidate'))
    fs.mkdirSync(path.join(pack, '2-held'))
    file(path.join(pack, '1-live-candidate'), 'core.md', '', '## Evals\n\nEvals score output.\n\nSource: docs')
    file(path.join(pack, '1-live-candidate'), 'security.md', '', '## SSO\n\nSAML on Enterprise.\n\nSource: docs')
    file(path.join(pack, '2-held'), '_held-proof.md', '', '## Customer\n\nNot cleared.\n\nSource: x')
    const r = importKnowledgeFiles(kdir, [pack], true)
    expect(r.added.sort()).toEqual(['core.md', 'security.md'])
    const kb = new KnowledgeBase(new Db(':memory:'), null)
    const docs = kb.indexFolder(kdir)
    expect(docs.map((d) => [d.doc_id, d.approved])).toEqual([['core', false], ['security', false]])
    // A plain folder (no pack layout): files without front matter are skipped and reported; _-prefixed never copied.
    const plain = tmp()
    fs.writeFileSync(path.join(plain, 'notes.md'), 'just notes')
    file(plain, 'faq.md', '', '## Q\n\nA.\n\nSource: x')
    file(plain, '_held-x.md', '', '## H\n\nHeld.\n\nSource: x')
    const r2 = importKnowledgeFiles(kdir, [plain], true)
    expect(r2.added).toEqual(['faq.md'])
    expect(r2.skipped.map((x) => x.name).sort()).toEqual(['_held-x.md', 'notes.md'])
    // "Add files": an explicitly picked plain .txt is accepted.
    fs.writeFileSync(path.join(plain, 'my-notes.txt'), 'Objection notes.')
    expect(importKnowledgeFiles(kdir, [path.join(plain, 'my-notes.txt')], false).added).toEqual(['my-notes.txt'])
  })

  it('Remove takes a file out of use without deleting it', () => {
    const kdir = tmp()
    file(kdir, 'old.md', '', '## Old\n\nOld text.\n\nSource: x')
    const kb = new KnowledgeBase(new Db(':memory:'), null)
    const [doc] = kb.indexFolder(kdir)
    expect(removeKnowledgeFile(kdir, doc.file, new Date('2026-10-05T12:00:00Z'))).toBe(true)
    expect(kb.indexFolder(kdir)).toHaveLength(0)
    expect(fs.readdirSync(path.join(kdir, '_removed'))).toEqual(['2026-10-05-12-00-00-old.md'])
    expect(removeKnowledgeFile(kdir, path.join(tmp(), 'elsewhere.md'))).toBe(false)
  })

  it('subfolders (e.g. held material) are not indexed', () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'held'))
    file(path.join(dir, 'held'), 'h.md', '', '## Held\n\nNot cleared yet.\n\nSource: x')
    expect(new KnowledgeBase(new Db(':memory:'), null).indexFolder(dir)).toHaveLength(0)
  })

  it("the buyer's latest question wins over earlier talk in the same 30 seconds", () => {
    const db = new Db(':memory:')
    const kb = new KnowledgeBase(db, null)
    kb.addDoc(docMetaFrom('/k/sec.md', {}, 'x'), '## How to get our SOC 2 report\n\nRequest it through the Trust Center.\n\nSource: x')
    kb.addDoc(docMetaFrom('/k/demo.md', {}, 'x'), '## Dashboards and charts\n\nDashboards show latency charts and colors.\n\nSource: x')
    kb.approve('sec', true)
    kb.approve('demo', true)
    const preamble = 'So this dashboard shows latency charts for every project and the colors change when traces slow down, ' +
      'then we drill into spans, filter by model, compare prompt versions, export results and share views with teammates across workspaces. '
    const hot = `${preamble.repeat(2)}Okay great. Quick one before I forget: can we get your SOC 2 report?`
    expect(kb.search(hot, 1).usable[0]?.heading).toBe('How to get our SOC 2 report')
  })

  it('a word with many synonyms does not outweigh a rarer, decisive one', () => {
    const kb = new KnowledgeBase(new Db(':memory:'), fileURLToPath(new URL('../config/aliases.json', import.meta.url)))
    kb.addDoc(docMetaFrom('/k/news.md', {}, 'x'), '## Dynatrace acquired Arize\n\nDynatrace completed its acquisition of Arize.\n\nSource: x')
    kb.addDoc(docMetaFrom('/k/obj.md', {}, 'x'), '## Objection: too expensive\n\nPrice, cost and budget come up: ask about budget versus value, then cost and price.\n\nSource: x')
    kb.approve('news', true)
    kb.approve('obj', true)
    expect(kb.search('Is Dynatrace going to change our pricing?', 2).usable[0].doc_id).toBe('news')
    // Two words from the same synonym group are still one concept.
    expect(kb.search('Is Dynatrace going to change our pricing? What will it cost?', 2).usable[0].doc_id).toBe('news')
    expect(kb.search('Does the Dynatrace deal change our pricing or budget?', 2).usable[0].doc_id).toBe('news')
  })

  it('a multi-word synonym said as a phrase is one concept, not its words', () => {
    const aliases = loadAliases(fileURLToPath(new URL('../config/aliases.json', import.meta.url)))
    expect(ftsConcepts('Does Dynatrace change our proof of concept?', aliases)).toEqual([
      ['proof of concept', 'poc', 'pilot', 'trial'],
      ['change'],
      ['dynatrace'],
    ])
    // Only a whole-word phrase counts: "open testing" is not "pen test".
    expect(ftsConcepts('we are open testing it', aliases).flat()).not.toContain('pen test')
  })

  it('the latest question keeps its synonyms after a long stretch of other talk', () => {
    const kb = new KnowledgeBase(new Db(':memory:'), fileURLToPath(new URL('../config/aliases.json', import.meta.url)))
    kb.addDoc(docMetaFrom('/k/otel.md', {}, 'x'), '## OpenTelemetry ingestion\n\nArize accepts OpenTelemetry data from any SDK.\n\nSource: x')
    kb.addDoc(docMetaFrom('/k/demo.md', {}, 'x'), '## Dashboards and charts\n\nDashboards show latency charts and colors.\n\nSource: x')
    kb.approve('otel', true)
    kb.approve('demo', true)
    const preamble = 'So this dashboard shows latency charts for every project and the colors change when requests slow down, ' +
      'then we drill into steps, filter by model, compare prompt variants, export results and share views with teammates across workspaces. '
    expect(kb.search(`${preamble.repeat(2)}Quick one: do you support OTel?`, 1).usable[0]?.heading).toBe('OpenTelemetry ingestion')
  })

  it('aliases widen search (FTS5, no embeddings)', () => {
    const db = new Db(':memory:')
    const kb = new KnowledgeBase(db, fileURLToPath(new URL('../config/aliases.json', import.meta.url)))
    kb.addDoc(docMetaFrom('/k/otel.md', {}, 'x'), 'Tracing uses OpenTelemetry instrumentation.')
    kb.approve('otel', true)
    expect(kb.search('do you support otel').usable).toHaveLength(1)
  })

  it("a doc's tags do not drown out the section that names the subject", () => {
    const db = new Db(':memory:')
    const kb = new KnowledgeBase(db, null)
    const sections = ['Braintrust', 'LangSmith', 'Langfuse', 'Weave'].map((c) => `## ${c} vs Arize\n\nWhere Arize differs from ${c}: tracing differs and evals differ.`)
    const body = `# Competitive\n\n${sections.join('\n\n')}\n\n## Galileo strengths\n\nGalileo is strong on guardrails.`
    // An untagged doc with an identical title and section is indexed first, so without the tag boost it wins the tie.
    kb.addDoc(docMetaFrom('/k/other.md', { title: 'Competitive' }, 'x'), '## Galileo strengths\n\nGalileo is strong on guardrails.')
    kb.addDoc(docMetaFrom('/k/competitive.md', { tags: 'braintrust, langsmith, langfuse, galileo, weave' }, body), body)
    kb.approve('other', true)
    kb.approve('competitive', true)
    expect(kb.search('how is this different from Galileo').usable.map((c) => c.heading).slice(0, 2)).toEqual(['Galileo strengths', 'Galileo strengths'])
    // Tags still break ties between documents.
    expect(kb.search('Galileo guardrails').usable[0].meta.doc_id).toBe('competitive')
  })

  it('chunks by headings; the Source paragraph is kept whole and separate', () => {
    const c = chunkBody('# Title\n\nIntro.\n\n## Deploy\n\nSelf-hosted notes.\n\nSource: Deploy page (arize.com/x, 2026-10-04)\n\n## Security\n\nSSO notes.')
    expect(c.map((x) => x.heading)).toEqual(['Title', 'Deploy', 'Security'])
    expect(c[1]).toEqual({ heading: 'Deploy', text: 'Self-hosted notes.', source_ref: 'Source: Deploy page (arize.com/x, 2026-10-04)' })
  })

  it('no chunk is longer than what the model receives; long text splits at sentence ends and keeps the source', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about deployment.`).join(' ')
    const c = chunkBody(`## Big\n\n${long}\n\nSource: Ref`)
    expect(c.length).toBeGreaterThan(1)
    for (const x of c) {
      expect(x.text.length).toBeLessThanOrEqual(KNOWLEDGE_TEXT_MAX)
      expect(x.text).toMatch(/\.$/)
      expect(x.source_ref).toBe('Source: Ref')
    }
    expect(c.map((x) => x.text).join(' ')).toBe(long)
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
    // Knowledge use: scope, hypotheses are not facts about this buyer, no presumed problems, absence is not a gap.
    expect(sys).toMatch(/Never state anything listed under other_deployment/)
    expect(sys).toMatch(/HAPPENING describes only what was actually said on this call/)
    expect(sys).toMatch(/must not presume a problem, a gap, existing work, urgency or a deadline/)
    expect(sys).toMatch(/never means Arize lacks it/)
    expect(sys).toMatch(/Never promise pricing, discounts, contract terms, roadmap, dates/)
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
  async check() { return { readiness: 'ready' as const } }
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

function engineSetup(model: HelpModel, opts: { prefetch?: boolean; timeout?: number; onBlocked?: (e: HelpError | null) => void } = {}) {
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
    log: (e, d) => logs.push({ e, d }), prefetch: opts.prefetch ?? false, wallNow: () => wall, onBlocked: opts.onBlocked,
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

  it('a short reply still being transcribed ("No, not yet") makes a prefetched card stale', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m, { prefetch: true })
    s.engine.onFinalWords()
    await vi.advanceTimersByTimeAsync(800)
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    s.advance(1000)
    s.memory.setInterim('system_remote', 'No, not yet.', 20500)
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(false)
  })

  it('a background prefetch Keith never saw keeps timings and cost, not the conversation text', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m, { prefetch: true })
    s.engine.onFinalWords()
    await vi.advanceTimersByTimeAsync(800)
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    const unseen = s.db.sql.prepare('SELECT request_text, output_raw, card_json, usage_json, prefetch FROM help_requests').get() as Record<string, unknown>
    expect(unseen).toMatchObject({ request_text: null, output_raw: null, card_json: null, prefetch: 1 })
    expect(unseen.usage_json).not.toBeNull()
    // Once shown (Keith pressed and it was adopted), it is kept like any pressed request.
    s.advance(2000)
    s.engine.press()
    const shown = s.db.sql.prepare('SELECT request_text, output_raw, card_json FROM help_requests').get() as Record<string, unknown>
    expect(shown.request_text).toEqual(expect.stringContaining('Give Keith his next line'))
    expect(shown.output_raw).not.toBeNull()
    expect(shown.card_json).not.toBeNull()
  })


  it("only the other side finishing a sentence starts a background candidate; Keith's own words cancel a pending one", async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m, { prefetch: true })
    s.engine.onFinalWords('local_mic')
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls).toHaveLength(0)
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(300)
    s.engine.onFinalWords('local_mic') // Keith starts talking before it fires
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls).toHaveLength(0)
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(1)
  })

  it('background candidates are capped per minute', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m, { prefetch: true })
    for (let i = 0; i < 6; i++) {
      s.addTurn(`New point number ${i}`)
      s.engine.onFinalWords('system_remote')
      await vi.advanceTimersByTimeAsync(800)
      s.advance(5000)
    }
    expect(m.calls).toHaveLength(4)
    expect(s.logs.some((l) => l.e === 'help_prefetch_capped')).toBe(true)
    s.advance(60_000)
    s.addTurn('Later point')
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    expect(m.calls).toHaveLength(5)
  })

  it('a rejected key gives a plain message and stops background work until a request succeeds', async () => {
    const auth = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers())
    let fail = true
    const calls: string[] = []
    const model: HelpModel = {
      mock: false, label: () => 'x', prewarm: async () => {}, check: async () => ({ readiness: 'ready' as const }),
      run: async (req) => {
        calls.push(req.user)
        if (fail) throw auth
        req.onText('MOVE: clarify_current_state\nASK: How does that work today?\nHAPPENING: -\nFOLLOW: -\nSOURCES: T1\nNOTE: -\n')
        return { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 }, stop_reason: 'end_turn', served_model: 'x', fell_back: false }
      },
    }
    const blocked: Array<string | null> = []
    const s = engineSetup(model, { prefetch: true, onBlocked: (e) => blocked.push(e?.code ?? null) })
    s.engine.press()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)).toMatchObject({ status: 'failed', error: 'Claude rejected the API key. Check it in Setup, step 3.' })
    expect(s.logs.find((l) => l.e === 'help_done')?.d?.error).toBe('key_rejected')
    expect(blocked).toEqual(['key_rejected'])
    s.addTurn('Something new')
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1) // no background request while the key is rejected
    // A press still tries; once it works, background work resumes.
    fail = false
    s.engine.press()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)!.status).toBe('complete')
    expect(blocked).toEqual(['key_rejected', null])
  })

  it('a background candidate never shown keeps only the kind of each issue, not text quoted from the output', async () => {
    const model: HelpModel = {
      mock: false, label: () => 'x', prewarm: async () => {}, check: async () => ({ readiness: 'ready' as const }),
      run: async (req) => {
        req.onText("MOVE: clarify_current_state\nASK: How does that work today?\nHAPPENING: -\nFOLLOW: -\nSOURCES: T1 (buyer's SSO question)\nNOTE: -\n")
        return { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 }, stop_reason: 'end_turn', served_model: 'x', fell_back: false }
      },
    }
    const s = engineSetup(model, { prefetch: true })
    s.engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    const row = s.db.sql.prepare('SELECT timing_json FROM help_requests').get() as { timing_json: string }
    expect(row.timing_json).not.toMatch(/SSO|buyer/)
    expect(JSON.parse(row.timing_json).issues).toContain('unknown source ids removed')
  })

  it('a card says who the call is with, as set when it was requested', async () => {
    const m = new ScriptedModel()
    const s = engineSetup(m)
    s.memory.setup = { ...s.memory.setup, account: 'Northwind', deployment: 'self_hosted' }
    s.engine.press()
    m.calls[0].release()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)!.setup).toEqual({ account: 'Northwind', deployment: 'self_hosted' })
  })

  it('opening a database from an older build drops the text of background requests Keith never saw', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'copilot.db')
    const old = new Db(file)
    const ins = old.sql.prepare(
      `INSERT INTO help_requests (id, origin, created_at, status, model_json, request_text, output_raw, card_json, timing_json, prefetch) VALUES (?, 'help_requested', 't', 'complete', '{}', 'BUYER WORDS', 'raw', '{}', ?, ?)`,
    )
    ins.run('unseen', JSON.stringify({ served_from_prefetch: false }), 1)
    ins.run('adopted', JSON.stringify({ served_from_prefetch: true }), 1)
    ins.run('pressed', JSON.stringify({ served_from_prefetch: false }), 0)
    old.close()
    const db = new Db(file)
    const rows = db.sql.prepare('SELECT id, request_text, output_raw, card_json FROM help_requests ORDER BY id').all()
    expect(rows).toEqual([
      { id: 'adopted', request_text: 'BUYER WORDS', output_raw: 'raw', card_json: '{}' },
      { id: 'pressed', request_text: 'BUYER WORDS', output_raw: 'raw', card_json: '{}' },
      { id: 'unseen', request_text: null, output_raw: null, card_json: null },
    ])
    db.close()
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
      mock: false, label: () => 'bad', prewarm: async () => {}, check: async () => ({ readiness: 'ready' as const }),
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

describe('plain errors and card checks', () => {
  it('turns Claude errors into plain words, and knows which ones pressing again will not fix', () => {
    const H = new Headers()
    expect(describeError(new Anthropic.AuthenticationError(401, {}, 'x', H))).toMatchObject({ code: 'key_rejected', blocking: true })
    expect(describeError(new Anthropic.PermissionDeniedError(403, {}, 'x', H))).toMatchObject({ code: 'key_not_allowed', blocking: true })
    const credit = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }
    expect(describeError(new Anthropic.BadRequestError(400, credit, undefined, H))).toMatchObject({ code: 'no_credit', blocking: true })
    expect(describeError(new Anthropic.RateLimitError(429, {}, 'x', H))).toMatchObject({ code: 'rate_limited', blocking: false })
    expect(describeError(new Anthropic.InternalServerError(529, {}, 'Overloaded', H))).toMatchObject({ code: 'overloaded', blocking: false })
    expect(describeError(new Anthropic.APIConnectionError({ message: 'fetch failed' }))).toMatchObject({ code: 'offline' })
    expect(describeError(new Error('weird'))).toMatchObject({ code: 'error', blocking: false })
    for (const m of [401, 403, 429, 500].map((n) => describeError(new Anthropic.APIError(n, {}, 'raw text', H)).message)) expect(m).not.toContain('raw text')
  })

  it('flags an unbacked number or an Arize capability claim with no approved source', () => {
    const card: HelpCardContent = { move: 'technical_answer', primary_kind: 'say', primary: 'We support SSO for 40 teams.', happening: null, follow_up: null, source_ids: ['T1'], note: null }
    const turnOnly = new Map([['T1', 'turn' as const]])
    expect(cardChecks({ ...card }, ['number not found in context: 40'], turnOnly)).toHaveLength(2)
    expect(cardChecks({ ...card, source_ids: ['K1'] }, [], new Map([['K1', 'knowledge' as const]]))).toEqual([])
    expect(cardChecks({ ...card, primary: 'Do we have time to look at SSO?' }, [], turnOnly)).toEqual([])
    // Checking before answering is not a claim.
    expect(cardChecks({ ...card, primary: 'Let me confirm we support that for self-hosted before I answer.' }, [], turnOnly)).toEqual([])
  })
})
