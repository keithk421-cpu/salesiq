import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HelpModelConfig } from '../src/shared/help'
import { HelpService } from '../src/main/helpService'
import { ClaudeHelpModel, DEFAULT_HELP_CONFIG, type HelpModel, type HelpModelResult, type HelpReadiness } from '../src/main/help/models'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const H = new Headers()
const credit = () => new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, undefined, H)
const overloaded = () => new Anthropic.InternalServerError(529, {}, 'Overloaded', H)
const LINES = 'MOVE: clarify_current_state\nASK: How does that work today?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'
const OK: HelpModelResult = { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 }, stop_reason: 'end_turn', served_model: 'x', fell_back: false }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A ClaudeHelpModel talking to a stand-in for the Anthropic client. */
function claudeWith(fake: { retrieve?: () => Promise<unknown>; stream?: (opts: { timeout?: number; maxRetries?: number }) => AsyncIterable<unknown> }) {
  const calls: Array<{ timeout?: number; maxRetries?: number }> = []
  const client = {
    models: { retrieve: fake.retrieve ?? (async () => ({})) },
    beta: {
      messages: {
        stream: (_p: unknown, opts: { timeout?: number; maxRetries?: number }) => {
          calls.push(opts)
          const it = fake.stream!(opts)
          return { [Symbol.asyncIterator]: () => it[Symbol.asyncIterator](), finalMessage: async () => ({ usage: { input_tokens: 1, output_tokens: 1 }, content: [], model: 'claude-sonnet-5-5', stop_reason: 'end_turn' }) }
        },
      },
    },
  }
  return { model: new ClaudeHelpModel('sk-ant-test', client as unknown as Anthropic), calls }
}

const delta = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })

describe('HELP-ready light: what the free check says', () => {
  const cases: Array<[string, () => unknown, HelpReadiness]> = [
    ['out of credit', credit, 'no_credit'],
    ['too many requests', () => new Anthropic.RateLimitError(429, {}, 'x', H), 'busy'],
    ['overloaded', overloaded, 'busy'],
    ['server error', () => new Anthropic.InternalServerError(500, {}, 'x', H), 'busy'],
    ['no connection', () => new Anthropic.APIConnectionError({ message: 'fetch failed' }), 'offline'],
    ['connection timed out', () => new Anthropic.APIConnectionTimeoutError(), 'offline'],
    ['key rejected', () => new Anthropic.AuthenticationError(401, {}, 'x', H), 'key_rejected'],
    ['model not available', () => new Anthropic.NotFoundError(404, {}, 'x', H), 'unavailable'],
  ]
  for (const [what, err, want] of cases) {
    it(`${what} -> ${want}`, async () => {
      const { model } = claudeWith({ retrieve: async () => { throw err() } })
      expect((await model.check(DEFAULT_HELP_CONFIG)).readiness).toBe(want)
    })
  }

  it('says Claude is busy in plain words', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    help.createModel = () => ({ mock: false, label: () => 'x', prewarm: async () => {}, check: async () => ({ readiness: 'busy' as const }), run: async () => OK })
    expect(await help.checkReady()).toEqual({ readiness: 'busy', message: 'Claude is busy right now; press HELP again' })
    help.shutdown()
  })
})

describe('HELP-ready light follows what presses actually see', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    const checks: Array<(r: HelpReadiness) => void> = []
    let next: () => Promise<HelpModelResult> = async () => OK
    const model: HelpModel = {
      mock: false, label: () => 'x', prewarm: async () => {},
      check: () => new Promise((resolve) => checks.push((readiness) => resolve({ readiness }))),
      run: async (req) => {
        const r = await next()
        req.onText(LINES)
        return r
      },
    }
    help.createModel = () => model
    const seen: string[] = []
    help.onReadiness = (r) => seen.push(r.readiness)
    const flush = () => new Promise((r) => setTimeout(r, 0))
    const press = async (outcome: () => Promise<HelpModelResult>) => {
      next = outcome
      expect(help.press().ok).toBe(true)
      await flush()
    }
    const startCall = async () => {
      help.onSessionEvent({ type: 'state', state: 'checking', sessionId: 's-1' }, 's-1', () => 0)
      help.onSessionEvent({ type: 'state', state: 'live', sessionId: 's-1' }, 's-1', () => 0)
      await flush()
    }
    return { help, checks, seen, press, startCall, flush }
  }

  it("a call-start check that said 'offline' turns green when a press gets through", async () => {
    const s = setup()
    await s.startCall()
    s.checks.shift()!('offline')
    await s.flush()
    expect(s.help.ready.readiness).toBe('offline')
    await s.press(async () => OK)
    expect(s.help.ready.readiness).toBe('ready')
    s.help.shutdown()
  })

  it('every failed press updates the light, even the same failure twice after a green check', async () => {
    const s = setup()
    await s.startCall()
    s.checks.shift()!('ready')
    await s.flush()
    await s.press(async () => { throw credit() })
    expect(s.help.ready.readiness).toBe('no_credit')
    // Clicking the light: the free check doesn't need credit, so it says ready.
    const click = s.help.checkReady()
    s.checks.shift()!('ready')
    await click
    expect(s.help.ready.readiness).toBe('ready')
    await s.press(async () => { throw credit() })
    expect(s.help.ready.readiness).toBe('no_credit')
    // Busy is its own state; a timeout says nothing new about the key or the connection.
    await s.press(async () => { throw overloaded() })
    expect(s.help.ready).toEqual({ readiness: 'busy', message: 'Claude is busy right now; press HELP again' })
    await s.press(async () => { throw new Anthropic.APIConnectionTimeoutError() })
    expect(s.help.ready.readiness).toBe('busy')
    await s.press(async () => { throw new Anthropic.APIConnectionError({ message: 'fetch failed' }) })
    expect(s.help.ready.readiness).toBe('offline')
    s.help.shutdown()
  })

  it('an older check finishing last never overwrites a newer result', async () => {
    const s = setup()
    const first = s.help.checkReady()
    const second = s.help.checkReady()
    s.checks[1]('ready')
    await second
    s.checks[0]('offline')
    await first
    expect(s.help.ready.readiness).toBe('ready')
    // A press that got through while a slow check was out wins over that check too.
    await s.startCall()
    const slow = s.checks.at(-1)!
    await s.press(async () => OK)
    slow('offline')
    await s.flush()
    expect(s.help.ready.readiness).toBe('ready')
    s.help.shutdown()
  })
})

describe('HELP retries by hand, within the 8 s budget', () => {
  const run = (model: ClaudeHelpModel, signal = new AbortController().signal) => {
    let text = ''
    return { text: () => text, done: model.run({ system: 's', user: 'u', config: DEFAULT_HELP_CONFIG as HelpModelConfig, signal, onText: (c) => (text += c) }) }
  }

  it('the client itself never retries (a 429 would wait past the deadline)', () => {
    expect((new ClaudeHelpModel('sk-ant-test') as unknown as { client: Anthropic }).client.maxRetries).toBe(0)
  })

  it('retries once when Claude is overloaded before any text arrived, with the time that is left', async () => {
    vi.useFakeTimers()
    let n = 0
    const { model, calls } = claudeWith({
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          if (n++ === 0) {
            vi.setSystemTime(Date.now() + 2000)
            throw overloaded()
          }
          yield delta('ASK: hi\n')
        },
      }),
    })
    const r = run(model)
    await expect(r.done).resolves.toMatchObject({ stop_reason: 'end_turn' })
    expect(r.text()).toBe('ASK: hi\n')
    expect(calls.map((c) => c.timeout)).toEqual([8000, 6000])
  })

  it('also retries a dropped connection', async () => {
    let n = 0
    const { model, calls } = claudeWith({
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          if (n++ === 0) throw new Anthropic.APIConnectionError({ message: 'socket hang up' })
          yield delta('ASK: hi\n')
        },
      }),
    })
    await expect(run(model).done).resolves.toBeTruthy()
    expect(calls).toHaveLength(2)
  })

  const once = (name: string, err: () => unknown, opts: { afterText?: boolean; elapsedMs?: number; abort?: boolean } = {}) =>
    it(name, async () => {
      vi.useFakeTimers()
      const ac = new AbortController()
      const { model, calls } = claudeWith({
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            if (opts.afterText) yield delta('ASK: half a li')
            if (opts.elapsedMs) vi.setSystemTime(Date.now() + opts.elapsedMs)
            if (opts.abort) ac.abort()
            throw err()
          },
        }),
      })
      await expect(run(model, ac.signal).done).rejects.toBeTruthy()
      expect(calls).toHaveLength(1)
    })

  once('a 429 comes straight back (Keith sees "Too many requests")', () => new Anthropic.RateLimitError(429, {}, 'x', H))
  once('no retry once text has streamed', overloaded, { afterText: true })
  once('no retry with less than 3 s left', overloaded, { elapsedMs: 5500 })
  once('no retry after HELP was cancelled', overloaded, { abort: true })
  once('no retry for a rejected key', () => new Anthropic.AuthenticationError(401, {}, 'x', H))
})
