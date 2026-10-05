import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelpCardContent } from '../src/shared/help'
import { loadPlaybook } from '../src/main/help/prompt'
import { CHECK_CLAIM, CHECK_NUMBER, CHECK_TECHNICAL, cardChecks, streamingChecks, unbackedNumbers } from '../src/main/help/protocol'
import { StagedModel, engineFixture, inventedCall } from './helpers/helpEngine'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))

describe('checks while the line streams', () => {
  const say = (primary: string, move: HelpCardContent['move'] = 'clarify_current_state'): Partial<HelpCardContent> => ({ move, primary_kind: 'say', primary })

  it('nothing until the ASK/SAY line is complete', () => {
    expect(streamingChecks({ move: 'technical_answer' }, { contextText: '', knowledgeInContext: false })).toEqual([])
  })

  it('a number nobody said is certain at once, with or without knowledge', () => {
    const ctx = '[T1] (0:41) Dana (buyer): We run about 40 agents. Keith pressed HELP at 0:52.'
    expect(streamingChecks(say('Teams like yours cut review time by 73%.'), { contextText: ctx, knowledgeInContext: true })).toEqual([CHECK_NUMBER])
    expect(streamingChecks(say('So all 40 agents go through that review?'), { contextText: ctx, knowledgeInContext: false })).toEqual([])
    // Ids, clock stamps and the press time are not numbers anyone said.
    expect(unbackedNumbers('Back at 0:41 you said 1 thing', ctx)).toEqual(['0', '41', '1'])
    expect(unbackedNumbers('Forty, I mean 40.', ctx)).toEqual([])
  })

  it('an Arize claim or a technical answer is certain only when no approved knowledge came with the press', () => {
    const claim = say('We support SAML single sign-on on every plan.')
    expect(streamingChecks(claim, { contextText: '', knowledgeInContext: false })).toEqual([CHECK_CLAIM])
    // With approved knowledge the finished card may still cite it: wait for the end.
    expect(streamingChecks(claim, { contextText: '', knowledgeInContext: true })).toEqual([])
    const technical = say('Spans are exported over OTLP from the agent.', 'technical_answer')
    expect(streamingChecks(technical, { contextText: '', knowledgeInContext: false })).toEqual([CHECK_TECHNICAL])
    expect(streamingChecks({ ...technical, primary: 'Let me check how spans get exported for you.' }, { contextText: '', knowledgeInContext: false })).toEqual([])
    // A claim in a later line (once it has arrived) counts too.
    expect(streamingChecks({ ...say('Good question.'), follow_up: 'Arize supports that out of the box.' }, { contextText: '', knowledgeInContext: false })).toEqual([CHECK_CLAIM])
  })

  it('uses exactly the finished card\'s words, so the swap never flickers', () => {
    const card: HelpCardContent = { move: 'technical_answer', primary_kind: 'say', primary: 'We support SSO for 40 teams.', happening: null, follow_up: null, source_ids: [], note: null }
    const early = streamingChecks(card, { contextText: '', knowledgeInContext: false })
    expect(cardChecks(card, ['number not found in context: 40'], new Map())).toEqual(early)
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HELP engine: checks while the line streams', () => {
  it('shows the certain checks with the line, and the finished card replaces them', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook)
    const id = s.engine.press()
    m.calls[0].send('MOVE: technical_answer\nSAY: Yes, our tracing handles 500 spans a second per service.\n')
    await vi.advanceTimersByTimeAsync(0)
    const streaming = s.events.at(-1)!
    expect(streaming.status).toBe('streaming')
    expect(streaming.content.primary).toMatch(/500 spans/)
    // No approved knowledge came with this press: the number, and an Arize claim nothing can back.
    expect(streaming.checks).toEqual([CHECK_NUMBER, CHECK_CLAIM])
    m.calls[0].send('HAPPENING: They asked about scale.\nFOLLOW: -\nSOURCES: T1\nNOTE: -\n')
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    const done = s.events.at(-1)!
    expect(done.status).toBe('complete')
    expect(done.checks).toEqual([CHECK_NUMBER, CHECK_CLAIM])
    const row = s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(id) as { timing_json: string }
    expect(JSON.parse(row.timing_json).checks).toBe(2)
    expect(s.logs.find((l) => l.e === 'help_done')?.d).toMatchObject({ early_checks: 2, checks: 2, wrap: null })
    expect(JSON.stringify(s.logs)).not.toMatch(/spans|scale|platform team/)
  })

  it('with approved knowledge in the context, only the number shows early; the cited card then has no claim check', async () => {
    const call = inventedCall({
      transcript: [
        { t: 0, who: 'keith', text: 'What would you like to know about tracing?' },
        { t: 4, end: 14, who: 'e1:s0', text: 'Is your tracing based on OpenTelemetry, or do we need a proprietary agent?' },
      ],
      knowledge: [{ id: 'k-otel', title: 'Tracing is OpenTelemetry-based', text: 'Arize tracing is built on OpenTelemetry and spans are exported over OTLP; a proprietary agent is not required.', category: 'product', vendor: 'arize' }],
    })
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call, withKb: true })
    s.engine.press()
    m.calls[0].send('MOVE: technical_answer\nSAY: Yes, tracing is OpenTelemetry-based, exported over OTLP, no proprietary agent, in 3 steps.\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)!.checks).toEqual([CHECK_NUMBER])
    m.calls[0].send('HAPPENING: -\nFOLLOW: -\nSOURCES: K1\nNOTE: -\n')
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)).toMatchObject({ status: 'complete', checks: [CHECK_NUMBER] })
  })

  it('a line that never finishes keeps no checks (it is struck through instead)', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook)
    const id = s.engine.press()
    m.calls[0].send('MOVE: clarify_scale\nASK: Is that across all 12 regions?\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)!.checks).toEqual([CHECK_NUMBER])
    m.calls[0].fail(new Error('connection dropped'))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)).toMatchObject({ status: 'failed', checks: [] })
    const row = s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(id) as { timing_json: string }
    expect(JSON.parse(row.timing_json).checks).toBe(0)
  })
})
