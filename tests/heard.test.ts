/** M3 A: the card shows what it heard (heard line, Keith's filler, end of speech, listening blind). Invented calls only. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '../src/main/session'
import { CallMemory } from '../src/main/help/callMemory'
import { buildHelpContext } from '../src/main/help/context'
import { collectFeedbackCalls, feedbackMarkdown } from '../src/main/help/feedbackExport'
import { BLIND_WARN_MS, FILLER_MAX_WORDS, blindNote, blindWords, heardLine, heardSummary, isFiller, keithFiller, savedHeard, tailAtWord, theyAsked, withoutTrailingFiller } from '../src/main/help/heard'
import { buildPracticeMoment } from '../src/main/help/practice'
import { loadPlaybook } from '../src/main/help/prompt'
import { HelpService } from '../src/main/helpService'
import { Storage } from '../src/main/storage'
import { StagedModel, engineFixture } from './helpers/helpEngine'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const playbook = loadPlaybook(path.join(ROOT, 'config', 'playbook.json'))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
const CARD = 'MOVE: clarify_current_state\nASK: Who picks the sample each week?\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n'
/** Dana's words in the invented call (tests/helpers/helpEngine.ts). */
const DANA = 'The platform team looks at a sample of answers every week.'

describe("Keith's filler", () => {
  it('a short filler from the list, alone or chained, at most 5 words', () => {
    for (const t of [
      'Great question.', 'Good question!', "That's a great question.", 'That’s a good question', 'Yeah.', 'So,', 'Okay.', 'OK', 'Right.',
      'Sure.', 'Mm-hmm.', 'Mhmm', 'Uh-huh.', 'Hmm.', 'Um', 'Let me think.', 'Let me think about that.', 'Yeah, great question.',
      'So, let me think.', 'Okay, so…', 'Right, right.', 'Got it.', 'Yeah yeah', "That's a fair question, so", 'Alright.', 'All right, so',
    ]) expect(isFiller(t), t).toBe(true)
  })

  it('never real words, answers, or more than 5 words', () => {
    for (const t of [
      'No, not yet.', 'No.', 'Yes.', 'Not yet', 'yeah we do support that', 'So the pricing is per seat.', 'Right now we use LangSmith.',
      'Okay so the SSO piece', 'Sure, we can send that over.', 'Great question, we integrate with LangSmith.', 'Let me check with our SA.',
      'Yeah yeah yeah yeah yeah yeah', 'Great question so so so so', '', '   ', '…', 'Absolutely.', 'Exactly, that is the point.',
    ]) expect(isFiller(t), t).toBe(false)
    expect(FILLER_MAX_WORDS).toBe(5)
  })

  it("only Keith's mic: the other side's filler still means the moment moved on", () => {
    expect(keithFiller({ stream: 'local_mic', text: 'Great question.' })).toBe(true)
    expect(keithFiller({ stream: 'system_remote', text: 'Great question.' })).toBe(false)
    expect(keithFiller({ stream: 'system_remote', text: 'Okay.' })).toBe(false)
    expect(keithFiller({ stream: 'local_mic', text: 'No, not yet.' })).toBe(false)
  })

  it("only Keith's trailing filler turns are left out of the moment; anything after them keeps them", () => {
    const t = (stream: 'local_mic' | 'system_remote', text: string) => ({ stream, text })
    const q = t('system_remote', 'Do you integrate with tracing?')
    expect(withoutTrailingFiller([q, t('local_mic', 'Great question.'), t('local_mic', 'So,')])).toEqual([q])
    const answered = [q, t('local_mic', 'Yes, we do.')]
    expect(withoutTrailingFiller(answered)).toEqual(answered)
    const theirs = [q, t('system_remote', 'Okay.')]
    expect(withoutTrailingFiller(theirs)).toEqual(theirs)
    const middle = [t('local_mic', 'Great question.'), q]
    expect(withoutTrailingFiller(middle)).toEqual(middle)
    expect(withoutTrailingFiller([])).toEqual([])
  })
})

describe('heard line', () => {
  it('keeps the end of long words, cut at a word', () => {
    expect(tailAtWord('Short and sweet?')).toBe('Short and sweet?')
    const long = 'We have been looking at a few options for tracing and evaluation and the thing I keep wondering is do you integrate with Lang Smith?'
    const t = tailAtWord(long)
    expect(t.startsWith('…')).toBe(true)
    expect(t.endsWith('do you integrate with Lang Smith?')).toBe(true)
    expect(t.length).toBeLessThanOrEqual(91)
    expect(long.endsWith(t.slice(1))).toBe(true)
    expect(t[1]).not.toBe(' ')
  })

  it('what they said last, who said it as HELP names them, and how long before the press', () => {
    const m = new CallMemory('s')
    m.upsertTurn({ id: 'a', stream: 'system_remote', cluster: 'e1:s0', start_ms: 1000, end_ms: 4000, text: 'Do you integrate with Lang Smith?', available_ms: 4500 }, true)
    m.upsertTurn({ id: 'b', stream: 'local_mic', cluster: null, start_ms: 4600, end_ms: 5200, text: 'Great question.', available_ms: 5600 }, true)
    expect(heardLine(m, 8000)).toEqual({ text: 'Do you integrate with Lang Smith?', speaker: 'Speaker 0 (unlabeled)', ago_ms: 4000 })
    m.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana' })
    expect(heardLine(m, 8000)?.speaker).toBe('Dana (buyer)')
    // "So, yeah." has no real words: the question before it is what the card answers.
    m.upsertTurn({ id: 'c', stream: 'system_remote', cluster: 'e1:s1', start_ms: 5300, end_ms: 6000, text: 'So, yeah.', available_ms: 6400 }, true)
    expect(heardLine(m, 8000)).toMatchObject({ text: 'Do you integrate with Lang Smith?', ago_ms: 4000 })
    // Still being transcribed: no speaker yet, said now. "Them" on the card, as the compact dot says (never "Remote").
    m.setInterim('system_remote', 'And what about pricing for the', 7500)
    expect(heardLine(m, 8000)).toEqual({ text: 'And what about pricing for the', speaker: 'Them', ago_ms: 0 })
  })

  it("none when they said nothing in the last 30 s, and never Keith's own words", () => {
    const m = new CallMemory('s')
    m.upsertTurn({ id: 'k', stream: 'local_mic', cluster: null, start_ms: 0, end_ms: 2000, text: 'How do you review outputs today?', available_ms: 2500 }, true)
    expect(heardLine(m, 5000)).toBeNull()
    m.upsertTurn({ id: 'a', stream: 'system_remote', cluster: 'e1:s0', start_ms: 3000, end_ms: 6000, text: 'We sample them weekly.', available_ms: 6500 }, true)
    expect(heardLine(m, 7000)?.text).toBe('We sample them weekly.')
    expect(heardLine(m, 40_000)).toBeNull()
  })

  it('reads back defensively from saved rows', () => {
    expect(savedHeard(undefined)).toBeNull()
    expect(savedHeard({ text: '', speaker: 'x', ago_ms: 1 })).toBeNull()
    expect(savedHeard({ text: 'Hi?', speaker: 'Dana (buyer)' })).toEqual({ text: 'Hi?', speaker: 'Dana (buyer)', ago_ms: 0 })
    expect(heardSummary({ text: 'Hi?', speaker: 'Dana (buyer)', ago_ms: 4200 })).toBe('"Hi?" (Dana (buyer) · 4 s before the press)')
    expect(heardSummary({ text: 'Hi', speaker: 'Them', ago_ms: 0 })).toBe('"Hi" (Them · still talking at the press)')
  })
})

describe('listening blind', () => {
  it('warns from BLIND_WARN_MS of untranscribed sound, not below', () => {
    expect(BLIND_WARN_MS).toBe(6000)
    expect(blindWords(5999)).toBeNull()
    expect(blindWords(0)).toBeNull()
    expect(blindWords(Number.NaN)).toBeNull()
    expect(blindWords(6000)?.warning).toBe("Their last ~6 s weren't transcribed yet. HELP may be behind.")
    expect(blindWords(9400)?.status).toBe("The other side's last ~9 s weren't transcribed yet: don't answer an older moment as if it were the latest; ask if unsure.")
  })

  it('reads the live hook; replay (no hook) and a failing hook never warn', () => {
    const m = new CallMemory('s')
    expect(blindNote(m)).toBeNull()
    m.untranscribedMs = () => 7000
    expect(blindNote(m)?.ms).toBe(7000)
    m.untranscribedMs = () => { throw new Error('session gone') }
    expect(blindNote(m)).toBeNull()
  })

  it("the card's warnings and HELP's <transcript_status> say so; under the threshold neither does", () => {
    const m = new CallMemory('s')
    m.upsertTurn({ id: 'a', stream: 'system_remote', cluster: 'e1:s0', start_ms: 1000, end_ms: 4000, text: 'We sample them weekly.', available_ms: 4500 }, true)
    m.untranscribedMs = () => 8000
    const blind = buildHelpContext({ memory: m, kb: null, atMs: 12_000 })
    expect(blind.warnings).toContain("Their last ~8 s weren't transcribed yet. HELP may be behind.")
    expect(blind.text).toMatch(/<transcript_status>\nThe other side's last ~8 s weren't transcribed yet: don't answer an older moment as if it were the latest; ask if unsure.\n<\/transcript_status>/)
    expect(blind.refs.gaps_noted).toEqual([])
    m.untranscribedMs = () => 5000
    const fine = buildHelpContext({ memory: m, kb: null, atMs: 12_000 })
    expect(fine.warnings.join(' ')).not.toMatch(/transcribed yet/)
    expect(fine.text).not.toContain('<transcript_status>')
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A background candidate for the invented call, finished and waiting for a press. */
async function readyCard(s: ReturnType<typeof engineFixture>, m: StagedModel) {
  s.engine.onFinalWords()
  await vi.advanceTimersByTimeAsync(800)
  expect(m.calls).toHaveLength(1)
  m.calls[0].send(CARD)
  m.calls[0].finish()
  await vi.advanceTimersByTimeAsync(0)
  s.advance(1500)
}

describe('HELP engine: the ready card survives a filler', () => {
  it("Keith's filler still being transcribed keeps the prepared card", async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.memory.setInterim('local_mic', 'Yeah, great question.', 0)
    s.engine.press()
    expect(m.calls).toHaveLength(1)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(true)
    expect(JSON.stringify(s.logs)).not.toContain('great question')
  })

  it("Keith's filler that already came back as a final turn keeps the prepared card too", async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.say('Great question.', 'keith')
    s.advance(300)
    s.engine.press()
    expect(m.calls).toHaveLength(1)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(true)
  })

  it('a final answer from Keith ("No, not yet.") makes a fresh card', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.say('No, not yet.', 'keith')
    s.advance(300)
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(false)
  })

  it('anything else Keith says makes a fresh card', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.memory.setInterim('local_mic', 'Yeah, we do support that.', 0)
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(false)
  })

  it("the other side's words never keep it, even a filler", async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.memory.setInterim('system_remote', 'Okay.', 0)
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(false)
  })
})

describe('HELP engine: background card on end of speech', () => {
  it("Keith's filler landing inside the debounce doesn't cancel the waiting card: the press still gets it ready", async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    s.say('We run evals nightly on a sample.') // no question mark: no early start on speech_final
    s.engine.onFinalWords('system_remote', 'We run evals nightly on a sample.')
    s.advance(400)
    await vi.advanceTimersByTimeAsync(400)
    s.say('Mm-hmm.', 'keith')
    s.engine.onFinalWords('local_mic', 'Mm-hmm.')
    s.engine.onSpeechEnd('system_remote', 'utterance_end')
    expect(m.calls).toHaveLength(1)
    m.calls[0].send(CARD)
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(1500)
    s.advance(1500)
    s.engine.press()
    expect(m.calls).toHaveLength(1)
    expect(s.events.at(-1)!.timing.served_from_prefetch).toBe(true)
    // Real words from Keith still cancel it, as before.
    const t = engineFixture(m, playbook, { prefetch: true })
    t.say('We run evals nightly on a sample.')
    t.engine.onFinalWords('system_remote', 'We run evals nightly on a sample.')
    t.say('Do you use an LLM judge for that?', 'keith')
    t.engine.onFinalWords('local_mic', 'Do you use an LLM judge for that?')
    t.engine.onSpeechEnd('system_remote', 'utterance_end')
    await vi.advanceTimersByTimeAsync(1500)
    expect(m.calls).toHaveLength(1)
  })

  it("their speech_final after a question starts the waiting background card at once (the debounce stays the fallback)", async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    s.say('Do you integrate with our tracing setup?')
    s.engine.onFinalWords('system_remote')
    expect(m.calls).toHaveLength(0)
    s.engine.onSpeechEnd('system_remote', 'speech_final')
    expect(m.calls).toHaveLength(1)
    expect(s.logs.find((l) => l.e === 'help_prefetch_early')?.d).toEqual({ signal: 'speech_final' })
    // The debounce doesn't start a second one for the same moment.
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.calls).toHaveLength(1)
  })

  it('nothing waiting means nothing to do: Keith spoke since, or the signal is from his mic', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    s.engine.onFinalWords('system_remote')
    s.engine.onFinalWords('local_mic') // Keith is talking: the candidate would be stale
    s.engine.onSpeechEnd('system_remote', 'utterance_end')
    expect(m.calls).toHaveLength(0)
    s.engine.onFinalWords('system_remote')
    s.engine.onSpeechEnd('local_mic')
    expect(m.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(800) // the fallback debounce
    expect(m.calls).toHaveLength(1)
  })

  it("a pause mid-explanation (speech_final, no question) waits for the debounce, so it doesn't use up the cap", async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    // A buyer explaining their setup with short pauses: each pause is a speech_final, more words follow within the debounce.
    for (const part of ['So we run evals nightly on a sample,', 'then the platform team reviews the misses,', 'and we track drift in a dashboard.']) {
      s.advance(400)
      s.say(part)
      s.engine.onFinalWords('system_remote')
      s.engine.onSpeechEnd('system_remote', 'speech_final')
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(m.calls).toHaveLength(0)
    expect(s.logs.some((l) => l.e === 'help_prefetch_early')).toBe(false)
    // Then the real question: speech_final starts it at once, with the cap untouched.
    s.advance(400)
    s.say('How would you handle that for us?')
    s.engine.onFinalWords('system_remote')
    s.engine.onSpeechEnd('system_remote', 'speech_final')
    expect(m.calls).toHaveLength(1)
    expect(s.logs.some((l) => l.e === 'help_prefetch_capped')).toBe(false)
  })

  it('their question is the last thing they said, after any of Keith\'s words', () => {
    const m = new CallMemory('s')
    expect(theyAsked(m, 1000)).toBe(false)
    m.upsertTurn({ id: 'a', stream: 'system_remote', cluster: 'e1:s0', start_ms: 0, end_ms: 900, text: 'Do you integrate with tracing?', available_ms: 950 }, true)
    expect(theyAsked(m, 1000)).toBe(true)
    m.upsertTurn({ id: 'k', stream: 'local_mic', cluster: null, start_ms: 950, end_ms: 1200, text: 'Mm-hmm.', available_ms: 1300 }, true)
    expect(theyAsked(m, 1400)).toBe(true)
    m.upsertTurn({ id: 'b', stream: 'system_remote', cluster: 'e1:s0', start_ms: 1300, end_ms: 2000, text: 'We use a custom collector today.', available_ms: 2100 }, true)
    expect(theyAsked(m, 2200)).toBe(false)
    m.upsertTurn({ id: 'c', stream: 'system_remote', cluster: 'e1:s0', start_ms: 2200, end_ms: 3000, text: 'Is that "supported?"', available_ms: 3100 }, true)
    expect(theyAsked(m, 3200)).toBe(true)
  })

  it('the 4-a-minute cap still holds', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    for (let i = 0; i < 6; i++) {
      s.advance(2000)
      s.say(`Point number ${i} about the weekly review?`)
      s.engine.onFinalWords('system_remote')
      s.engine.onSpeechEnd('system_remote')
    }
    const started = s.db.sql.prepare('SELECT COUNT(*) AS n FROM help_requests WHERE prefetch = 1').get() as { n: number }
    expect(started.n).toBe(4)
    expect(s.logs.some((l) => l.e === 'help_prefetch_capped')).toBe(true)
  })
})

describe('HELP engine: heard line and listening blind at the press', () => {
  it('every event of a request carries what it heard; kept with the request once shown', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook)
    const id = s.engine.press()
    m.calls[0].send(CARD)
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.events.length).toBeGreaterThan(1)
    for (const ev of s.events) expect(ev.heard).toEqual({ text: DANA, speaker: 'Dana (buyer)', ago_ms: 6000 })
    const row = s.db.sql.prepare('SELECT timing_json FROM help_requests WHERE id = ?').get(id) as { timing_json: string }
    expect(JSON.parse(row.timing_json).heard).toEqual({ text: DANA, speaker: 'Dana (buyer)', ago_ms: 6000 })
    // Diagnostics never carry it.
    expect(JSON.stringify(s.logs)).not.toContain('platform team')
  })

  it('a background card nobody saw keeps no heard line; adopted at a press, it gets the one from the press', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    const unseen = s.db.sql.prepare('SELECT timing_json FROM help_requests').get() as { timing_json: string }
    expect(unseen.timing_json).not.toContain('heard')
    expect(unseen.timing_json).not.toContain('platform team')
    s.engine.press()
    const shown = s.events.at(-1)!
    expect(shown.timing.served_from_prefetch).toBe(true)
    // Measured from the press, not from when the card was prepared.
    expect(shown.heard).toEqual({ text: DANA, speaker: 'Dana (buyer)', ago_ms: 7500 })
    const kept = s.db.sql.prepare('SELECT timing_json FROM help_requests').get() as { timing_json: string }
    expect(JSON.parse(kept.timing_json).heard.ago_ms).toBe(7500)
  })

  it('listening blind: a fresh request that says so, and the log keeps only the number', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.memory.untranscribedMs = () => 7000
    s.engine.press()
    expect(m.calls).toHaveLength(2)
    const ev = s.events.at(-1)!
    expect(ev.timing.served_from_prefetch).toBe(false)
    expect(ev.warnings).toContain("Their last ~7 s weren't transcribed yet. HELP may be behind.")
    expect(m.calls[1].user).toMatch(/The other side's last ~7 s weren't transcribed yet/)
    expect(s.logs.find((l) => l.e === 'help_listening_blind')?.d).toEqual({ blind_ms: 7000 })
  })

  it('under the threshold the prepared card is served as usual', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook, { prefetch: true })
    await readyCard(s, m)
    s.memory.untranscribedMs = () => BLIND_WARN_MS - 1
    s.engine.press()
    expect(m.calls).toHaveLength(1)
    expect(s.events.at(-1)!.warnings.join(' ')).not.toMatch(/transcribed yet/)
    expect(s.logs.some((l) => l.e === 'help_listening_blind')).toBe(false)
  })

  it('the practice moment keeps what the card heard; the feedback export does not carry their words', async () => {
    const m = new StagedModel()
    const s = engineFixture(m, playbook)
    s.db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run('sess-m2', new Date().toISOString(), JSON.stringify(s.memory.setup))
    const id = s.engine.press()
    m.calls[0].send(CARD)
    m.calls[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    const b = buildPracticeMoment(s.db, id)
    if (!b.ok) throw new Error(b.reason)
    expect(b.moment.keith_notes).toContain(`The card answered: "${DANA}" (Dana (buyer) · 6 s before the press).`)
    const md = feedbackMarkdown(collectFeedbackCalls(s.db, null), { period: 'all', now: new Date() })
    expect(md).not.toContain('Heard:')
    expect(md).not.toContain(DANA)
  })
})

describe('HelpService wiring', () => {
  it('end of speech reaches the engine; the blind getter reaches HELP', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heard-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    const clock = () => 0
    help.onSessionEvent({ type: 'state', state: 'checking', sessionId: 's-h' }, 's-h', clock)
    help.onSessionEvent({ type: 'state', state: 'live', sessionId: 's-h' }, 's-h', clock)
    const seen: string[] = []
    help.engine!.onSpeechEnd = (stream, signal) => { seen.push(`${stream}:${signal}`) }
    const ev: SessionEvent = { type: 'speech_end', stream: 'system_remote', signal: 'utterance_end' }
    help.onSessionEvent(ev, 's-h', clock)
    expect(seen).toEqual(['system_remote:utterance_end'])
    help.listeningBlindMs = () => 6500
    expect(blindNote(help.memory!)?.ms).toBe(6500)
    help.shutdown()
  })

  it("a finished turn reaches the engine with its words, so Keith's filler can be told apart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heard-'))
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {})
    const clock = () => 3000
    help.onSessionEvent({ type: 'state', state: 'checking', sessionId: 's-h' }, 's-h', clock)
    help.onSessionEvent({ type: 'state', state: 'live', sessionId: 's-h' }, 's-h', clock)
    const seen: Array<[string, string | undefined]> = []
    help.engine!.onFinalWords = (stream, text) => { seen.push([stream ?? '', text]) }
    help.onSessionEvent({ type: 'turn', event: { type: 'turn_final', turn: {
      turn_id: 't1', session_id: 's-h', stream: 'local_mic', speaker_cluster: null, speaker_identity_id: null, speaker_role: 'unknown',
      start_ms: 0, end_ms: 1000, text: 'Mm-hmm.', final: true, source_word_ids: [], gap_before: null,
    } } } as SessionEvent, 's-h', clock)
    expect(seen).toEqual([['local_mic', 'Mm-hmm.']])
    help.shutdown()
  })
})
