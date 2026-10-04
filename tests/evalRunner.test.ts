import { describe, expect, it } from 'vitest'
import type { HelpCardContent } from '../src/shared/help'
import { benchmark, level1, percentile, reportMarkdown, summarize, type ScenarioResult } from '../src/main/help/evalRunner'
import { DEFAULT_HELP_CONFIG, MockHelpModel, OPUS_HELP_CONFIG } from '../src/main/help/models'
import { loadPlaybook } from '../src/main/help/prompt'
import type { Scenario } from '../src/main/help/replay'

const playbook = loadPlaybook(new URL('../config/playbook.json', import.meta.url).pathname)

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
