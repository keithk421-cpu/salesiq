import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallNotes, CallNotesState, HelpModelConfig } from '../src/shared/help'
import type { Turn } from '../src/shared/contracts'
import { Db } from '../src/main/db'
import { CallMemory } from '../src/main/help/callMemory'
import { CALL_NOTES_BLOCK_MAX_CHARS, EMPTY_NOTES, NOTES_SCHEMA, NOTES_SYSTEM_PROMPT, callNotesBlock, validateNotes } from '../src/main/help/callNotes'
import { CallNotesKeeper, NOTES_MAX_PER_HOUR, NOTES_MIN_GAP_MS } from '../src/main/help/callNotesKeeper'
import { buildHelpContext } from '../src/main/help/context'
import { HelpEngine } from '../src/main/help/engine'
import { ClaudeHelpModel, DEFAULT_HELP_CONFIG, MockHelpModel, type HelpError, type HelpModel, type HelpModelRun, type HelpModelResult, type HelpNotesRun, type HelpNotesResult } from '../src/main/help/models'
import { buildSystemPrompt, loadPlaybook } from '../src/main/help/prompt'
import { buildScorecard } from '../src/main/help/scorecard'
import { replayAt } from '../src/main/help/replay'
import { deleteCall } from '../src/main/retention'
import { HelpService } from '../src/main/helpService'
import type { SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const config: HelpModelConfig = { ...DEFAULT_HELP_CONFIG }
const USAGE = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, cost_usd: 0.004 }

/** Notes JSON in the shape the model answers in (line ids, not turn ids). */
function answer(over: Partial<Record<keyof CallNotes, unknown>> = {}): string {
  return JSON.stringify({
    topic: { text: 'How they review model outputs', lines: ['L1'] },
    buyer_wants: [], open_questions: [], concerns: [], facts: [], next_steps: [], not_covered: ['timeline', 'decision_process', 'success_criteria'],
    ...over,
  })
}

/** A notes model whose answers are released by the test. HELP's own run() isn't used here. */
class ScriptedNotes implements HelpModel {
  readonly mock = false
  /** Simulate a network that keeps delivering after cancellation (late answers). */
  constructor(private readonly ignoreAbort = false) {}
  calls: Array<{ req: HelpNotesRun; release: (text: string, stop?: string) => void; fail: (e: unknown) => void }> = []
  label() { return 'scripted' }
  async prewarm() {}
  async check() { return { readiness: 'ready' as const } }
  run(_req: HelpModelRun): Promise<HelpModelResult> { throw new Error('not used') }
  notes(req: HelpNotesRun): Promise<HelpNotesResult> {
    return new Promise((resolve, reject) => {
      if (!this.ignoreAbort) req.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
      this.calls.push({ req, release: (text, stop = 'end_turn') => resolve({ text, usage: USAGE, stop_reason: stop }), fail: reject })
    })
  }
}

/** A real-looking (non-mock) model for the app: HELP runs and notes updates both wait for the test. */
class ScriptedApp extends ScriptedNotes {
  runs: Array<{ req: HelpModelRun; ok: () => void; fail: (e: unknown) => void }> = []
  override run(req: HelpModelRun): Promise<HelpModelResult> {
    return new Promise((resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
      this.runs.push({
        req,
        ok: () => {
          req.onText('MOVE: clarify_current_state\nASK: How does that work today?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n')
          resolve({ usage: USAGE, stop_reason: 'end_turn', served_model: 'scripted', fell_back: false })
        },
        fail: reject,
      })
    })
  }
}

function setup(opts: { enabled?: boolean; model?: HelpModel; onResult?: (e: HelpError | null) => void } = {}) {
  const model = opts.model ?? new ScriptedNotes()
  const db = new Db(':memory:')
  const memory = new CallMemory('sess-1', db)
  memory.setup = { call_type: 'discovery', call_goal: 'Learn how they evaluate LLM outputs', desired_outcomes: [], account: 'Northwind', deployment: 'unknown' }
  memory.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana' })
  let sessionMs = 0
  let wall = 1_760_000_000_000
  let busy = false
  const states: CallNotesState[] = []
  const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
  const keeper = new CallNotesKeeper({
    memory, model, config, db, sessionNowMs: () => sessionMs, helpBusy: () => busy, emit: (s) => states.push(s),
    log: (e, d) => logs.push({ e, d }), enabled: opts.enabled ?? true, now: () => wall, onResult: opts.onResult,
  })
  let n = 0
  /** One finished line; `secs` long. */
  const say = (who: 'buyer' | 'keith', text: string, secs = 10): string => {
    const id = `t${++n}`
    const start = sessionMs
    sessionMs += secs * 1000
    wall += secs * 1000
    memory.upsertTurn({ id, stream: who === 'keith' ? 'local_mic' : 'system_remote', cluster: who === 'keith' ? null : 'e1:s0', start_ms: start, end_ms: sessionMs, text, available_ms: sessionMs }, true)
    keeper.onFinalTurn(id)
    return id
  }
  return {
    model: model as ScriptedNotes, db, memory, keeper, states, logs, say,
    setBusy: (b: boolean) => { busy = b },
    wait: (ms: number) => { wall += ms; sessionMs += ms },
    /** About a minute of the buyer talking, in three lines. */
    buyerMinute: (tag: string) => ['first', 'second', 'third'].map((w) => say('buyer', `${tag} ${w} part of what they said about their review process`, 21)),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('when call notes update', () => {
  it("after about a minute of new talk from the other side; Keith's own talk doesn't count", () => {
    const s = setup()
    s.keeper.resume()
    for (let i = 0; i < 9; i++) s.say('keith', 'Let me tell you a bit about how we think about evaluation', 10)
    expect(s.model.calls).toHaveLength(0)
    s.say('buyer', 'We review samples every week.', 30)
    expect(s.model.calls).toHaveLength(0)
    s.say('buyer', 'The platform team owns it and the applied folks help.', 35)
    expect(s.model.calls).toHaveLength(1)
    expect(s.logs.find((l) => l.e === 'call_notes_start')?.d).toMatchObject({ lines: 11, remote_speech_ms: 65_000 })
  })

  it('a word threshold also counts (fast talkers)', () => {
    const s = setup()
    s.keeper.resume()
    s.say('buyer', Array.from({ length: 160 }, (_, i) => `word${i}`).join(' '), 40)
    expect(s.model.calls).toHaveLength(1)
  })

  it('only while live: nothing before the call goes live', () => {
    const s = setup()
    s.buyerMinute('Before live')
    expect(s.model.calls).toHaveLength(0)
    s.keeper.resume()
    expect(s.model.calls).toHaveLength(1) // the queued talk counts once live
  })

  it('never starts while a HELP request Keith pressed is being answered; the next finished line checks again', () => {
    const s = setup()
    s.keeper.resume()
    s.setBusy(true)
    s.buyerMinute('During HELP')
    expect(s.model.calls).toHaveLength(0)
    s.setBusy(false)
    s.say('buyer', 'Anyway.', 2)
    expect(s.model.calls).toHaveLength(1)
  })

  it('one request at a time', () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('One')
    s.buyerMinute('Two')
    expect(s.model.calls).toHaveLength(1)
    expect(s.states.at(-1)?.status).toBe('updating')
  })

  it(`spread out: at most one every ${NOTES_MIN_GAP_MS / 60_000} minutes (${NOTES_MAX_PER_HOUR} an hour); the next line after the gap starts it`, async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('One')
    s.model.calls[0].release(answer())
    await vi.advanceTimersByTimeAsync(0)
    s.buyerMinute('Two')
    s.buyerMinute('Three')
    expect(s.model.calls).toHaveLength(1)
    expect(s.logs.filter((l) => l.e === 'call_notes_capped')).toHaveLength(1) // once per wait
    expect(s.keeper.stats.capped).toBe(1)
    s.wait(NOTES_MIN_GAP_MS)
    s.say('keith', 'Got it.', 2)
    expect(s.model.calls).toHaveLength(2)
    expect(s.model.calls[1].req.user).toContain('Three third part')
  })

  it('keeps updating to the end of an hour-long call where the buyer talks half the time', async () => {
    const s = setup()
    s.keeper.resume()
    const starts: number[] = []
    const line = async (who: 'buyer' | 'keith', text: string) => {
      s.say(who, text, 15)
      // Every answer comes back right away.
      for (const c of s.model.calls.slice(starts.length)) {
        starts.push(s.memory.turnsAsOf(Infinity).at(-1)!.end_ms)
        c.release(answer())
        await vi.advanceTimersByTimeAsync(0)
      }
    }
    // 15 s from the buyer, 15 s from Keith, for 60 minutes.
    for (let i = 0; i < 120; i++) {
      await line('buyer', `Point ${i} about how their team reviews releases today`)
      await line('keith', 'Okay, and then?')
    }
    expect(starts.length).toBeLessThanOrEqual(NOTES_MAX_PER_HOUR)
    expect(starts.length).toBeGreaterThanOrEqual(NOTES_MAX_PER_HOUR - 2)
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(NOTES_MIN_GAP_MS)
    // Next steps are mostly agreed near the end: the notes are still updating then.
    expect(starts.at(-1)!).toBeGreaterThan(50 * 60_000)
  })

  it('Pause cancels an update in flight and drops its late answer; nothing runs while paused', async () => {
    const s = setup({ model: new ScriptedNotes(true) })
    s.keeper.resume()
    s.buyerMinute('Before pause')
    const first = s.model.calls[0]
    s.keeper.pause()
    expect(first.req.signal.aborted).toBe(true)
    first.release(answer())
    await vi.advanceTimersByTimeAsync(0)
    expect(s.keeper.state()).toMatchObject({ status: 'paused', notes: null })
    expect(s.keeper.stats.cancelled).toBe(1)
    s.buyerMinute('While paused')
    s.wait(NOTES_MIN_GAP_MS)
    expect(s.model.calls).toHaveLength(1)
    s.keeper.resume()
    expect(s.model.calls).toHaveLength(2)
    // Nothing was lost: the cancelled update's lines go with the next one.
    expect(s.model.calls[1].req.user).toContain('Before pause first part')
  })

  it('Stop ends updates and keeps the notes readable', async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('Opening')
    s.model.calls[0].release(answer())
    await vi.advanceTimersByTimeAsync(0)
    s.keeper.stop()
    s.buyerMinute('After stop')
    expect(s.model.calls).toHaveLength(1)
    expect(s.keeper.state()).toMatchObject({ status: 'stopped', updates: 1, notes: { topic: { text: 'How they review model outputs' } } })
  })

  it('a key, credit or model-access error stops updates until a request succeeds again', async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('One')
    s.model.calls[0].fail(new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.keeper.state()).toMatchObject({ status: 'blocked', problem: 'Claude rejected the API key. Check it in Setup, step 3.' })
    s.wait(NOTES_MIN_GAP_MS)
    s.buyerMinute('Two')
    expect(s.model.calls).toHaveLength(1)
    // A HELP press that works lifts it.
    s.keeper.onHelpResult(null)
    s.say('buyer', 'So yes.', 2)
    expect(s.model.calls).toHaveLength(2)
  })

  it("HELP's own key or credit error stops notes too; a busy Claude doesn't", () => {
    const s = setup()
    s.keeper.resume()
    s.keeper.onHelpResult({ code: 'overloaded', message: 'Claude is busy right now. Press HELP again.', blocking: false })
    s.keeper.onHelpResult({ code: 'no_credit', message: 'The Anthropic account is out of credit. Add credit, then press HELP again.', blocking: true })
    s.buyerMinute('One')
    expect(s.model.calls).toHaveLength(0)
    expect(s.keeper.state().status).toBe('blocked')
  })

  it('setting off: no requests and the panel says so', () => {
    const s = setup({ enabled: false })
    s.keeper.resume()
    s.buyerMinute('One')
    expect(s.model.calls).toHaveLength(0)
    expect(s.keeper.state().status).toBe('off')
  })
})

describe('what an update sends and keeps', () => {
  it('delta-only: the previous notes, the lines since them and the call setup, never the whole call', async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('Early')
    const first = s.model.calls[0].req
    expect(first.user).toContain('<previous_notes>\n(none yet)')
    expect(first.user).toMatch(/\[L1\] \(0:00\) Dana \(buyer\): Early first part/)
    s.model.calls[0].release(answer({ facts: [{ kind: 'current_tooling', text: 'They use an in-house dashboard', lines: ['L2'] }] }))
    await vi.advanceTimersByTimeAsync(0)
    s.wait(NOTES_MIN_GAP_MS)
    s.say('keith', 'How often do you look at it?', 5)
    s.buyerMinute('Later')
    const second = s.model.calls[1].req
    expect(second.user).toContain('"text":"They use an in-house dashboard","lines":["L2"]')
    expect(second.user).toMatch(/\[L4\] \(4:03\) Keith: How often do you look at it\?/)
    expect(second.user).toContain('Later first part')
    expect(second.user).not.toContain('Early first part')
    expect(second.user).toMatch(/<call_setup>[\s\S]*account: Northwind[\s\S]*<\/call_setup>/)
    // Same model, thinking and effort as HELP; cached stable system prompt; a JSON schema for the answer.
    expect(second).toMatchObject({ system: NOTES_SYSTEM_PROMPT, schema: NOTES_SCHEMA, config })
  })

  it('a broken answer keeps the previous notes; the lines stay queued and are retried after the gap', async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('Early')
    s.model.calls[0].release(answer())
    await vi.advanceTimersByTimeAsync(0)
    const before = s.keeper.state().notes
    s.wait(NOTES_MIN_GAP_MS)
    s.buyerMinute('Middle')
    s.model.calls[1].release('Sorry, here are the notes: {not json')
    await vi.advanceTimersByTimeAsync(0)
    expect(s.keeper.state().notes).toEqual(before)
    expect(s.keeper.stats).toMatchObject({ updated: 1, invalid: 1, errors: { not_json: 1 } })
    s.say('buyer', 'One more thing.', 2)
    expect(s.model.calls).toHaveLength(2) // waits before trying again
    s.wait(NOTES_MIN_GAP_MS)
    s.say('buyer', 'And another.', 2)
    expect(s.model.calls).toHaveLength(3)
    expect(s.model.calls[2].req.user).toContain('Middle first part')
    // A missing list, a cut-off answer and a refusal are broken too.
    s.model.calls[2].release(JSON.stringify({ topic: null, buyer_wants: [], open_questions: [], concerns: [], next_steps: [], not_covered: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(s.keeper.stats.errors).toMatchObject({ bad_facts: 1 })
    expect(s.keeper.state().notes).toEqual(before)
    s.wait(NOTES_MIN_GAP_MS)
    s.say('buyer', 'Right.', 2)
    s.model.calls[3].release(answer(), 'max_tokens')
    await vi.advanceTimersByTimeAsync(0)
    expect(s.keeper.stats.errors).toMatchObject({ max_tokens: 1 })
    expect(s.keeper.state().notes).toEqual(before)
  })

  it('stores the latest notes per call with counts; logs carry counts and codes, never note or call text', async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('Early')
    s.model.calls[0].release(answer({ open_questions: [{ text: 'Does it work with their SECRETSTACK?', lines: ['L3'] }] }))
    await vi.advanceTimersByTimeAsync(0)
    const row = s.db.sql.prepare('SELECT notes_json, as_of_ms, stats_json FROM call_notes WHERE session_id = ?').get('sess-1') as { notes_json: string; as_of_ms: number; stats_json: string }
    expect(JSON.parse(row.notes_json).open_questions).toEqual([{ text: 'Does it work with their SECRETSTACK?', turn_ids: ['t3'] }])
    expect(row.as_of_ms).toBe(63_000)
    expect(JSON.parse(row.stats_json)).toMatchObject({ started: 1, updated: 1, cost_usd: 0.004 })
    const logs = JSON.stringify(s.logs)
    expect(logs).not.toMatch(/SECRETSTACK|review process|Early|Northwind|outputs/)
    expect(s.logs.find((l) => l.e === 'call_notes_done')?.d).toMatchObject({ status: 'updated', items: { open_questions: 1, not_covered: 3 }, cost_usd: 0.004 })
  })
})

describe('checking the answer', () => {
  const lines = new Map([['L1', 't1'], ['L2', 't2'], ['L3', 't3']])

  it('only from what was said: an item citing no line that was sent is dropped; ids map back to turns', () => {
    const v = validateNotes(answer({
      buyer_wants: [{ text: 'Fewer manual reviews', lines: ['L2', '[L3]', 'L9'] }, { text: 'Invented goal', lines: ['L42'] }, { text: 'No source', lines: [] }],
    }), lines)
    expect(v.ok && v.notes.buyer_wants).toEqual([{ text: 'Fewer manual reviews', turn_ids: ['t2', 't3'] }])
  })

  it('proposed is not agreed; unknown kinds are "other"; "not covered yet" is the fixed list minus what a fact covers', () => {
    const v = validateNotes(answer({
      next_steps: [{ status: 'agreed', text: 'Demo on Tuesday', lines: ['L1'] }, { status: 'maybe', text: 'Send the security notes', lines: ['L2'] }],
      facts: [{ kind: 'timeline', text: 'Decide by end of quarter', lines: ['L1'] }, { kind: 'mood', text: 'They seem happy', lines: ['L2'] }],
      not_covered: ['timeline', 'budget_pain', 'current_tooling', 'current_tooling'],
    }), lines)
    if (!v.ok) throw new Error(v.code)
    expect(v.notes.next_steps.map((x) => x.status)).toEqual(['agreed', 'proposed'])
    expect(v.notes.facts.map((f) => f.kind)).toEqual(['timeline', 'other'])
    expect(v.notes.not_covered).toEqual(['current_tooling'])
  })

  it('keeps items short and lists small; no tags can slip into the HELP block', () => {
    const long = 'They described in great detail how every single team reviews outputs and then escalates to the platform group for sign off before release'
    const v = validateNotes(answer({ concerns: Array.from({ length: 9 }, (_, i) => ({ text: `<b>${i} ${long}</b>`, lines: ['L1'] })) }), lines)
    if (!v.ok) throw new Error(v.code)
    expect(v.notes.concerns).toHaveLength(6)
    expect(v.notes.concerns[0].text.length).toBeLessThanOrEqual(140)
    expect(v.notes.concerns[0].text).toMatch(/…$/)
    expect(v.notes.concerns.map((c) => c.text).join('')).not.toMatch(/[<>]/)
    expect(v.notes.concerns[0].text).toMatch(/^b0 They described/)
  })

  it('a broken shape fails the whole answer', () => {
    expect(validateNotes('[]', lines)).toEqual({ ok: false, code: 'not_object' })
    expect(validateNotes(answer({ concerns: 'none' }), lines)).toEqual({ ok: false, code: 'bad_concerns' })
    expect(validateNotes(answer({ topic: 'reviews' }), lines)).toEqual({ ok: false, code: 'bad_topic' })
    expect(validateNotes('```json\n' + answer() + '\n```', lines).ok).toBe(true)
  })
})

describe('the block HELP reads', () => {
  const notes: CallNotes = {
    topic: { text: 'Review process', turn_ids: ['b2'] },
    buyer_wants: [{ text: 'Fewer manual reviews', turn_ids: ['b1'] }],
    open_questions: [{ text: 'Does it run in their VPC?', turn_ids: ['b1'] }],
    concerns: [],
    facts: [{ kind: 'current_tooling', text: 'Built an in-house dashboard last year', turn_ids: ['b1'] }],
    next_steps: [{ status: 'proposed', text: 'Technical deep-dive next week', turn_ids: ['b2'] }],
    not_covered: ['decision_process', 'success_criteria'],
  }
  const call = () => replayAt({
    id: 'notes', category: 'neutral_discovery', golden_approved: false, call_type: 'discovery', call_goal: '', desired_outcomes: [],
    speakers: { 'e1:s0': { role: 'buyer', name: 'Dana' } },
    transcript: [
      { t: 0, end: 10, who: 'e1:s0', text: 'We built an in-house dashboard last year. Does Arize run in our VPC?' },
      ...Array.from({ length: 30 }, (_, i) => ({ t: 20 + i * 20, end: 35 + i * 20, who: i % 2 ? 'keith' : 'e1:s0', text: `Filler talk number ${i} about charts.` })),
    ],
    help_at_s: 640, best_moves: [], acceptable_moves: [], unacceptable_behaviors: [],
  })

  it('is absent without notes, so practice moments and tests build exactly what they did before', () => {
    const r = call()
    const ctx = buildHelpContext({ memory: r.memory, kb: null, atMs: r.atMs })
    expect(ctx.text).not.toContain('<call_notes')
  })

  it("is one compact block after the participants, citing early lines as sources (the card's sources show the real line)", () => {
    const r = call()
    const early = r.memory.turnsAsOf(r.atMs)[0]
    r.memory.callNotes = { notes: { ...notes, open_questions: [{ text: 'Does it run in their VPC?', turn_ids: [early.id] }] }, as_of_ms: 600_000 }
    const ctx = buildHelpContext({ memory: r.memory, kb: null, atMs: r.atMs })
    const block = /<call_notes[\s\S]*?<\/call_notes>/.exec(ctx.text)?.[0] ?? ''
    expect(block).toMatch(/^<call_notes note="running summary of the call up to 10:00; may lag; the transcript wins if they disagree">/)
    expect(block).toMatch(/Open questions \(not answered yet\): Does it run in their VPC\? \[T1\]/)
    expect(block).toContain('Next steps: proposed, not agreed: Technical deep-dive next week')
    expect(block).toContain('Facts they stated: tools: Built an in-house dashboard last year')
    expect(block).toContain('Not covered yet: decision process; success criteria')
    expect(ctx.sources.get('T1')).toMatchObject({ kind: 'turn', detail: early.text })
    // The early line itself is out of HELP's 30 s / thread window; the notes bring it back.
    expect(ctx.text.indexOf('</participants>')).toBeLessThan(ctx.text.indexOf('<call_notes'))
    expect(ctx.text.indexOf('<call_notes')).toBeLessThan(ctx.text.indexOf('<last_30_seconds>'))
    // Never in the cached system prompt.
    expect(buildSystemPrompt(playbook)).not.toContain('call_notes')
  })

  it(`stays within ${CALL_NOTES_BLOCK_MAX_CHARS} characters however much was noted`, () => {
    const many = (k: string) => Array.from({ length: 6 }, (_, i) => ({ text: `${k} item ${i} with quite a lot of words in it to fill the space up nicely`, turn_ids: ['b1'] }))
    const big: CallNotes = { ...notes, buyer_wants: many('want'), open_questions: many('question'), concerns: many('concern'), facts: many('fact').map((f) => ({ ...f, kind: 'team' as const })) }
    const block = callNotesBlock({ notes: big, as_of_ms: 0 }, 1000, { ref: () => 'T123', clock: () => '0:00' })!
    expect(block.length).toBeLessThanOrEqual(CALL_NOTES_BLOCK_MAX_CHARS)
    expect(block).toMatch(/^<call_notes[^>]*>\nOpen questions[\s\S]*<\/call_notes>$/)
  })

  it("sections share the room: a long list of questions doesn't push out the facts, wants or next steps", () => {
    // Items about 12 words long, as the notes prompt asks.
    const q = (i: number) => ({ text: `Question ${i}: can it score their support bot answers against help articles`, turn_ids: ['b1'] })
    const f = (i: number) => ({ kind: 'current_tooling' as const, text: `Fact ${i}: they copy every prompt and answer into a warehouse table nightly`, turn_ids: ['b1'] })
    const opts = { ref: () => 'T123', clock: () => '42:10' }
    const count = (b: string, re: RegExp) => b.match(re)?.length ?? 0
    const many = callNotesBlock({ notes: { ...EMPTY_NOTES, open_questions: [0, 1, 2, 3, 4, 5].map(q), facts: [0, 1, 2, 3, 4].map(f) }, as_of_ms: 0 }, 1, opts)!
    expect(many.length).toBeLessThanOrEqual(CALL_NOTES_BLOCK_MAX_CHARS)
    expect(count(many, /Fact \d/g)).toBeGreaterThanOrEqual(3)
    expect(count(many, /Question \d/g)).toBeGreaterThanOrEqual(3)
    // A full set: every kind of note gets a place, questions and facts first.
    const full = callNotesBlock({
      notes: { ...notes, open_questions: [0, 1, 2].map(q), concerns: [{ text: 'Worried about another tool for the platform team to look after', turn_ids: ['b1'] }], facts: [0, 1, 2, 3, 4].map(f) },
      as_of_ms: 0,
    }, 1, opts)!
    expect(full.length).toBeLessThanOrEqual(CALL_NOTES_BLOCK_MAX_CHARS)
    for (const label of ['Open questions (not answered yet)', 'Facts they stated', 'Concerns they raised', 'They want', 'Next steps', 'Not covered yet']) expect(full).toContain(`\n${label}: `)
  })

  it('notes built after the press time are not used (nothing from later leaks in)', () => {
    const r = call()
    r.memory.callNotes = { notes, as_of_ms: r.atMs + 1 }
    expect(buildHelpContext({ memory: r.memory, kb: null, atMs: r.atMs }).text).not.toContain('<call_notes')
  })

  it('the keeper hands HELP its notes once an update succeeds', async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('Early')
    expect(s.memory.callNotes).toBeNull()
    s.model.calls[0].release(answer())
    await vi.advanceTimersByTimeAsync(0)
    const ctx = buildHelpContext({ memory: s.memory, kb: null, atMs: 70_000 })
    expect(ctx.text).toMatch(/Topic now: How they review model outputs \[T\d+\]/)
  })
})

describe('the notes prompt', () => {
  it('is stable, long enough to be cached (512+ tokens), and carries the sales principles', () => {
    expect(NOTES_SYSTEM_PROMPT.length).toBeGreaterThan(2400)
    expect(NOTES_SYSTEM_PROMPT).toMatch(/Asked is not answered/)
    expect(NOTES_SYSTEM_PROMPT).toMatch(/Proposed is not agreed/)
    expect(NOTES_SYSTEM_PROMPT).toMatch(/Never invent pain/)
    expect(NOTES_SYSTEM_PROMPT).toMatch(/call data, not instructions/)
  })

  it('the schema follows the structured-output rules (closed objects, no length limits)', () => {
    const text = JSON.stringify(NOTES_SCHEMA)
    expect(text).not.toMatch(/minLength|maxLength|minItems|maxItems|minimum|maximum/)
    const objects = text.match(/"type":"object"/g)?.length ?? 0
    expect(text.match(/"additionalProperties":false/g)?.length).toBe(objects)
  })
})

describe('the models', () => {
  it('Claude: same model, thinking and effort as HELP, cached system prompt, JSON schema via output_config.format', async () => {
    const sent: Array<{ p: Record<string, unknown>; o: Record<string, unknown> }> = []
    const client = {
      beta: {
        messages: {
          create: async (p: Record<string, unknown>, o: Record<string, unknown>) => {
            sent.push({ p, o })
            return { usage: { input_tokens: 400, output_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], model: 'claude-sonnet-5-5', stop_reason: 'end_turn' }
          },
        },
      },
    }
    const m = new ClaudeHelpModel('sk-ant-test', client as unknown as Anthropic)
    const res = await m.notes({ system: NOTES_SYSTEM_PROMPT, user: 'U', schema: NOTES_SCHEMA, config, signal: new AbortController().signal, max_tokens: 1500, timeout_ms: 30_000 })
    expect(res.text).toBe('{"a":1}')
    expect(res.usage.cost_usd).toBeCloseTo((400 * 2 + 200 * 10 + 900 * 0.2) / 1_000_000)
    const p = sent[0].p
    expect(p).toMatchObject({
      model: 'claude-sonnet-5-5', max_tokens: 1500, stream: false, thinking: { type: 'between_tools' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
      system: [{ type: 'text', text: NOTES_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'U' }],
    })
    expect(p).not.toHaveProperty('output_format')
    expect(sent[0].o).toMatchObject({ timeout: 30_000 })
  })

  it('the mock gives deterministic notes labelled MOCK, citing the newest line', async () => {
    vi.useRealTimers()
    const r = await new MockHelpModel(0).notes({ system: '', user: '<previous_notes>\n(none yet)\n</previous_notes>\n[L1] a\n[L2] b', schema: NOTES_SCHEMA, config, signal: new AbortController().signal, max_tokens: 1, timeout_ms: 1 })
    const v = validateNotes(r.text, new Map([['L1', 't1'], ['L2', 't2']]))
    expect(v.ok && v.notes.topic).toEqual({ text: '[MOCK] Placeholder notes - no model was called', turn_ids: ['t2'] })
  })
})

describe('HELP and the notes', () => {
  it('a pressed HELP request counts as in flight until it finishes; a background candidate does not', async () => {
    let release: (() => void) | null = null
    const model: HelpModel = {
      mock: false, label: () => 'x', prewarm: async () => {}, check: async () => ({ readiness: 'ready' as const }),
      run: (req) => new Promise((resolve) => {
        release = () => {
          req.onText('MOVE: clarify_current_state\nASK: How does that work today?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n')
          resolve({ usage: USAGE, stop_reason: 'end_turn', served_model: 'x', fell_back: false })
        }
      }),
    }
    const memory = new CallMemory('s', null)
    memory.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 5000, text: 'We review samples weekly.', available_ms: 5000 }, true)
    const engine = new HelpEngine({ memory, kb: null, model, config, playbook, db: null, sessionNowMs: () => 6000, emit: () => {}, log: () => {}, prefetch: true, wallNow: () => 0 })
    engine.onFinalWords('system_remote')
    await vi.advanceTimersByTimeAsync(800)
    expect(engine.pressInFlight).toBe(false) // a background candidate is running, not a press
    release!()
    await vi.advanceTimersByTimeAsync(0)
    memory.upsertTurn({ id: 't2', stream: 'system_remote', cluster: 'e1:s0', start_ms: 5000, end_ms: 5900, text: 'Mostly.', available_ms: 5900 }, true)
    engine.press()
    expect(engine.pressInFlight).toBe(true)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.pressInFlight).toBe(false)
  })
})

describe('per call: scorecard, deletion and the app', () => {
  it('the scorecard counts note updates and their cost, never their text', async () => {
    const s = setup()
    s.keeper.resume()
    s.buyerMinute('One')
    s.model.calls[0].release(answer({ concerns: [{ text: 'Worried about SECRETWORD', lines: ['L1'] }] }))
    await vi.advanceTimersByTimeAsync(0)
    s.buyerMinute('Two') // too soon after the first: waits for the gap
    s.wait(NOTES_MIN_GAP_MS)
    s.say('buyer', 'Right.', 2)
    s.model.calls[1].release('nope')
    await vi.advanceTimersByTimeAsync(0)
    s.wait(NOTES_MIN_GAP_MS)
    s.buyerMinute('Three')
    s.model.calls[2].fail(new Anthropic.InternalServerError(529, {}, 'Overloaded', new Headers()))
    await vi.advanceTimersByTimeAsync(0)
    s.wait(NOTES_MIN_GAP_MS)
    s.buyerMinute('Four')
    s.keeper.stop()
    const card = buildScorecard(s.db, 'sess-1', 600_000)
    expect(card.call_notes).toEqual({
      started: 4, updated: 1, invalid: 1, failed: 1, cancelled: 1, capped: 1, cost_usd: 0.008,
      tokens: { input: 2400, output: 600, cache_read: 1800 }, errors: { not_json: 1, overloaded: 1 },
    })
    expect(card.total_cost_usd).toBe(0.008)
    expect(JSON.stringify(card)).not.toMatch(/SECRETWORD|One first/)
  })

  it('in the app: HELP wins, Pause cancels, a HELP key error stops the notes, a deleted call empties the panel, quitting saves the counts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    help.setSettings({ prefetch: false }) // no background HELP candidates in this test
    const model = new ScriptedApp()
    help.createModel = () => model
    const panel: Array<CallNotesState | null> = []
    help.onNotes = (st) => panel.push(st)
    let t = 0
    let n = 0
    const ev = (e: SessionEvent, call = 'call-1') => help.onSessionEvent(e, call, () => t)
    const state = (st: 'checking' | 'live' | 'paused' | 'stopping' | 'stopped', call = 'call-1') => ev({ type: 'state', state: st, sessionId: call } as SessionEvent, call)
    /** One finished line from the buyer, `secs` long (session time only: the wall clock stays put). */
    const buyer = (secs: number, call = 'call-1') => {
      const start = t
      t += secs * 1000
      const turn: Turn = {
        turn_id: `t${++n}`, session_id: call, stream: 'system_remote', speaker_cluster: 'e1:s0', speaker_identity_id: null, speaker_role: 'unknown',
        start_ms: start, end_ms: t, text: `Line ${n} about how they review releases`, final: true, source_word_ids: [], gap_before: null,
      }
      ev({ type: 'turn', event: { type: 'turn_final', turn } }, call)
    }
    state('checking')
    state('live')
    await vi.advanceTimersByTimeAsync(0)

    // HELP always wins: a minute of buyer talk while a pressed HELP is being answered starts no update.
    expect(help.press().ok).toBe(true)
    for (let i = 0; i < 3; i++) buyer(21)
    expect(model.calls).toHaveLength(0)
    model.runs[0].ok()
    await vi.advanceTimersByTimeAsync(0)
    buyer(2)
    expect(model.calls).toHaveLength(1)

    // Pause cancels the update in flight.
    state('paused')
    expect(model.calls[0].req.signal.aborted).toBe(true)
    expect(help.callNotes()?.status).toBe('paused')
    state('live')

    // HELP's own key error stops the notes too.
    expect(help.press().ok).toBe(true)
    model.runs[1].fail(new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()))
    await vi.advanceTimersByTimeAsync(0)
    expect(help.callNotes()).toMatchObject({ status: 'blocked', problem: 'Claude rejected the API key. Check it in Setup, step 3.' })

    // Stop, then delete the call: its notes leave the screen.
    state('stopping')
    state('stopped')
    help.forgetCall('call-1')
    expect(panel.at(-1)).toBeNull()

    // Quitting mid-update: the update is cancelled and counted before the scorecard is written.
    state('checking', 'call-2')
    state('live', 'call-2')
    for (let i = 0; i < 4; i++) buyer(21, 'call-2')
    expect(model.calls).toHaveLength(2)
    help.shutdown()
    expect(model.calls[1].req.signal.aborted).toBe(true)
    const card = JSON.parse(fs.readFileSync(path.join(dir, 'reports', 'help-scorecard-call-2.json'), 'utf8'))
    expect(card.call_notes).toMatchObject({ started: 1, cancelled: 1 })
  })

  it('deleting a call deletes its notes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'))
    const db = new Db(':memory:')
    db.sql.prepare("INSERT INTO call_notes (session_id, notes_json, stats_json) VALUES ('s-20261005-1200', '{}', '{}')").run()
    expect(deleteCall(dir, db, 's-20261005-1200')).toBe(true)
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM call_notes').get()).toEqual({ n: 0 })
  })

  it('in the app: on by default, MOCK notes without a key, kept after Stop and counted in the scorecard', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    expect(help.info().settings.call_notes).toBe(true)
    help.createModel = () => new MockHelpModel(0)
    const panel: Array<CallNotesState | null> = []
    help.onNotes = (st) => panel.push(st)
    let t = 0
    const clock = () => t
    const ev = (e: SessionEvent) => help.onSessionEvent(e, 'call-1', clock)
    ev({ type: 'state', state: 'checking', sessionId: 'call-1' })
    ev({ type: 'state', state: 'live', sessionId: 'call-1' })
    const turn = (id: string, text: string, start: number, end: number): Turn => ({
      turn_id: id, session_id: 'call-1', stream: 'system_remote', speaker_cluster: 'e1:s0', speaker_identity_id: null, speaker_role: 'unknown',
      start_ms: start, end_ms: end, text, final: true, source_word_ids: [], gap_before: null,
    })
    // An open turn growing doesn't count; only finished ones do.
    t = 70_000
    ev({ type: 'turn', event: { type: 'turn_update', turn: { ...turn('t1', 'We review samples every week', 0, 65_000), final: false } } })
    await vi.advanceTimersByTimeAsync(10)
    expect(help.callNotes()?.updates).toBe(0)
    ev({ type: 'turn', event: { type: 'turn_final', turn: turn('t1', 'We review samples every week', 0, 65_000) } })
    await vi.advanceTimersByTimeAsync(10)
    expect(help.callNotes()).toMatchObject({ status: 'waiting', mock: true, updates: 1, notes: { topic: { text: '[MOCK] Placeholder notes - no model was called', turn_ids: ['t1'] } } })
    expect(help.memory?.callNotes?.notes.topic?.turn_ids).toEqual(['t1'])
    ev({ type: 'state', state: 'stopping', sessionId: 'call-1' })
    ev({ type: 'state', state: 'stopped', sessionId: 'call-1' })
    expect(help.callNotes()).toMatchObject({ status: 'stopped', updates: 1 })
    expect(panel.at(-1)).toMatchObject({ status: 'stopped' })
    const card = JSON.parse(fs.readFileSync(path.join(dir, 'reports', 'help-scorecard-call-1.json'), 'utf8'))
    expect(card.call_notes).toMatchObject({ started: 1, updated: 1 })
    // Turned off in Setup: the next call keeps no notes.
    help.setSettings({ call_notes: false })
    ev({ type: 'state', state: 'checking', sessionId: 'call-2' })
    expect(help.callNotes()?.status).toBe('off')
    help.shutdown()
  })
})
