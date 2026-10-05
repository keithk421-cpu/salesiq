import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { Deployment, HelpCardContent } from '../src/shared/help'
import { Db, ftsConcepts } from '../src/main/db'
import { KnowledgeBase, contentHash, docMetaFrom, isCompetitor, loadAliases } from '../src/main/knowledge'
import { CallMemory, DEFAULT_SETUP } from '../src/main/help/callMemory'
import { aboutLabel, buildHelpContext } from '../src/main/help/context'
import { findApprovedPassage } from '../src/main/help/passage'
import { cardChecks, findCapabilityClaim, numbersIn, validateCard } from '../src/main/help/protocol'

const ALIASES = fileURLToPath(new URL('../config/aliases.json', import.meta.url))
const limits = { primary_max_words: 30, happening_max_words: 18, follow_up_max_words: 22 }

// ---------------------------------------------------------------- an invented pack (no real material)

const OURS = `# Conversation scoring

## Can the platform evaluate multi-turn conversations
Yes. Whole sessions can be scored at session scope.

Source: Product docs (fixture)`

const TRACELY = `# Tracely documented capabilities

## Can Tracely evaluate multi-turn conversations
Tracely documents scoring of grouped sessions.

Vendor: Tracely not ours.

Source: Tracely docs (fixture)

## Tracely Loop proposes prompt fixes
Tracely Loop drafts prompt fixes from production logs for review.

Vendor: Tracely not ours.

Source: Tracely docs (fixture)`

const LANGSMITH = `# LangSmith documented capabilities

## Can LangSmith evaluate multi-turn conversations
LangSmith documents thread evaluators.

Source: LangSmith docs (fixture)`

const GUIDE = `# Comparison guidance

## Comparing two evaluation tools
Ask what the team wants to compare before comparing features.

Source: Coaching notes (fixture)`

function pack(): KnowledgeBase {
  const kb = new KnowledgeBase(new Db(':memory:'), ALIASES)
  const add = (id: string, meta: Record<string, string>, body: string) => {
    kb.addDoc(docMetaFrom(`/k/${id}.md`, meta, body), body)
    kb.approve(id, true)
  }
  add('ours', { title: 'Conversation scoring', vendor: 'Arize', applies_to: 'all', tags: 'sessions' }, OURS)
  add('tracely', { title: 'Tracely documented capabilities', category: 'competitive', vendor: 'tracely', applies_to: 'all', tags: 'tracely, loop' }, TRACELY)
  add('langsmith', { title: 'LangSmith documented capabilities', category: 'competitive', vendor: 'LangSmith', applies_to: 'all', tags: 'langsmith' }, LANGSMITH)
  add('guide', { title: 'Comparison guidance', category: 'objection_handling', vendor: 'neutral', applies_to: 'all' }, GUIDE)
  return kb
}

/** A call: the buyer's lines (Keith answering at length between them when `keithAnswers`), HELP 2 s after the last. */
function call(lines: string[], opts: { keithAnswers?: boolean; deployment?: Deployment } = {}): { memory: CallMemory; atMs: number } {
  const memory = new CallMemory('sess', null)
  memory.setup = { ...DEFAULT_SETUP, deployment: opts.deployment ?? 'unknown' }
  let t = 10_000
  lines.forEach((text, i) => {
    if (i > 0 && opts.keithAnswers) {
      memory.upsertTurn({ id: `k${i}`, stream: 'local_mic', cluster: null, start_ms: t, end_ms: t + 4000, text: 'Sure, happy to walk through how that one works and where it fits for teams like yours.', available_ms: t + 4500 }, true)
      t += 5000
    }
    memory.upsertTurn({ id: `b${i}`, stream: 'system_remote', cluster: 'e1:s0', start_ms: t, end_ms: t + 3000, text, available_ms: t + 3500 }, true)
    t += 4000
  })
  return { memory, atMs: t + 1000 }
}

const today = new Date('2026-10-05T12:00:00')
const knowledgeFor = (lines: string[], opts: { keithAnswers?: boolean } = {}, kb = pack()) => {
  const c = call(lines, opts)
  const ctx = buildHelpContext({ memory: c.memory, kb, atMs: c.atMs, now: today })
  return { ctx, docs: ctx.refs.knowledge_chunk_ids.map((id) => /^k:([^#]+)#/.exec(id)![1]) }
}
const boxFor = (lines: string[], opts: { keithAnswers?: boolean } = {}, kb = pack()) => {
  const c = call(lines, opts)
  return findApprovedPassage({ kb, memory: c.memory, atMs: c.atMs, today })
}

describe('vendor line', () => {
  it('is read in lower case and is part of what Keith approved, only when the file has one', () => {
    const body = '## A\nText.\n\nSource: x'
    const withVendor = docMetaFrom('/k/a.md', { title: 'A', vendor: ' LangSmith ' }, body)
    const without = docMetaFrom('/k/a.md', { title: 'A' }, body)
    expect(withVendor.vendor).toBe('langsmith')
    expect(without.vendor).toBeUndefined()
    // A file without a vendor line keeps the hash it had before vendors were read (earlier approvals still hold).
    const { vendor: _v, ...material } = without
    expect(without.content_hash).toBe(contentHash(material, body))
    expect(withVendor.content_hash).not.toBe(without.content_hash)
    expect(docMetaFrom('/k/a.md', { title: 'A', vendor: 'braintrust' }, body).content_hash).not.toBe(withVendor.content_hash)
  })

  it('tells competitors apart from Arize, guidance and mixed documents', () => {
    expect(isCompetitor({ vendor: 'langsmith' })).toBe(true)
    for (const v of ['arize', 'phoenix', 'neutral', 'mixed', 'unknown', undefined]) expect(isCompetitor({ vendor: v })).toBe(false)
    expect(aboutLabel({ vendor: 'langsmith', title: 'LangSmith documented capabilities' })).toBe('LangSmith (competitor)')
    expect(aboutLabel({ vendor: 'new relic', title: 'Notes' })).toBe('New Relic (competitor)')
    expect(aboutLabel({ vendor: 'arize', title: 'x' })).toBe('Arize')
    expect(aboutLabel({ vendor: 'neutral', title: 'x' })).toMatch(/guidance, not a product fact/)
    expect(aboutLabel({ vendor: undefined, title: 'x' })).toBe('')
  })

  it('finds competitors named by their vendor name or a spoken alias', () => {
    const kb = pack()
    expect(kb.competitorsNamed('We tried Lang Smith last year.')).toEqual(['langsmith'])
    expect(kb.competitorsNamed('TRACELY is what we run.')).toEqual(['tracely'])
    expect(kb.competitorsNamed('We trace everything.')).toEqual([])
    // Only competitors with an approved document count.
    kb.approve('tracely', false)
    expect(kb.competitorsNamed('Tracely is what we run.')).toEqual([])
  })
})

describe("a competitor's sections only when that competitor came up", () => {
  it("a question put to Keith doesn't get a competitor's look-alike section", () => {
    const { docs } = knowledgeFor(['Can you evaluate multi-turn conversations?'])
    expect(docs).toContain('ours')
    expect(docs).not.toContain('tracely')
    expect(docs).not.toContain('langsmith')
  })

  it("the competitor named in the last 30 s is searched, and only that one", () => {
    const { docs, ctx } = knowledgeFor(['We use Tracely today.', 'Can it evaluate multi-turn conversations?'], { keithAnswers: true })
    expect(docs).toContain('tracely')
    expect(docs).not.toContain('langsmith')
    expect(ctx.text).toMatch(/\(about: Tracely \(competitor\); applies to/)
    expect(ctx.text).toMatch(/only as fact about the product it describes/)
    const k = [...ctx.sources.values()].find((s) => s.id.startsWith('k:tracely'))!
    expect(k.label).toBe('Tracely documented capabilities (competitor)')
  })

  it('documents without a vendor line are searched as before', () => {
    const kb = pack()
    const body = '## Tracely pricing tiers\nTracely lists three tiers.\n\nSource: x'
    kb.addDoc(docMetaFrom('/k/legacy.md', { title: 'Old competitive notes', category: 'competitive' }, body), body)
    kb.approve('legacy', true)
    expect(knowledgeFor(['What pricing tiers are there?'], {}, kb).docs).toContain('legacy')
  })
})

describe("approved note: a competitor's only when they're being discussed", () => {
  it('shows the named competitor', () => {
    expect(boxFor(['Can Tracely evaluate multi-turn conversations?'])?.doc_id).toBe('tracely')
  })

  it("never shows a competitor's note nobody named", () => {
    expect(boxFor(['Does anything here propose prompt fixes from the loop?'])).toBeNull()
    expect(boxFor(['Does Tracely Loop propose prompt fixes?'])?.doc_id).toBe('tracely')
  })

  it("hides it when what they said last is put to Keith without naming it", () => {
    const p = boxFor(['We looked at Tracely last quarter.', 'Does yours propose prompt fixes from the loop?'], { keithAnswers: true })
    expect(p?.doc_id).not.toBe('tracely')
  })
})

describe('price questions are not budget objections', () => {
  it('"cost" and "budget" are different concepts; "CLI" is "command line"', () => {
    const aliases = loadAliases(ALIASES)
    expect(ftsConcepts('What does it cost? Is there budget?', aliases)).toHaveLength(2)
    expect(ftsConcepts('price and cost', aliases)).toHaveLength(1)
    expect(ftsConcepts('Is there a command line tool?', aliases).flat()).toContain('cli')
  })
})

describe('numbers on a card', () => {
  it('reads figures written with digits or spelled out', () => {
    expect([...numbersIn('three teams, twenty-five agents, 1,500 traces, a hundred users, two, three')].sort()).toEqual(['100', '1500', '2', '25', '3'].sort())
    expect(numbersIn('two hundred and fifty')).toContain('250')
  })

  it('matches whole numbers, not tags, ids or clock stamps', () => {
    const ctx = '<last_30_seconds>\n[T1] (0:41) Buyer: We run about 150 traces a day across three teams.\n</last_30_seconds>\n[K1] Notes (version 2026-10-05-r3): Plans start at 2 seats.'
    const check = (say: string) => validateCard({ move: 'clarify_scale', primary_kind: 'ask', primary: say, source_ids: [] }, ['MOVE', 'ASK'], { knownSourceIds: new Set(), contextText: ctx, limits }).issues
    expect(check('Is that 150 traces for all 3 teams?')).toEqual([])
    expect(check('Is that 15 engineers per team?')).toEqual(['number not found in context: 15'])
    expect(check('Teams cut costs by 30% in a month.')).toEqual(['number not found in context: 30%'])
    expect(check('About 41 days to roll out?')).toEqual(['number not found in context: 41'])
    expect(check('Is 2026 the target?')).toEqual(['number not found in context: 2026'])
    expect(check('Would 2 seats be enough?')).toEqual([])
    // Times and product names the buyer said still count.
    const said = '[T1] (1:05) Buyer: Can we meet at 9:30? Our logs sit in S3.\nKeith pressed HELP at 1:12.'
    const check2 = (say: string) => validateCard({ move: 'confirm_next_step', primary_kind: 'ask', primary: say, source_ids: [] }, ['MOVE', 'ASK'], { knownSourceIds: new Set(), contextText: said, limits }).issues
    expect(check2('Does 9:30 work, with the logs in S3?')).toEqual([])
    expect(check2('Does 1:12 work?')).toEqual(['number not found in context: 1', 'number not found in context: 12'])
  })
})

describe('technical answers need an approved source', () => {
  const card: HelpCardContent = { move: 'technical_answer', primary_kind: 'say', primary: 'Arize AX can score a whole session at session scope.', happening: null, follow_up: null, source_ids: ['T1'], note: null }
  const turnOnly = new Map([['T1', 'turn' as const]])

  it('"Arize AX can" is a capability claim', () => {
    expect(findCapabilityClaim('Arize AX can score a whole session.')).not.toBeNull()
    expect(findCapabilityClaim('Phoenix has a playground.')).not.toBeNull()
  })

  it('warns on a technical answer with no approved source, once', () => {
    expect(cardChecks({ ...card }, [], turnOnly)).toEqual(['Says what Arize can do without an approved source. Check it before saying it.'])
    expect(cardChecks({ ...card, primary: 'Sessions are scored at session scope, after the conversation ends.' }, [], turnOnly)).toEqual(['Technical answer without an approved source. Check it before saying it.'])
    expect(cardChecks({ ...card, source_ids: ['K1'] }, [], new Map([['K1', 'knowledge' as const]]))).toEqual([])
    // A question or "let me check" is not an answer.
    expect(cardChecks({ ...card, primary: 'Which session boundaries do you use today?' }, [], turnOnly)).toEqual([])
    expect(cardChecks({ ...card, primary: 'Let me check how sessions are scored and come back to you.' }, [], turnOnly)).toEqual([])
    expect(cardChecks({ ...card, move: 'clarify_current_state', primary: 'Sessions are scored at session scope.' }, [], turnOnly)).toEqual([])
  })
})
