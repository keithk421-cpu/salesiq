/**
 * Smarter presses (M3): the same HELP button asks for something a little different when the moment
 * calls for it. Each is a short instruction block after the call context (like the WRAP card in
 * wrap.ts), a label on the card, and stored with the request so a practice moment replays it.
 *
 * Which one applies, in order (decidePress):
 *   1. the WRAP button (wrap.ts), building on the latest buying signal if there was one;
 *   2. another angle: Keith presses again for the same moment (nothing new said) soon after a card;
 *   3. closing words just before a HELP press (wrap.ts, M2);
 *   4. a buying signal: in the last 30 s they asked about a pilot, rollout time, pricing, or
 *      something to send their boss: the line answers or defers, FOLLOW proposes a next step;
 *   5. the opening: they've said little so far, early in the call;
 *   otherwise a normal press.
 *
 * Nothing appears without a press. The instruction goes in the user message, after the call
 * context, so the cached system prompt stays the same for every press.
 */
import type { HelpOrigin, MemoryTurn, PressMode, SalesMove } from '../../shared/help'
import { SALES_MOVES } from '../../shared/help'
import type { Stream } from '../../shared/contracts'
import type { CallMemory } from './callMemory'
import { HOT_WINDOW_MS, fmtClock } from './context'
import { buildUserMessage } from './prompt'
import { wrapReason, wrapUserMessage, type WrapWhy } from './wrap'

/** A re-press this soon after a card finished (and nothing new said) asks for another angle on it. */
export const ANOTHER_ANGLE_WINDOW_MS = 20_000
/** ...but only once that card was on screen long enough to have been read. */
export const ANOTHER_ANGLE_MIN_SHOWN_MS = 2_000
/** "Early in the call": the opening applies within the first 5 minutes of live time... */
export const OPENING_WINDOW_MS = 5 * 60_000
/** ...while the other side has said fewer words than this in all. */
export const OPENING_MAX_WORDS = 40
const MUST_LEARN_MAX = 3
const MUST_LEARN_MAX_CHARS = 80
const PRIOR_MAX_CHARS = 240

export type SignalKind = 'pilot' | 'rollout' | 'pricing' | 'send_to_boss'
export const SIGNAL_KINDS: readonly SignalKind[] = ['pilot', 'rollout', 'pricing', 'send_to_boss']

/** A buying signal and when they said it (call time). */
export interface SignalSeen {
  kind: SignalKind
  at_ms: number
}

/** The card Keith already got, for another angle. */
export interface PriorCard {
  move: string
  primary_kind: 'ask' | 'say'
  primary: string
}

/** What a press's instruction block needs beyond the call context (kept with a practice moment so it replays the same). */
export interface PressDetail {
  /** signal: what they asked about. */
  signal?: SignalKind
  /** another_angle: the line and move Keith already got. */
  prior?: PriorCard
  /** opening: Keith's must-learns for this call, as they were at the press. */
  must_learn?: string[]
  /** WRAP (or closing words): the latest buying signal of the call, for the next step to build on. */
  wrap_signal?: SignalSeen
}

export interface PressDecision {
  wrap: WrapWhy | null
  mode: PressMode | null
  detail: PressDetail
}

// ------------------------------------------------------------------ buying signals

/** Who would be shown the summary: "my VP", "our CTO", "my boss", "leadership", "the exec team". */
const BOSS = String.raw`(?:(?:my|our) (?:vp|v\.p\.|svp|evp|boss|manager|director|cto|cio|ciso|ceo|cfo|head of [a-z]+|leadership(?: team)?|execs?|executives?|exec team|chief [a-z]+ officer)|leadership(?: team)?|(?:the )?exec(?:utive)?s?(?: team)?)\b`
const TRIAL = String.raw`(?:pilot|poc|proof of concept|proof-of-concept|trial|free trial)`
const ROLL = String.raw`(?:implementation|rollout|roll-out|onboarding|deployment|setup|set-up)`

/**
 * Asking or wanting it, from Arize: each phrase is tied to the words around it, so their own work
 * ("token pricing in our pipeline", "the rollout of our new model", "our internal pilot of the
 * chatbot", "we priced it per seat internally") doesn't count. The tests list both kinds; a phrase
 * that slips through belongs there.
 */
const SIGNALS: Array<{ kind: SignalKind; res: RegExp[] }> = [
  {
    kind: 'pilot',
    res: [
      // "can we do a pilot?", "could we run a quick POC", "can we get a trial"
      new RegExp(String.raw`\b(?:can|could|would) (?:we|i|you) (?:do|run|set up|start|get|try|have) (?:a |an |some )?(?:quick |short |small |free |paid |two-week |limited )?${TRIAL}\b`),
      // "do you offer a free trial?", "do you guys do POCs"
      new RegExp(String.raw`\bdo you(?: guys)? (?:offer|do|have|run|support|allow) (?:a |an |any )?(?:free )?${TRIAL}s?\b`),
      new RegExp(String.raw`\bis there (?:a |an |any )?(?:free )?${TRIAL}\b`),
      // "what would a pilot look like?", "how long does a POC take", "how much is a trial"
      new RegExp(String.raw`\b(?:what (?:would|does|do|did)|how long (?:would|does|is)|how much (?:would|does|is)|how (?:would|does|do)) (?:a |an |the |your )?${TRIAL}s? (?:look like|involve|take|cost|need|work|run|be)\b`),
      // "we'd want to run a pilot first", "I'd love a trial"
      new RegExp(String.raw`\b(?:we'd|we would|i'd|i would) (?:want|like|need|love|prefer)(?: to (?:do|run|start|try|set up))? (?:a |an )?(?:quick |short |small |free )?${TRIAL}\b`),
      // "how do we start a pilot?", "how would we kick off a POC"
      new RegExp(String.raw`\bhow (?:do|would|could|can) (?:we|i) (?:start|set up|get|run|kick off|begin) (?:a |an |the )?${TRIAL}\b`),
    ],
  },
  {
    kind: 'rollout',
    res: [
      // "how long does implementation take?", "how long is onboarding"
      new RegExp(String.raw`\bhow long (?:does|would|will|is|did) (?:the |an |a |your )?(?:typical )?${ROLL}\b`),
      // "how long does it take to roll out?", "how long would it take to get us up and running"
      /\bhow long (?:does|would|will|might) it (?:usually |typically |normally )?take to (?:implement|roll (?:it |this )?out|deploy|set (?:it |this )?up|onboard|get (?:it |this |us |everyone )?(?:up and running|running|live|set up|going|onboarded))\b/,
      // "what does the rollout look like?", "what would onboarding involve"
      new RegExp(String.raw`\bwhat (?:does|would|will) (?:the |an |a |your )?(?:typical )?${ROLL} (?:look like|involve|take|need)\b`),
      // "what's the implementation timeline?", "what is a typical rollout time"
      new RegExp(String.raw`\bwhat(?:'s| is| would be| does)? (?:the |your |a )?(?:typical |usual |rough )?${ROLL} (?:time|timeline|timeframe|time frame)s?\b`),
      // "how fast could we be up and running?", "how quickly can we get live"
      /\bhow (?:fast|quickly|soon) (?:can|could|would) (?:we|you) (?:get|be) (?:it |this |us )?(?:up and running|running|live|set up|going|rolled out|deployed)\b/,
      // "how would we roll it out to the other teams?"
      /\bhow (?:do|would|could) (?:we|you) roll (?:it|this|arize) out\b/,
    ],
  },
  {
    kind: 'pricing',
    res: [
      // "how much does it cost?", "how much would that run us", "how much do you charge"
      /\bhow much (?:does|would|will|do|might|is) (?:it|this|that|arize|phoenix|the (?:platform|product|tool|license|licence|enterprise (?:plan|tier))|you(?: guys)?) (?:cost|charge|run (?:us|me))\b/,
      // "what does it cost?", "what would this cost us"
      /\bwhat (?:does|would|will|might) (?:it|this|that|arize) (?:cost|run (?:us|me))\b/,
      // "what's your pricing?", "can you share Arize's pricing", "your price per seat"
      /\b(?:your|arize's|arize) (?:pricing|prices?|price point|licensing|license cost|cost per (?:seat|user|trace|span))\b/,
      // "how is it priced?", "how do you price it", "how does pricing work"
      /\bhow (?:is|are) (?:it|this|that|arize|you) priced\b|\bhow do you(?: guys)? (?:price|charge)\b|\bhow does (?:the |your )?pricing work\b/,
      // "is it priced per seat?"
      /\b(?:is|are) (?:it|this|that|you) priced (?:per|by|on)\b/,
      // "can you send over pricing?", "could we get a quote"
      /\b(?:can|could|would) (?:you|we|i) (?:send|share|get|see|have) (?:me |us |over )?(?:some |a |the |your )?(?:pricing|price list|price sheet|quote|quotation|ballpark)\b/,
      // "a ballpark on cost", "a rough price"
      /\b(?:ballpark|rough|rough idea of(?: the)?) (?:price|pricing|cost|number|figure)\b(?! (?:of|for) (?:our|the (?:gpu|cloud|inference|tokens?)|running|inference|tokens?))/,
    ],
  },
  {
    kind: 'send_to_boss',
    res: [
      // "could you send me a one-pager for my VP?", "can you put together something to share with our CTO"
      new RegExp(String.raw`\b(?:can|could|would) you (?:send|share|put together|give|pull together|write up|email|forward)(?: (?:me|us|over))*[^.?!\n]{0,50}?\b(?:to|for|with) ${BOSS}`),
      // "something short I can forward to my VP", "a summary we could share with leadership"
      new RegExp(String.raw`\b(?:something|anything|a (?:short |quick |one-page |simple )?(?:one-pager|one pager|summary|deck|doc|document|write-?up|recap|overview|slide|business case))(?: (?:short|quick|simple|written))?(?: that)? (?:i|we) (?:can|could) (?:send|share|forward|show|pass along|take|bring)(?: (?:it|this))?(?: (?:to|with|up to))? ${BOSS}`),
      // "my boss will want to see something", "our CTO is going to ask for a business case"
      new RegExp(String.raw`\b${BOSS} (?:will|would|is going to|'ll|is gonna) (?:want|need|ask for|ask to see)(?: to see)? (?:something|a (?:summary|one-pager|one pager|deck|business case|write-?up|recap)|the business case)`),
    ],
  },
]

function norm(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\S\n]+/g, ' ')
}

/** What the words ask about, if they're a buying signal ("can we run a pilot?" -> 'pilot'), else null. */
export function buyingSignal(text: string): SignalKind | null {
  const t = norm(text)
  for (const s of SIGNALS) if (s.res.some((r) => r.test(t))) return s.kind
  return null
}

/** The other side: meeting audio, except someone Keith tagged as an Arize teammate. */
function theirs(memory: CallMemory, t: { stream: Stream; cluster: string | null }): boolean {
  if (t.stream !== 'system_remote') return false
  return !(t.cluster && memory.labels.get(t.cluster)?.role === 'teammate')
}

/** A buying signal in one finished turn of the other side (HelpService keeps the latest for the WRAP tag). */
export function signalIn(memory: CallMemory, t: Pick<MemoryTurn, 'stream' | 'cluster' | 'text' | 'start_ms'>): SignalSeen | null {
  if (!theirs(memory, t)) return null
  const kind = buyingSignal(t.text)
  return kind ? { kind, at_ms: Math.round(t.start_ms) } : null
}

/** The latest buying signal of the call so far (finished turns of the other side). */
export function latestSignal(memory: CallMemory, atMs: number): SignalSeen | null {
  const turns = memory.turnsAsOf(atMs)
  for (let i = turns.length - 1; i >= 0; i--) {
    const s = signalIn(memory, turns[i])
    if (s) return s
  }
  return null
}

/** A buying signal from the other side in the last 30 s (finished turns, or words still being transcribed). */
export function recentSignal(memory: CallMemory, atMs: number): SignalKind | null {
  const live = memory.interimsAsOf(atMs).filter((i) => i.stream === 'system_remote').map((i) => i.text)
  const turns = memory.turnsAsOf(atMs).filter((t) => t.end_ms >= atMs - HOT_WINDOW_MS && theirs(memory, t)).map((t) => t.text)
  // Newest first: what they asked last is what the next step builds on.
  for (const text of [...live, ...turns.reverse()]) {
    const kind = buyingSignal(text)
    if (kind) return kind
  }
  return null
}

// ------------------------------------------------------------------ the opening

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

/** Early in the call and the other side has said little so far (words still being transcribed count). */
export function isOpening(memory: CallMemory, atMs: number): boolean {
  if (atMs >= OPENING_WINDOW_MS) return false
  let n = 0
  for (const t of memory.turnsAsOf(atMs)) if (theirs(memory, t)) n += wordCount(t.text)
  for (const i of memory.interimsAsOf(atMs)) if (i.stream === 'system_remote') n += wordCount(i.text)
  return n < OPENING_MAX_WORDS
}

/** Keith's must-learns, read defensively (older setups don't have them). */
export function mustLearn(setup: { must_learn?: unknown }): string[] {
  const raw = Array.isArray(setup.must_learn) ? setup.must_learn : []
  return raw.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/\s+/g, ' ').trim().slice(0, MUST_LEARN_MAX_CHARS)).filter(Boolean).slice(0, MUST_LEARN_MAX)
}

// ------------------------------------------------------------------ which press is this

/**
 * Which instruction a press gets, in the plan's order. `prior` is the card Keith would be asking
 * another angle on (the engine decides that: see anotherAngleOk), null otherwise.
 */
export function decidePress(origin: HelpOrigin, memory: CallMemory, atMs: number, prior: PriorCard | null = null): PressDecision {
  const withSignal = (wrap: WrapWhy): PressDecision => {
    const s = latestSignal(memory, atMs)
    return { wrap, mode: null, detail: s ? { wrap_signal: s } : {} }
  }
  if (origin === 'wrap_requested') return withSignal('button')
  if (origin !== 'help_requested') return { wrap: null, mode: null, detail: {} }
  if (prior) return { wrap: null, mode: 'another_angle', detail: { prior } }
  if (wrapReason(origin, memory, atMs) === 'closing') return withSignal('closing')
  const signal = recentSignal(memory, atMs)
  if (signal) return { wrap: null, mode: 'signal', detail: { signal } }
  if (isOpening(memory, atMs)) {
    const ml = mustLearn(memory.setup)
    return { wrap: null, mode: 'opening', detail: ml.length ? { must_learn: ml } : {} }
  }
  return { wrap: null, mode: null, detail: {} }
}

/**
 * Another angle: the card on screen finished, was there at least ~2 s (and at most ~20 s), and
 * nothing new was said since it was built (`sameMoment`: same transcript, no words being transcribed).
 */
export function anotherAngleOk(shownWall: number | null, pressedWall: number, sameMoment: boolean): boolean {
  if (shownWall === null || !sameMoment) return false
  const on = pressedWall - shownWall
  return on >= ANOTHER_ANGLE_MIN_SHOWN_MS && on <= ANOTHER_ANGLE_WINDOW_MS
}

// ------------------------------------------------------------------ the instruction blocks

const SIGNAL_TEXT: Record<SignalKind, string> = {
  pilot: 'a pilot, POC or trial',
  rollout: 'rollout or implementation time',
  pricing: 'pricing or cost',
  send_to_boss: 'something to send their boss or leadership',
}

/** One line, quotes and tags made harmless, so a stored line can't break out of its block. */
function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').replace(/[<>]/g, '').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function openingBlock(contextText: string, detail: PressDetail): string {
  // The <earlier_calls> block is in the context exactly when there were earlier calls to pick up from.
  const earlier = contextText.includes('<earlier_calls')
  const ml = detail.must_learn ?? []
  const lines = [
    'Keith pressed HELP at the start of the call: the other side has said little so far.',
    '- If they just asked a question or raised something, answer or handle that first (the normal rules) and put the opening in FOLLOW.',
    earlier
      ? '- This is not the first call with them (earlier_calls). ASK: pick up where they left off: check, as a question, what they said they would do or the next step agreed last time ("Last time you were going to pull a sample of answers together. How did that go?"). Only what earlier_calls says, as a past statement: never say it happened, or that it is still true.'
      : `- This is the first call with them. ASK or SAY: set a short agenda from the call goal${ml.length ? " and Keith's must-learns" : ''}, and check it works for them ("I'd love to hear how you review answers today and who weighs in. Does that work?"). Never state a must-learn as something they said.`,
    ...(ml.length ? [`- Keith's must-learns for this call: ${ml.map((m) => `"${oneLine(m, MUST_LEARN_MAX_CHARS)}"`).join('; ')}.`] : []),
    '- Use only the call setup, earlier_calls and what was said on this call: no outside research or guesses about their company, and no pain, problem or need they have not voiced.',
    `- MOVE: ${earlier ? 'clarify_current_state for the check-in' : 'call_control for the agenda'}; when the line answers what they just asked, the move that fits that.`,
    '- FOLLOW: the opening, when the line answered their question; otherwise "-".',
  ]
  return `<opening_press>\n${lines.join('\n')}\n</opening_press>`
}

function signalBlock(detail: PressDetail): string {
  const what = SIGNAL_TEXT[detail.signal ?? 'pilot']
  return `<next_step_press>
Keith pressed HELP and in the last 30 seconds they asked about ${what}: a buying signal.
- ASK or SAY: answer or defer as usual: only approved knowledge is Arize fact; never a price, discount, contract term or delivery date. If approved knowledge doesn't answer it, offer to follow up.
- FOLLOW: one concrete next step that moves it forward, as a question: what it is, who should be there and when, asked, not picked ("Would a short call with your platform lead to scope that help? What day works?"). Never pick a date, a name or a commitment nobody said. A next step already agreed (call_notes "agreed") is built on, not replaced.
- MOVE: the move that fits the line (technical_answer only with approved knowledge).
</next_step_press>`
}

function angleBlock(detail: PressDetail): string {
  const p = detail.prior
  const had = p ? `He already has: MOVE ${oneLine(p.move, 40)}; ${p.primary_kind === 'say' ? 'SAY' : 'ASK'} "${oneLine(p.primary, PRIOR_MAX_CHARS)}"` : 'He already has a card for this moment.'
  return `<another_angle>
Keith pressed HELP again for the same moment: nothing new was said since his last card, and he wants another angle on it.
${had}
- Give a genuinely different move or question, not a rewording of that line. Keep the same move only if no other move fits, and then ask a clearly different question.
- The normal rules still hold: only approved knowledge is Arize fact; nothing they haven't said.
</another_angle>`
}

/** The latest buying signal, for a WRAP card to build on (a separate block, so wrap.ts stays as it is). */
function wrapSignalBlock(s: SignalSeen): string {
  return `<buying_signal>
At ${fmtClock(s.at_ms)} they asked about ${SIGNAL_TEXT[s.kind]}. If it fits, the next step can build on it (for example, scoping it together), still asked, not picked.
</buying_signal>`
}

/**
 * The user message for any press: the call context, then the wrap card or this press's block (a
 * normal press gets none). Also what is kept on disk, and what a practice moment replays.
 */
export function pressUserMessage(contextText: string, wrap: WrapWhy | null, mode: PressMode | null, detail: PressDetail = {}): string {
  if (wrap) {
    const msg = wrapUserMessage(contextText, wrap)
    if (!detail.wrap_signal) return msg
    // Right before the last line ("Give Keith his line to lock the next step."), after </wrap_card>.
    const i = msg.lastIndexOf('\n\n')
    return `${msg.slice(0, i)}\n\n${wrapSignalBlock(detail.wrap_signal)}${msg.slice(i)}`
  }
  if (mode === 'opening') return `${contextText}\n\n${openingBlock(contextText, detail)}\n\nGive Keith his next line.`
  if (mode === 'signal') return `${contextText}\n\n${signalBlock(detail)}\n\nGive Keith his next line.`
  if (mode === 'another_angle') return `${contextText}\n\n${angleBlock(detail)}\n\nGive Keith a different line.`
  return buildUserMessage(contextText)
}

/** Which press block a request carries (the offline MOCK model answers each one in kind). */
export function pressModeOf(user: string): PressMode | null {
  if (user.includes('<another_angle>')) return 'another_angle'
  if (user.includes('<next_step_press>')) return 'signal'
  if (user.includes('<opening_press>')) return 'opening'
  return null
}

/** The move of the card Keith already had, from an another-angle request (MOCK only). */
export function priorMoveOf(user: string): string | null {
  return /<another_angle>[\s\S]*?He already has: MOVE ([a-z_]+);/.exec(user)?.[1] ?? null
}

// ------------------------------------------------------------------ stored and replayed

const PRESS_MODES: readonly PressMode[] = ['opening', 'signal', 'another_angle']

/** A press mode read from a file or a database row (anything else: a normal press). */
export function cleanPressMode(x: unknown): PressMode | null {
  return (PRESS_MODES as readonly unknown[]).includes(x) ? (x as PressMode) : null
}

function cleanSignal(x: unknown): SignalSeen | null {
  const s = x as Partial<SignalSeen> | null
  return s && typeof s === 'object' && (SIGNAL_KINDS as readonly unknown[]).includes(s.kind) && typeof s.at_ms === 'number' && Number.isFinite(s.at_ms)
    ? { kind: s.kind as SignalKind, at_ms: Math.max(0, Math.round(s.at_ms)) }
    : null
}

function cleanPrior(x: unknown): PriorCard | null {
  const p = x as Partial<PriorCard> | null
  if (!p || typeof p !== 'object' || typeof p.primary !== 'string' || !p.primary.trim()) return null
  const move = (SALES_MOVES as readonly unknown[]).includes(p.move) ? (p.move as SalesMove) : 'no_move'
  return { move, primary_kind: p.primary_kind === 'say' ? 'say' : 'ask', primary: p.primary.slice(0, PRIOR_MAX_CHARS) }
}

/** What a stored press needs to replay, from a hand-editable file: anything unreadable is left out. */
export function cleanPressDetail(x: unknown): PressDetail {
  const d = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
  const out: PressDetail = {}
  if ((SIGNAL_KINDS as readonly unknown[]).includes(d.signal)) out.signal = d.signal as SignalKind
  const prior = cleanPrior(d.prior)
  if (prior) out.prior = prior
  const ml = mustLearn({ must_learn: d.must_learn })
  if (ml.length) out.must_learn = ml
  const ws = cleanSignal(d.wrap_signal)
  if (ws) out.wrap_signal = ws
  return out
}

/**
 * A saved press (help_requests.timing_json keeps only codes, ids and call times) as a practice
 * moment carries it: the mode, plus what its block showed. The must-learns come from the setup the
 * request was built with; another angle's line from the card it was asked on.
 */
export function savedPress(
  timing: { press_mode?: unknown; press_signal?: unknown; angle_of?: unknown; wrap_signal?: unknown },
  setupAtPress: { must_learn?: unknown } | null | undefined,
  cardOf: (requestId: string) => { card_json: string | null } | undefined,
): { press_mode?: PressMode; press_detail?: PressDetail } {
  const mode = cleanPressMode(timing.press_mode)
  const detail: PressDetail = {}
  const ws = cleanSignal(timing.wrap_signal)
  if (ws) detail.wrap_signal = ws
  if (mode === 'signal' && (SIGNAL_KINDS as readonly unknown[]).includes(timing.press_signal)) detail.signal = timing.press_signal as SignalKind
  if (mode === 'opening') {
    const ml = mustLearn(setupAtPress ?? {})
    if (ml.length) detail.must_learn = ml
  }
  if (mode === 'another_angle' && typeof timing.angle_of === 'string') {
    let card: unknown = null
    try {
      card = JSON.parse(cardOf(timing.angle_of)?.card_json ?? 'null')
    } catch {
      /* unreadable: replayed without the line */
    }
    const prior = cleanPrior(card)
    if (prior) detail.prior = prior
  }
  return { ...(mode ? { press_mode: mode } : {}), ...(Object.keys(detail).length ? { press_detail: detail } : {}) }
}
