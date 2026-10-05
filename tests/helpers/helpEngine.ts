/** A HELP engine on an invented call, with a model whose answer Keith's test releases line by line. */
import type { HelpCardEvent, HelpModelConfig } from '../../src/shared/help'
import { Db } from '../../src/main/db'
import { CallMemory } from '../../src/main/help/callMemory'
import { HelpEngine } from '../../src/main/help/engine'
import type { HelpModel, HelpModelResult, HelpModelRun } from '../../src/main/help/models'
import type { Playbook } from '../../src/main/help/prompt'
import { replayAt, type Scenario } from '../../src/main/help/replay'

/** Holds each request until the test sends its lines (send) and then ends it (finish or fail). */
export class StagedModel implements HelpModel {
  readonly mock = false
  calls: Array<{ user: string; send: (text: string) => void; finish: () => void; fail: (err: Error) => void }> = []
  label() { return 'staged' }
  async prewarm() {}
  async check() { return { readiness: 'ready' as const } }
  run(req: HelpModelRun): Promise<HelpModelResult> {
    return new Promise((resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Error('aborted')))
      this.calls.push({
        user: req.user,
        send: (text) => req.onText(text),
        finish: () => resolve({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.0001 }, stop_reason: 'end_turn', served_model: 'staged', fell_back: false }),
        fail: reject,
      })
    })
  }
}

/** An invented discovery call (no real company or person). */
export function inventedCall(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'm2-unit', category: 'neutral_discovery', golden_approved: false, synthetic: true, call_type: 'discovery', call_goal: 'Understand their review process',
    desired_outcomes: ['Agree a next step'], speakers: { 'e1:s0': { role: 'buyer', name: 'Dana' } },
    transcript: [
      { t: 0, who: 'keith', text: 'How do you review model outputs today?' },
      { t: 4, end: 14, who: 'e1:s0', text: 'The platform team looks at a sample of answers every week.' },
      { t: 15, end: 18, who: 'keith', text: 'Got it, thanks.' },
    ],
    help_at_s: 20, best_moves: ['clarify_current_state'], acceptable_moves: [], unacceptable_behaviors: [],
    ...over,
  }
}

export function engineFixture(model: HelpModel, playbook: Playbook, opts: { call?: Scenario; prefetch?: boolean; withKb?: boolean } = {}) {
  const db = new Db(':memory:')
  const call = opts.call ?? inventedCall()
  const r = replayAt(call, call.help_at_s)
  const memory = new CallMemory('sess-m2', db)
  for (const t of r.memory.turnsAsOf(r.atMs)) memory.upsertTurn(t, true)
  for (const l of r.memory.labels.values()) memory.setLabel(l)
  let sessionMs = r.atMs
  let wall = 1000
  const events: HelpCardEvent[] = []
  const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
  const config: HelpModelConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', thinking: 'off', timeout_ms: 8000, max_tokens: 400 }
  const engine = new HelpEngine({
    memory, kb: opts.withKb ? r.kb : null, model, config, playbook, db, sessionNowMs: () => sessionMs, emit: (e) => events.push(e),
    log: (e, d) => logs.push({ e, d }), prefetch: opts.prefetch ?? false, wallNow: () => wall,
  })
  return {
    db, memory, engine, events, logs,
    advance: (ms: number) => { wall += ms; sessionMs += ms },
    say: (text: string, who: 'buyer' | 'keith' = 'buyer') => memory.upsertTurn({
      id: `x${sessionMs}`, stream: who === 'keith' ? 'local_mic' : 'system_remote', cluster: who === 'keith' ? null : 'e1:s0',
      start_ms: sessionMs - 2000, end_ms: sessionMs - 500, text, available_ms: sessionMs,
    }, true),
  }
}
