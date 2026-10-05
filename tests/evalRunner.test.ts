import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { HelpCardContent } from '../src/shared/help'
import {
  benchmark, compareBaseline, comparisonText, findCapabilityClaim, level1, percentile, reportMarkdown, summarize, toBaseline,
  type Baseline, type BaselineScenario, type ConfigSummary, type ScenarioResult,
} from '../src/main/help/evalRunner'
import { DEFAULT_HELP_CONFIG, MockHelpModel, OPUS_HELP_CONFIG } from '../src/main/help/models'
import { loadPlaybook } from '../src/main/help/prompt'
import type { Scenario } from '../src/main/help/replay'

const playbook = loadPlaybook(fileURLToPath(new URL('../config/playbook.json', import.meta.url)))

const s: Scenario = {
  id: 'neutral-ownership', category: 'neutral_discovery', golden_approved: false, call_type: 'discovery', call_goal: '', desired_outcomes: [],
  speakers: { 'e1:s0': { role: 'buyer', name: 'Dana' } },
  transcript: [{ t: 0, end: 9, who: 'e1:s0', text: 'The platform team owns evaluation and the applied team reviews samples each week.' }],
  help_at_s: 11, best_moves: ['clarify_current_state'], acceptable_moves: ['explore_process'], unacceptable_behaviors: [], forbid_regex: ['\\bdiscount'],
}

const card = (over: Partial<HelpCardContent>): HelpCardContent => ({
  move: 'clarify_current_state', primary_kind: 'ask', primary: 'How does that arrangement work in practice?', happening: 'They described team ownership.',
  follow_up: null, source_ids: ['T1'], note: null, ...over,
})
const kinds = new Map<string, 'turn' | 'knowledge'>([['T1', 'turn']])

describe('Level 1 (hard gate)', () => {
  it('a card may refer back to pain the buyer voiced on an earlier call', () => {
    const ask = 'Last time you mentioned latency problems in the eval pipeline, is that still the case?'
    const earlier = { ...s, earlier_calls: [{ kind: 'open' as const, text: 'Latency problems in their eval pipeline', date: '2026-09-28' }] }
    expect(level1(earlier, card({ primary: ask }), [], '', kinds)).toEqual([])
    // Without that earlier call it's still invented pain.
    expect(level1(s, card({ primary: ask }), [], '', kinds).join(' ')).toMatch(/assumed pain not voiced by the buyer: problems?/)
  })

  it('passes a neutral, supported card', () => {
    expect(level1(s, card({}), [], '<approved_knowledge>(none relevant)', kinds)).toEqual([])
  })

  it('fails invented pain on a neutral answer', () => {
    const f = level1(s, card({ primary: 'Sounds like that split is a real headache for you - how painful is it?' }), [], '', kinds)
    expect(f.join(' ')).toMatch(/assumed pain not voiced by the buyer: headache, painful/)
  })

  it('fails a technical answer with no approved source, and Arize claims with no knowledge', () => {
    expect(level1(s, card({ move: 'technical_answer' }), [], '', kinds).join(' ')).toMatch(/technical answer without an approved knowledge source/)
    expect(level1(s, card({ primary_kind: 'say', primary: 'Arize supports that out of the box with SSO.' }), [], '<approved_knowledge>(none relevant)', kinds).join(' ')).toMatch(/states an Arize capability/)
  })

  it('fails invented pain in any category, but not pain the transcript voiced', () => {
    const objection: Scenario = { ...s, id: 'objection-x', category: 'objection', transcript: [{ t: 0, end: 6, who: 'e1:s0', text: 'The other option is cheaper, that is the main thing.' }] }
    expect(level1(objection, card({ primary: 'Is the price gap a real problem for the team?' }), [], '', kinds).join(' ')).toMatch(/assumed pain not voiced by the buyer: problem/)
    const sources: Scenario = { ...s, id: 'sources-x', category: 'sources' }
    expect(level1(sources, card({ primary: 'How frustrating has that been?' }), [], '', kinds).join(' ')).toMatch(/assumed pain not voiced by the buyer: frustrating/)
    const voiced: Scenario = { ...objection, transcript: [{ t: 0, end: 6, who: 'e1:s0', text: 'Honestly the bigger problem is the review backlog.' }] }
    expect(level1(voiced, card({ primary: 'How big is that problem week to week?' }), [], '', kinds)).toEqual([])
  })

  it('an Arize capability claim must cite approved knowledge (K#); approved knowledge merely in context is not enough', () => {
    const withK = new Map<string, 'turn' | 'knowledge'>([['T1', 'turn'], ['K1', 'knowledge']])
    const ctx = '<approved_knowledge note="the ONLY material you may state as Arize fact">\n[K1] Tracing ...</approved_knowledge>'
    const claims = ['Arize supports OTLP export natively.', 'We have an OpenTelemetry-based tracer for that.', 'We offer SSO on every plan.', 'That is fully supported.', 'It supports OTLP out of the box.', 'Arize has that built in.']
    for (const primary of claims) {
      expect(level1(s, card({ primary_kind: 'say', primary, source_ids: ['T1'] }), [], ctx, withK).join(' '), primary).toMatch(/states an Arize capability .* without citing an approved knowledge source/)
      expect(level1(s, card({ primary_kind: 'say', primary, source_ids: ['T1', 'K1'] }), [], ctx, withK), primary).toEqual([])
    }
    // A K# that is not a knowledge source in this context does not count.
    expect(level1(s, card({ primary_kind: 'say', primary: 'We support that.', source_ids: ['K2'] }), [], ctx, withK).join(' ')).toMatch(/states an Arize capability/)
    // Also checked in the supporting lines, not just the primary, and a hedge in one field does not excuse another.
    expect(level1(s, card({ follow_up: 'Arize supports SSO too.' }), [], ctx, withK).join(' ')).toMatch(/states an Arize capability/)
    expect(level1(s, card({ primary: 'Let me confirm', follow_up: 'Arize supports SSO too' }), [], ctx, withK).join(' ')).toMatch(/states an Arize capability/)
    // Questions and time talk are not claims.
    for (const primary of ['Do we have time to cover the security piece?', 'Let me check what we offer for self-hosted and come back to you.', 'I want to confirm whether Arize supports that before I answer.', 'We have about ten minutes left; what matters most?', 'We have to wrap up soon, can we pick a next step?']) {
      expect(level1(s, card({ primary, source_ids: ['T1'] }), [], ctx, withK), primary).toEqual([])
    }
  })

  it('ordinary "we have", questions, hedges and negations are not capability claims', () => {
    const lines = [
      'We have a call with Priyanka next week; what should we cover?',
      'Now that we have the full picture, what would a sensible next step be?',
      'We have two options for how this could run',
      'Can we provide the questionnaire answers in parallel with the technical evaluation?',
      'Let me confirm we support that for self-hosted before I answer.',
      'I want to check whether that is supported on self-hosted before I answer.',
      "Arize can't confirm that for self-hosted yet",
      'Arize cannot say yet; I will find out.',
      'Which languages are supported in your stack today?',
      'Do you know if self-hosted is supported by your security team?',
      'Our platform team will want to see your trace volumes.',
      'We have a call next week',
      'Can we have 15 minutes with your security lead?',
      'Sounds like we have alignment on the pilot scope.',
      'Once we have the traces, we can compare runs.',
      // Questions that open with the helper verb, after a filler word or a "which/how" phrase.
      'So can we provide that in the pilot?',
      'Which of these would we support first, in your view?',
      'Which of these teams would we support first?',
      // A comma opener before the helper verb is still a question.
      'Got it, can we provide the questionnaire answers next week?',
      'On self-hosted, do we support SAML?',
      'Given your timeline, can we offer a two-week trial?',
      'Thanks for that. For your team, would we support both regions?',
    ]
    for (const primary of lines) {
      expect(findCapabilityClaim(primary), primary).toBeNull()
      expect(level1(s, card({ primary, source_ids: ['T1'] }), [], '', kinds), primary).toEqual([])
    }
  })

  it('catches capability claims in more forms, and a hedge only counts before the claim, in its clause', () => {
    const withK = new Map<string, 'turn' | 'knowledge'>([['T1', 'turn'], ['K1', 'knowledge']])
    const claims = [
      'We do support OTLP.',
      'Arize covers LLM and agent apps',
      'Our platform supports OTLP.',
      "Arize's tracing supports OTLP.",
      'Arize works with OpenTelemetry',
      'We have SSO on every plan.',
      'Arize can export spans over OTLP.',
      // A conditional or a later hedge does not take the claim back.
      'If you are on SaaS, we support that natively.',
      "Yes, we support that, but I'll confirm the version.",
      // A claim tucked into a question is still a claim.
      'Since we support OTLP, would that fit your pipeline?',
      // A hedge in an earlier clause does not take back a definite claim after it.
      'Let me check the details, but we support SAML SSO on SaaS.',
      "I'll confirm pricing later, but Arize supports SCIM provisioning today.",
      'Good that you ask - we support self-hosted on Kubernetes.',
      // "can" with a subject before it is not a question, even after a comma opener.
      'You can see we support SSO out of the box.',
      'Honestly, you can see we support SSO.',
    ]
    for (const primary of claims) {
      expect(findCapabilityClaim(primary), primary).not.toBeNull()
      expect(level1(s, card({ primary_kind: 'say', primary, source_ids: ['T1'] }), [], '', withK).join(' '), primary).toMatch(/states an Arize capability .* without citing an approved knowledge source/)
      expect(level1(s, card({ primary_kind: 'say', primary, source_ids: ['T1', 'K1'] }), [], '', withK), primary).toEqual([])
    }
  })

  it('idioms that use a pain word are not invented pain, in any category', () => {
    const objection: Scenario = { ...s, id: 'objection-x', category: 'objection', transcript: [{ t: 0, end: 6, who: 'e1:s0', text: 'We plan budgets in February.' }] }
    for (const primary of [
      "No problem, I'll send a short summary after the call.",
      'No problem. I will come back with a real range rather than guess.',
      'Would you want the usage broken down by team for the February plan?',
      "That's not a problem, we can take it step by step. What does February look like?",
      "I'll confirm when the current report was issued and send it over.",
    ]) {
      expect(level1(objection, card({ primary }), [], '', kinds), primary).toEqual([])
    }
    // The pain words themselves still count.
    expect(level1(objection, card({ primary: 'Is the budget timing a real problem for the team?' }), [], '', kinds).join(' ')).toMatch(/assumed pain not voiced by the buyer: problem/)
    expect(level1(objection, card({ primary: 'No problem. Is the current setup broken?' }), [], '', kinds).join(' ')).toMatch(/assumed pain not voiced by the buyer: broken/)
  })

  it('fails invented figures, unknown sources, forbidden patterns, missing card', () => {
    expect(level1(s, card({}), ['number not found in context: 40%'], '', kinds).join(' ')).toMatch(/invented figure/)
    expect(level1(s, card({}), ['unknown source ids removed: K9'], '', kinds).join(' ')).toMatch(/not in context/)
    expect(level1(s, card({ primary: 'We could look at a discount for you here.' }), [], '', kinds).join(' ')).toMatch(/forbidden pattern/)
    expect(level1(s, null, [], '', kinds)).toEqual(['no valid card (protocol/validation failed)'])
  })
})

describe('benchmark', () => {
  it('runs every scenario per config, reports latency percentiles, cost and gates', async () => {
    const report = await benchmark({ scenarios: [s, { ...s, id: 'second', golden_approved: true }], model: new MockHelpModel(5), configs: [DEFAULT_HELP_CONFIG, OPUS_HELP_CONFIG], playbook, repeats: 2 })
    expect(report.results).toHaveLength(8)
    // Grouped by model even though the mock labels both configs identically.
    expect(report.summaries.map((x) => [x.model, x.runs])).toEqual([['claude-sonnet-5-5', 4], ['claude-opus-5-5', 4]])
    const sum = report.summaries[0]
    expect(sum.first_usable_median_ms).not.toBeNull()
    expect(report.approved_scenarios).toBe(1)
    expect(reportMarkdown(report)).toMatch(/First usable p50/)
  })

  it('summaries treat a fast but Level-1-failing card as not usable', () => {
    const base: ScenarioResult = {
      scenario_id: 'x', category: 'c', approved: false, model: 'm', config_label: 'm', status: 'complete', card: null, raw: '', first_usable_ms: 900, complete_ms: 1200,
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.002 },
      level1: { pass: true, failures: [] }, move_ok: true, error: null,
    }
    const sum = summarize('m', [base, { ...base, level1: { pass: false, failures: ['x'] } }, { ...base, first_usable_ms: 2600 }, { ...base, status: 'timeout', first_usable_ms: null, complete_ms: null }])
    expect(sum.usable_within_2s).toBe(0.25)
    expect(sum.usable_within_3s).toBe(0.5)
    expect(sum.timeouts).toBe(1)
    expect(sum.cost_per_request_usd).toBeCloseTo(0.002)
  })

  it('percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    expect(percentile([], 50)).toBeNull()
  })
})

describe('baseline compare', () => {
  const sum = (over: Partial<ConfigSummary> = {}): ConfigSummary => ({
    config_label: 'm', model: 'm', runs: 3, first_usable_median_ms: 900, first_usable_p95_ms: 1500, complete_median_ms: 1800, complete_p95_ms: 2500,
    usable_within_2s: 1, usable_within_3s: 1, timeouts: 0, failures: 0, level1_pass_rate: 1, approved_move_agreement: null, draft_move_agreement: 1,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, cost_per_request_usd: 0, ...over,
  })
  const sc = (over: Partial<BaselineScenario> = {}): BaselineScenario => ({
    approved: false, move: 'clarify_current_state', move_ok: true, level1_pass: true, level1_failures: [], first_usable_ms: 900, complete_ms: 1800, ...over,
  })
  const base = (scenarios: Record<string, BaselineScenario>, summary = sum()): Baseline => ({
    created_at: '2026-10-01T00:00:00Z', playbook_version: 'p1', repeats: 1, mock: false, models: { m: { summary, scenarios } },
  })

  it('no regressions when nothing got worse (and a fix is not a regression)', () => {
    const before = base({ a: sc(), b: sc({ level1_pass: false, level1_failures: ['x'] }) })
    const after = base({ a: sc({ first_usable_ms: 1080 }), b: sc() }) // +20% exactly is within tolerance
    const c = compareBaseline(before, after)
    expect(c.regressions).toEqual([])
    expect(comparisonText(c)).toMatch(/No regressions/)
  })

  it('flags Level 1 pass -> fail, but not fail -> fail', () => {
    const before = base({ a: sc(), b: sc({ level1_pass: false }) })
    const after = base({ a: sc({ level1_pass: false, level1_failures: ['matched forbidden pattern /x/'] }), b: sc({ level1_pass: false }) })
    const c = compareBaseline(before, after)
    expect(c.regressions).toEqual([{ model: 'm', kind: 'level1', scenario_id: 'a', detail: 'passed Level 1 before, fails now: matched forbidden pattern /x/' }])
  })

  it('flags move agreement drops on shared scenarios, split approved / drafts, listing the scenarios that flipped', () => {
    const before = base({ a: sc({ approved: true }), b: sc({ approved: true }), c: sc(), d: sc(), e: sc({ move_ok: false }) })
    const after = base({
      a: sc({ approved: true, move: 'handle_objection', move_ok: false }), b: sc({ approved: true }),
      c: sc({ move: null, move_ok: null }), d: sc({ move: 'pitch', move_ok: false }), e: sc({ move_ok: false }),
    })
    const c = compareBaseline(before, after)
    expect(c.regressions.map((r) => [r.kind, r.scenario_id, r.detail])).toEqual([
      ['move_agreement', null, 'approved move agreement 100% -> 50% on 2 shared scenario(s); right -> wrong: a (clarify_current_state -> handle_objection)'],
      ['move_agreement', null, 'draft move agreement 67% -> 0% on 3 shared scenario(s); right -> wrong: c (clarify_current_state -> none), d (clarify_current_state -> pitch)'],
    ])
  })

  it('flips that cancel out are not a regression (agreement did not drop)', () => {
    const before = base({ a: sc({ move_ok: true }), b: sc({ move: 'pitch', move_ok: false }) })
    const after = base({ a: sc({ move: 'pitch', move_ok: false }), b: sc({ move_ok: true }) })
    const c = compareBaseline(before, after)
    expect(c.regressions).toEqual([])
  })

  it('a scenario that goes from a valid card to no card is reported once, as Level 1', () => {
    const before = base({ a: sc(), b: sc(), c: sc() })
    const after = base({ a: sc({ move: null, move_ok: null, level1_pass: false, level1_failures: ['no valid card (protocol/validation failed)'] }), b: sc({ move: null, move_ok: null }), c: sc({ move: null, move_ok: null }) })
    // Agreement falls too, so it is one Level 1 line for a plus one agreement line for the set, not a per-scenario move line.
    expect(compareBaseline(before, after).regressions.map((r) => [r.kind, r.scenario_id])).toEqual([['level1', 'a'], ['move_agreement', null]])
    const single = compareBaseline(base({ a: sc(), b: sc({ move_ok: false }) }), base({ a: sc({ move: null, move_ok: null, level1_pass: false }), b: sc({ move_ok: true }) }))
    expect(single.regressions.map((r) => [r.kind, r.scenario_id])).toEqual([['level1', 'a']])
  })

  it('a bigger scenario set is not a drop: only shared scenarios are compared, the rest are noted', () => {
    const before = base({ a: sc() })
    const after = base({ a: sc(), n1: sc({ move_ok: false, level1_pass: false }), n2: sc({ move_ok: false }) })
    const c = compareBaseline(before, after)
    expect(c.regressions).toEqual([])
    expect(c.notes.join(' ')).toMatch(/2 scenario\(s\) not in the baseline \(not compared\): n1, n2/)
  })

  it('flags p95 latency increases over 20% across the shared scenarios, for first usable and full card', () => {
    const before = base({ a: sc({ first_usable_ms: 1500, complete_ms: 2500 }), b: sc({ first_usable_ms: 800, complete_ms: 1500 }) })
    const after = base({ a: sc({ first_usable_ms: 1801, complete_ms: 4000 }), b: sc({ first_usable_ms: 800, complete_ms: 1500 }) })
    expect(compareBaseline(before, after).regressions.map((r) => [r.kind, r.detail])).toEqual([
      ['latency', 'first usable p95 over 2 shared scenario(s) 1500 ms -> 1801 ms (+20%, limit +20%)'],
      ['latency', 'full card p95 over 2 shared scenario(s) 2500 ms -> 4000 ms (+60%, limit +20%)'],
    ])
    // Nothing usable on one side, or a baseline written before complete_ms existed: not compared.
    expect(compareBaseline(base({ a: sc({ complete_ms: undefined }) }), base({ a: sc({ first_usable_ms: null, complete_ms: 9000 }) })).regressions).toEqual([])
  })

  it('latency ignores scenarios on one side only and the whole-set summary p95', () => {
    const before = base({ a: sc({ first_usable_ms: 1000 }) }, sum({ first_usable_p95_ms: 1000 }))
    // A slow new scenario pushes the run's summary p95 up, but it is not in the baseline.
    const after = base({ a: sc({ first_usable_ms: 1000 }), slow: sc({ first_usable_ms: 5000, complete_ms: 9000 }) }, sum({ first_usable_p95_ms: 5000, complete_p95_ms: 9000 }))
    const c = compareBaseline(before, after)
    expect(c.regressions).toEqual([])
    expect(c.notes.join(' ')).toMatch(/1 scenario\(s\) not in the baseline \(not compared\): slow/)
  })

  it('models on one side only are notes, not regressions', () => {
    const before = base({ a: sc() })
    const after: Baseline = { ...base({ a: sc() }), models: { other: { summary: sum({ model: 'other' }), scenarios: { a: sc({ level1_pass: false }) } } } }
    const c = compareBaseline(before, after)
    expect(c.regressions).toEqual([])
    expect(c.notes.join('\n')).toMatch(/m: in the baseline, not in this run[\s\S]*other: not in the baseline/)
  })

  it('MOCK timings are never compared (offline noise), but Level 1 and moves still are', () => {
    const before: Baseline = { ...base({ a: sc() }), mock: true }
    const after: Baseline = { ...base({ a: sc({ level1_pass: false, first_usable_ms: 9000 }) }), mock: true }
    const c = compareBaseline(before, after)
    expect(c.regressions.map((r) => r.kind)).toEqual(['level1'])
    expect(c.notes.join(' ')).toMatch(/MOCK baseline vs MOCK run: latency not compared/)
  })

  it('toBaseline folds repeats: most common move, Level 1 only if every run passed, median first usable', async () => {
    const report = await benchmark({ scenarios: [s], model: new MockHelpModel(5), configs: [DEFAULT_HELP_CONFIG], playbook, repeats: 3 })
    report.results[0] = { ...report.results[0], first_usable_ms: 900, complete_ms: 1500 }
    report.results[1] = { ...report.results[1], level1: { pass: false, failures: ['x'] }, first_usable_ms: 5000, complete_ms: null }
    report.results[2] = { ...report.results[2], first_usable_ms: 1, complete_ms: 1700 }
    const b = toBaseline(report, true)
    const entry = b.models['claude-sonnet-5-5'].scenarios['neutral-ownership']
    expect(entry.move).toBe('clarify_current_state')
    expect(entry.move_ok).toBe(true)
    expect(entry.level1_pass).toBe(false)
    expect(entry.level1_failures).toEqual(['x'])
    expect(entry.first_usable_ms).toBe(900)
    expect(entry.complete_ms).toBe(1500) // median of the completed runs (1500, 1700)
    expect(b.mock).toBe(true)
    expect(b.models['claude-sonnet-5-5'].summary.runs).toBe(3)
    // A run compared with its own baseline has no regressions.
    expect(compareBaseline(b, b).regressions).toEqual([])
  })
})
