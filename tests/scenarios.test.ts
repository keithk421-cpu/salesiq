import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { level1, loadScenarios } from '../src/main/help/evalRunner'
import { buildHelpContext } from '../src/main/help/context'
import { replayAt } from '../src/main/help/replay'

const scenarios = loadScenarios(fileURLToPath(new URL('../evals/scenarios/help', import.meta.url)))

describe('HELP scenario set', () => {
  it('has the 25 M1 drafts, none approved by anyone but Keith', () => {
    expect(scenarios).toHaveLength(25)
    // Only Keith flips this. If this fails after his review, update the expected count here.
    expect(scenarios.filter((s) => s.golden_approved)).toHaveLength(0)
  })

  for (const s of scenarios) {
    it(`${s.id}: replays without leaking the future, and Level 1 accepts its example good lines`, () => {
      const r = replayAt(s)
      const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
      expect(r.hiddenLineIndexes).toEqual([]) // the decision point is after everything was available
      expect(ctx.text).toContain('<last_30_seconds>')
      const kinds = new Map([...ctx.sources.entries()].map(([k, v]) => [k, v.kind]))
      for (const q of s.acceptable_questions ?? []) {
        const card = { move: s.best_moves[0] as never, primary_kind: 'ask' as const, primary: q, happening: null, follow_up: null, source_ids: [], note: null }
        const f = level1(s, card, [], ctx.text, kinds).filter((x) => !x.startsWith('technical answer without'))
        expect(f, `false Level 1 failure on a good line: "${q}"`).toEqual([])
      }
    })
  }
})
