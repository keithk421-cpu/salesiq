import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { level1, loadScenarios } from '../src/main/help/evalRunner'
import { buildHelpContext } from '../src/main/help/context'
import { FINAL_DELAY_MS, replayAt } from '../src/main/help/replay'
import { cleanPressDetail, cleanPressMode, decidePress } from '../src/main/help/pressModes'

const scenarios = loadScenarios(fileURLToPath(new URL('../evals/scenarios/help', import.meta.url)))

describe('HELP scenario set', () => {
  it('has the M1 drafts (25 + 8 from the knowledge review + 10 practice moments + 2 with Keith\'s notes + 23 call modes), none approved by anyone but Keith', () => {
    expect(scenarios).toHaveLength(68)
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

  it('each replays the press Keith would get live (WRAP, closing words, a buying signal, the opening), as stored', () => {
    for (const s of scenarios) {
      const mode = cleanPressMode(s.press_mode)
      // Another angle and a must-learn click need a card on screen or a click: not something a replay re-detects.
      if (mode === 'another_angle' || mode === 'plan_item') continue
      const r = replayAt(s)
      const d = decidePress(s.wrap === 'button' ? 'wrap_requested' : 'help_requested', r.memory, r.atMs)
      expect({ wrap: d.wrap, mode: d.mode }, s.id).toEqual({ wrap: s.wrap ?? null, mode })
      expect(d.detail, s.id).toMatchObject(cleanPressDetail(s.press_detail))
    }
  })

  for (const s of scenarios) {
    it(`${s.id}: replays without leaking the future, and Level 1 accepts its example good lines`, () => {
      const r = replayAt(s)
      const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
      // The decision point is after everything was available, except in a scenario tagged live_words (M5:
      // the SA mid-screen, a buyer mid-reaction): the last line of a stream, still being spoken at the
      // press, which HELP sees only as its first words, live. A typo'd "end" can't hide a line anywhere else.
      if (!s.tags?.includes('live_words')) expect(r.hiddenLineIndexes, 'a line not yet available at the press').toEqual([])
      const streamOf = (i: number) => (s.transcript[i].who === 'keith' ? 'keith' : 'meeting')
      const live = ctx.text.slice(Math.max(0, ctx.text.indexOf('(still being transcribed')))
      for (const i of r.hiddenLineIndexes) {
        const l = s.transcript[i]
        expect(l.t, `line ${i} started early enough to be heard`).toBeLessThan(s.help_at_s - FINAL_DELAY_MS / 1000)
        expect(s.transcript.slice(i + 1).some((_, j) => streamOf(i + 1 + j) === streamOf(i)), `line ${i} is the last of its stream`).toBe(false)
        expect(live, `line ${i} shows as live words`).toContain(l.text.split(/\s+/).slice(0, 3).join(' '))
      }
      expect(ctx.text).toContain('<last_30_seconds>')
      const kinds = new Map([...ctx.sources.entries()].map(([k, v]) => [k, v.kind]))
      // Where the best move is to answer from knowledge, a good line states approved knowledge and
      // would cite it, so the example cites the approved K# ids in context. Elsewhere it cites nothing.
      const answersFromKnowledge = s.best_moves.some((m) => m === 'technical_answer' || m === 'handle_competitor')
      const cites = answersFromKnowledge ? [...ctx.sources.entries()].filter(([, v]) => v.kind === 'knowledge').map(([k]) => k) : []
      for (const q of s.acceptable_questions ?? []) {
        const card = { move: s.best_moves[0] as never, primary_kind: 'ask' as const, primary: q, happening: null, follow_up: null, source_ids: cites, note: null }
        const f = level1(s, card, [], ctx.text, kinds).filter((x) => !x.startsWith('technical answer without'))
        expect(f, `false Level 1 failure on a good line: "${q}"`).toEqual([])
      }
    })
  }
})
