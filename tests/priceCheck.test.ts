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
    'Can 3 of your team try the free tier first?',
    'Is the free plan enough for 2 engineers?',
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
  const buyer = { theirText: "We'd need 20% off to get this through." }

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

  it('on other call types an offer counts only with a %, or months or years: a bare number stays a pricing-call rule', () => {
    for (const type of NOT_PRICING) {
      expect(flagged('We could do 20 if you sign today.', type, buyer)).toBe(false)
      expect(flagged('Could we do 3 short calls instead?', type)).toBe(false)
      for (const line of [
        'We can do 20% if you sign annually.',
        '15% is doable on a two year term.',
        'We can cap increases at 5% a year.',
        'We could add 3 months at no charge.',
        'Happy to include 3 months free on a two-year deal.',
      ]) expect(flagged(line, type, { theirText: "We'd need 20% off. We need 15% and 5% caps." }), `${type}: ${line}`).toBe(true)
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

  it('their figure is only theirs when their side said it, asked as a question that offers nothing', () => {
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
    expect(flagged('What makes $40k a year the ceiling?', 'negotiation', { theirText: 'We have about forty thousand dollars a year for this.' })).toBe(false)
    expect(flagged('What makes $40k a year the ceiling?', 'negotiation', { theirText: 'Our budget is 40 a seat.' })).toBe(true)
    // A FOLLOW that is a question may ask it back too.
    expect(priceFigures(card('What would make this work?', { follow_up: "What's behind the 20% off?" }), { callType: 'negotiation', ...buyer })).toEqual([])
  })

  it('a bare % that is their own figure, asked back, passes; Keith stating one does not', () => {
    const spend = { theirText: 'About 30% of our budget goes to tooling.' }
    expect(flagged('So 30% of the budget goes to tooling?', 'negotiation', spend)).toBe(false)
    expect(flagged('So 30% of the budget goes to tooling?', 'negotiation')).toBe(true)
    expect(flagged('So 30% of the budget goes to tooling.', 'negotiation', spend)).toBe(true)
    expect(flagged('So the goal is an error rate under 2%?', 'negotiation')).toBe(true)
    // A change in their own numbers is an outcome, not a price (an invented figure still gets the number check).
    expect(flagged('Your token costs went up 40% last quarter?', 'negotiation')).toBe(false)
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
  const buyer = { theirText: "We'd need 20% off to get this through.", callType: 'negotiation' }
  const offer = card('We can do 20% if you sign annually.')

  it('the finished card shows CHECK_PRICE; old callers without the options still get it for a plain price', () => {
    expect(cardChecks(offer, [], new Map(), buyer)).toEqual([CHECK_PRICE])
    expect(cardChecks(card('That would be about $40k a year.'), [], new Map())).toEqual([CHECK_PRICE])
    expect(cardChecks(card("What's driving the 20?"), [], new Map(), buyer)).toEqual([])
  })

  it('while streaming it warns early only when no approved item came with the press, and matches the finished card then', () => {
    expect(streamingChecks(offer, { contextText: buyer.theirText, knowledgeInContext: false, ...buyer })).toEqual([CHECK_PRICE])
    expect(streamingChecks(offer, { contextText: buyer.theirText, knowledgeInContext: true, ...buyer })).toEqual([])
    // Same order as the finished card: number, price, claim.
    const both = card('We support SSO for $40k a year.')
    const early = streamingChecks(both, { contextText: '', knowledgeInContext: false, callType: 'discovery' })
    expect(early).toEqual([CHECK_NUMBER, CHECK_PRICE, CHECK_CLAIM])
    expect(cardChecks(both, ['number not found in context: 40'], new Map(), { callType: 'discovery' })).toEqual(early)
  })
})

describe('priceCheckInputs: what the call gives the check', () => {
  it('their side all call long (not Keith, not a tagged SA), the sources and the type at the press', () => {
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
    // The quote from over a minute ago is still theirs to ask about; the SA's and Keith's figures never are.
    expect(p.theirText).toBe("Last quarter we were quoted 35 elsewhere.\nWe'd need 20% off to get this through.")
    expect(p.sources).toBe(ctx.sources)
    // The type as the request was built: a later change mid-call doesn't rewrite it.
    r.memory.setup = { ...r.memory.setup, call_type: 'discovery' }
    expect(priceCheckInputs(r.memory, ctx).callType).toBe('negotiation')
  })

  it('their words still being transcribed at the press count as theirs (the model saw them too)', () => {
    const call = inventedCall({
      call_type: 'negotiation',
      transcript: [
        { t: 0, end: 5, who: 'keith', text: 'How does the proposal look on your side?' },
        { t: 66, end: 76, who: 'e1:s0', text: "We'd need 20% off to get this through." },
      ],
      help_at_s: 75,
    })
    const r = replayAt(call)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    const p = priceCheckInputs(r.memory, ctx)
    expect(r.memory.turnsAsOf(r.atMs).some((t) => t.text.includes('20%'))).toBe(false)
    expect(p.theirText).toContain('20% off')
    expect(priceFigures(card("What's driving the 20% off?"), p)).toEqual([])
    expect(priceFigures(card('We can do 20% if you sign annually.'), p)).toEqual(['20%'])
  })

  it("what they said on earlier calls counts; Arize's promises, Keith's plan and open items don't", () => {
    const call = inventedCall({
      call_type: 'follow_up',
      earlier_calls: [
        { kind: 'wants', text: 'Tooling spend under $150k a year', date: '2026-09-20' },
        { kind: 'promised', text: 'Send pricing for 40 seats at $90k', date: '2026-09-20' },
        { kind: 'open', text: 'Proposed 12% off for a two-year term', date: '2026-09-20' },
        { kind: 'to_learn', text: 'Whether the $70k cap is firm', date: '2026-09-20' },
      ],
      help_at_s: 20,
    })
    const r = replayAt(call)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    const p = priceCheckInputs(r.memory, ctx)
    expect(p.theirText).toContain('$150k')
    expect(p.theirText).not.toMatch(/\$90k|12%|\$70k/)
    expect(priceFigures(card('Last call you mentioned a $150k budget for tooling. Is that still right?'), p)).toEqual([])
    expect(priceFigures(card('Last call you mentioned a $90k quote. Is that still right?'), p)).toEqual(['$90k'])
  })
})

describe('review fixes: a yes/no question never concedes their discount', () => {
  const buyer = { theirText: "We'd need 20% off to get this through. Our budget is $40k." }
  const mustFlag = [
    'Would 20% off get this signed by Friday?',
    'If you sign this quarter, would 20% off work?',
    'Is 20% off enough to close this month?',
    'Can you sign today at 20% off?',
    'Does 20% off get this done for you?',
    'Would you take 20% off for a two-year term?',
    'Would $40k work if you signed for two years?',
    'What would 20% off mean for your budget?',
    'Which 20% off option works for you?',
  ]
  for (const type of ['negotiation', 'discovery', 'demo'] as CallType[]) {
    it(`flags their figure tied to a yes, as ASK or as a FOLLOW question (${type})`, () => {
      for (const line of mustFlag) {
        expect(flagged(line, type, buyer), line).toBe(true)
        expect(priceFigures(card('What would make this work?', { follow_up: line }), { callType: type, ...buyer }), line).not.toEqual([])
      }
    })
  }

  it('a real question about their figure still passes', () => {
    for (const line of ["What's driving the 20?", "What's driving the 20% off?", 'Where does the 20% come from?', 'What makes $40k the ceiling?', 'Why 20% off? What sets that number?']) {
      expect(flagged(line, 'negotiation', buyer), line).toBe(false)
    }
  })
})

describe('review fixes: an approved item backs only the same kind of figure', () => {
  const sources = new Map<string, { kind: 'turn' | 'knowledge'; detail: string }>([
    ['K1', { kind: 'knowledge', detail: 'Arize AX keeps traces for 30 days on SaaS and supports 20 integrations.' }],
    ['K2', { kind: 'knowledge', detail: 'Team plan: $50 per seat per month. Annual prepay: 10% off list.' }],
  ])
  it('"30 days" never backs "30% off"; "$50 per seat" backs "50 per seat"; "10% off" backs "10% off"', () => {
    for (const type of CALL_TYPES) {
      expect(priceFigures(card('We can do 30% off if you sign this quarter.', { source_ids: ['K1'] }), { callType: type, sources })).toEqual(['30%'])
      expect(priceFigures(card('We could do 20% off for annual.', { source_ids: ['K1'] }), { callType: type, sources })).toEqual(['20%'])
      expect(priceFigures(card('That is $30 per seat.', { source_ids: ['K1'] }), { callType: type, sources })).toEqual(['$30'])
      expect(priceFigures(card('It is 50 per seat a month.', { source_ids: ['K2'] }), { callType: type, sources })).toEqual([])
      expect(priceFigures(card('Annual prepay gets 10% off list.', { source_ids: ['K2'] }), { callType: type, sources })).toEqual([])
      expect(priceFigures(card('Annual prepay gets $10 off list.', { source_ids: ['K2'] }), { callType: type, sources })).toEqual(['$10'])
    }
  })
})

describe('review fixes: pricing-call lines that are not prices', () => {
  const mustPass = [
    // Non-money gives and the path to signature.
    'Can I give you 2 examples of how teams do this?',
    'I can get you 3 references from similar teams.',
    'Can we do 2 more sessions with your ML team next week?',
    'We could do 3 pilots in parallel.',
    'Can we get 5 of your engineers on the next call?',
    'We can do 1 more demo for the VP.',
    'I will give 3 options for the follow up.',
    'Could we do Thursday at 3 to walk through the order form?',
    'Can we get this signed by 10/30?',
    'Could we get 2 people from security on the next call?',
    'Could we meet with the 4 reviewers next week?',
    'Can we get legal and the 2 security reviewers on Tuesday?',
    'Could we do 24/7 support coverage as part of it?',
    'Which 3 pricing questions should we cover today?',
    'Is price 1 of the top 3 things you\'ll judge us on?',
    'How many spans a day, 50 million?',
    'Does security need our ISO 27001 report before signing?',
    // Value recaps in their words (pricing line 1).
    'In the POV you saw 40% fewer bad answers reach users. Does that still hold?',
    'Your team cut debugging time 30% in the pilot. Is that still the main value?',
    'What would cutting cost by 30% mean for your team?',
  ]
  it('must pass', () => {
    for (const line of mustPass) expect(flagged(line, 'negotiation'), line).toBe(false)
  })

  it('must flag: concessions, their figure accepted, and large figures', () => {
    const cases: Array<[string, string]> = [
      ["Let's call it 40k and get it signed.", 'Our budget is 40k.'],
      ['We can come down to 35k.', 'We were hoping for 35k.'],
      ['I can bring it down to 35k if you sign this month.', 'We were hoping for 35k.'],
      ['What if we meet you at 30k?', 'We can do 30k.'],
      ['How about 40k for the first year?', 'Our budget is 40k.'],
      ['Could you get there at 40k?', 'Our budget is 40k.'],
      ['We can sharpen to 45k.', 'Could you do 45k?'],
      ['What if we went to 20% for a two-year term?', "We'd need 20% off."],
      ['If we meet you at 20%, could you sign this quarter?', "We'd need 20% off."],
      ["We'll come down to 30.", 'We need it at 30.'],
      ['40,000 a year works for us.', 'We have 40,000 a year.'],
      ['Happy to include 3 months free on a two-year deal.', ''],
      ['We could drop 10% if you sign.', ''],
      ['We could cut it by 10%.', ''],
      ['Could we cut the price by 10%?', ''],
    ]
    for (const [line, theirText] of cases) expect(flagged(line, 'negotiation', { theirText }), line).toBe(true)
  })
})

describe('review fixes: their own costs and budgets, on any call', () => {
  const mustPass: Array<[string, string]> = [
    ['What drove the 15% increase in cost last quarter?', 'Our inference cost went up 15% last quarter.'],
    ['What are your 2 biggest cost drivers today?', ''],
    ['What are your top 3 cost drivers today?', ''],
    ['How do you price the 3 tiers of your own product?', ''],
    ['What would cutting cost by 30% mean for your team?', ''],
    ["You mentioned costs went up 40% last quarter. What's driving that?", 'Our costs went up 40% last quarter.'],
    ['So the $200k you spend on Datadog today, what does that cover?', 'We spend about $200k on Datadog.'],
    ['Last call you mentioned a $150k budget for tooling. Is that still right?', 'Tooling spend under $150k a year'],
  ]
  for (const type of CALL_TYPES) {
    it(`must pass (${type})`, () => {
      for (const [line, theirText] of mustPass) expect(flagged(line, type, { theirText }), line).toBe(false)
    })
  }

  it('a price word about Arize still flags: a price increase, a price cut', () => {
    for (const type of CALL_TYPES) {
      expect(flagged('There will be a 5% price increase next year.', type), type).toBe(true)
      expect(flagged('Could we cut the price by 10%?', type), type).toBe(true)
    }
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
    expect(level1(scenario, card("What's driving the 20% off?"), [], '', kinds, { callType: 'negotiation', theirText: "We'd need 20% off to get this through." })).toEqual([])
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
