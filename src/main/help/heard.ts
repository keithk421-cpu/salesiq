/**
 * The card shows what it heard (M3 A).
 *
 * - The heard line: the other side's words a card answers, as they were at the press (what they said
 *   last, else what they asked; retrieval.ts questionParts), who said them as HELP names them, and how
 *   long before the press they ended. Shown at the top of the card so Keith can tell at a glance
 *   whether the card is about the moment he's in.
 * - Keith's filler: a press while Keith's own "Great question, so…" is still being transcribed keeps
 *   the card prepared in the background. Only a short filler from a fixed list, only from his mic:
 *   anything else he says (or anything the other side says) means the moment moved on.
 * - Listening blind: the meeting audio has had sound for a while and no words came back from the
 *   speech service. The card says so and HELP is told to ask rather than answer an older moment.
 */
import type { Stream } from '../../shared/contracts'
import type { HeardLine } from '../../shared/help'
import type { CallMemory } from './callMemory'
import { speakerName } from './context'
import { QUESTION_WINDOW_MS, questionParts } from './retrieval'

/** The heard line is cut to about this many characters, at a word, keeping the end (their latest words). */
export const HEARD_MAX_CHARS = 90

/** A filler is at most this many words ("that's a great question, so" is five). */
export const FILLER_MAX_WORDS = 5

/**
 * What Keith says to buy a second, not an answer. Never "yes", "no" or "not yet": those answer
 * something, so the prepared card may be wrong now. Lower case, as normalised by fillerWords().
 */
export const FILLER_PHRASES = [
  "that's a great question", "that's a good question", "that's a fair question", 'great question', 'good question', 'fair question',
  'let me think about that', 'let me think', 'let me see', 'got it', 'i see', 'makes sense', 'all right', 'mm hmm', 'uh huh',
  'yeah', 'yep', 'so', 'okay', 'ok', 'right', 'sure', 'alright', 'well', 'hmm', 'mhm', 'mhmm', 'mm', 'um', 'uh', 'er', 'great', 'cool',
]

/** A filler's words, lower case, without punctuation ("Mm-hmm." -> ["mm", "hmm"]). */
function fillerWords(text: string): string[] {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/-/g, ' ').replace(/[^a-z' ]+/g, ' ').trim().split(/\s+/).filter(Boolean)
}

const PHRASE_WORDS = FILLER_PHRASES.map((p) => p.split(' ')).sort((a, b) => b.length - a.length)

/** True when the text is only filler phrases ("Yeah, great question.", "So, let me think."), at most FILLER_MAX_WORDS words. */
export function isFiller(text: string): boolean {
  const words = fillerWords(text)
  if (!words.length || words.length > FILLER_MAX_WORDS) return false
  let i = 0
  while (i < words.length) {
    const hit = PHRASE_WORDS.find((p) => p.every((w, k) => words[i + k] === w))
    if (!hit) return false
    i += hit.length
  }
  return true
}

/** Words still being transcribed that don't make the prepared card stale: Keith's own short filler (his mic only). */
export function keithFiller(i: { stream: Stream; text: string }): boolean {
  return i.stream === 'local_mic' && isFiller(i.text)
}

/** The end of the text, cut at a word to about `max` characters, with a leading "…" when cut. */
export function tailAtWord(text: string, max = HEARD_MAX_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const tail = t.slice(t.length - max)
  const sp = tail.indexOf(' ')
  // Start at the next whole word, unless that would throw most of it away (one very long word).
  return `…${sp >= 0 && sp < max / 2 ? tail.slice(sp + 1) : tail}`
}

/**
 * What the card answers: the other side's words at the press (what they said last, else what they
 * asked), who said them and how long before `atMs` they ended. Null when they said nothing in the last
 * 30 s. Words still being transcribed have no speaker yet: named as HELP names them ("Remote"), 0 s ago.
 */
export function heardLine(memory: CallMemory, atMs: number): HeardLine | null {
  const q = questionParts(memory, atMs)
  const part = (q.newest || q.asked).trim()
  if (!part) return null
  const turns = memory.turnsAsOf(atMs)
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.stream !== 'system_remote' || t.end_ms < atMs - QUESTION_WINDOW_MS) continue
    if (t.text.trim() === part) return { text: tailAtWord(part), speaker: speakerName(memory, t), ago_ms: Math.max(0, Math.round(atMs - t.end_ms)) }
  }
  return { text: tailAtWord(part), speaker: 'Remote', ago_ms: 0 }
}

/** At a press, this much sound on the meeting audio with no words back means HELP may be behind. */
export const BLIND_WARN_MS = 6000

/** The card's warning and the <transcript_status> line, for `ms` of sound with no words back (null below BLIND_WARN_MS). */
export function blindWords(ms: number): { warning: string; status: string } | null {
  if (!(ms >= BLIND_WARN_MS)) return null
  const n = Math.round(ms / 1000)
  return {
    warning: `Their last ~${n} s weren't transcribed yet. HELP may be behind.`,
    status: `The other side's last ~${n} s weren't transcribed yet: don't answer an older moment as if it were the latest; ask if unsure.`,
  }
}

/** The meeting audio is untranscribed right now (live calls only: replay and tests have no hook). */
export function blindNote(memory: CallMemory): { ms: number; warning: string; status: string } | null {
  let ms = 0
  try {
    ms = memory.untranscribedMs?.() ?? 0
  } catch {
    // Never stops HELP: the press goes on without the warning.
    return null
  }
  const w = blindWords(ms)
  return w ? { ms: Math.round(ms), ...w } : null
}

/** A heard line read back from a saved request (timing_json): null unless it has the expected shape (older rows have none). */
export function savedHeard(x: unknown): HeardLine | null {
  const h = x as Partial<HeardLine> | null | undefined
  if (!h || typeof h !== 'object' || typeof h.text !== 'string' || !h.text.trim() || typeof h.speaker !== 'string') return null
  return { text: h.text, speaker: h.speaker, ago_ms: typeof h.ago_ms === 'number' && Number.isFinite(h.ago_ms) ? Math.max(0, h.ago_ms) : 0 }
}

/** "…words" (Dana (buyer) · 4 s before the press), for the practice moment's notes and the feedback export. */
export function heardSummary(h: HeardLine): string {
  const ago = h.ago_ms < 1000 ? 'still talking at the press' : `${Math.round(h.ago_ms / 1000)} s before the press`
  return `"${h.text}" (${h.speaker} · ${ago})`
}
