/**
 * HELP eval/benchmark CLI.
 *   npm run eval:help -- --models sonnet,opus --repeats 2      (needs SALES_COPILOT_ANTHROPIC_KEY)
 *   npm run eval:help -- --mock                                  (offline; labelled MOCK)
 *   npm run eval:help -- --replay evals/scenarios/help/<id>.json (print exactly what HELP would see)
 *   npm run eval:help -- --session <userData>/sessions/<id>/transcript.jsonl --at 754   (a real call, as of 12:34)
 *   npm run eval:help -- --save-baseline evals/reports/baseline.json  (per scenario: move, Level 1, first usable; summaries)
 *   npm run eval:help -- --compare evals/reports/baseline.json        (prints regressions; exit code 1 if any)
 * Reports go to evals/reports/ (git-ignored).
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildHelpContext } from '../src/main/help/context'
import { benchmark, compareBaseline, comparisonText, loadScenarios, reportMarkdown, toBaseline, type Baseline } from '../src/main/help/evalRunner'
import { ClaudeHelpModel, DEFAULT_HELP_CONFIG, MockHelpModel, OPUS_HELP_CONFIG } from '../src/main/help/models'
import { buildSystemPrompt, buildUserMessage, loadPlaybook } from '../src/main/help/prompt'
import { loadScenario, replayAt, scenarioFromSession } from '../src/main/help/replay'

const args = process.argv.slice(2)
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const playbook = loadPlaybook('config/playbook.json')

const replayFile = arg('replay')
const sessionFile = arg('session')
if (replayFile || sessionFile) {
  const s = sessionFile ? scenarioFromSession(sessionFile, Number(arg('at') ?? 60)) : loadScenario(replayFile!)
  const r = replayAt(s, Number(arg('at') ?? s.help_at_s))
  const ctx = buildHelpContext({ memory: r.memory, kb: r.kb, atMs: r.atMs })
  if (args.includes('--system')) console.log(buildSystemPrompt(playbook), '\n\n=====\n')
  console.log(buildUserMessage(ctx.text))
  console.log(`\n[hidden at this time: lines ${r.hiddenLineIndexes.join(', ') || 'none'}] [warnings: ${ctx.warnings.join(' | ') || 'none'}]`)
  process.exit(0)
}

const mock = args.includes('--mock')
const key = process.env.SALES_COPILOT_ANTHROPIC_KEY ?? ''
if (!mock && !key) {
  console.error('Set SALES_COPILOT_ANTHROPIC_KEY, or run with --mock (offline, labelled MOCK). Live runs are normally done from the app: Diagnostics -> Run HELP speed test.')
  process.exit(2)
}
const which = (arg('models') ?? 'sonnet,opus').split(',')
const configs = [DEFAULT_HELP_CONFIG, OPUS_HELP_CONFIG].filter((c) => which.some((w) => c.model.includes(w)))
const scenarios = loadScenarios(arg('scenarios') ?? 'evals/scenarios/help')
const model = mock ? new MockHelpModel(20) : new ClaudeHelpModel(key)
const report = await benchmark({
  scenarios, model, configs, playbook, repeats: Number(arg('repeats') ?? 1),
  onProgress: (d, t, r) => process.stdout.write(`\r${d}/${t} ${r.scenario_id.padEnd(48)} ${r.level1.pass ? 'L1 ok ' : 'L1 FAIL'}`),
})
const out = 'evals/reports'
fs.mkdirSync(out, { recursive: true })
const file = path.join(out, `help-benchmark-${report.created_at.replace(/[:.]/g, '-')}${mock ? '-MOCK' : ''}`)
fs.writeFileSync(`${file}.json`, JSON.stringify({ ...report, mock }, null, 2))
const md = (mock ? '> MOCK RUN - no model was called.\n\n' : '') + reportMarkdown(report)
fs.writeFileSync(`${file}.md`, md)
console.log(`\n\n${md}\nSaved ${file}.json`)

const baseline = toBaseline(report, mock)
const saveTo = arg('save-baseline')
if (saveTo) {
  fs.mkdirSync(path.dirname(saveTo), { recursive: true })
  fs.writeFileSync(saveTo, JSON.stringify(baseline, null, 2))
  console.log(`Saved baseline ${saveTo}`)
}
const compareWith = arg('compare')
if (compareWith) {
  const before = JSON.parse(fs.readFileSync(compareWith, 'utf8')) as Baseline
  const cmp = compareBaseline(before, baseline)
  console.log(`\nCompared with ${compareWith} (${before.created_at}):\n${comparisonText(cmp)}`)
  if (cmp.regressions.length) process.exitCode = 1
}
