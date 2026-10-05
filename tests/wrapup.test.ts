import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallNotes, CallNotesState, CallWrapup, HelpModelConfig, WrapupItem } from '../src/shared/help'
import type { Turn } from '../src/shared/contracts'
import { Db } from '../src/main/db'
import { CallMemory } from '../src/main/help/callMemory'
import { CallNotesKeeper, NOTES_CLOSING_BUDGET_MS, NOTES_MIN_GAP_MS } from '../src/main/help/callNotesKeeper'
import { FOLLOWUP_SCHEMA, FOLLOWUP_SYSTEM_PROMPT, buildFollowupInput, draftItems, followupUserMessage, mockFollowup, validateFollowup, type FollowupInput } from '../src/main/help/followup'
import { DEFAULT_HELP_CONFIG, MockHelpModel, type HelpModel, type HelpModelResult, type HelpModelRun, type HelpNotesResult, type HelpNotesRun } from '../src/main/help/models'
import { WRAPUP_ITEMS_MAX, WRAPUP_MAX_TRANSCRIPT_CHARS, WRAPUP_SCHEMA, WRAPUP_SYSTEM_PROMPT, afterCallText, quoteFrom, validateWrapup, wrapupUserMessage } from '../src/main/help/wrapup'
import { KnowledgeBase, docMetaFrom } from '../src/main/knowledge'
import { deleteCall } from '../src/main/retention'
import { HelpService } from '../src/main/helpService'
import type { SessionEvent } from '../src/main/session'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const config: HelpModelConfig = { ...DEFAULT_HELP_CONFIG }
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, cost_usd: 0.003 }
/** Invented call details: none of this is a real company, person or product fact. */
const CALL_ID = 's-2026-10-05T10-00-00-000Z-abc123'

const notesAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ topic: null, buyer_wants: [], open_questions: [], concerns: [], facts: [], next_steps: [], not_covered: [], ...over })

/** A real-looking (non-mock) model whose structured answers (notes, wrap-up, email) wait for the test. */
class Scripted implements HelpModel {
  readonly mock = false
  calls: Array<{ req: HelpNotesRun; kind: 'notes' | 'wrapup' | 'followup'; release: (text: string, stop?: string) => void; fail: (e: unknown) => void }> = []
  label() { return 'scripted' }
  async prewarm() {}
  async check() { return { readiness: 'ready' as const } }
  run(_req: HelpModelRun): Promise<HelpModelResult> { throw new Error('not used') }
  notes(req: HelpNotesRun): Promise<HelpNotesResult> {
    const kind = req.system === WRAPUP_SYSTEM_PROMPT ? 'wrapup' : req.system === FOLLOWUP_SYSTEM_PROMPT ? 'followup' : 'notes'
    return new Promise((resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))
      this.calls.push({ req, kind, release: (text, stop = 'end_turn') => resolve({ text, usage: USAGE, stop_reason: stop }), fail: reject })
    })
  }
  of(kind: 'notes' | 'wrapup' | 'followup') {
    return this.calls.filter((c) => c.kind === kind)
  }
}

/** The app with a scripted (or MOCK) model, a clock, and a way to say lines. */
function app(model: HelpModel = new Scripted(), settings: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-'))
  const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
  const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, (e, d) => logs.push({ e, d }))
  help.setSettings({ prefetch: false, ...settings })
  help.createModel = () => model
  const wraps: Array<CallWrapup | null> = []
  help.onWrapup = (w) => wraps.push(w)
  const panel: Array<CallNotesState | null> = []
  help.onNotes = (s) => panel.push(s)
  let t = 0
  let n = 0
  const ev = (e: SessionEvent, call = CALL_ID, clock = () => t) => help.onSessionEvent(e, call, clock)
  /** `clock`: that call's own session clock (a new call's starts again near 0). */
  const state = (st: 'checking' | 'live' | 'paused' | 'stopping' | 'stopped' | 'idle', call = CALL_ID, clock = () => t) => ev({ type: 'state', state: st, sessionId: call } as SessionEvent, call, clock)
  /** One finished line, `secs` long. */
  const say = (who: 'buyer' | 'keith', text: string, secs = 5, call = CALL_ID): string => {
    const start = t
    t += secs * 1000
    const turn: Turn = {
      turn_id: `t${++n}`, session_id: call, stream: who === 'keith' ? 'local_mic' : 'system_remote', speaker_cluster: who === 'keith' ? null : 'e1:s0',
      speaker_identity_id: null, speaker_role: 'unknown', start_ms: start, end_ms: t, text, final: true, source_word_ids: [], gap_before: null,
    }
    ev({ type: 'turn', event: { type: 'turn_final', turn } }, call)
    return turn.turn_id
  }
  const scorecard = (call = CALL_ID) => JSON.parse(fs.readFileSync(path.join(dir, 'reports', `help-scorecard-${call}.json`), 'utf8'))
  const row = (call = CALL_ID) => help.db.sql.prepare('SELECT wrapup_json, stats_json FROM call_wrapups WHERE session_id = ?').get(call) as { wrapup_json: string; stats_json: string } | undefined
  return { dir, help, logs, wraps, panel, state, say, scorecard, row, model: model as Scripted }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Stop: the closing notes pass, then the wrap-up', () => {
  it("doesn't cancel a notes update at Stop; covers the last lines; builds the wrap-up from the ended call, not the cleared setup strip", async () => {
    const a = app()
    a.help.setSetup({ call_type: 'discovery', call_goal: 'Learn how they review chatbot answers', desired_outcomes: ['book a deep-dive'], account: 'Larkspur Health', deployment: 'self_hosted' })
    a.state('checking')
    a.state('live')
    expect(a.help.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana Whitfield' }).ok).toBe(true)
    // About a minute of the buyer talking starts a regular notes update.
    for (const w of ['first', 'second', 'third']) a.say('buyer', `The ${w} thing is we review chatbot answers by hand every Friday`, 21)
    expect(a.model.of('notes')).toHaveLength(1)
    // The last minutes: promises and a next step, too little talk for a regular update.
    a.say('buyer', 'Could you send over how tracing works on our own servers?', 6)
    a.say('keith', "Yes, I'll send you the self-hosted tracing overview by Friday.", 5)
    a.say('buyer', "Great. I'll loop in Priya from the platform team. Tuesday at 2 works for the deep-dive.", 7)
    a.state('stopping')
    // Stop no longer cancels the update in flight.
    expect(a.model.calls[0].req.signal.aborted).toBe(false)
    a.state('stopped')
    // The setup strip is cleared for the next call straight away...
    expect(a.help.info().setup).toMatchObject({ account: '', deployment: 'unknown' })
    expect(a.help.callNotes()?.status).toBe('finishing')
    // ...and the wrap-up window can say "Finishing notes and wrap-up…" at once.
    expect(a.wraps.at(-1)).toMatchObject({ session_id: CALL_ID, status: 'building', account: 'Larkspur Health', items: [], mock: false })

    // The update in flight finishes and is kept; then one closing update covers every line still queued.
    a.model.calls[0].release(notesAnswer({ buyer_wants: [{ text: 'Fewer hand reviews of chatbot answers', lines: ['L1'] }] }))
    await flush()
    const closing = a.model.of('notes')[1]
    expect(closing).toBeDefined()
    expect(closing.req.user).toContain('tracing works on our own servers')
    expect(closing.req.user).toContain('Tuesday at 2')
    expect(closing.req.user).not.toContain('first thing is')
    expect(a.model.of('wrapup')).toHaveLength(0)
    closing.release(notesAnswer({
      buyer_wants: [{ text: 'Fewer hand reviews of chatbot answers', lines: ['L1'] }],
      next_steps: [{ status: 'agreed', text: 'Deep-dive Tuesday at 2 with Priya', lines: ['L6'] }],
    }))
    await flush()
    expect(a.help.callNotes()).toMatchObject({ status: 'stopped', updates: 2 })
    expect(a.scorecard().call_notes).toMatchObject({ started: 2, updated: 2, closing: 1, cancelled: 0 })

    // The wrap-up request: the ended call's own setup, labels, final notes and transcript with line ids.
    const wr = a.model.of('wrapup')[0]
    expect(wr.req).toMatchObject({ max_tokens: 3000, timeout_ms: 45_000, schema: WRAPUP_SCHEMA })
    expect(wr.req.user).toContain('account: Larkspur Health')
    expect(wr.req.user).toContain('deployment: self-hosted')
    expect(wr.req.user).toContain('[L5] (1:09) Keith: Yes, I\'ll send you the self-hosted tracing overview by Friday.')
    expect(wr.req.user).toContain('Dana Whitfield (buyer): Great.')
    expect(wr.req.user).toContain('Deep-dive Tuesday at 2 with Priya')
    wr.release(JSON.stringify({
      we_owe: [{ text: 'Send the self-hosted tracing overview', who: 'Keith', when: 'by Friday', lines: ['L5'] }],
      they_owe: [{ text: 'Loop in Priya from the platform team', who: 'Dana', when: 'not said', lines: ['L6'] }],
      agreed: [{ text: 'Deep-dive Tuesday at 2', who: null, when: 'Tuesday at 2', lines: ['L6'] }],
      proposed: [{ text: 'A pilot next quarter', who: null, when: null, lines: ['L99'] }],
      open_questions: [{ text: 'How tracing works on their own servers', who: null, when: null, lines: ['[L4]'] }],
    }))
    await flush()
    const w = a.wraps.at(-1)!
    expect(w.status).toBe('ready')
    expect(w.items.map((i) => [i.id, i.section, i.text, i.who, i.when, i.state])).toEqual([
      ['w1', 'we_owe', 'Send the self-hosted tracing overview', 'Keith', 'by Friday', 'pending'],
      ['w2', 'they_owe', 'Loop in Priya from the platform team', 'Dana', null, 'pending'],
      ['w3', 'agreed', 'Deep-dive Tuesday at 2', null, 'Tuesday at 2', 'pending'],
      ['w4', 'open_questions', 'How tracing works on their own servers', null, null, 'pending'],
    ])
    // The quote is the transcript's own words, never the model's.
    expect(w.items[0]).toMatchObject({ turn_ids: ['t5'], quote: "Yes, I'll send you the self-hosted tracing overview by Friday." })
    // Stored with the call, and counted (numbers only) in the scorecard, cost included.
    expect(JSON.parse(a.row()!.wrapup_json)).toMatchObject({ status: 'ready', items: { length: 4 } })
    const card = a.scorecard()
    expect(card.wrapup).toMatchObject({ status: 'ready', items: { we_owe: 1, they_owe: 1, agreed: 1, proposed: 0, open_questions: 1 }, dropped: 1, requests: 1, cost_usd: 0.003 })
    expect(card.total_cost_usd).toBeCloseTo(0.009)
    expect(JSON.stringify(card)).not.toMatch(/Larkspur|Priya|tracing|Dana|chatbot/)
    // Logs: counts, timings and codes only.
    expect(a.logs.map((l) => l.e)).toEqual(expect.arrayContaining(['call_notes_closing_start', 'call_notes_closing_done', 'wrapup_start', 'wrapup_done']))
    expect(a.logs.find((l) => l.e === 'call_notes_closing_done')?.d).toMatchObject({ passes: 1, last: 'updated', queued_left: 0 })
    expect(JSON.stringify(a.logs)).not.toMatch(/Larkspur|Priya|tracing|Dana|chatbot|Friday|Tuesday/)
    a.help.shutdown()
  })

  it("with nothing left to cover, the notes read 'call ended' as soon as Stop is done", async () => {
    const a = app(new MockHelpModel(0))
    a.state('checking')
    a.state('live')
    a.say('buyer', 'We review answers by hand.', 70)
    await flush()
    a.state('stopping')
    a.state('stopped')
    expect(a.help.callNotes()).toMatchObject({ status: 'stopped', updates: 1 })
    expect(a.scorecard().call_notes).toMatchObject({ closing: 0 })
    a.help.shutdown()
  })

  it('a deleted call stops the closing pass and the wrap-up; nothing more is written for it', async () => {
    const a = app()
    a.state('checking')
    a.state('live')
    for (let i = 0; i < 3; i++) a.say('buyer', `Line ${i} about how they review answers every week`, 21)
    a.say('keith', "I'll send the overview.", 3)
    a.state('stopping')
    a.state('stopped')
    // Deleted while the update before Stop is still running.
    a.help.forgetCall(CALL_ID)
    expect(deleteCall(a.dir, a.help.db, CALL_ID)).toBe(true)
    expect(a.model.calls[0].req.signal.aborted).toBe(true)
    expect(a.wraps.at(-1)).toBeNull()
    expect(a.panel.at(-1)).toBeNull()
    await flush()
    expect(a.model.calls).toHaveLength(1)
    expect(a.row()).toBeUndefined()
    expect(a.help.wrapup()).toBeNull()

    // Deleted while the wrap-up request is running.
    const b = app()
    b.state('checking')
    b.state('live')
    b.say('buyer', 'Can you send pricing?', 4)
    b.state('stopping')
    b.state('stopped')
    // Below the threshold: the closing pass covers the one line, then the wrap-up starts.
    b.model.calls[0].release(notesAnswer())
    await flush()
    const wr = b.model.of('wrapup')[0]
    b.help.forgetCall(CALL_ID)
    deleteCall(b.dir, b.help.db, CALL_ID)
    expect(wr.req.signal.aborted).toBe(true)
    wr.release(JSON.stringify({ we_owe: [], they_owe: [], agreed: [], proposed: [], open_questions: [{ text: 'Pricing', who: null, when: null, lines: ['L1'] }] }))
    await flush()
    expect(b.row()).toBeUndefined()
    expect(b.wraps.at(-1)).toBeNull()
    expect(b.help.updateWrapupItem({ id: 'w1', state: 'confirmed' }).ok).toBe(false)
    a.help.shutdown()
    b.help.shutdown()
  })

  it("a new Start doesn't stop the last call's closing pass or wrap-up: they finish and save, and its notes stay off the new call's panel", async () => {
    const a = app()
    a.help.setSetup({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: 'Larkspur Health', deployment: 'unknown' })
    a.state('checking')
    a.state('live')
    // A regular update is in flight at Stop, and one more line comes after it.
    for (const w of ['first', 'second', 'third']) a.say('buyer', `The ${w} thing is we review chatbot answers by hand every Friday`, 21)
    expect(a.model.of('notes')).toHaveLength(1)
    a.say('buyer', 'Could you send the trial checklist by Thursday?', 5)
    a.state('stopping')
    a.state('stopped')
    // Start for the next call right away; its session clock starts again near 0.
    const next = 's-2026-10-05T11-00-00-000Z-def456'
    a.state('checking', next, () => 500)
    expect(a.model.of('notes')[0].req.signal.aborted).toBe(false)
    const panelAtStart = a.panel.length
    expect(a.panel.at(-1)).toMatchObject({ status: 'waiting', notes: null })
    a.model.of('notes')[0].release(notesAnswer({ buyer_wants: [{ text: 'Fewer reviews by hand', lines: ['L1'] }] }))
    await flush()
    // The closing pass reads the ended call's own clock: the last line is covered.
    const closing = a.model.of('notes')[1]
    expect(closing.req.user).toContain('trial checklist')
    closing.release(notesAnswer({ buyer_wants: [{ text: 'Fewer reviews by hand', lines: ['L1'] }], open_questions: [{ text: 'Trial checklist by Thursday', lines: ['L4'] }] }))
    await flush()
    // Saved to the ended call; nothing of it reached the new call's notes panel.
    const saved = a.help.db.sql.prepare('SELECT notes_json FROM call_notes WHERE session_id = ?').get(CALL_ID) as { notes_json: string }
    expect(saved.notes_json).toContain('Trial checklist by Thursday')
    expect(a.panel.length).toBe(panelAtStart)
    expect(a.help.callNotes()).toMatchObject({ status: 'waiting', notes: null })
    // The next call goes live while the last call's wrap-up is still being built.
    a.state('live', next, () => 500)
    a.model.of('wrapup')[0].release(JSON.stringify({ we_owe: [], they_owe: [], agreed: [], proposed: [], open_questions: [{ text: 'Trial checklist by Thursday', who: null, when: 'by Thursday', lines: ['L4'] }] }))
    await flush()
    expect(JSON.parse(a.row()!.wrapup_json)).toMatchObject({ status: 'ready', items: [{ id: 'w1', section: 'open_questions' }] })
    expect(a.scorecard()).toMatchObject({ call_notes: { closing: 1 }, wrapup: { requests: 1, items: { open_questions: 1 } } })
    expect(a.row(next)).toBeUndefined()
    a.help.shutdown()
  })

  it("the next call ending doesn't stop the last call's wrap-up either; deleting that call stops it", async () => {
    const a = app(new Scripted(), { call_notes: false })
    a.state('checking')
    a.state('live')
    a.say('buyer', 'What does the trial include?', 4)
    a.state('stopping')
    a.state('stopped')
    await flush()
    const first = a.model.of('wrapup')[0]
    // A short next call, over before the first call's wrap-up is back.
    const next = 's-2026-10-05T11-00-00-000Z-def456'
    a.state('checking', next)
    a.state('live', next)
    a.say('buyer', 'Can we start with one team?', 4, next)
    a.state('stopping', next)
    a.state('stopped', next)
    await flush()
    expect(first.req.signal.aborted).toBe(false)
    expect(a.help.wrapup()?.session_id).toBe(next)
    const shown = a.wraps.length
    first.release(JSON.stringify({ we_owe: [], they_owe: [], agreed: [], proposed: [], open_questions: [{ text: 'What the trial includes', who: null, when: null, lines: ['L1'] }] }))
    await flush()
    // Saved for the first call, out of sight: the window keeps showing the call that ended last.
    expect(JSON.parse(a.row()!.wrapup_json).status).toBe('ready')
    expect(a.wraps.length).toBe(shown)
    expect(a.help.wrapup()?.session_id).toBe(next)

    // Deleting a call whose wrap-up is still running out of sight stops it; the other call's is untouched.
    const b = app(new Scripted(), { call_notes: false })
    b.state('checking')
    b.state('live')
    b.say('buyer', 'Can you send pricing?', 4)
    b.state('stopping')
    b.state('stopped')
    await flush()
    const old = b.model.of('wrapup')[0]
    b.state('checking', next)
    b.state('live', next)
    b.say('buyer', 'Is there a sandbox?', 4, next)
    b.state('stopping', next)
    b.state('stopped', next)
    await flush()
    b.help.forgetCall(CALL_ID)
    deleteCall(b.dir, b.help.db, CALL_ID)
    expect(old.req.signal.aborted).toBe(true)
    expect(b.row()).toBeUndefined()
    expect(b.model.of('wrapup')[1].req.signal.aborted).toBe(false)
    expect(b.help.wrapup()?.session_id).toBe(next)
    // Quitting with the next call's wrap-up still running: saved as not finished, never "building".
    b.help.shutdown()
    const db = new Db(path.join(b.dir, 'copilot.db'))
    const row = db.sql.prepare('SELECT wrapup_json FROM call_wrapups WHERE session_id = ?').get(next) as { wrapup_json: string }
    expect(JSON.parse(row.wrapup_json)).toMatchObject({ status: 'failed', error: 'The app closed before the wrap-up was ready.' })
    db.close()
    a.help.shutdown()
  })

  it('quitting with the last call\'s wrap-up still running out of sight: saved as not finished, never "building"', async () => {
    const a = app(new Scripted(), { call_notes: false })
    a.state('checking')
    a.state('live')
    a.say('buyer', 'What does the trial include?', 4)
    a.state('stopping')
    a.state('stopped')
    await flush()
    const next = 's-2026-10-05T11-00-00-000Z-def456'
    a.state('checking', next)
    a.state('live', next)
    a.say('buyer', 'Can we start with one team?', 4, next)
    a.state('stopping', next)
    a.state('stopped', next)
    await flush()
    a.help.shutdown()
    expect(a.model.of('wrapup').every((c) => c.req.signal.aborted)).toBe(true)
    const db = new Db(path.join(a.dir, 'copilot.db'))
    for (const id of [CALL_ID, next]) {
      const row = db.sql.prepare('SELECT wrapup_json, stats_json FROM call_wrapups WHERE session_id = ?').get(id) as { wrapup_json: string; stats_json: string }
      expect(JSON.parse(row.wrapup_json).status).toBe('failed')
      expect(JSON.parse(row.stats_json).errors).toEqual({ quit: 1 })
    }
    db.close()
    // Its scorecard was brought up to date at quit.
    expect(a.scorecard().wrapup).toMatchObject({ status: 'failed', errors: { quit: 1 } })
  })

  it('a call where nothing was transcribed: no wrap-up request, and the window has nothing to open for', async () => {
    const a = app()
    a.state('checking')
    a.state('live')
    a.state('stopping')
    a.state('stopped')
    await flush()
    expect(a.model.calls).toHaveLength(0)
    expect(a.wraps).toHaveLength(1)
    expect(a.wraps[0]).toMatchObject({ status: 'ready', items: [], error: null })
    expect(a.scorecard().wrapup).toMatchObject({ requests: 0, errors: { empty_call: 1 } })
    expect(a.logs.find((l) => l.e === 'wrapup_skipped')?.d).toEqual({ reason: 'empty_call' })
    // Keith can still add his own items and draft from them.
    expect(a.help.addWrapupItem({ section: 'we_owe', text: 'Send the calendar invite again' }).ok).toBe(true)
    a.help.shutdown()
  })

  it('quitting while the wrap-up is built: nothing waits for Claude, and it is saved as not finished', async () => {
    const a = app()
    a.state('checking')
    a.state('live')
    a.say('buyer', 'Send me the security overview please.', 4)
    a.state('stopping')
    a.state('stopped')
    a.model.calls[0].release(notesAnswer())
    await flush()
    const wr = a.model.of('wrapup')[0]
    a.help.shutdown()
    expect(wr.req.signal.aborted).toBe(true)
    // Read straight from the file: the app closed its database.
    const db = new Db(path.join(a.dir, 'copilot.db'))
    const row = db.sql.prepare('SELECT wrapup_json, stats_json FROM call_wrapups WHERE session_id = ?').get(CALL_ID) as { wrapup_json: string; stats_json: string }
    expect(JSON.parse(row.wrapup_json)).toMatchObject({ status: 'failed', error: 'The app closed before the wrap-up was ready.' })
    expect(JSON.parse(row.stats_json).errors).toEqual({ quit: 1 })
    expect(a.scorecard().wrapup).toMatchObject({ status: 'failed', errors: { quit: 1 } })
    db.close()
  })

  it('quitting during the closing pass cancels it and saves the counts', async () => {
    const a = app()
    a.state('checking')
    a.state('live')
    a.say('buyer', 'One more thing before we go.', 4)
    a.state('stopping')
    a.state('stopped')
    const closing = a.model.calls[0]
    expect(a.help.callNotes()?.status).toBe('finishing')
    a.help.shutdown()
    expect(closing.req.signal.aborted).toBe(true)
    expect(a.scorecard().call_notes).toMatchObject({ started: 1, closing: 1, cancelled: 1 })
  })

  it('"Wrap-up after each call" off: no wrap-up; call notes off: the wrap-up still works from the transcript alone', async () => {
    const off = app(new Scripted(), { wrapup: false })
    expect(off.help.info().settings).toMatchObject({ wrapup: false })
    off.state('checking')
    off.state('live')
    off.say('buyer', 'Can we see it on our own data?', 4)
    off.state('stopping')
    off.state('stopped')
    off.model.calls[0].release(notesAnswer())
    await flush()
    expect(off.model.of('wrapup')).toHaveLength(0)
    expect(off.wraps.at(-1)).toBeNull()
    expect(off.help.wrapup()).toBeNull()
    off.help.shutdown()

    const noNotes = app(new Scripted(), { call_notes: false })
    expect(noNotes.help.info().settings.wrapup).toBe(true)
    noNotes.state('checking')
    noNotes.state('live')
    noNotes.say('buyer', 'Can we see it on our own data?', 4)
    noNotes.state('stopping')
    noNotes.state('stopped')
    expect(noNotes.help.callNotes()?.status).toBe('off')
    await flush()
    const wr = noNotes.model.calls[0]
    expect(wr.kind).toBe('wrapup')
    expect(wr.req.user).toContain('<call_notes>\n(none)\n</call_notes>')
    wr.release(JSON.stringify({ we_owe: [], they_owe: [], agreed: [], proposed: [], open_questions: [{ text: 'See it on their own data', who: null, when: null, lines: ['L1'] }] }))
    await flush()
    expect(noNotes.help.wrapup()).toMatchObject({ status: 'ready', items: [{ section: 'open_questions', quote: 'Can we see it on our own data?' }] })
    noNotes.help.shutdown()
  })

  it("a failed wrap-up says so plainly; Keith can add items, draft from them, or try again", async () => {
    const a = app(new Scripted(), { call_notes: false })
    a.state('checking')
    a.state('live')
    a.say('buyer', 'Could you share the SOC 2 report?', 4)
    a.state('stopping')
    a.state('stopped')
    await flush()
    a.model.calls[0].release('not json at all')
    await flush()
    expect(a.help.wrapup()).toMatchObject({ status: 'failed', error: "Couldn't build the wrap-up this time. Try again, or add the items yourself." })
    expect(a.help.addWrapupItem({ section: 'we_owe', text: 'Send the SOC 2 report' })).toMatchObject({ ok: true, wrapup: { items: [{ id: 'k1', state: 'confirmed', added_by_keith: true, quote: '' }] } })
    // The email fails too: its problem goes to the draft button, and the build's stays next to "Try again".
    const draft = a.help.draftFollowup()
    await flush()
    a.model.of('followup')[0].fail(new Anthropic.APIError(402, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, 'Your credit balance is too low', new Headers()))
    const dr = await draft
    expect(dr).toMatchObject({ ok: false, reason: "Couldn't write the email. The Anthropic account is out of credit. Add credit, then draft the email again." })
    expect(dr.wrapup).toMatchObject({ status: 'failed', error: "Couldn't build the wrap-up this time. Try again, or add the items yourself." })
    const retry = a.help.retryWrapup()
    await flush()
    a.model.of('wrapup')[1].release(JSON.stringify({ we_owe: [], they_owe: [], agreed: [], proposed: [], open_questions: [{ text: 'SOC 2 report', who: null, when: null, lines: ['L1'] }] }))
    expect((await retry).ok).toBe(true)
    // Keith's own item stays, after the call's.
    expect(a.help.wrapup()?.items.map((i) => i.id)).toEqual(['w1', 'k1'])
    expect(a.scorecard().wrapup).toMatchObject({ requests: 2, errors: { not_json: 1, draft_no_credit: 1 }, added: 1, draft_failed: 1 })
    // Shared error texts name HELP's button; after the call they name the button that's there.
    expect(afterCallText('The Anthropic account is out of credit. Add credit, then press HELP again.', 'click Try again')).toBe('The Anthropic account is out of credit. Add credit, then click Try again.')
    expect(afterCallText('Claude is busy right now. Press HELP again.', 'click Try again')).toBe('Claude is busy right now. Click Try again.')
    a.help.shutdown()
  })
})

describe("Keith's changes and the follow-up draft", () => {
  it('practice mode: a deterministic MOCK wrap-up from the final notes and a MOCK draft, all counted, no text in logs', async () => {
    const a = app(new MockHelpModel(0))
    a.help.setSetup({ call_type: 'demo', call_goal: '', desired_outcomes: [], account: 'Larkspur Health', deployment: 'saas' })
    a.state('checking')
    a.state('live')
    a.help.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana Whitfield' })
    a.say('buyer', 'We want fewer hand reviews before each release.', 70)
    await flush()
    a.say('keith', "I'll send the evaluation guide today.", 5)
    a.say('buyer', 'Thanks, we will share sample transcripts.', 5)
    a.state('stopping')
    a.state('stopped')
    await flush()
    const w = a.help.wrapup()!
    expect(w).toMatchObject({ status: 'ready', mock: true, account: 'Larkspur Health' })
    expect(w.items.map((i) => [i.id, i.section, i.quote])).toEqual([
      ['w1', 'we_owe', "I'll send the evaluation guide today."],
      ['w2', 'they_owe', 'Thanks, we will share sample transcripts.'],
    ])
    expect(w.items[0].text).toMatch(/^\[MOCK\]/)
    // Same every time.
    expect(JSON.stringify(a.help.wrapup())).toBe(JSON.stringify(w))

    // Every input is checked.
    for (const bad of [null, 'w1', { id: 'w9', state: 'confirmed' }, { id: '../x', state: 'confirmed' }, { id: 'w1', state: 'done' }, { id: 'w1', text: '   ' }, { id: 'w1', text: 5 }, { id: 'w1' }]) {
      expect(a.help.updateWrapupItem(bad).ok).toBe(false)
    }
    for (const bad of [null, { section: 'gossip', text: 'x' }, { section: 'agreed', text: '' }, { section: 'agreed', text: 7 }]) expect(a.help.addWrapupItem(bad).ok).toBe(false)
    expect(a.help.updateWrapupItem({ id: 'w1', state: 'confirmed', text: 'Send the evaluation guide today' }).ok).toBe(true)
    expect(a.help.updateWrapupItem({ id: 'w2', state: 'removed' }).ok).toBe(true)
    const long = 'x'.repeat(400)
    const added = a.help.addWrapupItem({ section: 'agreed', text: `Demo for their platform team next Wednesday ${long}` })
    expect(added.ok).toBe(true)
    expect(added.wrapup!.items.at(-1)!.text.length).toBeLessThanOrEqual(160)
    expect(a.scorecard().wrapup).toMatchObject({ confirmed: 2, removed: 1, added: 1, edited: 1, items: { we_owe: 1, they_owe: 0, agreed: 1 } })

    // The draft uses the confirmed items only; nothing is sent.
    const r = await a.help.draftFollowup()
    expect(r.ok).toBe(true)
    const email = r.wrapup!.email!
    expect(email).toMatchObject({ mock: true, checks: [], knowledge_chunk_ids: [] })
    expect(email.subject).toBe('[MOCK] Following up on today\'s call - Larkspur Health')
    expect(email.body).toMatch(/^Hi Dana,/)
    expect(email.body).toContain('From me: Send the evaluation guide today.')
    expect(email.body).not.toContain('sample transcripts')
    expect(email.body.trim().endsWith('Keith')).toBe(true)
    expect(a.scorecard().wrapup).toMatchObject({ drafts: 1, draft_checks: 0 })
    expect(JSON.stringify(a.logs.filter((l) => /wrapup|followup|closing/.test(l.e)))).not.toMatch(/Larkspur|Dana|evaluation guide|transcripts|Wednesday|release/)
    a.help.shutdown()
  })

  it('the draft request: confirmed items, buyer names, what they want, and approved, current, in-scope knowledge only', async () => {
    const a = app()
    const kdir = path.join(a.dir, 'knowledge')
    const doc = (name: string, front: string, body: string) => fs.writeFileSync(path.join(kdir, name), `---\ntitle: ${name}\ncategory: product\nsource: invented test doc\nversion: 2026-10\n${front}---\n\n${body}`)
    doc('sso.md', 'vendor: arize\napplies_to: all\n', '## Single sign-on\n\nSAML single sign-on works with Okta and Azure AD on every plan.\n\nSource: invented SSO page')
    doc('draft-sso.md', 'vendor: arize\n', '## Single sign-on draft\n\nUNAPPROVEDCLAIM single sign-on with Okta supports 400 groups.\n\nSource: draft')
    doc('residency.md', 'vendor: arize\napplies_to: saas\n', '## Single sign-on regions\n\nSAASONLYCLAIM single sign-on with Okta is hosted in two regions.\n\nSource: invented')
    doc('old.md', 'vendor: arize\nreview_by: 2020-01-01\n', '## Single sign-on history\n\nSTALECLAIM single sign-on with Okta was added long ago.\n\nSource: invented')
    a.help.reindexKnowledge()
    for (const d of ['sso', 'residency', 'old']) a.help.kb.approve(d, true)
    a.help.setSetup({ call_type: 'discovery', call_goal: '', desired_outcomes: [], account: 'Larkspur Health', deployment: 'self_hosted' })
    a.state('checking')
    a.state('live')
    a.help.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana Whitfield' })
    for (let i = 0; i < 3; i++) a.say('buyer', `We want fewer manual reviews, part ${i}, across all twelve of our support bots`, 21)
    a.model.calls[0].release(notesAnswer({ buyer_wants: [{ text: 'Fewer manual reviews', lines: ['L1'] }] }))
    await flush()
    a.say('buyer', 'Does single sign-on with Okta work for us?', 5)
    a.state('stopping')
    a.state('stopped')
    a.model.of('notes')[1].release(notesAnswer({ buyer_wants: [{ text: 'Fewer manual reviews', lines: ['L1'] }] }))
    await flush()
    a.model.of('wrapup')[0].release(JSON.stringify({
      we_owe: [], they_owe: [{ text: 'Share their bot list', who: 'Dana', when: null, lines: ['L2'] }], agreed: [], proposed: [],
      open_questions: [{ text: 'Does single sign-on with Okta work for them', who: null, when: null, lines: ['L4'] }],
    }))
    await flush()
    a.help.updateWrapupItem({ id: 'w2', state: 'confirmed' })
    const pending = a.help.draftFollowup()
    await flush()
    expect(a.help.wrapup()?.status).toBe('drafting')
    const fr = a.model.of('followup')[0]
    expect(fr.req.schema).toBe(FOLLOWUP_SCHEMA)
    const u = fr.req.user
    expect(u).toContain('Dana Whitfield')
    expect(u).toContain('- Fewer manual reviews')
    expect(u).toContain('Does single sign-on with Okta work for them')
    // Only the one confirmed item goes (the unconfirmed one stays out).
    expect(u).not.toContain('Share their bot list')
    expect(u).toMatch(/\[K1\] sso\.md - Single sign-on \(about: Arize; applies to: all deployments; version 2026-10\): SAML single sign-on works/)
    expect(u).not.toMatch(/UNAPPROVEDCLAIM|SAASONLYCLAIM|STALECLAIM|\[K2\]/)
    fr.release(JSON.stringify({
      subject: 'Following up: single sign-on',
      body: 'Hi Dana,\n\nThanks for your time today.\n\nOn single sign-on: SAML single sign-on works with Okta on every plan, for all 40 of your teams.\n\nKeith',
      sources: ['K1', 'K7'],
    }))
    const r = await pending
    expect(r.ok).toBe(true)
    expect(r.wrapup!.email).toMatchObject({ subject: 'Following up: single sign-on', mock: false, knowledge_chunk_ids: [expect.stringMatching(/^k:sso#/)] })
    expect(r.wrapup!.email!.checks).toEqual(["Has a number that isn't in the call or approved knowledge (40). Check it before sending."])
    expect(r.wrapup!.status).toBe('ready')
    expect(a.scorecard().wrapup).toMatchObject({ drafts: 1, draft_checks: 1, draft_cost_usd: 0.003 })
    expect(JSON.stringify(a.logs.filter((l) => /followup/.test(l.e)))).not.toMatch(/Dana|Okta|sign-on|Larkspur/)
    a.help.shutdown()
  })
})

describe('the closing pass itself', () => {
  function keeper(model: Scripted, enabled = true) {
    const db = new Db(':memory:')
    const memory = new CallMemory('sess-1', db)
    let sessionMs = 0
    let wall = 1_760_000_000_000
    const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
    const states: CallNotesState[] = []
    const k = new CallNotesKeeper({
      memory, model, config, db, sessionNowMs: () => sessionMs, helpBusy: () => false, emit: (s) => states.push(s), log: (e, d) => logs.push({ e, d }),
      enabled, now: () => wall,
    })
    let n = 0
    const say = (text: string, secs = 5) => {
      const id = `t${++n}`
      const start = sessionMs
      sessionMs += secs * 1000
      wall += secs * 1000
      memory.upsertTurn({ id, stream: 'system_remote', cluster: 'e1:s0', start_ms: start, end_ms: sessionMs, text, available_ms: sessionMs }, true)
      k.onFinalTurn(id)
    }
    return { k, db, memory, say, logs, states, tick: (ms: number) => { wall += ms; sessionMs += ms } }
  }

  it('ignores the minimum talk and the spacing, but at most 3 passes', async () => {
    const m = new Scripted()
    const s = keeper(m)
    s.k.resume()
    for (let i = 0; i < 3; i++) s.say(`Minute line ${i} about how their reviews work today`, 21)
    m.calls[0].release(notesAnswer())
    await flush()
    // Right after an update, and only a few words: no regular update would start.
    s.say('Short one.', 2)
    expect(m.calls).toHaveLength(1)
    s.k.beginFinish()
    const done = s.k.finish()
    expect(s.k.state().status).toBe('finishing')
    expect(m.calls).toHaveLength(2)
    expect(m.calls[1].req.user).toContain('Short one.')
    // Broken answers keep the lines queued: retried, but never more than 3 passes.
    m.calls[1].release('nope')
    await flush()
    m.calls[2].release('nope')
    await flush()
    m.calls[3].release('nope')
    await done
    expect(m.calls).toHaveLength(4)
    expect(s.k.stats).toMatchObject({ closing: 3, invalid: 3 })
    expect(s.k.state().status).toBe('stopped')
    expect(s.logs.find((l) => l.e === 'call_notes_closing_done')?.d).toMatchObject({ passes: 3, last: 'invalid', queued_left: 1 })
  })

  it(`a model that never answers: each pass times out, and it's all over in ${NOTES_CLOSING_BUDGET_MS / 1000} s`, async () => {
    const m = new Scripted()
    const s = keeper(m)
    s.k.resume()
    s.say('Something said at the very end.', 3)
    s.k.beginFinish()
    const done = s.k.finish()
    let over = false
    void done.then(() => { over = true })
    for (let i = 0; i < 3; i++) {
      s.tick(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
    }
    await flush()
    expect(over).toBe(true)
    expect(m.calls.length).toBeLessThanOrEqual(3)
    expect(s.k.stats.errors).toMatchObject({ timeout: m.calls.length })
    expect(s.k.state().status).toBe('stopped')
  })

  it('not run when notes are off or blocked; a deleted call aborts it and nothing is written or shown again', async () => {
    const off = keeper(new Scripted(), false)
    off.k.resume()
    off.say('Anything.', 3)
    off.k.beginFinish()
    await off.k.finish()
    expect(off.k.state().status).toBe('off')

    const m = new Scripted()
    const blocked = keeper(m)
    blocked.k.resume()
    for (let i = 0; i < 3; i++) blocked.say(`Minute line ${i} about how their reviews work today`, 21)
    m.calls[0].fail(new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()))
    await flush()
    blocked.k.beginFinish()
    await blocked.k.finish()
    expect(m.calls).toHaveLength(1)
    expect(blocked.k.state().status).toBe('stopped')

    const m2 = new Scripted()
    const gone = keeper(m2)
    gone.k.resume()
    gone.say('Last words.', 3)
    gone.k.beginFinish()
    const done = gone.k.finish()
    const shown = gone.states.length
    gone.k.dispose()
    expect(m2.calls[0].req.signal.aborted).toBe(true)
    await done
    expect(gone.states.length).toBe(shown)
    expect(gone.db.sql.prepare('SELECT COUNT(*) AS n FROM call_notes').get()).toEqual({ n: 0 })
  })

  it('Pause still cancels an update in flight', () => {
    const m = new Scripted()
    const s = keeper(m)
    s.k.resume()
    for (let i = 0; i < 3; i++) s.say(`Minute line ${i} about how their reviews work today`, 21)
    s.k.pause()
    expect(m.calls[0].req.signal.aborted).toBe(true)
    s.tick(NOTES_MIN_GAP_MS)
  })
})

describe('what the wrap-up request sends and keeps', () => {
  const memoryWith = (lines: Array<[who: 'buyer' | 'keith', text: string]>) => {
    const memory = new CallMemory('sess-1')
    memory.setup = { call_type: 'follow_up', call_goal: 'Agree a pilot', desired_outcomes: ['pilot date'], account: 'Larkspur Health', deployment: 'saas' }
    memory.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana' })
    lines.forEach(([who, text], i) => memory.upsertTurn({ id: `t${i + 1}`, stream: who === 'keith' ? 'local_mic' : 'system_remote', cluster: who === 'keith' ? null : 'e1:s0', start_ms: i * 10_000, end_ms: i * 10_000 + 8000, text, available_ms: i * 10_000 + 8000 }, true))
    return memory
  }

  it('the whole call with line ids, oldest first, speaker names as HELP shows them, and the final notes', () => {
    const memory = memoryWith([['keith', 'Thanks for joining.'], ['buyer', 'Happy to. Can it run in our VPC?']])
    const notes: CallNotes = { topic: null, buyer_wants: [], open_questions: [{ text: 'Runs in their VPC?', turn_ids: ['t2'] }], concerns: [], facts: [], next_steps: [], not_covered: [] }
    const input = wrapupUserMessage(memory, notes)
    expect(input.user).toContain('<call_setup>\ntype: follow_up\ngoal: Agree a pilot\ndesired outcomes: pilot date\naccount: Larkspur Health\ndeployment: Arize\'s SaaS\n</call_setup>')
    expect(input.user).toContain('"open_questions":[{"text":"Runs in their VPC?","lines":["L2"]}]')
    expect(input.user).toContain('<transcript note="the whole call, oldest first">\n[L1] (0:00) Keith: Thanks for joining.\n[L2] (0:10) Dana (buyer): Happy to. Can it run in our VPC?\n</transcript>')
    expect(input).toMatchObject({ lines: 2, sent: 2, cut: false })
  })

  it(`a long call sends its last ${WRAPUP_MAX_TRANSCRIPT_CHARS.toLocaleString('en-US')} characters (whole lines); lines the notes cite can still be cited`, () => {
    const filler = 'and then we talked about how the reviews go each week in some detail '.repeat(6)
    const lines: Array<['buyer' | 'keith', string]> = Array.from({ length: 200 }, (_, i) => [i % 2 ? 'keith' : 'buyer', `${i}: ${filler}`])
    lines[0] = ['buyer', 'EARLY: we need it working before the March board review.']
    const memory = memoryWith(lines)
    const notes: CallNotes = { topic: null, buyer_wants: [{ text: 'Working before the board review', turn_ids: ['t1'] }], open_questions: [], concerns: [], facts: [], next_steps: [], not_covered: [] }
    const input = wrapupUserMessage(memory, notes)
    expect(input.cut).toBe(true)
    expect(input.chars).toBeLessThanOrEqual(WRAPUP_MAX_TRANSCRIPT_CHARS)
    expect(input.user).not.toContain('EARLY:')
    expect(input.user).toContain('[L200]')
    expect(input.user).toMatch(/the last part of the call, oldest first; the \d+ earlier lines are left out and the call notes cover them/)
    expect(input.lineIds.get('L1')).toBe('t1')
    expect(input.lineIds.has('L2')).toBe(false)
  })

  it('only from what was said: items citing no line that was sent are dropped; at most 6 per section; short text; quote from the transcript', () => {
    const ids = new Map([['L1', 't1'], ['L2', 't2']])
    const quotes: Record<string, string> = { t1: 'Sure, I will send the guide.', t2: `${'We would like to look at it with the whole platform team before anything else happens, '.repeat(3)}ok?` }
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Question ${i}`, who: null, when: null, lines: ['L2'] }))
    const v = validateWrapup(JSON.stringify({
      we_owe: [{ text: 'Send the guide', who: 'Keith', when: 'N/A', lines: ['L1'] }, { text: 'Invented promise', who: null, when: null, lines: ['L9'] }, { text: '', who: null, when: null, lines: ['L1'] }],
      they_owe: [{ text: `Review it with the platform team ${'and more '.repeat(40)}`, who: 'Dana', when: null, lines: ['L2', 'L1'] }],
      agreed: [], proposed: [{ text: 'Send the guide', who: null, when: null, lines: ['L1'] }, { text: 'send the GUIDE', who: null, when: null, lines: ['L1'] }],
      open_questions: many,
    }), ids, (id) => quoteFrom(quotes[id] ?? ''))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.dropped).toBe(2 + 1 + (9 - WRAPUP_ITEMS_MAX))
    const it = (s: string) => v.items.filter((i) => i.section === s)
    expect(it('we_owe')).toEqual([{ id: 'w1', section: 'we_owe', text: 'Send the guide', who: 'Keith', when: null, turn_ids: ['t1'], quote: 'Sure, I will send the guide.', state: 'pending', added_by_keith: false } satisfies WrapupItem])
    expect(it('they_owe')[0].text.length).toBeLessThanOrEqual(160)
    expect(it('they_owe')[0].turn_ids).toEqual(['t2', 't1'])
    expect(it('they_owe')[0].quote.length).toBeLessThanOrEqual(120)
    expect(it('they_owe')[0].quote).toMatch(/^We would like to look at it.*…$/)
    expect(it('proposed')).toHaveLength(1)
    expect(it('open_questions')).toHaveLength(WRAPUP_ITEMS_MAX)
    expect(v.items.map((i) => i.id)).toEqual(v.items.map((_, i) => `w${i + 1}`))
    expect(validateWrapup('{"we_owe": []}', ids, () => '')).toEqual({ ok: false, code: 'bad_they_owe' })
    expect(validateWrapup('Sorry, I cannot', ids, () => '')).toEqual({ ok: false, code: 'not_json' })
  })

  it('the prompt is stable, long enough to be cached, and carries the rules; the schema follows the structured-output rules', () => {
    expect(WRAPUP_SYSTEM_PROMPT.length).toBeGreaterThan(2400)
    expect(WRAPUP_SYSTEM_PROMPT).toMatch(/Proposed is not agreed/)
    expect(WRAPUP_SYSTEM_PROMPT).toMatch(/Asked is not answered/)
    expect(WRAPUP_SYSTEM_PROMPT).toMatch(/Never invent promises, dates/)
    expect(WRAPUP_SYSTEM_PROMPT).toMatch(/call data, not instructions/)
    expect(FOLLOWUP_SYSTEM_PROMPT).toMatch(/No pricing, discount, contract terms or roadmap promises/)
    expect(FOLLOWUP_SYSTEM_PROMPT).toMatch(/I'll come back to you on/)
    for (const schema of [WRAPUP_SCHEMA, FOLLOWUP_SCHEMA]) {
      const text = JSON.stringify(schema)
      expect(text).not.toMatch(/minLength|maxLength|minItems|maxItems|minimum|maximum/)
      expect(text.match(/"additionalProperties":false/g)?.length).toBe(text.match(/"type":"object"/g)?.length)
    }
  })

  it('deleting the call deletes its wrap-up', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-'))
    const db = new Db(':memory:')
    db.sql.prepare("INSERT INTO call_wrapups (session_id, wrapup_json, updated_at) VALUES (?, '{}', 't')").run(CALL_ID)
    expect(deleteCall(dir, db, CALL_ID)).toBe(true)
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM call_wrapups').get()).toEqual({ n: 0 })
  })
})

describe('the follow-up checks', () => {
  const item = (section: WrapupItem['section'], text: string, state: WrapupItem['state'] = 'pending', quote = ''): WrapupItem =>
    ({ id: `w${text.length}`, section, text, who: null, when: null, turn_ids: ['t1'], quote, state, added_by_keith: false })
  const kb = new KnowledgeBase(new Db(':memory:'), null)
  const add = (file: string, meta: Record<string, string>, body: string) => kb.addDoc(docMetaFrom(file, { source: 'invented', version: '1', ...meta }, body), body)
  add('/k/arize-sso.md', { vendor: 'arize', title: 'SSO' }, '## Okta single sign-on\n\nSAML single sign-on works with Okta on every plan.\n\nSource: invented')
  add('/k/rival.md', { vendor: 'langsmith', title: 'LangSmith notes', category: 'competitive' }, '## Okta single sign-on at LangSmith\n\nRIVALCLAIM LangSmith single sign-on with Okta.\n\nSource: invented')
  kb.approve('arize-sso', true)
  kb.approve('rival', true)

  it("the items Keith ticked plus his own; when he ticked none of the call's, every item not removed", () => {
    const a = item('we_owe', 'Send guide')
    const b = item('agreed', 'Pilot', 'removed')
    expect(draftItems([a, b])).toEqual([a])
    const c = item('they_owe', 'Share data', 'confirmed')
    expect(draftItems([a, b, c])).toEqual([c])
    // Adding one missing item (it starts ticked) doesn't leave out everything he didn't tick.
    const mine: WrapupItem = { ...item('agreed', 'Pilot on their support bot next month', 'confirmed'), id: 'k1', added_by_keith: true, turn_ids: [] }
    expect(draftItems([a, b, mine])).toEqual([a, mine])
    // Once he ticks one of the call's items, his own items go with the ticked ones.
    expect(draftItems([a, b, c, mine])).toEqual([c, mine])
  })

  it("each quote says whose words it is: Keith's promise isn't something the buyer said", () => {
    const memory = new CallMemory('sess-1')
    memory.setup = { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' }
    memory.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana Whitfield' })
    memory.upsertTurn({ id: 't1', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 4000, text: 'Could you send the tracing overview?', available_ms: 4000 }, true)
    memory.upsertTurn({ id: 't2', stream: 'local_mic', cluster: null, start_ms: 4000, end_ms: 8000, text: "Yes, I'll send it by Friday.", available_ms: 8000 }, true)
    const owe: WrapupItem = { ...item('we_owe', 'Send the tracing overview', 'pending', "Yes, I'll send it by Friday."), turn_ids: ['t2'] }
    const ask: WrapupItem = { ...item('open_questions', 'How tracing works on their servers', 'pending', 'Could you send the tracing overview?'), turn_ids: ['t1'] }
    const u = followupUserMessage(buildFollowupInput(memory, [owe, ask], null))
    expect(u).toContain(`Keith said: "Yes, I'll send it by Friday."`)
    expect(u).toContain('Dana Whitfield (buyer) said: "Could you send the tracing overview?"')
    expect(u).not.toContain('they said:')
    expect(FOLLOWUP_SYSTEM_PROMPT).toMatch(/Keith's own words are never the buyer's/)
    expect(FOLLOWUP_SYSTEM_PROMPT).toMatch(/say it once/)
    expect(FOLLOWUP_SYSTEM_PROMPT).toMatch(/pain, urgency, interest or enthusiasm they didn't express/)
    // Practice mode says a promise once too.
    const body = JSON.parse(mockFollowup({ ...buildFollowupInput(memory, [owe, ask], null) })).body as string
    expect(body).toContain('From me: Send the tracing overview.')
    expect(body).not.toContain("I'll come back to you on")
  })

  it("searches each open question and promise; a competitor's section only when it was named", () => {
    const memory = new CallMemory('sess-1')
    memory.setup = { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' }
    const plain = buildFollowupInput(memory, [item('open_questions', 'Okta single sign-on?')], kb)
    expect(plain.knowledge.map((c) => c.doc_id)).toEqual(['arize-sso'])
    const named = buildFollowupInput(memory, [item('open_questions', 'Is Okta single sign-on like LangSmith has?'), item('we_owe', 'Compare LangSmith Okta single sign-on')], kb)
    expect(named.knowledge.map((c) => c.doc_id).sort()).toEqual(['arize-sso', 'rival'])
    expect(followupUserMessage(named)).toMatch(/LangSmith notes - Okta single sign-on at LangSmith \(about: LangSmith \(competitor\)/)
  })

  it('numbers not in the inputs and Arize claims without a cited K section become "check before sending" warnings', () => {
    const input: FollowupInput = {
      setup: { call_type: 'discovery', call_goal: '', desired_outcomes: [], account: 'Larkspur Health', deployment: 'unknown' },
      items: [item('open_questions', 'Does Okta single sign-on work for their 12 teams?')], buyers: ['Dana'], wants: [], knowledge: [],
    }
    const draft = (body: string, sources: string[] = []) => validateFollowup(JSON.stringify({ subject: 'Following up', body, sources }), input)
    expect(draft('Hi Dana,\n\nThanks. I\'ll come back to you on single sign-on for your 12 teams.\n\nKeith')).toMatchObject({ ok: true, draft: { checks: [] } })
    expect(draft('Hi Dana,\n\nWe support SAML single sign-on with Okta.\n\nKeith')).toMatchObject({ ok: true, draft: { checks: ['Says what Arize can do without an approved source. Check it before sending.'] } })
    expect(draft('Hi Dana, it costs $500 a month for 3 seats.\n\nKeith')).toMatchObject({ ok: true, draft: { checks: ["Has a number that isn't in the call or approved knowledge ($500, 3). Check it before sending."] } })
    const withK = { ...input, knowledge: kb.search('okta single sign-on').usable.filter((c) => c.doc_id === 'arize-sso') }
    expect(validateFollowup(JSON.stringify({ subject: 's', body: 'We support SAML single sign-on with Okta.', sources: ['K1'] }), withK)).toMatchObject({ ok: true, draft: { checks: [], knowledge_chunk_ids: withK.knowledge.map((c) => c.chunk_id) } })
    expect(withK.knowledge).toHaveLength(1)
    // A cited id that wasn't given doesn't count as a source.
    expect(validateFollowup(JSON.stringify({ subject: 's', body: 'We support SAML single sign-on with Okta.', sources: ['K4'] }), withK)).toMatchObject({ draft: { checks: ['Says what Arize can do without an approved source. Check it before sending.'] } })
    expect(validateFollowup('{"subject": "s"}', input)).toEqual({ ok: false, code: 'bad_shape' })
    expect(validateFollowup('{"subject": "s", "body": "  ", "sources": []}', input)).toEqual({ ok: false, code: 'empty' })
  })
})
