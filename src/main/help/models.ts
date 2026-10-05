/**
 * HELP model adapters.
 * - ClaudeHelpModel: Anthropic SDK, streaming, cached system prompt, server-side fallback,
 *   explicit api.anthropic.com base URL (ignores ambient env overrides).
 * - MockHelpModel: offline stand-in for replay/UI/tests. Every card it produces is labelled MOCK.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { HelpModelConfig, HelpUsage } from '../../shared/help'

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
export type HelpReadiness = 'ready' | 'practice' | 'key_rejected' | 'no_credit' | 'offline' | 'unavailable' | 'checking'

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

  constructor(apiKey: string) {
    // One quick retry for a busy (429/529) or dropped request; the 8 s HELP deadline still applies.
    this.client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 1 })
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
    const c = req.config
    const stream = this.client.beta.messages.stream(this.params(req.system, req.user, c, c.max_tokens), {
      signal: req.signal,
      timeout: c.timeout_ms,
    })
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') req.onText(ev.delta.text)
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

  async prewarm(system: string, c: HelpModelConfig): Promise<void> {
    // max_tokens 0: writes/refreshes the cached system prompt and opens the connection; no output billed.
    const p = this.params(system, 'warm-up', c, 0)
    await this.client.beta.messages.create({ ...p, stream: false }, { timeout: 10_000 })
  }

  async check(c: HelpModelConfig): Promise<{ readiness: HelpReadiness; error?: HelpError }> {
    try {
      // Looking up the model is free and needs a valid key with access to it.
      await this.client.models.retrieve(c.model, {}, { timeout: 8000, maxRetries: 0 })
      return { readiness: 'ready' }
    } catch (err) {
      const error = describeError(err)
      if (error.blocking) return { readiness: error.code === 'model_unavailable' ? 'unavailable' : 'key_rejected', error }
      return { readiness: 'offline', error }
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
    const lines = [
      'MOVE: clarify_current_state',
      'ASK: [MOCK] How does that work in practice today?',
      'HAPPENING: [MOCK] Placeholder read - no model was called.',
      'FOLLOW: -',
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
}
