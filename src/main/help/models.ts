/**
 * HELP model adapters.
 * - ClaudeHelpModel: Anthropic SDK, streaming, cached system prompt, server-side fallback,
 *   explicit api.anthropic.com base URL (ignores ambient env overrides).
 * - MockHelpModel: offline stand-in for replay/UI/tests. Every card it produces is labelled MOCK.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { HelpModelConfig, HelpUsage } from '../../shared/help'
import { isWrapRequest } from './wrap'
import { planItemOf, pressModeOf, priorMoveOf } from './pressModes'
import { shortItem } from './callPlan'

export interface HelpModelRun {
  system: string
  user: string
  config: HelpModelConfig
  signal: AbortSignal
  onText: (chunk: string) => void
}

export interface HelpModelResult {
  usage: HelpUsage
  stop_reason: string | null
  served_model: string
  fell_back: boolean
}

export interface HelpModel {
  readonly mock: boolean
  label(config: HelpModelConfig): string
  run(req: HelpModelRun): Promise<HelpModelResult>
  /** Warm the connection and the cached system prompt so the first press is fast. */
  prewarm(system: string, config: HelpModelConfig): Promise<void>
  /** Free check that the key works for this model (no tokens used). */
  check(config: HelpModelConfig): Promise<{ readiness: HelpReadiness; error?: HelpError }>
  /** Background call notes: one structured-JSON request. A model without it keeps no notes. */
  notes?(req: HelpNotesRun): Promise<HelpNotesResult>
}

/** One call-notes update: JSON in a fixed shape, not streamed (nothing is shown until it's checked). */
export interface HelpNotesRun {
  system: string
  user: string
  /** JSON schema the answer must follow (output_config.format). */
  schema: Record<string, unknown>
  config: HelpModelConfig
  signal: AbortSignal
  max_tokens: number
  timeout_ms: number
}

export interface HelpNotesResult {
  /** The JSON text, unchecked: the caller validates it. */
  text: string
  usage: HelpUsage
  stop_reason: string | null
}

/** USD per million tokens. Output price applies to billed thinking tokens too. Edit when prices change. */
export const PRICES: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
}

export function costUsd(model: string, u: Omit<HelpUsage, 'cost_usd'>): number {
  const p = PRICES[model] ?? PRICES['claude-sonnet-5-5']
  return (
    (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.cache_read + u.cache_creation_input_tokens * p.cache_write) /
    1_000_000
  )
}

/** What Keith sees when HELP can't run, plus a short code for logs (never call text). */
export interface HelpError {
  code: 'key_rejected' | 'key_not_allowed' | 'no_credit' | 'model_unavailable' | 'rate_limited' | 'overloaded' | 'server_error' | 'offline' | 'timeout' | 'aborted' | 'error'
  message: string
  /** True when pressing again won't help until something is fixed (key, credit, model access). */
  blocking: boolean
}

export function describeError(err: unknown): HelpError {
  const e = err as { status?: number; type?: string | null; message?: string; error?: unknown }
  let body = ''
  try {
    body = JSON.stringify(e?.error ?? '')
  } catch {
    /* unprintable body */
  }
  const text = `${String(e?.message ?? '')} ${body}`
  if (err instanceof Anthropic.APIUserAbortError) return { code: 'aborted', message: 'Cancelled.', blocking: false }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { code: 'timeout', message: 'Claude took too long to answer. Press HELP again.', blocking: false }
  if (err instanceof Anthropic.APIConnectionError) return { code: 'offline', message: "Can't reach Claude. Check the internet connection.", blocking: false }
  const status = typeof e?.status === 'number' ? e.status : null
  if (status === 401) return { code: 'key_rejected', message: 'Claude rejected the API key. Check it in Setup, step 3.', blocking: true }
  if (status === 403) return { code: 'key_not_allowed', message: "This API key isn't allowed to use HELP's model. Check the key in the Anthropic Console.", blocking: true }
  if (status === 404) return { code: 'model_unavailable', message: "HELP's Claude model isn't available to this API key.", blocking: true }
  if (/credit balance|billing/i.test(text)) return { code: 'no_credit', message: 'The Anthropic account is out of credit. Add credit, then press HELP again.', blocking: true }
  if (status === 429 || e?.type === 'rate_limit_error') return { code: 'rate_limited', message: 'Too many requests right now. Wait a few seconds, then press HELP again.', blocking: false }
  if (status === 529 || e?.type === 'overloaded_error' || /overloaded/i.test(text)) return { code: 'overloaded', message: 'Claude is busy right now. Press HELP again.', blocking: false }
  if (status !== null && status >= 500) return { code: 'server_error', message: 'Claude had a server problem. Press HELP again.', blocking: false }
  return { code: 'error', message: 'HELP hit an unexpected problem. Press HELP again.', blocking: false }
}

/** HELP-ready light: is a real key there, and does Claude accept it? */
export type HelpReadiness = 'ready' | 'practice' | 'key_rejected' | 'no_credit' | 'offline' | 'busy' | 'unavailable' | 'checking'

/**
 * What an error says about the HELP-ready light. null: nothing new about the key, credit or
 * connection (a timeout, a cancel, an unexpected problem), so the light stays as it is.
 */
export function readinessFor(e: HelpError): HelpReadiness | null {
  switch (e.code) {
    case 'key_rejected':
    case 'key_not_allowed':
      return 'key_rejected'
    case 'no_credit':
      return 'no_credit'
    case 'model_unavailable':
      return 'unavailable'
    case 'rate_limited':
    case 'overloaded':
    case 'server_error':
      return 'busy'
    case 'offline':
      return 'offline'
    default:
      return null
  }
}

/** Busy or a dropped connection: worth one quick retry by hand. A 429 comes straight back to Keith. */
const RETRY_CODES: ReadonlySet<HelpError['code']> = new Set(['overloaded', 'server_error', 'offline'])
/** Only retry if at least this much of the HELP deadline is left. */
const RETRY_MIN_LEFT_MS = 3000

export const DEFAULT_HELP_CONFIG: HelpModelConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  effort: 'low',
  thinking: 'off',
  timeout_ms: 8000,
  max_tokens: 400,
}

export const OPUS_HELP_CONFIG: HelpModelConfig = { ...DEFAULT_HELP_CONFIG, model: 'claude-opus-5-5', thinking: 'adaptive' }

export class ClaudeHelpModel implements HelpModel {
  readonly mock = false
  private client: Anthropic

  constructor(apiKey: string, client?: Anthropic) {
    // No automatic retries: the client would wait out a 429's retry-after past the 8 s HELP deadline.
    // run() retries once by hand when that can still finish in time.
    this.client = client ?? new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0 })
  }

  label(c: HelpModelConfig): string {
    return `${c.model} · effort ${c.effort} · thinking ${this.thinkingParam(c).type}`
  }

  /** Sonnet 5.5 can turn thinking off ('between_tools'); Opus 5.5 always thinks (adaptive) - effort controls depth. */
  private thinkingParam(c: HelpModelConfig): { type: 'adaptive' } | { type: 'between_tools' } {
    return c.thinking === 'off' && c.model.startsWith('claude-sonnet-5-5') ? { type: 'between_tools' } : { type: 'adaptive' }
  }

  private params(system: string, user: string, c: HelpModelConfig, maxTokens: number) {
    return {
      model: c.model,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default' as const,
      system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content: user }],
      thinking: this.thinkingParam(c),
      output_config: { effort: c.effort },
    }
  }

  async run(req: HelpModelRun): Promise<HelpModelResult> {
    const startedAt = Date.now()
    let streamed = false
    const onText = (t: string) => {
      streamed = true
      req.onText(t)
    }
    try {
      return await this.runOnce(req, req.config.timeout_ms, onText)
    } catch (err) {
      // One quick retry for a busy or dropped request, only if nothing reached Keith yet and it can
      // still finish inside the HELP deadline.
      const left = req.config.timeout_ms - (Date.now() - startedAt)
      if (streamed || req.signal.aborted || left < RETRY_MIN_LEFT_MS || !RETRY_CODES.has(describeError(err).code)) throw err
      return this.runOnce(req, left, onText)
    }
  }

  private async runOnce(req: HelpModelRun, timeoutMs: number, onText: (t: string) => void): Promise<HelpModelResult> {
    const c = req.config
    const stream = this.client.beta.messages.stream(this.params(req.system, req.user, c, c.max_tokens), {
      signal: req.signal,
      timeout: timeoutMs,
    })
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') onText(ev.delta.text)
    }
    const msg = await stream.finalMessage()
    const u = msg.usage
    const base = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    }
    const fellBack = msg.content.some((b) => (b as { type: string }).type === 'fallback')
    return {
      usage: { ...base, cost_usd: costUsd(msg.model, base) },
      stop_reason: msg.stop_reason ?? null,
      served_model: msg.model,
      fell_back: fellBack,
    }
  }

  /** Same model, thinking and effort as HELP, cached system prompt, plus a JSON schema for the answer. */
  async notes(req: HelpNotesRun): Promise<HelpNotesResult> {
    // No refusal fallback here: a declined notes update just keeps the previous notes, and the fallback
    // option isn't proven together with structured output, so leaving it out can't break every update.
    const { betas: _betas, fallbacks: _fallbacks, ...p } = this.params(req.system, req.user, req.config, req.max_tokens)
    // Background, nobody waiting on it: one automatic retry is fine (the caller's deadline still applies).
    const msg = await this.client.beta.messages.create(
      { ...p, output_config: { effort: req.config.effort, format: { type: 'json_schema', schema: req.schema } }, stream: false },
      { signal: req.signal, timeout: req.timeout_ms, maxRetries: 1 },
    )
    const u = msg.usage
    const base = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    }
    return {
      text: msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      usage: { ...base, cost_usd: costUsd(msg.model, base) },
      stop_reason: msg.stop_reason ?? null,
    }
  }

  async prewarm(system: string, c: HelpModelConfig): Promise<void> {
    // max_tokens 0: writes/refreshes the cached system prompt and opens the connection; no output billed.
    const p = this.params(system, 'warm-up', c, 0)
    // Background, no deadline: one automatic retry is fine here.
    await this.client.beta.messages.create({ ...p, stream: false }, { timeout: 10_000, maxRetries: 1 })
  }

  async check(c: HelpModelConfig): Promise<{ readiness: HelpReadiness; error?: HelpError }> {
    try {
      // Looking up the model is free and needs a valid key with access to it.
      await this.client.models.retrieve(c.model, {}, { timeout: 8000, maxRetries: 0 })
      return { readiness: 'ready' }
    } catch (err) {
      const error = describeError(err)
      // A check that timed out or failed oddly most likely couldn't reach Claude.
      return { readiness: readinessFor(error) ?? 'offline', error }
    }
  }
}

/** Offline stand-in. Deterministic, clearly labelled, never presented as real guidance. */
export class MockHelpModel implements HelpModel {
  readonly mock = true
  constructor(private readonly delayMs = 150) {}

  label(): string {
    return 'MOCK (no model; offline test output)'
  }

  async run(req: HelpModelRun): Promise<HelpModelResult> {
    const last = /\[(T\d+)\][^\n]*$/m.exec(req.user.split('<last_30_seconds>')[1] ?? '')?.[1]
    // A WRAP press gets a next-step placeholder, so Practice mode shows what that card looks like.
    const wrap = isWrapRequest(req.user)
    // An opening, buying-signal, another-angle or must-learn press (pressModes.ts) gets a placeholder of its kind too.
    const press = wrap ? null : mockPress(req.user)
    const lines = [
      press ? `MOVE: ${press.move}` : wrap ? 'MOVE: confirm_next_step' : 'MOVE: clarify_current_state',
      press ? press.line : wrap ? 'ASK: [MOCK] What day works for a follow-up, and who should join?' : 'ASK: [MOCK] How does that work in practice today?',
      'HAPPENING: [MOCK] Placeholder read - no model was called.',
      press ? `FOLLOW: ${press.follow}` : wrap ? "FOLLOW: [MOCK] I'll send over what I promised." : 'FOLLOW: -',
      `SOURCES: ${last ?? '-'}`,
      'NOTE: MOCK output for offline testing',
    ]
    for (const l of lines) {
      if (req.signal.aborted) throw new Anthropic.APIUserAbortError()
      await new Promise((r) => setTimeout(r, this.delayMs / lines.length))
      req.onText(`${l}\n`)
    }
    return {
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 },
      stop_reason: 'end_turn',
      served_model: 'mock',
      fell_back: false,
    }
  }

  async prewarm(): Promise<void> {
    /* nothing to warm */
  }

  async check(): Promise<{ readiness: HelpReadiness }> {
    return { readiness: 'practice' }
  }

  /** Placeholder notes citing the newest line sent, so the notes panel can be tried without a key. */
  async notes(req: HelpNotesRun): Promise<HelpNotesResult> {
    await new Promise((r) => setTimeout(r, this.delayMs))
    if (req.signal.aborted) throw new Anthropic.APIUserAbortError()
    const last = [...req.user.matchAll(/\[(L\d+)\]/g)].at(-1)?.[1]
    const notes = {
      topic: last ? { text: '[MOCK] Placeholder notes - no model was called', lines: [last] } : null,
      buyer_wants: [], open_questions: [], concerns: [], facts: [], next_steps: [],
      not_covered: ['timeline', 'decision_process', 'current_tooling', 'success_criteria'],
    }
    return {
      text: JSON.stringify(notes),
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 },
      stop_reason: 'end_turn',
    }
  }
}

/** Placeholder lines for a smarter press, so Practice mode shows what each card looks like. */
function mockPress(user: string): { move: string; line: string; follow: string } | null {
  switch (pressModeOf(user)) {
    case 'opening':
      // Only when the block asked for a check-in on what they said last time (pressModes.ts openingBlock):
      // earlier calls that left only Keith's own must-learns get the agenda line.
      return /<opening_press>[\s\S]*This is not the first call with them/.test(user)
        ? { move: 'clarify_current_state', line: 'ASK: [MOCK] Picking up from last time: how did that go?', follow: '-' }
        : { move: 'call_control', line: "ASK: [MOCK] Here's what I'd love to cover today. Does that work?", follow: '-' }
    case 'signal':
      return { move: 'clarify_requirement', line: "SAY: [MOCK] Good question. I'll check and come back to you.", follow: '[MOCK] Who should join a call to plan next steps, and when suits you?' }
    case 'another_angle': {
      // A different move from the card Keith already had.
      const had = priorMoveOf(user)
      const pick = MOCK_ANGLES.find((a) => a.move !== had) ?? MOCK_ANGLES[0]
      return { ...pick, follow: '-' }
    }
    case 'plan_item': {
      // The must-learn Keith clicked, cut short so the line stays inside the card's word limit.
      const item = planItemOf(user)
      return { move: 'clarify_current_state', line: `ASK: [MOCK] To get to ${item ? shortItem(item) : 'your must-learn'}: how does that work?`, follow: '-' }
    }
    default:
      return null
  }
}

// Still on the same topic: another way in, never a change of subject.
const MOCK_ANGLES = [
  { move: 'identify_owner', line: 'ASK: [MOCK] Another angle on that: who on your side feels it most?' },
  { move: 'explore_process', line: 'ASK: [MOCK] Another angle on that: can you walk me through it step by step?' },
]
