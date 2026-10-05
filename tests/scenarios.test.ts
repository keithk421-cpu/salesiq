import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { level1, loadScenarios } from '../src/main/help/evalRunner'
import { buildHelpContext } from '../src/main/help/context'
import { replayAt } from '../src/main/help/replay'

const scenarios = loadScenarios(fileURLToPath(new URL('../evals/scenarios/help', import.meta.url)))

describe('HELP scenario set', () => {
  it('has the M1 drafts (25 + 8 from the knowledge review + 10 practice moments), none approved by anyone but Keith', () => {
    expect(scenarios).toHaveLength(43)
    // Only Keith flips this. If this fails after his review, update the expected count here.
    expect(scenarios.filter((s) => s.golden_approved)).toHaveLength(0)
    // The repo is public: every scenario is made up.
    expect(scenarios.filter((s) => s.synthetic !== true).map((s) => s.id)).toEqual([])
  })

  it('every forbid_regex compiles (an invalid one would be silently skipped by Level 1)', () => {
    for (const s of scenarios) {
      for (const r of s.forbid_regex ?? []) expect(() => new RegExp(r, 'i'), `${s.id}: /${r}/`).not.toThrow()
    }
  })

  it('held material and other-deployment facts never reach the model as approved knowledge', () => {
    const ctxOf = (id: string) => {
      const r = replayAt(scenarios.find((x) => x.id === id)!)
      return buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs }).text
    }
    expect(ctxOf('sources-02-customer-reference-awaiting-clearance')).not.toContain('Northfield')
    const selfHosted = ctxOf('sources-03-saas-only-feature-self-hosted-buyer')
    expect(selfHosted).not.toContain('every 6 hours')
    expect(selfHosted).toContain('<other_deployment>')
    expect(ctxOf('sources-04-saas-only-feature-unknown-deployment')).toMatch(/applies to: Arize's SaaS; version fixture\): Automatic issue detection runs/)
    // A SaaS-only certification is not offered as fact to a self-hosted buyer.
    const soc2 = ctxOf('sources-08-soc2-saas-only-self-hosted-buyer')
    expect(soc2).toContain('<other_deployment>')
    expect(soc2).toContain('"SOC 2 report (SaaS)" covers')
    expect(soc2).not.toContain('Type II')
    expect(soc2).not.toContain('NDA')
    // An unapproved draft pilot outline never reaches the model; nothing else is approved either.
    const poc = ctxOf('technical-04-poc-shape-no-approved-source')
    expect(poc).not.toMatch(/30 days|free of charge|success plan/)
    expect(poc).toContain('<approved_knowledge>(none relevant)')
    expect(ctxOf('sources-05-pricing-ask-no-pricing-source')).toContain('<approved_knowledge>(none relevant)')
    expect(ctxOf('sources-06-references-requested-none-approved')).toContain('<approved_knowledge>(none relevant)')
  })

  it('the acquisition question sees the public fact, and only that, as approved knowledge', () => {
    const r = replayAt(scenarios.find((x) => x.id === 'sources-07-acquisition-question-public-fact-only')!)
    const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
    expect(ctx.text).toMatch(/\[K1\] Acquisition announcement \(public\).*applies to: all deployments.*Dynatrace completed its acquisition of Arize on October 1, 2026 and said Arize will continue supporting Phoenix and Arize AX\./)
    expect(ctx.text).not.toContain('[K2]')
    expect(ctx.sources.get('K1')?.kind).toBe('knowledge')
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
