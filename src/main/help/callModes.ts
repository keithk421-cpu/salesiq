/**
 * Call modes (M5): each call type gets its own job. Discovery suggests the next question, a demo digs
 * into what lands while the SA presents, a deep-dive tracks the test plan, pricing holds back and a
 * follow-up remembers and moves one thing forward.
 *
 * Two parts, both pure:
 *   - modeFacts: a few things counted in code at the press (time left, Keith's questions, Keith's
 *     run of talk, a number of Keith's still unanswered, ...), in coarse buckets so a background card
 *     built a few seconds earlier still matches. Codes only: they go to HELP and timing_json, never
 *     to the screen or into a log as text.
 *   - modeBlock: the <call_mode> block for the active type only, from the playbook's call_modes
 *     (Keith can edit them), with the rules every mode shares written here once, so an edit can't drop
 *     them. It goes in the user message after the call context, so the cached system prompt stays the
 *     same on every call.
 *
 * The app never guesses the type: Keith picks it (no product we know of ships per-type modes).
 */
import type { CallSetup, CallType, ModeFacts } from '../../shared/help'
import { CALL_LENGTH_DEFAULTS, CALL_TYPES, CHECKIN_SECONDS } from '../../shared/help'
import type { CallMemory } from './callMemory'
import type { CallModeSpec, Playbook } from './prompt'

/** The playbook's call modes, one entry per type (helpService fills a missing type from the built-in). */
export type CallModes = Playbook['call_modes']

/** The types that have a mode: "other" behaves exactly as before (no block). */
export const MODE_TYPES: readonly CallType[] = CALL_TYPES.filter((t) => t !== 'other')

/**
 * The part of a type's block that comes from the playbook (goal, who talks, lines, never, as rendered)
 * is held to this: about 450 tokens at ~4 characters each. The app's own lines (the shared rules and the
 * counted facts) add about 750 characters on top, the same for every type.
 */
export const MODE_TEXT_MAX_CHARS = 1800
/** The opening, wrap and signal sentences go into other blocks; each is held to this. */
export const MODE_SENTENCE_MAX_CHARS = 400
/** Any one stored string, after cleaning (a guard: playbookProblem already holds the whole block to its cap). */
const STRING_MAX_CHARS = 600
const LIST_MAX = 12

const hasMode = (type: string): type is CallType => (MODE_TYPES as readonly string[]).includes(type)

// ------------------------------------------------------------------ cleaning

/**
 * One line, tags made harmless: playbook text is Keith's to edit, so it can't open or fake a tag that
 * pressModeOf(), isWrapRequest() or the MOCK model looks for, or start a line of its own.
 */
export function cleanModeText(s: unknown, max = STRING_MAX_CHARS): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(/\s+/g, ' ').replace(/[<>]/g, '').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** A field that may be one string or a list of strings, as clean lines (anything else left out). */
function asList(x: unknown): string[] {
  const raw = Array.isArray(x) ? x : typeof x === 'string' ? [x] : []
  return raw.map((s) => cleanModeText(s)).filter(Boolean).slice(0, LIST_MAX)
}

/** A one-sentence field (a list is joined), cleaned. */
function asSentence(x: unknown, max = MODE_SENTENCE_MAX_CHARS): string {
  return cleanModeText(Array.isArray(x) ? x.filter((s) => typeof s === 'string').join(' ') : x, max)
}

/** This type's entry, if the playbook has a usable one ("other" never has a mode). */
export function modeSpec(type: string, modes: CallModes | null | undefined): CallModeSpec | null {
  if (!hasMode(type) || !modes || typeof modes !== 'object') return null
  const spec = (modes as Record<string, unknown>)[type]
  return spec && typeof spec === 'object' && !Array.isArray(spec) ? (spec as CallModeSpec) : null
}

/** The type's sentence for the opening press, cleaned; '' when there is none. */
export function modeOpening(type: string, modes: CallModes | null | undefined): string {
  return asSentence(modeSpec(type, modes)?.opening)
}

/** The type's sentence that replaces the buying-signal press's ASK/SAY rule, cleaned; '' when there is none. */
export function modeSignal(type: string, modes: CallModes | null | undefined): string {
  return asSentence(modeSpec(type, modes)?.signal)
}

/** What WRAP aims for on this type, cleaned; '' when there is none. */
export function modeWrap(type: string, modes: CallModes | null | undefined): string {
  return asSentence(modeSpec(type, modes)?.wrap)
}

// ------------------------------------------------------------------ the block

/** Written once here, so every mode has them and an edit to the playbook can't drop them. */
const HOW_LINES_WORK =
  'How lines work in every mode: ASK and SAY are only words Keith says to the buyer. A cue to Keith (hold the pitch, not yet heard, sounds like extra work, a requirement to note) goes in HAPPENING.'
const LINE_ZERO =
  "0. They just asked or raised something: answer or handle it first (normal rules; in a demo or deep-dive with a teammate tagged, a technical how-to goes to the SA). This mode's line goes in FOLLOW."

const MINUTES_TEXT: Record<ModeFacts['minutes_left'], string> = {
  '>20': 'more than 20 min left',
  '20': 'about 20 min left',
  '15': 'about 15 min left',
  '10': 'about 10 min left',
  '5': 'about 5 min left',
  '0': 'at or past the planned end',
}
const PLAYBACK_TEXT: Record<ModeFacts['keith_q_since_playback'], string> = {
  '<10': 'under 10',
  '10-14': '10 to 14',
  '15+': '15 or more',
}
const RUN_TEXT: Record<ModeFacts['keith_run'], string> = {
  '<30s': 'under 30 s',
  '30-60s': '30 to 60 s',
  '60s-threshold': `60 to ${CHECKIN_SECONDS} s`,
  over_threshold: `over ${CHECKIN_SECONDS} s (past the check-in time)`,
}
/** The MOCK model looks for this to show a pricing Hold (models.ts). */
export const NUMBER_UNANSWERED_TEXT = "Keith gave a number they haven't answered yet"

const nearEnd = (m: ModeFacts['minutes_left']) => m === '10' || m === '5' || m === '0'

/**
 * The facts in plain words for HELP. Only the facts v1 lines use: the SA facts (sa_has_presented,
 * sa_run, sa_talking_now) are counted and stored but wait for step 2, after a real two-person call
 * shows the SA's speaker id holds.
 */
export function factsLine(f: ModeFacts): string {
  const parts = [MINUTES_TEXT[f.minutes_left], f.agreed_next_step ? 'next step agreed (call notes)' : 'no agreed next step']
  if (nearEnd(f.minutes_left)) parts.push(f.wrap_started ? 'wrap-up started (no time-left line again)' : 'wrap-up not started')
  parts.push(`Keith's questions since the last play-back: ${PLAYBACK_TEXT[f.keith_q_since_playback]}`)
  if (f.keith_q_in_row > 0) parts.push(`${f.keith_q_in_row === 3 ? '3 or more' : f.keith_q_in_row} in a row`)
  parts.push(`Keith's talk since they last spoke: ${RUN_TEXT[f.keith_run]}`)
  if (f.keith_number_unanswered) parts.push(NUMBER_UNANSWERED_TEXT)
  parts.push(f.teammate_tagged ? 'a teammate (the SA) is tagged' : 'no teammate tagged (roles unknown)')
  return `Right now (counted by the app; may lag): ${parts.join('; ')}.`
}

/**
 * The <call_mode> block for the active type only (null for "other", or a type the playbook has no
 * mode for). `facts` null: rendered without the "Right now" line (an older saved press).
 */
export function modeBlock(type: string, modes: CallModes | null | undefined, facts: ModeFacts | null): string | null {
  const spec = modeSpec(type, modes)
  if (!spec) return null
  const own = playbookLines(spec)
  return [
    `<call_mode type="${type}">`,
    ...own.head,
    HOW_LINES_WORK,
    "Keith's line on a press (first that applies):",
    LINE_ZERO,
    ...own.lines,
    ...own.never,
    ...(facts ? [factsLine(facts)] : []),
    '</call_mode>',
  ].join('\n')
}

/** The block's lines that come from the playbook, cleaned (goal and who talks; numbered lines; never). */
function playbookLines(spec: CallModeSpec): { head: string[]; lines: string[]; never: string[] } {
  const goal = asSentence(spec.goal, STRING_MAX_CHARS)
  const who = asSentence(spec.who_talks, STRING_MAX_CHARS)
  const never = asList(spec.never)
  return {
    head: [...(goal ? [`What this call is for: ${goal}`] : []), ...(who ? [`Who talks: ${who}`] : [])],
    // Numbered after line 0; a number Keith typed in is dropped so it isn't doubled.
    lines: asList(spec.lines).map((l, i) => `${i + 1}. ${l.replace(/^\d+[.)]\s*/, '')}`),
    never: never.length ? [`Never: ${never.join('; ')}.`.replace(/\.\.$/, '.')] : [],
  }
}

/** How long the playbook's part of a type's block is, as rendered (playbookProblem holds it to MODE_TEXT_MAX_CHARS). */
export function modeTextLength(spec: CallModeSpec): number {
  const own = playbookLines(spec)
  return [...own.head, ...own.lines, ...own.never].join('\n').length
}

/** The active call type, from the context's <call_setup> (so a replay uses the type it was built with). */
export function callTypeIn(contextText: string): CallType | null {
  const t = /<call_setup>\ntype: ([a-z_]+)\n/.exec(contextText)?.[1] ?? ''
  return (CALL_TYPES as readonly string[]).includes(t) ? (t as CallType) : null
}

/** Which mode a request carries, and whether it says Keith's number is waiting for an answer (MOCK only). */
export function callModeOf(user: string): { type: CallType; number_unanswered: boolean } | null {
  const m = /<call_mode type="([a-z_]+)">\n([\s\S]*?)\n<\/call_mode>/.exec(user)
  if (!m || !hasMode(m[1])) return null
  return { type: m[1], number_unanswered: m[2].includes(`\nRight now (counted by the app; may lag): `) && m[2].includes(NUMBER_UNANSWERED_TEXT) }
}

// ------------------------------------------------------------------ the built-in fallback

/**
 * Keith's playbook copy wins, but a copy made before modes existed (or that leaves a type out) takes
 * that type's mode from the built-in one. Without this, modes would stay off on Keith's machine with no
 * sign why. `from` says which is in use, for the playbook panel.
 */
export function withBuiltInModes(mine: Playbook, builtIn: Playbook): { playbook: Playbook; from: 'yours' | 'built_in' | 'mixed' } {
  const merged: Partial<Record<string, CallModeSpec>> = {}
  let yours = 0
  let theirs = 0
  for (const t of MODE_TYPES) {
    const own = modeSpec(t, mine.call_modes)
    const shipped = modeSpec(t, builtIn.call_modes)
    if (own) {
      merged[t] = own
      yours++
    } else if (shipped) {
      merged[t] = shipped
      theirs++
    }
  }
  const from = yours && theirs ? 'mixed' : yours ? 'yours' : 'built_in'
  return { playbook: { ...mine, call_modes: merged }, from }
}

// ------------------------------------------------------------------ the facts

/** "Right?", "make sense?", "you know?" at the end of a turn: a tag on a statement, not a question. */
const TAG_QUESTION = /(?:^|[\s,.;:!?-])(?:right|make sense|makes sense|does that make sense|you know|okay|ok|yeah|correct)\s*\?\s*$/i
/** A short play-back: Keith checks they got it right. */
const PLAYBACK = /\b(?:did i get that right|did i miss anything|anything i missed|is that a fair summary)\b/i
/** Since about 10 minutes were left: Keith asking about the next step, timing or what stood out. */
const WRAP_ASK = /\bnext steps?\b|\bstood out\b|\bfrom here\b|\bbefore we run out\b|\bbook(?:ed|ing)? (?:a|an|the|some|time|it|that|this|another|us|you|in|for|our)\b|\bfollow[- ]?ups?\b|\bfollow up\b/i
/**
 * A figure Keith gave: a currency amount ("$40k", "€12,000", "40 thousand dollars", "120,000 USD") or a
 * percentage ("18%", "20 percent"). Volumes ("10 million traces a month"), days and counts don't count.
 */
const KEITH_NUMBER = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:k|m|thousand|million|grand)?\s?(?:dollars|euros|pounds|bucks|usd|eur|gbp)\b|\d\s?(?:%|percent\b|per cent\b)/i

const PLAYBACK_LONG_MS = 30_000
const THEIR_REPLY_WORDS = 5
const THEIR_ANSWER_WORDS = 8
const QUESTION_MIN_WORDS = 4
const SA_PRESENTED_MS = 60_000
const SA_LONG_RUN_MS = 120_000

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** A question Keith asked: at least 4 words with a "?", once a trailing tag ("right?") is taken off. */
export function keithQuestion(text: string): boolean {
  let t = text.trim()
  // At most twice ("..., right? Okay?"): a turn that is only tags isn't a question.
  for (let i = 0; i < 2 && TAG_QUESTION.test(t); i++) t = t.replace(TAG_QUESTION, '').trim()
  return t.includes('?') && words(t.replace(/[?]/g, ' ')) >= QUESTION_MIN_WORDS
}

/** Keith played back what they said: a turn of 30 s or more, or one that checks it ("did I miss anything?"). */
export function keithPlayback(t: { text: string; start_ms: number; end_ms: number }): boolean {
  return t.end_ms - t.start_ms >= PLAYBACK_LONG_MS || PLAYBACK.test(t.text)
}

/** Keith asked about the next step, the time or what stood out (the wrap-up has started). */
export function wrapAsk(text: string): boolean {
  return WRAP_ASK.test(text)
}

/** A currency figure or a percentage. */
export function keithNumber(text: string): boolean {
  return KEITH_NUMBER.test(text)
}

/** The call's planned length in minutes: the setup's, else the type's default. */
export function callLengthMin(type: string, setup: { length_min?: unknown } | null | undefined): number {
  const n = setup?.length_min
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n
  return (CALL_LENGTH_DEFAULTS as Record<string, number>)[type] ?? CALL_LENGTH_DEFAULTS.other
}

function minutesBucket(leftMs: number): ModeFacts['minutes_left'] {
  const left = leftMs / 60_000
  if (left > 20) return '>20'
  if (left <= 0) return '0'
  return String(Math.ceil(left / 5) * 5) as ModeFacts['minutes_left']
}

function runBucket(ms: number, thresholdS: number): ModeFacts['keith_run'] {
  const s = ms / 1000
  if (s >= thresholdS) return 'over_threshold'
  return s < 30 ? '<30s' : s < 60 ? '30-60s' : '60s-threshold'
}

function saRunBucket(ms: number, thresholdS: number): ModeFacts['sa_run'] {
  if (ms <= 0) return 'none'
  if (ms > SA_LONG_RUN_MS) return '>120s'
  return ms / 1000 >= thresholdS ? 'at_or_over' : 'below'
}

/**
 * The mode facts at a press (ModeFacts in shared/help.ts), from finished turns plus one fact about live
 * words. Who is who comes from memory.fromTheirSide() and the speaker labels (role "teammate" is the
 * SA). `checkinSeconds` is how long a run may go before a check-in (Keith may change it later).
 */
export function modeFacts(memory: CallMemory, atMs: number, type: string, setup: Partial<CallSetup> | null | undefined, checkinSeconds = CHECKIN_SECONDS): ModeFacts {
  const turns = memory.turnsAsOf(atMs)
  const keith = (t: { stream: string }) => t.stream === 'local_mic'
  const teammate = (t: { stream: string; cluster: string | null }) => t.stream === 'system_remote' && !!t.cluster && memory.labels.get(t.cluster)?.role === 'teammate'
  const theirs = (t: { stream: 'local_mic' | 'system_remote'; cluster: string | null }) => memory.fromTheirSide(t)

  // Session time from Start, not from when the Zoom started: Keith's length setting covers an early Start.
  const lengthMs = callLengthMin(type, setup) * 60_000
  const minutes_left = minutesBucket(lengthMs - atMs)
  const wrapFromMs = lengthMs - 10 * 60_000
  const wrap_started = nearEnd(minutes_left) && turns.some((t) => keith(t) && t.start_ms >= wrapFromMs && wrapAsk(t.text))

  // Proposed is not agreed: only a next step the notes mark "agreed".
  const steps = (memory.callNotes?.notes as { next_steps?: unknown } | undefined)?.next_steps
  const agreed_next_step = Array.isArray(steps) && steps.some((s) => (s as { status?: unknown } | null)?.status === 'agreed')

  let sincePlayback = 0
  let inRow = 0
  for (const t of turns) {
    if (keith(t)) {
      if (keithPlayback(t)) sincePlayback = 0
      else if (keithQuestion(t.text)) sincePlayback++
      if (keithQuestion(t.text)) inRow++
    } else if (theirs(t) && words(t.text) >= THEIR_ANSWER_WORDS) inRow = 0
  }

  // Runs since the other side's last real turn (a "mm-hmm" doesn't end one).
  const lastReply = [...turns].reverse().find((t) => theirs(t) && words(t.text) >= THEIR_REPLY_WORDS)
  const after = (t: { start_ms: number }) => !lastReply || t.start_ms > lastReply.start_ms
  const talkMs = (pick: (t: (typeof turns)[number]) => boolean) => turns.filter((t) => pick(t) && after(t)).reduce((n, t) => n + Math.max(0, t.end_ms - t.start_ms), 0)
  const keithRunMs = talkMs(keith)
  const saRunMs = talkMs(teammate)

  // Keith's latest turn gave a figure, and nobody on their side has spoken since (live words count).
  const lastKeith = [...turns].reverse().find(keith)
  // The interim's speaker id is read defensively: older memory doesn't carry it (then it counts as theirs).
  const live = memory.interimsAsOf(atMs).filter((i) => i.stream === 'system_remote' && i.text.trim()).map((i) => ({ stream: i.stream, cluster: (i as { cluster?: string | null }).cluster ?? null }))
  const keith_number_unanswered = !!lastKeith && keithNumber(lastKeith.text) && !turns.some((t) => theirs(t) && t.start_ms > lastKeith.start_ms) && !live.some(theirs)

  const teammate_tagged = [...memory.labels.values()].some((l) => l.role === 'teammate')
  const saTotalMs = turns.filter(teammate).reduce((n, t) => n + Math.max(0, t.end_ms - t.start_ms), 0)

  // One literal, keys always in this order: the background card is reused only when its press detail
  // (facts included) is the same JSON as the press's (engine.ts).
  return {
    minutes_left,
    agreed_next_step,
    wrap_started,
    keith_q_since_playback: sincePlayback >= 15 ? '15+' : sincePlayback >= 10 ? '10-14' : '<10',
    keith_q_in_row: Math.min(3, inRow) as ModeFacts['keith_q_in_row'],
    keith_run: runBucket(keithRunMs, checkinSeconds),
    keith_number_unanswered,
    teammate_tagged,
    sa_has_presented: saTotalMs > SA_PRESENTED_MS,
    sa_run: saRunBucket(saRunMs, checkinSeconds),
    sa_talking_now: live.some(teammate),
  }
}

/** Words a tagged teammate has said so far (finished turns and live words), for the demo opening. */
export function teammateWords(memory: CallMemory, atMs: number): number {
  const tagged = (cluster: string | null | undefined) => !!cluster && memory.labels.get(cluster)?.role === 'teammate'
  let n = 0
  for (const t of memory.turnsAsOf(atMs)) if (t.stream === 'system_remote' && tagged(t.cluster)) n += words(t.text)
  for (const i of memory.interimsAsOf(atMs)) if (i.stream === 'system_remote' && tagged((i as { cluster?: string | null }).cluster)) n += words(i.text)
  return n
}

/**
 * A press's detail with this moment's facts: what decidePress gives every press of a type that has a
 * mode, and what a replay uses when nothing was stored (a saved practice moment keeps its own).
 */
export function withModeFacts<D extends { mode_facts?: ModeFacts }>(detail: D, memory: CallMemory, atMs: number): D {
  if (detail.mode_facts) return detail
  const type = memory.setup.call_type
  if (!hasMode(type)) return detail
  return { ...detail, mode_facts: modeFacts(memory, atMs, type, memory.setup) }
}

// ------------------------------------------------------------------ stored and replayed

const MINUTES: ReadonlyArray<ModeFacts['minutes_left']> = ['>20', '20', '15', '10', '5', '0']
const PLAYBACKS: ReadonlyArray<ModeFacts['keith_q_since_playback']> = ['<10', '10-14', '15+']
const RUNS: ReadonlyArray<ModeFacts['keith_run']> = ['<30s', '30-60s', '60s-threshold', 'over_threshold']
const SA_RUNS: ReadonlyArray<ModeFacts['sa_run']> = ['none', 'below', 'at_or_over', '>120s']

/**
 * Mode facts read from a hand-editable file or a database row: codes only. A missing or unreadable
 * field gets its quiet value (nothing to act on); anything that isn't an object is no facts at all.
 */
export function cleanModeFacts(x: unknown): ModeFacts | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const f = x as Record<string, unknown>
  const pick = <T>(v: unknown, ok: readonly T[], quiet: T): T => ((ok as readonly unknown[]).includes(v) ? (v as T) : quiet)
  const yes = (v: unknown) => v === true
  return {
    minutes_left: pick(f.minutes_left, MINUTES, '>20'),
    agreed_next_step: yes(f.agreed_next_step),
    wrap_started: yes(f.wrap_started),
    keith_q_since_playback: pick(f.keith_q_since_playback, PLAYBACKS, '<10'),
    keith_q_in_row: pick(f.keith_q_in_row, [0, 1, 2, 3] as const, 0),
    keith_run: pick(f.keith_run, RUNS, '<30s'),
    keith_number_unanswered: yes(f.keith_number_unanswered),
    teammate_tagged: yes(f.teammate_tagged),
    sa_has_presented: yes(f.sa_has_presented),
    sa_run: pick(f.sa_run, SA_RUNS, 'none'),
    sa_talking_now: yes(f.sa_talking_now),
  }
}
