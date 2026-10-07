import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { CALL_TYPES, type HelpCardContent } from '../src/shared/help'
import { benchmark, level1, loadScenarios, reportMarkdown, runScenario, summarize, type ScenarioResult } from '../src/main/help/evalRunner'
import { byCallType, byCallTypeMarkdown, isPriceCheckFailure } from '../src/main/help/evalByType'
import * as protocol from '../src/main/help/protocol'
import { buildHelpContext } from '../src/main/help/context'
import { DEFAULT_HELP_CONFIG, MockHelpModel, OPUS_HELP_CONFIG } from '../src/main/help/models'
import { loadPlaybook } from '../src/main/help/prompt'
import { replayAt, type Scenario } from '../src/main/help/replay'

const playbook = loadPlaybook(fileURLToPath(new URL('../config/playbook.json', import.meta.url)))
const all = loadScenarios(fileURLToPath(new URL('../evals/scenarios/help', import.meta.url)))
const modes = all.filter((s) => s.id.startsWith('mode-'))
const byId = (id: string) => {
  const s = modes.find((x) => x.id === id)
  if (!s) throw new Error(`no scenario ${id}`)
  return s
}

/** Level 1 on a card whose only line is `primary`, with the scenario's own context (as the speed test builds it). */
function l1(s: Scenario, primary: string, over: Partial<HelpCardContent> = {}): string[] {
  const r = replayAt(s)
  const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
  const kinds = new Map([...ctx.sources.entries()].map(([k, v]) => [k, v.kind]))
  const card: HelpCardContent = { move: 'clarify_current_state', primary_kind: 'ask', primary, happening: null, follow_up: null, source_ids: [], note: null, ...over }
  return level1(s, card, [], ctx.text, kinds)
}

/** Keith's question turns, as the mode facts count them: 4+ words with a "?" that isn't only a tag question. */
const TAG_Q = /\b(right|make sense|you know|okay|yeah|correct|does that make sense)\?\s*$/i
const keithQuestions = (s: Scenario) =>
  s.transcript.filter((l) => l.who === 'keith' && l.text.split(/\s+/).length >= 4 && l.text.replace(TAG_Q, '').includes('?'))

describe('M5 call-mode scenarios (drafts for Keith)', () => {
  it('the 23 from the plan, one or more per call type, all made up and unapproved', () => {
    expect(modes).toHaveLength(23)
    const per = (t: string) => modes.filter((s) => s.call_type === t).length
    expect([per('discovery'), per('demo'), per('technical_deep_dive'), per('negotiation'), per('follow_up')]).toEqual([5, 7, 4, 4, 3])
    for (const s of modes) {
      expect(s.category, s.id).toBe('call_mode')
      expect(s.golden_approved, s.id).toBe(false)
      expect(s.synthetic, s.id).toBe(true)
      expect(CALL_TYPES as readonly string[], s.id).toContain(s.call_type)
      // Whoever is meant as the SA is tagged as a teammate, so the mode can hand questions to them.
      for (const sp of Object.values(s.speakers)) if (/\(SA\)/.test(sp.name ?? '')) expect(sp.role, s.id).toBe('teammate')
      // A length, where set, reaches the replayed call setup (the time-left cue counts from it).
      expect(replayAt(s).memory.setup.length_min, s.id).toBe(s.length_min)
    }
  })

  it('the discovery question counts are set up as the plan says', () => {
    // 16 questions and no play-back since: no Keith turn of 30 s or more, no "did I miss anything".
    for (const id of ['mode-disco-02-fifteen-questions', 'mode-disco-03-new-issue-after-many']) {
      const s = byId(id)
      expect(keithQuestions(s), id).toHaveLength(16)
      expect(s.transcript.filter((l) => l.who === 'keith' && ((l.end ?? l.t) - l.t >= 30 || /did I (miss|get that right)|anything I missed|fair summary/i.test(l.text))), id).toEqual([])
    }
    // Disco 03 ends on a new issue they raised; disco 02 on a plain answer.
    expect(byId('mode-disco-03-new-issue-after-many').transcript.at(-1)!.text).toMatch(/releases are slow since we added agents/)
    // Disco 01: Keith has been describing the product for over a minute.
    const pitch = byId('mode-disco-01-pitching-early').transcript.find((l) => l.who === 'keith' && (l.end ?? l.t) - l.t > 60)
    expect(pitch?.text).toMatch(/evals/)
  })

  it('time-left moments sit where the plan puts them', () => {
    const at = (id: string) => [Math.floor(byId(id).help_at_s / 60), byId(id).length_min]
    expect(at('mode-disco-04-ten-min-left')).toEqual([21, 30])
    expect(at('mode-demo-07-wrap-already-started')).toEqual([38, 45])
    // Demo 07: Keith already asked what stood out, after the 10-minutes-left mark (minute 35 of 45).
    const asked = byId('mode-demo-07-wrap-already-started').transcript.find((l) => l.who === 'keith' && /what stood out/i.test(l.text))
    expect(asked!.t).toBeGreaterThanOrEqual(35 * 60)
  })

  it('demo 01: Sam is still talking at the press, and HELP sees only the start, as live words', () => {
    const s = byId('mode-demo-01-sa-mid-screen')
    expect(s.tags).toContain('step_2')
    expect(s.keith_notes).toMatch(/^Step 2/)
    const r = replayAt(s)
    expect(r.hiddenLineIndexes).toEqual([s.transcript.length - 1])
    const live = s.transcript.at(-1)!
    expect(s.speakers[live.who].role).toBe('teammate')
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toMatch(/\(still being transcribed, may be inaccurate\) Remote: And if I click into the carrier lookup/)
    expect(ctx.text).not.toContain('before the invoice ever shows up')
    // About 50 s of Sam since the buyer last spoke (the step-2 Hold needs the SA running).
    const buyerEnd = Math.max(...s.transcript.filter((l) => s.speakers[l.who]?.role === 'buyer').map((l) => l.end ?? l.t))
    const samStart = Math.min(...s.transcript.filter((l) => l.t > buyerEnd && s.speakers[l.who]?.role === 'teammate').map((l) => l.t))
    expect(s.help_at_s - samStart).toBeGreaterThanOrEqual(45)
  })

  it("demo 02: the live words at the press are the buyer's reaction, not Sam's", () => {
    const s = byId('mode-demo-02-reaction-go-deeper')
    const r = replayAt(s)
    expect(r.hiddenLineIndexes.map((i) => s.speakers[s.transcript[i].who].role)).toEqual(['buyer'])
    expect(buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs }).text).toMatch(/Remote: Oh, that trace view is what we've been hacking together\n/)
  })

  it('deep-dive 03: the readout date was agreed 20 minutes before WRAP, out of what HELP sees', () => {
    const s = byId('mode-dive-03-readout-said-earlier')
    expect(s.wrap).toBe('button')
    const readout = s.transcript.find((l) => /nineteenth/.test(l.text))!
    expect(s.help_at_s - readout.t).toBeGreaterThan(19 * 60)
    const r = replayAt(s)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs }).text
    // The goals mention a readout (the call's outcomes); the agreed date and time never reach HELP.
    expect(ctx).not.toMatch(/nineteenth|November|two o'clock/i)
  })

  it('pricing 02: Keith gave the number last, and nobody has answered yet', () => {
    const s = byId('mode-price-02-keith-gave-number')
    expect(s.transcript.at(-1)).toMatchObject({ who: 'keith', text: expect.stringMatching(/\$84,000/) })
  })

  // Level 1 extras: lines each scenario's patterns must catch, and lines they must let through.
  const cases: Array<[string, string[], string[]]> = [
    ['mode-disco-01-pitching-early', ['We can also run online evals on that.', 'You could use LLM-as-a-judge checks here.'], ['How do adjusters catch a missing detail today?']],
    ['mode-disco-03-new-issue-after-many', ['So far: wrong citations, no owner. Did I miss anything?', 'Is that a fair summary?', 'How much is that costing you?', 'That must be costing you customers.'], ['What happened on the last slow release?', 'What does that cost you per release, in time?']],
    ['mode-disco-05-direct-question', ['Yes, with zero code changes.', 'No code changes needed at all.'], ['Which services would you trace first?']],
    ['mode-demo-02-reaction-go-deeper', ['Where does that bite today?'], ['What have you been hacking together so far?']],
    ['mode-demo-03-tech-question-to-keith', ['Yes, the context will propagate across the call.', 'It does follow it across, as long as both are instrumented.', 'The trace will follow it.'], ['Good one for Sam. Sam, can you take the propagation question?', 'Sam, does the context propagate across that call?', 'Good one for Sam. Sam, can you show how the context would carry across to fraud scoring?', 'Sam, can you walk through whether the trace would follow it into fraud scoring?']],
    ['mode-demo-04-objection', ['We have a self-hosted option for exactly that.', 'Our self-hosted version keeps data with you.', 'No problem, we have a self-hosted option.'], ["Understood. What's behind that: client agreements, or a firm-wide policy?"]],
    ['mode-demo-05-refresh-before-sa', ['Let Sam carry on now.', 'Let Sam take it from here.'], ['What did going to all stores change for the Friday sample?', 'Sam, let\'s start with the Friday sample.']],
    ['mode-demo-06-non-tech-question', ['Yes, and viewers are free seats.', 'You get unlimited users.'], ['Which PMs would use them?']],
    ['mode-demo-07-wrap-already-started', ['Before we run out of time, what stood out most?'], ['What happened in August?', 'Who else should see the experiments view?']],
    ['mode-dive-01-new-ask', ['Sure, we can add that.', "Yes, we'll include cost tracking.", 'Of course, Sam can set up cost per team.'], ['Swap it for one of the three goals, or keep it for later?']],
    ['mode-dive-02-requirement', ["That's a must-have, noted.", 'Sounds like a must-have.', 'Arize can run entirely inside your VPC.', 'Everything stays in your network.'], ['Would it need to run inside your VPC for every service?', 'Got it, a hard requirement. Who reviews that?', 'So everything stays inside your network, prompts included?', 'So it stays in your VPC: is that all prompt data?', 'Is that a must-have, or a nice-to-have?']],
    ['mode-dive-03-readout-said-earlier', ['We still need a readout date.', "We haven't set a readout yet."], ['Did we land on the readout date?']],
    ['mode-dive-04-onboarding-question', ['You can be live in two weeks.', 'Onboarding is free of charge.'], ['Who would join the kickoff from your side?']],
    ['mode-price-01-discount-ask', ['We can do 20% if you sign annually.', 'We could do 15 if you sign today.', "We'll do 15 if you sign this week.", 'Could we do 18 for a two-year term?', "I'll go down to 15 if you sign today.", 'We could go to 18 for two years.', 'That would be $40k a year.', 'Let me see about a discount of 10.', 'This price is only good until end of quarter.'], ["What's driving the 20?", 'Is the 20 a budget cap, or another quote?', 'What could you do on term or timing on your side?', "Could we go through what's driving the 20?", "Could we go over what's behind the 20%?", "I'll go back to our deal desk on the 20 and come back by Friday.", "I'll give you a call back Thursday at 2."]],
    ['mode-price-02-keith-gave-number', ['We could come down a bit.', 'There is some wiggle room.', 'To recap, $84,000 for the year.', 'I can ask about a discount.'], ['How does that land for you?']],
    ['mode-price-03-comparison', ['Langfuse charges for its enterprise tier.', "It isn't really free once you run it.", 'Ours starts at $2,000.'], ["Fair question. If you ran it yourselves, who'd own it?"]],
    ['mode-price-04-volume-recap', ['That is about $0.10 per trace.', 'We price per million spans.', 'The cost is lower per million at that volume.', 'I can get you a discount.'], ['So about 10 million traces a month, 90 days of history?', 'How many spans per trace, roughly?', 'Is that per million requests or per assistant?']],
    ['mode-follow-02-think-about-it', ['This offer expires Friday.', 'We can do a discount if you sign this quarter.', "It's the end of the quarter for us."], ['My sense is something still feels uncertain. Is that fair?']],
    ['mode-follow-03-direct-question', ['I sent it over on Tuesday.', 'We already shared the security doc.'], ['I\'ll make sure Hana has it today. Anything else she needs?', 'Let me check that I sent it to Hana, and confirm today.', "I'll check whether we sent it and get it to Hana today.", "I'll check that we sent it and confirm today."]],
  ]
  // A cue in HAPPENING that names what was already asked, or tells Keith what not to do, is fine; saying it to them is not.
  const dontDiscount = ["Don't offer a discount; name the stall", 'No discount: find what\'s unsure']
  const happenings: Record<string, string[]> = {
    'mode-demo-07-wrap-already-started': ["You asked what stood out; they're reacting"],
    'mode-demo-04-objection': ['Hold the self-hosted option until you know why'],
    'mode-dive-02-requirement': ['Must-have: prompts stay in their VPC. Note it.'],
    'mode-price-02-keith-gave-number': [
      "Wait: don't lower it or justify it", "Don't come down: let them answer", "Wait for their answer. Don't flex on the number.",
      "Don't lower it: let them answer", 'Hold: no discount, let them answer', ...dontDiscount,
    ],
    'mode-price-04-volume-recap': ['Volumes only: no price or discount yet', ...dontDiscount],
    'mode-follow-02-think-about-it': dontDiscount,
  }
  for (const [id, bad, good] of cases) {
    it(`${id}: its Level 1 extras catch the wrong lines and pass the right ones`, () => {
      const s = byId(id)
      for (const b of bad) expect(l1(s, b).join(' '), b).toMatch(/matched forbidden pattern/)
      for (const g of good) expect(l1(s, g).filter((f) => f.startsWith('matched forbidden pattern')), g).toEqual([])
      for (const h of happenings[id] ?? []) expect(l1(s, 'What happened in August?', { happening: h }).filter((f) => f.startsWith('matched forbidden pattern')), h).toEqual([])
    })
  }

  it("no Level 1 extra trips on Practice mode's placeholder lines, today's or the mode ones the plan names", () => {
    const placeholders = [
      '[MOCK] How does that work in practice today?', '[MOCK] What day works for a follow-up, and who should join?', "[MOCK] I'll send over what I promised.",
      '[MOCK] Placeholder read - no model was called.',
      '[MOCK · discovery] How do you handle that today?', '[MOCK · demo] How does that compare to how you do it today?',
      "[MOCK · follow_up] What's changed on your side since we spoke?", '[MOCK · negotiation] How does that land for you?',
      "[MOCK · technical_deep_dive] At the end, what would you need to see to decide either way?", "[MOCK · negotiation] You've given the number: let them answer",
    ]
    for (const s of modes) for (const p of placeholders) expect(l1(s, p), `${s.id}: ${p}`).toEqual([])
  })

  it('every one passes Level 1 in Practice mode (the MOCK speed test)', async () => {
    for (const s of modes) {
      const r = await runScenario(s, new MockHelpModel(0), DEFAULT_HELP_CONFIG, playbook)
      expect(r.level1, s.id).toEqual({ pass: true, failures: [] })
      expect(r.call_type).toBe(s.call_type)
      expect(r.step_2 === true, s.id).toBe(s.tags?.includes('step_2') === true)
    }
  })
})

describe('speed test: the "By call type" table', () => {
  const res = (over: Partial<ScenarioResult>): ScenarioResult => ({
    scenario_id: 'x', category: 'call_mode', call_type: 'discovery', approved: false, model: 'm1', config_label: 'm1', status: 'complete',
    card: { move: 'clarify_current_state', primary_kind: 'ask', primary: 'How?', happening: null, follow_up: null, source_ids: [], note: null },
    raw: '', first_usable_ms: 1000, complete_ms: 1500, usage: null, level1: { pass: true, failures: [] }, move_ok: true, error: null, ...over,
  })
  const say = { move: 'technical_answer' as const, primary_kind: 'say' as const, primary: 'Yes.', happening: null, follow_up: null, source_ids: [], note: null }
  const hold = { move: 'no_move' as const, primary_kind: 'ask' as const, primary: 'How does that land?', happening: null, follow_up: null, source_ids: [], note: null }

  it('reads price-check failures from their words, never from a quoted forbidden pattern', () => {
    // The check's text (M5 plan 1.5) and the step-0 Level 1 failure both carry "not from approved pricing".
    for (const f of ["Price or discount not from approved pricing: don't say it.", 'states a price or discount not from approved pricing', 'price check: a discount NOT FROM APPROVED PRICING']) expect(isPriceCheckFailure(f), f).toBe(true)
    for (const f of ['matched forbidden pattern /not from approved pricing/', 'matched forbidden pattern /\\bpric(e|es|ing)\\b/', 'matched forbidden pattern /price/', 'Pricing figure not approved', 'invented figure: number not found in context: 40%', 'priceless', 'states an Arize capability ("we support") without citing an approved knowledge source']) expect(isPriceCheckFailure(f), f).toBe(false)
  })

  it('one row per call type and model, in the setup order, with the Ask / Say / Hold split and the price hits', () => {
    const rows = byCallType([
      res({ scenario_id: 'n1', call_type: 'negotiation', card: hold, first_usable_ms: 900 }),
      res({ scenario_id: 'n2', call_type: 'negotiation', card: say, level1: { pass: false, failures: ["Price or discount not from approved pricing: don't say it"] }, move_ok: false, first_usable_ms: 2000 }),
      res({ scenario_id: 'n2', call_type: 'negotiation', model: 'm2', first_usable_ms: 3000 }),
      res({ scenario_id: 'd1', call_type: 'discovery', first_usable_ms: 1200 }),
      res({ scenario_id: 'd2', call_type: 'discovery', approved: true, move_ok: false, level1: { pass: false, failures: ['matched forbidden pattern /\\bprice\\b/'] }, first_usable_ms: 800 }),
      res({ scenario_id: 'd2', call_type: 'discovery', card: null, status: 'failed', first_usable_ms: null, level1: { pass: false, failures: ['request failed'] }, move_ok: null }),
      res({ scenario_id: 'old', call_type: undefined }),
    ])
    expect(rows.map((r) => [r.call_type, r.model])).toEqual([['discovery', 'm1'], ['negotiation', 'm1'], ['negotiation', 'm2'], ['', 'm1']])
    const [disco, price] = rows
    expect(disco).toMatchObject({ scenarios: 2, runs: 3, ask: 2, say: 0, hold: 0, price_hits: 0, first_usable_median_ms: 800 })
    expect(disco.level1_pass_rate).toBeCloseTo(1 / 3)
    // Agreement is on the drafts only, as in the main table (the failed run counts as not agreeing).
    expect(disco.move_agreement).toBe(0.5)
    expect(price).toMatchObject({ scenarios: 2, runs: 2, ask: 0, say: 1, hold: 1, price_hits: 1, level1_pass_rate: 0.5, move_agreement: 0.5, first_usable_median_ms: 900 })
  })

  it('a step-2 moment counts in Level 1 and the timings, never in move agreement (here or in the main table)', () => {
    const rs = [res({ move_ok: true }), res({ scenario_id: 's2', step_2: true, move_ok: false, level1: { pass: false, failures: ['x'] }, first_usable_ms: 3000 })]
    const [row] = byCallType(rs)
    expect(row).toMatchObject({ scenarios: 2, runs: 2, level1_pass_rate: 0.5, move_agreement: 1, first_usable_median_ms: 1000 })
    expect(summarize('m1', rs)).toMatchObject({ runs: 2, level1_pass_rate: 0.5, draft_move_agreement: 1 })
    // Only step-2 moments: nothing to agree on yet.
    expect(byCallType([rs[1]])[0].move_agreement).toBeNull()
    expect(summarize('m1', [rs[1]]).draft_move_agreement).toBeNull()
  })

  // Activates once the price check (step 0) is merged: its real Level 1 failure lands in the Price check column.
  it.runIf('priceFigures' in protocol)('with the price check in, an offer with a figure counts as a price-check hit', () => {
    const failures = l1(byId('mode-price-01-discount-ask'), 'We can do 20% if you sign annually.', { move: 'handle_objection', primary_kind: 'say' })
    expect(failures.filter(isPriceCheckFailure)).toHaveLength(1)
    expect(byCallType([res({ call_type: 'negotiation', level1: { pass: false, failures } })])[0].price_hits).toBe(1)
  })

  it('your moments: agreement only where your rating judged the move; their own rows, marked as never picking the model', () => {
    const mine = byCallType([res({ move_ok: null }), res({ move_ok: true }), res({ move_ok: false })], true)
    expect(mine[0].move_agreement).toBe(0.5)
    expect(byCallType([res({ move_ok: null })], true)[0].move_agreement).toBeNull()
    const md = byCallTypeMarkdown([res({ call_type: 'negotiation' })], [res({ call_type: 'demo', model: 'm1' })])
    const lines = md.split('\n')
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l))
    expect(at(/^\| Pricing \| m1 \| 1 \| 100% \| 100% \| 1 \/ 0 \/ 0 \| 0 \| 1\.00 s \|$/)).toBeGreaterThan(0)
    expect(at(/^\| \*\*Your moments\*\* \(never pick the model\)/)).toBeGreaterThan(at(/^\| Pricing/))
    expect(at(/^\| Demo \| m1 \|/)).toBeGreaterThan(at(/Your moments/))
    // Without saved moments there's no such row; with no results at all the table still renders.
    expect(byCallTypeMarkdown([res({})])).not.toMatch(/Your moments/)
    expect(byCallTypeMarkdown([])).toMatch(/\| – \| – \| 0 \|/)
  })

  it('the report has the table after the speed tables and before the Level 1 failures; the other sections stay', async () => {
    const pick = [byId('mode-disco-02-fifteen-questions'), byId('mode-price-04-volume-recap'), byId('mode-price-02-keith-gave-number')]
    const report = await benchmark({ scenarios: pick, model: new MockHelpModel(0), configs: [DEFAULT_HELP_CONFIG, OPUS_HELP_CONFIG], playbook, repeats: 1 })
    const md = reportMarkdown(report)
    const at = (s: string) => md.indexOf(s)
    expect(at('## Speed by stage')).toBeGreaterThan(at('First usable p50'))
    expect(at('## By call type')).toBeGreaterThan(at('## Speed by stage'))
    expect(at('## Level 1 failures')).toBeGreaterThan(at('## By call type'))
    expect(md).toMatch(/\| Discovery \| claude-sonnet-5-5 \| 1 \| 100% \|/)
    expect(md).toMatch(/\| Pricing \| claude-opus-5-5 \| 2 \| 100% \|/)
    // Counts, rates and timings only: no scenario or card text in the table.
    const table = md.slice(at('## By call type'), at('## Level 1 failures'))
    expect(table).not.toMatch(/MOCK|traces a month|\$84/)
  })
})
