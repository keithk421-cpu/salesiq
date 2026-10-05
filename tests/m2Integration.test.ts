import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallWrapup } from '../src/shared/help'
import type { Turn } from '../src/shared/contracts'
import { accountMemory } from '../src/main/help/accountMemory'
import type { CallMemory } from '../src/main/help/callMemory'
import { buildHelpContext } from '../src/main/help/context'
import { FOLLOWUP_SYSTEM_PROMPT } from '../src/main/help/followup'
import { type HelpModel, type HelpModelResult, type HelpModelRun, type HelpNotesResult, type HelpNotesRun } from '../src/main/help/models'
import { WRAPUP_SYSTEM_PROMPT } from '../src/main/help/wrapup'
import { HelpService } from '../src/main/helpService'
import type { SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'

// M2 parts built separately meet here: the wrap-up one call leaves behind is what the next call with
// the same account remembers ("Last time with..." and HELP's <earlier_calls>). Invented call details only.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, cost_usd: 0.003 }
const CALL_A = 's-2026-09-29T15-00-00-000Z-aaa111'
const CALL_B = 's-2026-10-05T15-00-00-000Z-bbb222'
const notesAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ topic: null, buyer_wants: [], open_questions: [], concerns: [], facts: [], next_steps: [], not_covered: [], ...over })

/** Structured answers (notes, wrap-up, email) wait for the test. */
class Scripted implements HelpModel {
  readonly mock = false
  calls: Array<{ req: HelpNotesRun; kind: string; release: (text: string) => void }> = []
  label() { return 'scripted' }
  async prewarm() {}
  async check() { return { readiness: 'ready' as const } }
  run(_req: HelpModelRun): Promise<HelpModelResult> { throw new Error('not used') }
  notes(req: HelpNotesRun): Promise<HelpNotesResult> {
    const kind = req.system === WRAPUP_SYSTEM_PROMPT ? 'wrapup' : req.system === FOLLOWUP_SYSTEM_PROMPT ? 'followup' : 'notes'
    return new Promise((resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
      this.calls.push({ req, kind, release: (text) => resolve({ text, usage: USAGE, stop_reason: 'end_turn' }) })
    })
  }
  of(kind: string) {
    return this.calls.filter((c) => c.kind === kind)
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a call\'s wrap-up is what the next call with that account remembers', () => {
  it('promises, the agreed next step and open questions reach "Last time" and HELP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    const model = new Scripted()
    help.setSettings({ prefetch: false })
    help.createModel = () => model
    const wraps: Array<CallWrapup | null> = []
    help.onWrapup = (w) => wraps.push(w)
    let t = 0
    let n = 0
    const state = (st: string, call: string) => help.onSessionEvent({ type: 'state', state: st, sessionId: call } as SessionEvent, call, () => t)
    const say = (who: 'buyer' | 'keith', text: string, call: string, secs = 6) => {
      const start = t
      t += secs * 1000
      const turn: Turn = {
        turn_id: `t${++n}`, session_id: call, stream: who === 'keith' ? 'local_mic' : 'system_remote', speaker_cluster: who === 'keith' ? null : 'e1:s0',
        speaker_identity_id: null, speaker_role: 'unknown', start_ms: start, end_ms: t, text, final: true, source_word_ids: [], gap_before: null,
      }
      help.onSessionEvent({ type: 'turn', event: { type: 'turn_final', turn } } as SessionEvent, call, () => t)
    }

    // Call A with Larkspur Health.
    help.setSetup({ call_type: 'discovery', call_goal: 'Learn how they review chatbot answers', desired_outcomes: ['book a deep-dive'], account: 'Larkspur Health', deployment: 'self_hosted' })
    state('checking', CALL_A)
    state('live', CALL_A)
    say('buyer', 'We review chatbot answers by hand every Friday.', CALL_A)
    say('buyer', 'Does the self-hosted install support Okta?', CALL_A)
    say('keith', "Good question, let me confirm. I'll send you the self-hosted tracing overview by Friday.", CALL_A)
    say('buyer', 'Great. Tuesday at 2 works for the deep-dive with Priya.', CALL_A)
    state('stopping', CALL_A)
    state('stopped', CALL_A)
    await flush()
    // The closing notes pass covers the lines (too little talk for a regular update).
    model.of('notes')[0].release(notesAnswer({ buyer_wants: [{ text: 'Fewer hand reviews of chatbot answers', lines: ['L1'] }] }))
    await flush()
    model.of('wrapup')[0].release(JSON.stringify({
      we_owe: [{ text: 'Send the self-hosted tracing overview', who: 'Keith', when: 'by Friday', lines: ['L3'] }],
      they_owe: [],
      agreed: [{ text: 'Deep-dive with Priya', who: 'Priya', when: 'Tuesday at 2', lines: ['L4'] }],
      proposed: [],
      open_questions: [{ text: 'Does the self-hosted install support Okta?', who: null, when: null, lines: ['L2'] }],
    }))
    await flush()
    expect(wraps.at(-1)).toMatchObject({ session_id: CALL_A, status: 'ready', account: 'Larkspur Health' })

    // "Last time with" reads what the wrap-up stored, grouped by account however it's typed.
    const mem = accountMemory(help.db, '  larkspur   HEALTH ')!
    expect(mem).toMatchObject({ account: 'Larkspur Health', calls: 1 })
    const byKind = (k: string) => mem.items.filter((i) => i.kind === k).map((i) => i.text)
    expect(byKind('promised').join(' ')).toMatch(/Send the self-hosted tracing overview/)
    expect(byKind('promised').join(' ')).toMatch(/by Friday/)
    expect(byKind('agreed').join(' ')).toMatch(/Deep-dive with Priya.*Tuesday at 2/)
    expect(byKind('open').join(' ')).toMatch(/Okta/)
    expect(byKind('wants').join(' ')).toMatch(/Fewer hand reviews/)

    // Call B with the same account: HELP's context carries the earlier call, dated, as past statements.
    help.setSetup({ call_type: 'follow_up', call_goal: '', desired_outcomes: [], account: 'larkspur health', deployment: 'self_hosted' })
    state('checking', CALL_B)
    state('live', CALL_B)
    t += 2000
    say('buyer', 'So where did we land last time?', CALL_B)
    const memory = (help as unknown as { memory: CallMemory }).memory
    expect(memory.sessionId).toBe(CALL_B)
    const ctx = buildHelpContext({ memory, kb: null, atMs: t + 1000 })
    expect(ctx.text).toMatch(/<earlier_calls[^>]*>/)
    expect(ctx.text).toMatch(/Send the self-hosted tracing overview/)
    expect(ctx.text).toMatch(/Okta/)
    // The running call is never its own memory.
    expect(accountMemory(help.db, 'Larkspur Health', CALL_B)!.calls).toBe(1)
  })
})

describe('M2 parts together: review findings', () => {
  function harness(settings: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2b-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    const model = new Scripted()
    help.setSettings({ prefetch: false, ...settings })
    help.createModel = () => model
    const wraps: Array<CallWrapup | null> = []
    help.onWrapup = (w) => wraps.push(w)
    let t = 0
    let n = 0
    const state = (st: string, call: string) => help.onSessionEvent({ type: 'state', state: st, sessionId: call } as SessionEvent, call, () => t)
    const say = (who: 'buyer' | 'keith', text: string, call: string, secs = 6) => {
      const start = t
      t += secs * 1000
      const turn: Turn = {
        turn_id: `t${++n}`, session_id: call, stream: who === 'keith' ? 'local_mic' : 'system_remote', speaker_cluster: who === 'keith' ? null : 'e1:s0',
        speaker_identity_id: null, speaker_role: 'unknown', start_ms: start, end_ms: t, text, final: true, source_word_ids: [], gap_before: null,
      }
      help.onSessionEvent({ type: 'turn', event: { type: 'turn_final', turn } } as SessionEvent, call, () => t)
    }
    const memory = () => (help as unknown as { memory: CallMemory }).memory
    return { dir, help, model, wraps, state, say, memory }
  }
  const setup = (account: string) => ({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account, deployment: 'saas' })
  const WRAP_ANSWER = JSON.stringify({
    we_owe: [{ text: 'Send the self-hosted tracing overview', who: 'Keith', when: 'by Friday', lines: ['L2'] }],
    they_owe: [], agreed: [], proposed: [], open_questions: [],
  })

  it('a call with the same account that started before the last wrap-up landed gets it when it lands', async () => {
    const h = harness()
    h.help.setSetup(setup('Larkspur Health'))
    h.state('checking', CALL_A)
    h.state('live', CALL_A)
    h.say('buyer', 'Could you send how tracing works on our own servers?', CALL_A)
    h.say('keith', "Yes, I'll send you the self-hosted tracing overview by Friday.", CALL_A)
    h.state('stopping', CALL_A)
    h.state('stopped', CALL_A)
    await flush()
    // Keith reconnects with the same account before the closing notes and the wrap-up are back.
    h.help.setSetup(setup('Larkspur Health'))
    h.state('checking', CALL_B)
    h.state('live', CALL_B)
    expect(h.memory().sessionId).toBe(CALL_B)
    expect(h.memory().earlierCalls).toEqual([])
    h.model.of('notes')[0].release(notesAnswer({ buyer_wants: [{ text: 'Tracing on their own servers', lines: ['L1'] }] }))
    await flush()
    expect(h.memory().earlierCalls.map((i) => i.text).join(' ')).toMatch(/Tracing on their own servers/)
    h.model.of('wrapup')[0].release(WRAP_ANSWER)
    await flush()
    expect(h.memory().earlierCalls.map((i) => i.text).join(' ')).toMatch(/Send the self-hosted tracing overview/)
  })

  it("a Start that never goes live leaves the review and ratings on the call that ended", async () => {
    const h = harness()
    h.help.setSetup(setup('Larkspur Health'))
    h.state('checking', CALL_A)
    h.state('live', CALL_A)
    h.say('buyer', 'What does the deep-dive cover?', CALL_A)
    h.help.db.sql.prepare(
      `INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, card_json, timing_json, prefetch)
       VALUES ('r1', ?, 'help_requested', '2026-09-29T15:01:00.000Z', 6000, 'complete', '{}', ?, '{}', 0)`,
    ).run(CALL_A, JSON.stringify({ move: 'clarify_requirement', primary_kind: 'ask', primary: 'Which parts matter most to your team?', source_ids: [] }))
    h.state('stopping', CALL_A)
    h.state('stopped', CALL_A)
    await flush()
    expect(h.help.callCards().map((c) => c.id)).toEqual(['r1'])
    // The next meeting's Start, but the buyer never joins.
    h.state('checking', CALL_B)
    h.state('idle', CALL_B)
    expect(h.help.callCards().map((c) => c.id)).toEqual(['r1'])
    h.help.feedback({ card_id: 'r1', type: 'useful' })
    const card = JSON.parse(fs.readFileSync(path.join(h.dir, 'reports', `help-scorecard-${CALL_A}.json`), 'utf8'))
    expect(card.feedback.useful).toBe(1)
  })
})
