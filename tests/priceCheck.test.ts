/**
 * M5 step 0: the price check. A card line that would be heard as a price, discount or term, and that
 * approved knowledge the card cites doesn't state, gets CHECK_PRICE (Keith chose a warning, not hiding
 * the line). All calls, companies and figures here are invented.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALL_TYPES, type CallType, type HelpCardContent, type HelpModelConfig } from '../src/shared/help'
import { buildHelpContext } from '../src/main/help/context'
import { level1, runScenario } from '../src/main/help/evalRunner'
import type { HelpModel, HelpModelRun } from '../src/main/help/models'
import { priceCheckInputs } from '../src/main/help/priceInputs'
import { loadPlaybook } from '../src/main/help/prompt'
import { CHECK_CLAIM, CHECK_NUMBER, CHECK_PRICE, cardChecks, priceFigures, streamingChecks, type PriceCheckOpts } from '../src/main/help/protocol'
import { replayAt } from '../src/main/help/replay'
import { StagedModel, engineFixture, inventedCall } from './helpers/helpEngine'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))

const card = (primary: string, over: Partial<HelpCardContent> = {}): HelpCardContent => ({
  move: 'clarify_scale', primary_kind: primary.trim().endsWith('?') ? 'ask' : 'say', primary, happening: null, follow_up: null, source_ids: [], note: null, ...over,
})
const flagged = (line: string, callType: CallType, opts: PriceCheckOpts = {}) => priceFigures(card(line), { callType, ...opts }).length > 0
const NOT_PRICING = CALL_TYPES.filter((t) => t !== 'negotiation')

describe('priceFigures: every call type', () => {
  // Currency amounts, "N% off", "off the list", "discount of N", and a figure within 3 words of a price word.
  const mustFlag = [
    '$40k a year',
    'That would be about $40k a year for the whole team.',
    'It comes to €12,000 for the year.',
    'The team plan is £500 a month.',
    'Roughly forty thousand dollars a year.',
    "We'd be at 40 thousand dollars all in.",
    'That lands around 40k dollars a year.',
    'It is USD 25,000 for the first year.',
    'Usage runs $2 per 1,000 traces.',
    'That is $40k/year with support.',
    'Annual plans get about 15% off.',
    'Annual plans get about 15 percent off.',
    'We usually take twenty percent off for annual.',
    'There are 10-20% off options for multi-year.',
    'That is 10 off the list price.',
    'Call it 15 off list.',
    'There is a discount of 10 on annual plans.',
    'There is a discount of ten on annual plans.',
    'Pricing is 25 per user per month.',
    'It is 50 per seat.',
    'The enterprise tier costs 80k a year.',
    'That price is 1,200 a month.',
    'You get a 12% discount on annual.',
    'That works out 30% below list price.',
  ]
  for (const type of CALL_TYPES) {
    it(`flags currency, % off, off list, discount of and a figure by a price word (${type})`, () => {
      for (const line of mustFlag) expect(flagged(line, type), line).toBe(true)
    })
  }

  // Volumes, retention, latency, error rates, team sizes, dates, model names and plain counts.
  const mustPass = [
    'So about 10 million traces a month, 90 days of history?',
    'How many spans a day, 50 million?',
    'Is 30 days of retention enough for your audits?',
    'So p95 latency is under 200 ms today?',
    'Could we kick off in 2 weeks?',
    'So you ship 4 times a year?',
    'Which of the 3 goals we commit to matters most?',
    'Can we meet again in two weeks?',
    'So 12 engineers on the platform team, across 3 squads?',
    'Are you on GPT-4o or Claude 3.5 today?',
    'Is GPT-4o pricing behind the cost push?',
    'Would a readout in Q3 work for your team?',
    'Could we hold the readout on March 15?',
    'Which of the two price options did they see?',
    "Let me get you pricing for 200 seats from our deal desk.",
    'What does the cost of 10 million traces look like on your side today?',
    'What does an hour of downtime cost you, roughly 10 engineers?',
    'So your token costs went up 40 last quarter?',
    'Who else signs off, and is the 2026 budget set?',
    'The rate limit is 100 requests per second?',
    'What does that 2-week delay cost the team?',
  ]
  for (const type of CALL_TYPES) {
    it(`never flags volumes, timings, dates, model names or plain counts (${type})`, () => {
      for (const line of mustPass) expect(flagged(line, type), line).toBe(false)
    })
  }

  it('unit words alone never flag: per month, a year, rate, commit, off', () => {
    for (const type of CALL_TYPES) {
      for (const line of ['We bill per month, not a year up front.', 'What rate of change do you see?', 'What would you commit to on your side?', 'Can we kick things off in 2 weeks?']) {
        expect(flagged(line, type), `${type}: ${line}`).toBe(false)
      }
    }
  })

  it('a bare % and plain goals pass outside pricing calls', () => {
    for (const type of NOT_PRICING) {
      expect(flagged('So the goal is an error rate under 2%?', type)).toBe(false)
      expect(flagged('Is 50% fewer regressions the bar for the POC?', type)).toBe(false)
      expect(flagged('Your token costs went up 40% last quarter?', type)).toBe(false)
    }
  })

  it('checks ASK/SAY and FOLLOW, not HAPPENING (that line is only for Keith)', () => {
    expect(priceFigures(card('What would make this an easy yes?', { happening: 'They asked for 20% off.' }), { callType: 'negotiation' })).toEqual([])
    expect(priceFigures(card('What would make this an easy yes?', { follow_up: 'Annual plans get 15% off.' }), { callType: 'discovery' })).toEqual(['15%'])
  })
})

describe('priceFigures: pricing calls (negotiation) also flag a bare % and an offer with a figure', () => {
  const buyer = { theirRecentText: "We'd need 20% off to get this through." }

  it('must flag (the plan)', () => {
    expect(flagged('We can do 20% if you sign annually.', 'negotiation', buyer)).toBe(true)
    expect(flagged('We could do 20 if you sign today.', 'negotiation', buyer)).toBe(true)
    expect(flagged('$40k a year', 'negotiation')).toBe(true)
    expect(flagged('about 15% off', 'negotiation')).toBe(true)
    expect(flagged('a discount of 10', 'negotiation')).toBe(true)
  })

  it('more offers, in either word order, and as a question', () => {
    for (const line of [
      'Could we do 30 if you commit to two years?',
      'Can I offer 25 on a two-year term?',
      "I'll knock 5 off if we close this month.",
      'I can give you three months free.',
      "We'd do 18 for a three-year deal.",
      'That is about 12% under what you pay now.',
      'Would 15 percent get this done?',
    ]) expect(flagged(line, 'negotiation', buyer), line).toBe(true)
  })

  it('the same offers are not price lines on other call types without a price word (the narrowed patterns)', () => {
    for (const type of NOT_PRICING) {
      expect(flagged('We could do 20 if you sign today.', type, buyer)).toBe(false)
      expect(flagged('We can do 20% if you sign annually.', type, buyer)).toBe(false)
    }
  })

  it('must pass: their own figure asked back, path-to-signature dates, volumes', () => {
    expect(flagged("What's driving the 20?", 'negotiation', buyer)).toBe(false)
    expect(flagged("What's driving the 20% off?", 'negotiation', buyer)).toBe(false)
    expect(flagged('Where does the 20% come from?', 'negotiation', buyer)).toBe(false)
    expect(flagged('So about 10 million traces a month, 90 days of history?', 'negotiation')).toBe(false)
    expect(flagged('Could we do the security review by March 15?', 'negotiation')).toBe(false)
    expect(flagged('Could we do a review call in 2 weeks?', 'negotiation')).toBe(false)
    expect(flagged('Can we go through the 3 paper steps left?', 'negotiation')).toBe(false)
    expect(flagged('Could we do two short calls instead?', 'negotiation')).toBe(false)
    expect(flagged('What could you do on term or timing on your side?', 'negotiation')).toBe(false)
  })

  it('their figure is only theirs when they said it in the last 30 s, as a question that offers nothing', () => {
    // Nobody on their side said 20 lately: asking about "the 20% off" puts a discount on the table.
    expect(flagged("What's driving the 20% off?", 'negotiation')).toBe(true)
    expect(flagged("What's driving the 20% off?", 'discovery')).toBe(true)
    // A statement, not a question.
    expect(flagged('So 20% off is what you need.', 'negotiation', buyer)).toBe(true)
    // A question that offers: still an offer.
    expect(flagged('Could we do 20% if you sign this month?', 'negotiation', buyer)).toBe(true)
    // A different figure from theirs.
    expect(flagged("Would 15% off work instead?", 'negotiation', buyer)).toBe(true)
    // Spelled or with a size word, the value still matches.
    expect(flagged('What makes $40k a year the ceiling?', 'negotiation', { theirRecentText: 'We have about forty thousand dollars a year for this.' })).toBe(false)
    expect(flagged('What makes $40k a year the ceiling?', 'negotiation', { theirRecentText: 'Our budget is 40 a seat.' })).toBe(true)
    // A FOLLOW that is a question may ask it back too.
    expect(priceFigures(card('What would make this work?', { follow_up: "What's behind the 20% off?" }), { callType: 'negotiation', ...buyer })).toEqual([])
  })

  it('a bare % that is their own figure, asked back, passes; Keith stating it does not', () => {
    const tokens = { theirRecentText: 'Our token costs went up 40% last quarter.' }
    expect(flagged('Your token costs went up 40% last quarter?', 'negotiation', tokens)).toBe(false)
    expect(flagged('Your token costs went up 40% last quarter?', 'negotiation')).toBe(true)
    expect(flagged('So the goal is an error rate under 2%?', 'negotiation')).toBe(true)
  })
})

describe('priceFigures: approved pricing the card cites', () => {
  const sources = new Map<string, { kind: 'turn' | 'knowledge'; detail: string }>([
    ['K1', { kind: 'knowledge', detail: 'Team plan: $50 per seat per month, billed annually. Annual prepay: 10% off list.' }],
    ['T1', { kind: 'turn', detail: 'Is it about $50 per seat?' }],
  ])

  for (const type of CALL_TYPES) {
    it(`a figure from a cited approved item passes; uncited, or only in a turn, it doesn't (${type})`, () => {
      const line = 'The Team plan is $50 per seat a month.'
      expect(priceFigures(card(line, { source_ids: ['K1'] }), { callType: type, sources })).toEqual([])
      expect(priceFigures(card(line), { callType: type, sources })).toEqual(['$50'])
      expect(priceFigures(card(line, { source_ids: ['T1'] }), { callType: type, sources })).toEqual(['$50'])
      expect(priceFigures(card('Annual prepay gets 10% off list.', { source_ids: ['K1'] }), { callType: type, sources })).toEqual([])
      // A figure the item doesn't state is still flagged, even with the item cited.
      expect(priceFigures(card('Annual prepay gets 15% off list.', { source_ids: ['K1'] }), { callType: type, sources })).toEqual(['15%'])
    })
  }
})

describe('cardChecks and streamingChecks carry the price check', () => {
  const buyer = { theirRecentText: "We'd need 20% off to get this through.", callType: 'negotiation' }
  const offer = card('We can do 20% if you sign annually.')

  it('the finished card shows CHECK_PRICE; old callers without the options still get it for a plain price', () => {
    expect(cardChecks(offer, [], new Map(), buyer)).toEqual([CHECK_PRICE])
    expect(cardChecks(card('That would be about $40k a year.'), [], new Map())).toEqual([CHECK_PRICE])
    expect(cardChecks(card("What's driving the 20?"), [], new Map(), buyer)).toEqual([])
  })

  it('while streaming it warns early only when no approved item came with the press, and matches the finished card then', () => {
    expect(streamingChecks(offer, { contextText: buyer.theirRecentText, knowledgeInContext: false, ...buyer })).toEqual([CHECK_PRICE])
    expect(streamingChecks(offer, { contextText: buyer.theirRecentText, knowledgeInContext: true, ...buyer })).toEqual([])
    // Same order as the finished card: number, price, claim.
    const both = card('We support SSO for $40k a year.')
    const early = streamingChecks(both, { contextText: '', knowledgeInContext: false, callType: 'discovery' })
    expect(early).toEqual([CHECK_NUMBER, CHECK_PRICE, CHECK_CLAIM])
    expect(cardChecks(both, ['number not found in context: 40'], new Map(), { callType: 'discovery' })).toEqual(early)
  })
})

describe('priceCheckInputs: what the call gives the check', () => {
  it('their side of the last 30 s only (not Keith, not a tagged SA, not older turns), the sources and the type at the press', () => {
    const call = inventedCall({
      call_type: 'negotiation',
      speakers: { 'e1:s0': { role: 'buyer', name: 'Dana' }, 'e1:s1': { role: 'teammate', name: 'Sam (SA)' } },
      transcript: [
        { t: 0, end: 6, who: 'e1:s0', text: 'Last quarter we were quoted 35 elsewhere.' },
        { t: 50, end: 56, who: 'e1:s1', text: 'Most teams start around 18.' },
        { t: 58, end: 64, who: 'keith', text: 'Happy to walk through 12 options.' },
        { t: 66, end: 72, who: 'e1:s0', text: "We'd need 20% off to get this through." },
      ],
      help_at_s: 75,
    })
    const r = replayAt(call)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    const p = priceCheckInputs(r.memory, ctx)
    expect(p.callType).toBe('negotiation')
    expect(p.theirRecentText).toBe("We'd need 20% off to get this through.")
    expect(p.sources).toBe(ctx.sources)
    // The type as the request was built: a later change mid-call doesn't rewrite it.
    r.memory.setup = { ...r.memory.setup, call_type: 'discovery' }
    expect(priceCheckInputs(r.memory, ctx).callType).toBe('negotiation')
  })
})

describe('speed test: Level 1', () => {
  const scenario = inventedCall({
    id: 'price-unit', call_type: 'negotiation',
    transcript: [
      { t: 0, end: 5, who: 'keith', text: 'How does the proposal look on your side?' },
      { t: 6, end: 12, who: 'e1:s0', text: "We'd need 20% off to get this through." },
    ],
    help_at_s: 14,
  })
  const kinds = new Map<string, 'turn' | 'knowledge'>([['T1', 'turn']])

  it('a card with a price figure fails, with no figure in the failure text', () => {
    const f = level1(scenario, card('We can do 20% if you sign annually.'), [], '', kinds)
    expect(f).toEqual(['states a price or discount not from approved pricing'])
    expect(f.join(' ')).not.toMatch(/\d/)
    expect(level1(scenario, card("What's driving the 20?"), [], '', kinds)).toEqual([])
    // With the call's inputs, their own figure asked back passes even with a %.
    expect(level1(scenario, card("What's driving the 20% off?"), [], '', kinds, { callType: 'negotiation', theirRecentText: "We'd need 20% off to get this through." })).toEqual([])
  })

  it('runScenario judges the real card with the replayed call', async () => {
    const scripted = (lines: string): HelpModel => ({
      mock: false, label: () => 'scripted', prewarm: async () => {}, check: async () => ({ readiness: 'ready' as const }),
      run: async (req: HelpModelRun) => {
        req.onText(lines)
        return { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 }, stop_reason: 'end_turn', served_model: 'scripted', fell_back: false }
      },
    })
    const config: HelpModelConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', thinking: 'off', timeout_ms: 8000, max_tokens: 400 }
    const offer = await runScenario(scenario, scripted('MOVE: handle_objection\nSAY: We can do 20% if you sign annually.\nHAPPENING: -\nFOLLOW: -\nSOURCES: T2\nNOTE: -\n'), config, playbook)
    expect(offer.level1.failures).toEqual(['states a price or discount not from approved pricing'])
    const askedBack = await runScenario(scenario, scripted("MOVE: handle_objection\nASK: What's driving the 20% off?\nHAPPENING: -\nFOLLOW: -\nSOURCES: T2\nNOTE: -\n"), config, playbook)
    expect(askedBack.level1).toEqual({ pass: true, failures: [] })
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HELP engine: the price check on a live card', () => {
  const pricingCall = () => inventedCall({
    call_type: 'negotiation',
    transcript: [
      { t: 0, end: 5, who: 'keith', text: 'How does the proposal look on your side?' },
      { t: 6, end: 14, who: 'e1:s0', text: "We'd need 20% off to get this through procurement." },
    ],
    help_at_s: 16,
  })

  it('an offer of their figure gets the check while streaming and on the finished card; logs keep counts only', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pricingCall() })
    // The fixture copies turns and labels; the call type is set as Keith would set it.
    s.memory.setup = { ...s.memory.setup, call_type: 'negotiation' }
    s.engine.press()
    m.calls[0].send('MOVE: handle_objection\nSAY: We can do 20% if you sign annually.\n')
    await vi.advanceTimersByTimeAsync(0)
    // 20 was said, so no number check: only the price check.
    expect(s.events.at(-1)).toMatchObject({ status: 'streaming', checks: [CHECK_PRICE] })
    m.calls[0].send('HAPPENING: They asked for a discount.\nFOLLOW: -\nSOURCES: T2\nNOTE: -\n')
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)).toMatchObject({ status: 'complete', checks: [CHECK_PRICE] })
    expect(s.events.at(-1)!.content.primary).toBe('We can do 20% if you sign annually.')
    expect(s.logs.find((l) => l.e === 'help_done')?.d).toMatchObject({ checks: 1, early_checks: 1 })
    // The card's words, not bare digits: request ids are random hex and may hold any digits.
    expect(JSON.stringify(s.logs)).not.toMatch(/20%|annually|discount|procurement/)
  })

  it('their figure asked back as a question has no check', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { call: pricingCall() })
    s.memory.setup = { ...s.memory.setup, call_type: 'negotiation' }
    s.engine.press()
    m.calls[0].send("MOVE: handle_objection\nASK: What's driving the 20% off?\nHAPPENING: -\nFOLLOW: -\nSOURCES: T2\nNOTE: -\n")
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)).toMatchObject({ status: 'complete', checks: [] })
  })

  it('on a discovery call a plain volume recap has no check; a price does', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, {
      call: inventedCall({
        transcript: [{ t: 0, end: 9, who: 'e1:s0', text: 'We send about 10 million traces a month and keep 90 days of history.' }],
        help_at_s: 11,
      }),
    })
    s.engine.press()
    m.calls[0].send('MOVE: clarify_scale\nASK: So about 10 million traces a month, 90 days of history?\nHAPPENING: -\nFOLLOW: -\nSOURCES: T1\nNOTE: -\n')
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)).toMatchObject({ status: 'complete', checks: [] })
    s.engine.press()
    m.calls[1].send('MOVE: clarify_scale\nSAY: At 10 million traces that would be about $40k a year.\nHAPPENING: -\nFOLLOW: -\nSOURCES: T1\nNOTE: -\n')
    m.calls[1].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.at(-1)!.checks).toEqual([CHECK_NUMBER, CHECK_PRICE])
  })
})
