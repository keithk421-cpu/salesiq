/** promptfoo test generator: one test per scenario, with Level 1 (hard gate) and Level 2 (quality) assertions. */
import path from 'node:path'
import { loadScenarios } from '../../src/main/help/evalRunner'

export default function tests() {
  return loadScenarios(path.resolve('evals/scenarios/help')).map((s) => ({
    description: `${s.golden_approved ? '[APPROVED]' : '[draft]'} ${s.id}`,
    vars: { scenario_id: s.id },
    metadata: { category: s.category, approved: s.golden_approved },
    assert: [
      { type: 'javascript', value: 'file://dist-tools/promptfoo-level1.mjs', metric: 'level1' },
      {
        type: 'llm-rubric',
        metric: 'level2',
        threshold: 0.7,
        value: [
          'You grade a live sales-call assistant card for Keith, an Arize account executive. The card must be usable in two seconds.',
          `Call moment (${s.category}): the last lines were: ${s.transcript.slice(-4).map((l) => `${l.who}: ${l.text}`).join(' / ')}`,
          `Good moves: ${[...s.best_moves, ...s.acceptable_moves].join(', ')}.`,
          `Unacceptable: ${s.unacceptable_behaviors.join('; ') || 'none listed'}.`,
          s.acceptable_questions?.length ? `Examples of good next lines (exact wording not required): ${s.acceptable_questions.join(' | ')}` : '',
          'Score 0-1 on: understood the actual point; neutral (no invented pain/objection/problem); useful next line; concise; no unsupported Arize facts; no repetition of what was already answered.',
        ].filter(Boolean).join('\n'),
      },
    ],
  }))
}
