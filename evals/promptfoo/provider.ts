/** promptfoo custom provider: runs one HELP scenario (replayed as of its HELP time) through Claude. */
import path from 'node:path'
import { loadScenarios, runScenario } from '../../src/main/help/evalRunner'
import { ClaudeHelpModel, DEFAULT_HELP_CONFIG, OPUS_HELP_CONFIG } from '../../src/main/help/models'
import { loadPlaybook } from '../../src/main/help/prompt'

const scenarios = new Map(loadScenarios(path.resolve('evals/scenarios/help')).map((s) => [s.id, s]))
const playbook = loadPlaybook(path.resolve('config/playbook.json'))

export default class HelpProvider {
  private readonly model: string
  constructor(options: { id?: string; config?: { model?: string } }) {
    this.model = options.config?.model ?? 'claude-sonnet-5-5'
  }
  id(): string {
    return `help:${this.model}`
  }
  async callApi(_prompt: string, context: { vars: Record<string, string> }) {
    const s = scenarios.get(context.vars.scenario_id)
    if (!s) return { error: `unknown scenario ${context.vars.scenario_id}` }
    const key = process.env.SALES_COPILOT_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''
    if (!key) return { error: 'Set SALES_COPILOT_ANTHROPIC_KEY (or ANTHROPIC_API_KEY) to run live evals.' }
    const config = this.model === 'claude-opus-5-5' ? OPUS_HELP_CONFIG : DEFAULT_HELP_CONFIG
    const r = await runScenario(s, new ClaudeHelpModel(key), config, playbook)
    const visible = r.card ? [r.card.happening ? `What's happening: ${r.card.happening}` : '', `${r.card.primary_kind === 'say' ? 'Say' : 'Ask'}: ${r.card.primary}`, r.card.follow_up ? `Then: ${r.card.follow_up}` : ''].filter(Boolean).join('\n') : '(no usable card)'
    return {
      output: visible,
      tokenUsage: r.usage ? { prompt: r.usage.input_tokens, completion: r.usage.output_tokens, total: r.usage.input_tokens + r.usage.output_tokens } : undefined,
      cost: r.usage?.cost_usd,
      metadata: { result: r },
    }
  }
}
