/**
 * HELP evaluation + latency benchmark (shared by the in-app benchmark, CLI and promptfoo).
 *
 * Per scenario: replay exactly as of the HELP time -> one HELP request -> Level 1 checks
 * (hard gate, deterministic) -> timing/tokens/cost. Level 3 (move agreement) is reported
 * for Keith-approved scenarios only; drafts are reported separately and never gate.
 * Level 2 (quality) is graded in promptfoo (evals/promptfooconfig.yaml).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { HelpCardContent, HelpModelConfig, HelpUsage } from '../../shared/help'
import { cleanEarlierItems } from './accountMemory'
import { buildHelpContext } from './context'
import type { HelpModel } from './models'
import { findApprovedPassage } from './passage'
import { buildSystemPrompt, type Playbook } from './prompt'
import { LineProtocolParser, findCapabilityClaim, validateCard } from './protocol'
import { replayAt, type Scenario } from './replay'
import { cleanPressDetail, cleanPressMode, pressUserMessage } from './pressModes'
import { keithNotesChecks } from './keithNotes'
import { byCallTypeMarkdown } from './evalByType'

export { findCapabilityClaim }

export interface ScenarioResult {
  scenario_id: string
  category: string
  /** M5: the call type the scenario was set up with, for the "By call type" table (absent in older results). */
  call_type?: string
  /**
   * M5: a moment judged only once step 2 (the SA-aware demo cards) ships: left out of move agreement
   * until then, since a v1 card can't make that move (still in Level 1 and the timings).
   */
  step_2?: boolean
  approved: boolean
  /** Model id of the config that produced this result (grouping key). */
  model: string
  config_label: string
  status: 'complete' | 'failed' | 'timeout'
  card: HelpCardContent | null
  raw: string
  first_usable_ms: number | null
  complete_ms: number | null
  /** Stages, all from the press: the approved passage on screen (null: none shown), Claude's first byte. */
  passage_ms?: number | null
  first_token_ms?: number | null
  /** Building the context, and the knowledge search inside it (ms). */
  context_ms?: number
  knowledge_ms?: number
  /** The approved passage shown at the press (section heading), and whether the card cited it. */
  passage?: { title: string; heading: string; cited: boolean } | null
  usage: HelpUsage | null
  level1: { pass: boolean; failures: string[] }
  /** Level 3 signal: move in best/acceptable. Only gates when the scenario is approved. */
  move_ok: boolean | null
  error: string | null
}

const PAIN_WORDS = /\b(pain|painful|frustrat\w*|struggl\w*|headache\w*|broken|bottleneck\w*|nightmare|problem\w*|issue\w*|challenge\w*)\b/gi
/** Everyday phrases that use a pain word without claiming pain; removed before PAIN_WORDS is matched. */
const NOT_PAIN = /\bno (?:problem|issue)s?\b|\b(?:that'?s|that is|it'?s|it is) not an? (?:problem|issue)\b|\bbroken (?:down|out|up|into)\b|\bissu(?:ed|ing)\b/gi

export function loadScenarios(dir: string): Scenario[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Scenario)
}

/**
 * Level 1 correctness - hard gate. Deterministic, no model needed.
 * Knowledge-backed statements are judged by the card's cited sources (sourceKinds), not by what
 * happened to be in context; the context text parameter is kept for callers' signatures.
 */
export function level1(s: Scenario, card: HelpCardContent | null, issues: string[], _contextText: string, sourceKinds: Map<string, 'turn' | 'knowledge'>): string[] {
  const f: string[] = []
  if (!card) return ['no valid card (protocol/validation failed)']
  for (const i of issues) {
    if (i.startsWith('number not found')) f.push(`invented figure: ${i}`)
    if (i.startsWith('unknown source ids')) f.push(`cited sources that were not in context: ${i}`)
    if (i === 'MOVE was not selected first') f.push('move not selected before wording')
  }
  const visible = [card.primary, card.happening ?? '', card.follow_up ?? ''].join(' ')
  for (const r of s.forbid_regex ?? []) {
    try {
      if (new RegExp(r, 'i').test(visible)) f.push(`matched forbidden pattern /${r}/`)
    } catch {
      /* invalid regex in a draft scenario: ignore */
    }
  }
  const citesKnowledge = card.source_ids.some((id) => sourceKinds.get(id) === 'knowledge')
  if (card.move === 'technical_answer' && !citesKnowledge) {
    f.push('technical answer without an approved knowledge source')
  }
  // Any category: pain, frustration or problems the transcript never voiced are invented.
  // Idioms such as "no problem" or "broken down by team" are not pain.
  // Pain the buyer voiced on an earlier call (<earlier_calls>) may be referred back to as a past statement.
  const transcript = [...s.transcript.map((l) => l.text), ...cleanEarlierItems(s.earlier_calls).map((i) => i.text)].join(' ').toLowerCase()
  const invented = (visible.replace(NOT_PAIN, ' ').match(PAIN_WORDS) ?? []).filter((w) => !transcript.includes(w.toLowerCase()))
  if (invented.length) f.push(`assumed pain not voiced by the buyer: ${[...new Set(invented.map((w) => w.toLowerCase()))].join(', ')}`)
  // Approved knowledge merely being in context is not enough: the claim must cite it.
  // Each field is checked on its own so a hedge in one field never excuses a claim in another.
  const claim = citesKnowledge ? null : [card.primary, card.happening ?? '', card.follow_up ?? ''].map(findCapabilityClaim).find((c) => c !== null) ?? null
  if (claim) f.push(`states an Arize capability ("${claim}") without citing an approved knowledge source`)
  // Keith's notes (M4) are never something they said: "you mentioned X" when only his notes have X.
  f.push(...keithNotesChecks(card, _contextText).map(() => "says they told Keith something only his notes say"))
  return f
}

export async function runScenario(s: Scenario, model: HelpModel, config: HelpModelConfig, playbook: Playbook, now = new Date()): Promise<ScenarioResult> {
  const r = replayAt(s)
  // The press: as in the engine, the approved passage is found and the context built before the first card goes out.
  const t0 = performance.now()
  const passage = findApprovedPassage({ kb: r.kb, memory: r.memory, atMs: r.atMs, today: now })
  const c0 = performance.now()
  const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs, now })
  const shownAt = performance.now()
  const parser = new LineProtocolParser()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('timeout')), config.timeout_ms)
  let raw = ''
  let firstTokenAt = null as number | null
  let usage: HelpUsage | null = null
  let error: string | null = null
  let status: ScenarioResult['status'] = 'complete'
  try {
    const res = await model.run({
      // A moment saved from a WRAP or smarter press replays with the instruction it had (stored, not re-detected).
      system: buildSystemPrompt(playbook), user: pressUserMessage(ctx.text, s.wrap === 'button' || s.wrap === 'closing' ? s.wrap : null, cleanPressMode(s.press_mode), cleanPressDetail(s.press_detail)), config, signal: abort.signal,
      onText: (c) => { firstTokenAt ??= performance.now(); raw += c; parser.feed(c) },
    })
    usage = res.usage
    if (res.stop_reason === 'refusal') throw new Error('refusal')
  } catch (err) {
    status = abort.signal.aborted ? 'timeout' : 'failed'
    error = (err as Error).message
  } finally {
    clearTimeout(timer)
  }
  const completeAt = performance.now()
  parser.end()
  const v = validateCard(parser.partial(), parser.fieldOrder, { knownSourceIds: new Set(ctx.sources.keys()), contextText: ctx.text, limits: playbook.card_limits })
  if (status === 'complete' && !v.ok) status = 'failed'
  const kinds = new Map([...ctx.sources.entries()].map(([k, v2]) => [k, v2.kind]))
  const failures = status === 'complete' ? level1(s, v.card, v.issues, ctx.text, kinds) : [`request ${status}${error ? `: ${error}` : ''}`]
  const move = v.card?.move
  const cited = !!passage && status === 'complete' && !!v.card?.source_ids.some((id) => {
    const src = ctx.sources.get(id)
    return src?.kind === 'knowledge' && passage.chunk_ids.includes(src.id)
  })
  return {
    scenario_id: s.id,
    category: s.category,
    call_type: s.call_type,
    ...(Array.isArray(s.tags) && s.tags.includes('step_2') ? { step_2: true } : {}),
    approved: s.golden_approved === true,
    model: config.model,
    config_label: model.label(config),
    status,
    card: v.card,
    raw,
    first_usable_ms: parser.firstUsableAt === null ? null : Math.round(parser.firstUsableAt - t0),
    complete_ms: status === 'complete' ? Math.round(completeAt - t0) : null,
    passage_ms: passage ? Math.round(shownAt - t0) : null,
    first_token_ms: firstTokenAt === null ? null : Math.round(firstTokenAt - t0),
    context_ms: Math.round(shownAt - c0),
    knowledge_ms: ctx.knowledge_ms,
    passage: passage ? { title: passage.title, heading: passage.heading, cited } : null,
    usage,
    level1: { pass: failures.length === 0, failures },
    move_ok: moveOk(s, move),
    error,
  }
}

/** A saved moment replay threw on (a hand-edited file): a failed result, so the run goes on. */
function unreplayable(s: Scenario, model: HelpModel, config: HelpModelConfig, err: unknown): ScenarioResult {
  return {
    scenario_id: typeof s.id === 'string' ? s.id : '?', category: typeof s.category === 'string' ? s.category : 'real_call', approved: false,
    ...(typeof s.call_type === 'string' ? { call_type: s.call_type } : {}),
    model: config.model, config_label: model.label(config), status: 'failed', card: null, raw: '', first_usable_ms: null, complete_ms: null, usage: null,
    level1: { pass: false, failures: [`could not replay: ${(err as Error)?.message ?? String(err)}`] }, move_ok: null, error: (err as Error)?.message ?? String(err),
  }
}

/**
 * Level 3 signal for one card. Built-in scenarios list every good move, so any other move disagrees.
 * A moment saved from a real call knows only what Keith's feedback said about the move HELP gave
 * then (fine, or wrong): other moves aren't judged until someone adds its best moves.
 */
export function moveOk(s: Scenario, move: string | undefined): boolean | null {
  if (!move) return null
  if (s.unacceptable_moves?.includes(move)) return false
  const ok = [...s.best_moves, ...s.acceptable_moves]
  if (ok.includes(move)) return true
  return s.best_moves.length === 0 && (s.source === 'real_call' || ok.length === 0) ? null : false
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}

export interface ConfigSummary {
  config_label: string
  model: string
  runs: number
  first_usable_median_ms: number | null
  first_usable_p95_ms: number | null
  complete_median_ms: number | null
  complete_p95_ms: number | null
  /**
   * Stages from the press: share of runs that showed an approved passage, and when; Claude's first
   * byte; context build and knowledge search. Absent in baselines saved before they were measured.
   */
  passage_shown_rate?: number
  passage_median_ms?: number | null
  first_token_median_ms?: number | null
  first_token_p95_ms?: number | null
  context_median_ms?: number | null
  knowledge_median_ms?: number | null
  /** Share of runs that showed a passage whose card then cited it. */
  passage_cited_rate?: number | null
  /** Share of runs with usable guidance within the 2 s and 3 s targets. */
  usable_within_2s: number
  usable_within_3s: number
  timeouts: number
  failures: number
  level1_pass_rate: number
  approved_move_agreement: number | null
  draft_move_agreement: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cost_usd: number
  cost_per_request_usd: number
}

export function summarize(model: string, results: ScenarioResult[]): ConfigSummary {
  const fu = results.map((r) => r.first_usable_ms).filter((x): x is number => x !== null)
  const cm = results.map((r) => r.complete_ms).filter((x): x is number => x !== null)
  const n = results.length || 1
  const usage = results.map((r) => r.usage).filter((u): u is HelpUsage => !!u)
  const sum = (k: keyof HelpUsage) => usage.reduce((a, u) => a + (u[k] as number), 0)
  // A step-2 moment (M5) can't agree until step 2 ships: it counts in everything but agreement.
  const agree = (all: ScenarioResult[], rs = all.filter((r) => !r.step_2)) => (rs.length ? rs.filter((r) => r.move_ok).length / rs.length : null)
  const nums = (k: 'passage_ms' | 'first_token_ms' | 'context_ms' | 'knowledge_ms') => results.map((r) => r[k]).filter((x): x is number => typeof x === 'number')
  const withPassage = results.filter((r) => r.passage)
  return {
    config_label: results[0]?.config_label ?? model,
    model,
    runs: results.length,
    first_usable_median_ms: percentile(fu, 50),
    first_usable_p95_ms: percentile(fu, 95),
    complete_median_ms: percentile(cm, 50),
    complete_p95_ms: percentile(cm, 95),
    passage_shown_rate: withPassage.length / n,
    passage_median_ms: percentile(nums('passage_ms'), 50),
    first_token_median_ms: percentile(nums('first_token_ms'), 50),
    first_token_p95_ms: percentile(nums('first_token_ms'), 95),
    context_median_ms: percentile(nums('context_ms'), 50),
    knowledge_median_ms: percentile(nums('knowledge_ms'), 50),
    passage_cited_rate: withPassage.length ? withPassage.filter((r) => r.passage!.cited).length / withPassage.length : null,
    usable_within_2s: results.filter((r) => r.first_usable_ms !== null && r.first_usable_ms <= 2000 && r.level1.pass).length / n,
    usable_within_3s: results.filter((r) => r.first_usable_ms !== null && r.first_usable_ms <= 3000 && r.level1.pass).length / n,
    timeouts: results.filter((r) => r.status === 'timeout').length,
    failures: results.filter((r) => r.status === 'failed').length,
    level1_pass_rate: results.filter((r) => r.level1.pass).length / n,
    approved_move_agreement: agree(results.filter((r) => r.approved)),
    draft_move_agreement: agree(results.filter((r) => !r.approved)),
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cache_read_tokens: sum('cache_read_input_tokens'),
    cost_usd: Number(sum('cost_usd').toFixed(4)),
    cost_per_request_usd: Number((sum('cost_usd') / n).toFixed(5)),
  }
}

export interface BenchmarkReport {
  created_at: string
  playbook_version: string
  scenarios: number
  approved_scenarios: number
  repeats: number
  note: string
  summaries: ConfigSummary[]
  results: ScenarioResult[]
  /**
   * Keith's saved real-call moments, when the run included them: unapproved drafts, reported on
   * their own and never part of the summaries, baselines or anything that gates.
   */
  mine?: {
    scenarios: number
    summaries: ConfigSummary[]
    results: ScenarioResult[]
    /** Readable name and the move HELP gave on the call, per moment id. */
    moments: Array<{ id: string; title: string; observed_move: string | null }>
  }
}

/**
 * Compare model configs on the same scenarios. Sequential (no parallel requests) so latency
 * reflects a single live press; each config is pre-warmed first, as it is during a live call.
 */
export async function benchmark(opts: {
  scenarios: Scenario[]
  /** Keith's saved real-call moments: run in the same loop (same warm connection), reported apart. */
  mine?: Scenario[]
  model: HelpModel
  configs: HelpModelConfig[]
  playbook: Playbook
  repeats: number
  onProgress?: (done: number, total: number, last: ScenarioResult) => void
}): Promise<BenchmarkReport> {
  const results: ScenarioResult[] = []
  const mineResults: ScenarioResult[] = []
  const mine = opts.mine ?? []
  const total = (opts.scenarios.length + mine.length) * opts.configs.length * opts.repeats
  let done = 0
  for (const config of opts.configs) {
    try {
      await opts.model.prewarm(buildSystemPrompt(opts.playbook), config)
    } catch {
      /* measured anyway */
    }
    for (let rep = 0; rep < opts.repeats; rep++) {
      for (const [list, out] of [[opts.scenarios, results], [mine, mineResults]] as const) {
        for (const s of list) {
          // One of Keith's moments that can't be replayed (hand-edited) is reported as failed, never
          // stopping the run: his drafts never get in the way of the built-in results.
          const run = runScenario(s, opts.model, config, opts.playbook)
          const r = await (list === mine ? run.catch((err: unknown) => unreplayable(s, opts.model, config, err)) : run)
          out.push(r)
          opts.onProgress?.(++done, total, r)
        }
      }
    }
  }
  const summaries = opts.configs.map((c) => summarize(c.model, results.filter((r) => r.model === c.model)))
  const approved = opts.scenarios.filter((s) => s.golden_approved).length
  const mineReport = mine.length
    ? {
        mine: {
          scenarios: mine.length,
          summaries: opts.configs.map((c) => summarize(c.model, mineResults.filter((r) => r.model === c.model))),
          results: mineResults,
          moments: mine.map((s) => ({ id: s.id, title: s.title ?? s.id, observed_move: s.observed?.move ?? null })),
        },
      }
    : {}
  return {
    created_at: new Date().toISOString(),
    playbook_version: opts.playbook.version,
    scenarios: opts.scenarios.length,
    approved_scenarios: approved,
    repeats: opts.repeats,
    note: approved === 0
      ? 'No scenarios are Keith-approved yet: move agreement is on unapproved drafts and does not gate anything.'
      : 'Level 3 move agreement is computed on Keith-approved scenarios only.',
    summaries,
    results,
    ...mineReport,
  }
}

/** Per-scenario result kept in a baseline (several repeats are folded into one entry). */
export interface BaselineScenario {
  approved: boolean
  /** Most common move across repeats (first seen wins a tie); null when no valid card. */
  move: string | null
  move_ok: boolean | null
  /** True only if every repeat passed Level 1. */
  level1_pass: boolean
  level1_failures: string[]
  /** Median across repeats; null when nothing usable arrived. */
  first_usable_ms: number | null
  /** Median full-card time across repeats; null when no request completed (absent in older baselines). */
  complete_ms?: number | null
}

export interface Baseline {
  created_at: string
  playbook_version: string
  repeats: number
  mock?: boolean
  /** Keyed by model id. */
  models: Record<string, { summary: ConfigSummary; scenarios: Record<string, BaselineScenario> }>
}

/** Fold a benchmark report into a small, comparable baseline (scripts/help-eval.ts --save-baseline). */
export function toBaseline(r: BenchmarkReport, mock = false): Baseline {
  const models: Baseline['models'] = {}
  for (const summary of r.summaries) {
    const byScenario = new Map<string, ScenarioResult[]>()
    for (const x of r.results.filter((y) => y.model === summary.model)) byScenario.set(x.scenario_id, [...(byScenario.get(x.scenario_id) ?? []), x])
    const scenarios: Record<string, BaselineScenario> = {}
    for (const [id, runs] of byScenario) {
      const counts = new Map<string | null, number>()
      for (const x of runs) counts.set(x.card?.move ?? null, (counts.get(x.card?.move ?? null) ?? 0) + 1)
      const move = [...counts.entries()].reduce((best, e) => (e[1] > best[1] ? e : best))[0]
      const fu = runs.map((x) => x.first_usable_ms).filter((v): v is number => v !== null)
      const cm = runs.map((x) => x.complete_ms).filter((v): v is number => v !== null)
      scenarios[id] = {
        approved: runs[0].approved,
        move,
        move_ok: runs.find((x) => (x.card?.move ?? null) === move)?.move_ok ?? null,
        level1_pass: runs.every((x) => x.level1.pass),
        level1_failures: [...new Set(runs.flatMap((x) => x.level1.failures))],
        first_usable_ms: percentile(fu, 50),
        complete_ms: percentile(cm, 50),
      }
    }
    models[summary.model] = { summary, scenarios }
  }
  return { created_at: r.created_at, playbook_version: r.playbook_version, repeats: r.repeats, mock, models }
}

export interface BaselineRegression {
  model: string
  kind: 'level1' | 'move_agreement' | 'latency'
  scenario_id: string | null
  detail: string
}

export interface BaselineComparison {
  regressions: BaselineRegression[]
  /** Context that is not a regression (models or scenarios on one side only, mock vs live). */
  notes: string[]
}

/**
 * Compare a run against a saved baseline. Everything is computed over the scenarios both runs
 * share, so a growing set never reads as a regression. Regressions: a scenario that passed Level 1
 * before and fails now; move agreement (approved and drafts separately) going down, listing the
 * scenarios whose move went from right to wrong (a flip that another scenario's fix cancels out is
 * not a drop); first-usable or full-card p95 (across the shared scenarios' per-scenario medians) up
 * by more than `latencyTolerance` (default 20%; live runs only). Models or scenarios present on one
 * side only are noted, not flagged.
 */
export function compareBaseline(before: Baseline, after: Baseline, latencyTolerance = 0.2): BaselineComparison {
  const regressions: BaselineRegression[] = []
  const notes: string[] = []
  // A MOCK run's timings are offline noise: latency is only compared live against live.
  const compareLatency = !before.mock && !after.mock
  if (!compareLatency) notes.push(`${before.mock ? 'MOCK' : 'live'} baseline vs ${after.mock ? 'MOCK' : 'live'} run: latency not compared.`)
  if (before.playbook_version !== after.playbook_version) notes.push(`Playbook changed: ${before.playbook_version} -> ${after.playbook_version}.`)
  for (const model of Object.keys(before.models)) if (!after.models[model]) notes.push(`${model}: in the baseline, not in this run (not compared).`)
  for (const [model, now] of Object.entries(after.models)) {
    const was = before.models[model]
    if (!was) {
      notes.push(`${model}: not in the baseline (not compared).`)
      continue
    }
    const common = Object.keys(now.scenarios).filter((id) => was.scenarios[id]).sort()
    const added = Object.keys(now.scenarios).filter((id) => !was.scenarios[id])
    const dropped = Object.keys(was.scenarios).filter((id) => !now.scenarios[id])
    if (added.length) notes.push(`${model}: ${added.length} scenario(s) not in the baseline (not compared): ${added.join(', ')}`)
    if (dropped.length) notes.push(`${model}: ${dropped.length} baseline scenario(s) not run now: ${dropped.join(', ')}`)

    for (const id of common) {
      const a = was.scenarios[id]
      const b = now.scenarios[id]
      if (a.level1_pass && !b.level1_pass) {
        regressions.push({ model, kind: 'level1', scenario_id: id, detail: `passed Level 1 before, fails now: ${b.level1_failures.join('; ') || 'no detail'}` })
      }
    }
    // Agreement grouped by today's approval. Only a drop in the rate is a regression; the scenarios
    // that flipped from right to wrong are listed in it.
    for (const approved of [true, false]) {
      const ids = common.filter((id) => now.scenarios[id].approved === approved)
      if (!ids.length) continue
      const rate = (m: Record<string, BaselineScenario>) => ids.filter((id) => m[id].move_ok === true).length / ids.length
      const [x, y] = [rate(was.scenarios), rate(now.scenarios)]
      if (y < x) {
        const flipped = ids
          .filter((id) => was.scenarios[id].move_ok === true && now.scenarios[id].move_ok !== true)
          .map((id) => `${id} (${was.scenarios[id].move ?? '-'} -> ${now.scenarios[id].move ?? 'none'})`)
        regressions.push({ model, kind: 'move_agreement', scenario_id: null, detail: `${approved ? 'approved' : 'draft'} move agreement ${Math.round(x * 100)}% -> ${Math.round(y * 100)}% on ${ids.length} shared scenario(s); right -> wrong: ${flipped.join(', ')}` })
      }
    }
    // p95 across the shared scenarios' per-scenario medians, so added or dropped scenarios do not move it.
    const p95 = (m: Record<string, BaselineScenario>, key: 'first_usable_ms' | 'complete_ms') =>
      percentile(common.map((id) => m[id][key] ?? null).filter((v): v is number => v !== null), 95)
    for (const key of compareLatency ? (['first_usable_ms', 'complete_ms'] as const) : []) {
      const [x, y] = [p95(was.scenarios, key), p95(now.scenarios, key)]
      if (x !== null && y !== null && x > 0 && y > x * (1 + latencyTolerance)) {
        const label = key === 'first_usable_ms' ? 'first usable' : 'full card'
        regressions.push({ model, kind: 'latency', scenario_id: null, detail: `${label} p95 over ${common.length} shared scenario(s) ${x} ms -> ${y} ms (+${Math.round((y / x - 1) * 100)}%, limit +${Math.round(latencyTolerance * 100)}%)` })
      }
    }
  }
  return { regressions, notes }
}

export function comparisonText(c: BaselineComparison): string {
  const lines = c.regressions.length
    ? [`${c.regressions.length} regression(s) against the baseline:`, ...c.regressions.map((r) => `- ${r.model} · ${r.kind}${r.scenario_id ? ` · ${r.scenario_id}` : ''}: ${r.detail}`)]
    : ['No regressions against the baseline.']
  if (c.notes.length) lines.push('', 'Notes:', ...c.notes.map((n) => `- ${n}`))
  return lines.join('\n')
}

export function reportMarkdown(r: BenchmarkReport): string {
  const ms = (x: number | null) => (x === null ? '–' : `${(x / 1000).toFixed(2)} s`)
  const pc = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`)
  const rows = r.summaries.map((s) =>
    `| ${s.model} | ${ms(s.first_usable_median_ms)} | ${ms(s.first_usable_p95_ms)} | ${ms(s.complete_median_ms)} | ${ms(s.complete_p95_ms)} | ${pc(s.usable_within_2s)} | ${pc(s.usable_within_3s)} | ${s.timeouts} | ${s.failures} | ${pc(s.level1_pass_rate)} | ${pc(s.approved_move_agreement)} | ${pc(s.draft_move_agreement)} | $${s.cost_per_request_usd.toFixed(4)} |`,
  )
  const fails = r.results.filter((x) => !x.level1.pass).map((x) => `- ${x.scenario_id} · ${x.config_label.split(' · ')[0]}: ${x.level1.failures.join('; ')}`)
  return `# HELP benchmark ${r.created_at}

Playbook ${r.playbook_version} · ${r.scenarios} scenarios (${r.approved_scenarios} Keith-approved) · ${r.repeats} run(s) each.${r.mine ? ` Plus ${r.mine.scenarios} of your saved moments, reported separately at the end.` : ''}
${r.note}

Targets: usable guidance ~1-2 s, p95 <= 3 s. "Usable" = a complete, validated Ask/Say line that passes Level 1.
Times are from the press, including finding the approved note and building the context (a few ms), as on a call.

| Model | First usable p50 | First usable p95 | Full card p50 | Full card p95 | Usable <=2 s | Usable <=3 s | Timeouts | Failures | Level 1 pass | Move agree (approved) | Move agree (drafts) | Cost / press |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

${stagesMarkdown(r.summaries, pc)}

${byCallTypeMarkdown(r.results, r.mine?.results)}

## Level 1 failures
${fails.join('\n') || 'None.'}
${r.mine ? mineMarkdown(r.mine, ms, pc) : ''}`
}

/**
 * Speed by stage, all timed from the press (which includes finding the approved passage and building
 * the context, as on a call): passage on screen, Claude's first byte, first usable line.
 */
function stagesMarkdown(summaries: ConfigSummary[], pc: (x: number | null) => string): string {
  const t = (x: number | null | undefined) => (x == null ? '–' : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(2)} s`)
  const rows = summaries.map((s) =>
    `| ${s.model} | ${pc(s.passage_shown_rate ?? null)} | ${t(s.passage_median_ms)} | ${t(s.first_token_median_ms)} | ${t(s.first_token_p95_ms)} | ${t(s.first_usable_median_ms)} | ${t(s.first_usable_p95_ms)} | ${t(s.context_median_ms)} | ${t(s.knowledge_median_ms)} | ${pc(s.passage_cited_rate ?? null)} |`,
  )
  return `## Speed by stage (from the press)

"Approved note" is the approved passage shown at once, only on a strong match; "cited" is how often the finished card then cited it.

| Model | Approved note shown | Press -> note p50 | Press -> first token p50 | p95 | Press -> first usable p50 | p95 | Context build p50 | Knowledge search p50 | Note cited by card |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}`
}

/** Keith's saved moments: their own section, so they never mix with the numbers that decide anything. */
function mineMarkdown(m: NonNullable<BenchmarkReport['mine']>, ms: (x: number | null) => string, pc: (x: number | null) => string): string {
  const cell = (x: string) => x.replace(/\|/g, '/').replace(/\s+/g, ' ')
  const byId = new Map(m.moments.map((x) => [x.id, x]))
  const rows = m.summaries.map((s) =>
    `| ${s.model} | ${ms(s.first_usable_median_ms)} | ${ms(s.first_usable_p95_ms)} | ${ms(s.complete_median_ms)} | ${pc(s.usable_within_3s)} | ${s.timeouts} | ${s.failures} | ${pc(s.level1_pass_rate)} | $${s.cost_per_request_usd.toFixed(4)} |`,
  )
  const fits = (x: ScenarioResult) => (x.move_ok === null ? 'not judged' : x.move_ok ? 'yes' : 'no')
  const each = m.results.map((x) =>
    `| ${cell(byId.get(x.scenario_id)?.title ?? x.scenario_id)} | ${x.model} | ${ms(x.first_usable_ms)} | ${x.level1.pass ? 'pass' : 'FAIL'} | ${x.card?.move ?? '–'} | ${byId.get(x.scenario_id)?.observed_move ?? '–'} | ${fits(x)} |`,
  )
  const fails = m.results.filter((x) => !x.level1.pass).map((x) => `- ${cell(byId.get(x.scenario_id)?.title ?? x.scenario_id)} · ${x.model}: ${x.level1.failures.join('; ')}`)
  return `
## Your saved moments (${m.scenarios}, from real calls)

Unapproved drafts: reported here only, never part of the numbers above or of anything that picks a model.
"Fits your feedback" is judged only where your rating said which move was fine or wrong.

| Model | First usable p50 | First usable p95 | Full card p50 | Usable <=3 s | Timeouts | Failures | Level 1 pass | Cost / press |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

| Moment | Model | First usable | Level 1 | Move now | Move on the call | Fits your feedback |
|---|---|---|---|---|---|---|
${each.join('\n')}

### Level 1 failures (your moments)
${fails.join('\n') || 'None.'}
`
}
