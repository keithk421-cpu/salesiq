import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockHelpModel } from '../src/main/help/models'
import { loadPlaybook } from '../src/main/help/prompt'
import { closingLanguage, isWrapRequest, wrapUserMessage } from '../src/main/help/wrap'
import { HelpService } from '../src/main/helpService'
import { Storage } from '../src/main/storage'
import { StagedModel, engineFixture } from './helpers/helpEngine'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const CARD = 'MOVE: confirm_next_step\nASK: What day next week works for a working session?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'

describe('closing language', () => {
  it('hears the call ending', () => {
    for (const t of [
      "Sorry, we're out of time.", "I know we're almost out of time", 'I have a hard stop at the half hour.', 'I have to jump in a minute.',
      'I need to hop off soon', "I'll let you go.", "It's nearly the top of the hour.", 'Before we wrap, can we agree on something?',
      'So what are the next steps?', "Let's wrap up here.", "I've got to run.", 'I have to run to another meeting', 'We’re at time.',
      'We are running short on time', "In terms of next steps, I'd suggest a demo.",
      'I have to run to my next meeting', "We've only got five minutes left", 'I have another meeting in two minutes',
      'I have another call at the top of the hour.', 'Okay, I need to drop off the call.', "Let's start wrapping up.",
      "To wrap up, we'd love a demo.", "I'll let you get back to your day.", 'Next steps?', "I'm short on time, sorry",
    ]) expect(closingLanguage(t), t).toBe(true)
  })

  it("doesn't mistake everyday talk for the end of the call", () => {
    for (const t of [
      'We have to jump through a lot of hoops for security.', 'The next steps in the pipeline call the retriever.',
      'We ran out of time last quarter, so it slipped.', 'We have to run the evals every night.', 'Can we wrap the SDK calls?',
      "That's the top of the funnel for us.", 'Before we go live we need sign-off.', 'We should hop on a call with security next week.',
      'I need to jump into the demo now.', 'The next step in the chain is the reranker.', 'We need to go through procurement first.',
      'Go ahead, next step of the process is review.', '',
      // Heard mid-call in practice runs: none of these mean the call is ending.
      "I'll let you go ahead and share your screen", "Sure, I'll let you go first", 'We want to wrap up the evaluation by end of Q3',
      "we're tight on time with the launch so we need something fast", "honestly we're running out of time to pick a vendor",
      "we're short on time for this project", 'the batch job kicks off at the top of the hour',
      'Our next steps are to migrate everything to Snowflake.', 'Next steps for us internally are a POC with Datadog.',
      'the next steps after ingestion are labeling', 'The job runs at the top of the hour.', "We'll need to drop support for the old SDK.",
      'I have to drop the old tables first.', 'We wrap it up in a Docker image.', "we're tight on time to market",
      'What are your next steps for evaluating vendors?', 'We need to hop on a call next week with security.',
    ]) expect(closingLanguage(t), t).toBe(false)
  })

  it('the wrap instruction asks for one dated next step and what Keith still owes, without inventing anything', () => {
    const u = wrapUserMessage('<call_setup>x</call_setup>', 'button')
    expect(u.startsWith('<call_setup>x</call_setup>')).toBe(true)
    expect(u).toMatch(/what happens, who attends, and a date or time/)
    expect(u).toMatch(/MOVE: confirm_next_step/)
    expect(u).toMatch(/A step that was only proposed is not agreed/)
    expect(u).toMatch(/never pick a date, a name or a commitment nobody said/)
    expect(u).toMatch(/FOLLOW: what Keith still owes them from this call, as a short line in Keith's voice/)
    // No timeframe nobody said, and no pushing for a meeting after "not now".
    expect(u).not.toMatch(/next week/)
    expect(u).toMatch(/Keep to any timeframe they named/)
    expect(u).toMatch(/If they said not now or not interested, don't push for a meeting/)
    expect(isWrapRequest(u)).toBe(true)
    // WRAP is strict; closing words heard before HELP let a question they just asked come first.
    expect(u).not.toMatch(/answer or handle that first/)
    const closing = wrapUserMessage('x', 'closing')
    expect(closing).toMatch(/last 30 seconds sound like the call may be ending/)
    expect(closing).toMatch(/If they just asked a question or raised a concern, answer or handle that first/)
    expect(closing).toMatch(/If the call is not actually ending, ignore this block/)
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** Lets a prefetched candidate be built and finished, so a press could adopt it. */
async function prefetched(s: ReturnType<typeof engineFixture>, m: StagedModel) {
  s.engine.onFinalWords('system_remote')
  await vi.advanceTimersByTimeAsync(800)
  expect(m.calls).toHaveLength(1)
  m.calls[0].send(CARD)
  m.calls[0].finish()
  await vi.advanceTimersByTimeAsync(0)
  s.advance(1000)
}

describe('WRAP card', () => {
  it('WRAP is always a fresh request with the wrap instruction, kept as a WRAP card', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await prefetched(s, m)
    const id = s.engine.press('wrap_requested')
    expect(m.calls).toHaveLength(2) // the background candidate was not used
    expect(isWrapRequest(m.calls[1].user)).toBe(true)
    m.calls[1].send(CARD)
    m.calls[1].finish()
    await vi.advanceTimersByTimeAsync(0)
    const last = s.events.at(-1)!
    expect(last).toMatchObject({ status: 'complete', origin: 'wrap_requested', wrap: true, timing: { served_from_prefetch: false } })
    const row = s.db.sql.prepare('SELECT origin, request_text, timing_json FROM help_requests WHERE id = ?').get(id) as Record<string, string>
    expect(row.origin).toBe('wrap_requested')
    // What was kept on disk is exactly what was sent.
    expect(row.request_text).toBe(m.calls[1].user)
    expect(JSON.parse(row.timing_json).wrap).toBe('button')
    expect(s.logs.find((l) => l.e === 'help_press' && l.d?.request_id === id)?.d).toMatchObject({ wrap: true, closing: false })
  })

  it('a HELP press with closing words in the last 30 s gets the wrap instruction and skips the candidate', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    s.say('This was useful, but I have a hard stop in two minutes.')
    await prefetched(s, m)
    const id = s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(m.calls[1].user).toMatch(/last 30 seconds sound like the call may be ending/)
    m.calls[1].send(CARD)
    m.calls[1].finish()
    await vi.advanceTimersByTimeAsync(0)
    // Keith pressed HELP: it stays a HELP card (rated as one), labelled "Wrapping up".
    expect(s.events.at(-1)).toMatchObject({ origin: 'help_requested', wrap: true })
    expect(s.logs.find((l) => l.e === 'help_press' && l.d?.request_id === id)?.d).toMatchObject({ wrap: true, closing: true })
    // Diagnostics never carry call or card text.
    const logs = JSON.stringify(s.logs)
    expect(logs).not.toMatch(/hard stop|platform team|working session/)
  })

  it('closing words from earlier in the call, or words still being transcribed, count only within the last 30 s', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook)
    s.say('Before we wrap, quick question on the timeline.')
    s.advance(45_000)
    s.say('Anyway, the review happens on Thursdays.')
    s.engine.press()
    expect(isWrapRequest(m.calls[0].user)).toBe(false)
    expect(s.events.at(-1)!.wrap).toBeUndefined()
    s.memory.setInterim('system_remote', "Sorry, I've got to run.", 66_000)
    s.advance(1000)
    s.engine.press()
    expect(isWrapRequest(m.calls[1].user)).toBe(true)
  })

  it('Practice mode answers WRAP with a next-step placeholder', async () => {
    const s = engineFixture(new MockHelpModel(10), playbook)
    s.engine.press('wrap_requested')
    await vi.advanceTimersByTimeAsync(50)
    expect(s.events.at(-1)).toMatchObject({ status: 'complete', mock: true, content: { move: 'confirm_next_step' } })
    expect(s.events.at(-1)!.content.primary).toMatch(/^\[MOCK\]/)
  })
})

describe('WRAP in the app', () => {
  it('needs a live call, and a rating on a WRAP card is stored as a WRAP rating', () => {
    vi.useRealTimers()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    expect(help.press('wrap_requested')).toEqual({ ok: false, reason: 'Start a call first.' })
    const ins = help.db.sql.prepare("INSERT INTO help_requests (id, session_id, origin, created_at, status, model_json, prefetch) VALUES (?, 's1', ?, 't', 'complete', '{}', 0)")
    ins.run('w1', 'wrap_requested')
    ins.run('h1', 'help_requested')
    expect(help.feedback({ card_id: 'w1', type: 'useful' })).toEqual({ ok: true })
    expect(help.feedback({ card_id: 'h1', type: 'bad' })).toEqual({ ok: true })
    expect(help.feedback({ card_id: 'unknown-card', type: 'useful' })).toEqual({ ok: true })
    const rows = help.db.sql.prepare('SELECT card_id, origin FROM feedback ORDER BY id').all()
    expect(rows).toEqual([{ card_id: 'w1', origin: 'wrap_requested' }, { card_id: 'h1', origin: 'help_requested' }, { card_id: 'unknown-card', origin: 'help_requested' }])
    expect(help.info()).toMatchObject({ wrapHotkeyRegistered: false })
    help.shutdown()
  })
})
