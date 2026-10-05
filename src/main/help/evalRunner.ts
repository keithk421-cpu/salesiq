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
import { buildHelpContext } from './context'
import type { HelpModel } from './models'
import { buildSystemPrompt, buildUserMessage, type Playbook } from './prompt'
import { LineProtocolParser, validateCard } from './protocol'
import { replayAt, type Scenario } from './replay'

export interface ScenarioResult {
  scenario_id: string
  category: string
  approved: boolean
  /** Model id of the config that produced this result (grouping key). */
  model: string
  config_label: string
  status: 'complete' | 'failed' | 'timeout'
  card: HelpCardContent | null
  raw: string
  first_usable_ms: number | null
  complete_ms: number | null
  usage: HelpUsage | null
  level1: { pass: boolean; failures: string[] }
  /** Level 3 signal: move in best/acceptable. Only gates when the scenario is approved. */
  move_ok: boolean | null
  error: string | null
}

const PAIN_WORDS = /\b(pain|painful|frustrat\w*|struggl\w*|headache\w*|broken|bottleneck\w*|nightmare|problem\w*|issue\w*|challenge\w*)\b/gi
/**
 * Wording that states what Arize can do. It must be tied to a cited approved source (a K# id).
 * Question forms ("do we have", "what we offer", "whether Arize supports") and time talk
 * ("we have ten minutes", "we have to wrap") are not claims.
 */
const CAPABILITY_CLAIM = new RegExp(
  String.raw`(?<!\b(?:do|does|did|what|whether|if|which)\s)\b(?:` +
    [
      String.raw`we (?:support|offer|provide|can support|can handle)`,
      String.raw`we have(?!\s+(?:to|time|about|around|until|left|a few|a couple|a minute|a moment|\d|five|ten|fifteen|twenty|thirty)\b)`,
      String.raw`we've got`,
      String.raw`arize (?:supports|has|offers|provides|includes|can)`,
      String.raw`(?:is|are) (?:fully |natively |officially )?supported`,
      String.raw`(?:it|the platform|the product) (?:supports|includes)`,
    ].join('|') +
    String.raw`)\b`,
  'i',
)

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
  const transcript = s.transcript.map((l) => l.text).join(' ').toLowerCase()
  const invented = (visible.match(PAIN_WORDS) ?? []).filter((w) => !transcript.includes(w.toLowerCase()))
  if (invented.length) f.push(`assumed pain not voiced by the buyer: ${[...new Set(invented.map((w) => w.toLowerCase()))].join(', ')}`)
  // Approved knowledge merely being in context is not enough: the claim must cite it.
  const claim = CAPABILITY_CLAIM.exec(visible)
  if (claim && !citesKnowledge) {
    f.push(`states an Arize capability ("${claim[0]}") without citing an approved knowledge source`)
  }
  return f
}

export async function runScenario(s: Scenario, model: HelpModel, config: HelpModelConfig, playbook: Playbook, now = new Date()): Promise<ScenarioResult> {
  const r = replayAt(s)
  const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs, now })
  const parser = new LineProtocolParser()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('timeout')), config.timeout_ms)
  const t0 = performance.now()
  let raw = ''
  let usage: HelpUsage | null = null
  let error: string | null = null
  let status: ScenarioResult['status'] = 'complete'
  try {
    const res = await model.run({
      system: buildSystemPrompt(playbook), user: buildUserMessage(ctx.text), config, signal: abort.signal,
      onText: (c) => { raw += c; parser.feed(c) },
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
  return {
    scenario_id: s.id,
    category: s.category,
    approved: s.golden_approved === true,
    model: config.model,
    config_label: model.label(config),
    status,
    card: v.card,
    raw,
    first_usable_ms: parser.firstUsableAt === null ? null : Math.round(parser.firstUsableAt - t0),
    complete_ms: status === 'complete' ? Math.round(completeAt - t0) : null,
    usage,
    level1: { pass: failures.length === 0, failures },
    move_ok: move ? [...s.best_moves, ...s.acceptable_moves].includes(move) : null,
    error,
  }
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
  const agree = (rs: ScenarioResult[]) => (rs.length ? rs.filter((r) => r.move_ok).length / rs.length : null)
  return {
    config_label: results[0]?.config_label ?? model,
    model,
    runs: results.length,
    first_usable_median_ms: percentile(fu, 50),
    first_usable_p95_ms: percentile(fu, 95),
    complete_median_ms: percentile(cm, 50),
    complete_p95_ms: percentile(cm, 95),
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
}

/**
 * Compare model configs on the same scenarios. Sequential (no parallel requests) so latency
 * reflects a single live press; each config is pre-warmed first, as it is during a live call.
 */
export async function benchmark(opts: {
  scenarios: Scenario[]
  model: HelpModel
  configs: HelpModelConfig[]
  playbook: Playbook
  repeats: number
  onProgress?: (done: number, total: number, last: ScenarioResult) => void
}): Promise<BenchmarkReport> {
  const results: ScenarioResult[] = []
  const total = opts.scenarios.length * opts.configs.length * opts.repeats
  let done = 0
  for (const config of opts.configs) {
    try {
      await opts.model.prewarm(buildSystemPrompt(opts.playbook), config)
    } catch {
      /* measured anyway */
    }
    for (let rep = 0; rep < opts.repeats; rep++) {
      for (const s of opts.scenarios) {
        const r = await runScenario(s, opts.model, config, opts.playbook)
        results.push(r)
        opts.onProgress?.(++done, total, r)
      }
    }
  }
  const summaries = opts.configs.map((c) => summarize(c.model, results.filter((r) => r.model === c.model)))
  const approved = opts.scenarios.filter((s) => s.golden_approved).length
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
      scenarios[id] = {
        approved: runs[0].approved,
        move,
        move_ok: runs.find((x) => (x.card?.move ?? null) === move)?.move_ok ?? null,
        level1_pass: runs.every((x) => x.level1.pass),
        level1_failures: [...new Set(runs.flatMap((x) => x.level1.failures))],
        first_usable_ms: percentile(fu, 50),
      }
    }
    models[summary.model] = { summary, scenarios }
  }
  return { created_at: r.created_at, playbook_version: r.playbook_version, repeats: r.repeats, mock, models }
}

export interface BaselineRegression {
  model: string
  kind: 'level1' | 'move_agreement' | 'move' | 'latency'
  scenario_id: string | null
  detail: string
}

export interface BaselineComparison {
  regressions: BaselineRegression[]
  /** Context that is not a regression (models or scenarios on one side only, mock vs live). */
  notes: string[]
}

/**
 * Compare a run against a saved baseline. Regressions: a scenario that passed Level 1 before and
 * fails now; move agreement (approved and drafts, over the scenarios both runs share) going down,
 * with the scenarios whose move went from right to wrong; first-usable or full-card p95 up by more
 * than `latencyTolerance` (default 20%; live runs only). Models or scenarios present on one side only
 * are noted, not flagged.
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
      if (a.move_ok === true && b.move_ok !== true) {
        regressions.push({ model, kind: 'move', scenario_id: id, detail: `move ${a.move ?? '-'} (agreed) -> ${b.move ?? 'none'} (not agreed)${b.approved ? '' : ' [draft]'}` })
      }
    }
    // Agreement on the shared scenarios only, grouped by today's approval, so a growing set never reads as a drop.
    for (const approved of [true, false]) {
      const ids = common.filter((id) => now.scenarios[id].approved === approved)
      if (!ids.length) continue
      const rate = (m: Record<string, BaselineScenario>) => ids.filter((id) => m[id].move_ok === true).length / ids.length
      const [x, y] = [rate(was.scenarios), rate(now.scenarios)]
      if (y < x) {
        regressions.push({ model, kind: 'move_agreement', scenario_id: null, detail: `${approved ? 'approved' : 'draft'} move agreement ${Math.round(x * 100)}% -> ${Math.round(y * 100)}% on ${ids.length} shared scenario(s)` })
      }
    }
    for (const key of compareLatency ? (['first_usable_p95_ms', 'complete_p95_ms'] as const) : []) {
      const [x, y] = [was.summary[key], now.summary[key]]
      if (x !== null && y !== null && x > 0 && y > x * (1 + latencyTolerance)) {
        regressions.push({ model, kind: 'latency', scenario_id: null, detail: `${key.replace(/_ms$/, '').replace(/_/g, ' ')} ${x} ms -> ${y} ms (+${Math.round((y / x - 1) * 100)}%, limit +${Math.round(latencyTolerance * 100)}%)` })
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

Playbook ${r.playbook_version} · ${r.scenarios} scenarios (${r.approved_scenarios} Keith-approved) · ${r.repeats} run(s) each.
${r.note}

Targets: usable guidance ~1-2 s, p95 <= 3 s. "Usable" = a complete, validated Ask/Say line that passes Level 1.

| Model | First usable p50 | First usable p95 | Full card p50 | Full card p95 | Usable <=2 s | Usable <=3 s | Timeouts | Failures | Level 1 pass | Move agree (approved) | Move agree (drafts) | Cost / press |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Level 1 failures
${fails.join('\n') || 'None.'}
`
}
