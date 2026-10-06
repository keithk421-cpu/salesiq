/**
 * Smarter presses (M3): the same HELP button asks for something a little different when the moment
 * calls for it. Each is a short instruction block after the call context (like the WRAP card in
 * wrap.ts), a label on the card, and stored with the request so a practice moment replays it.
 *
 * Which one applies, in order (decidePress):
 *   1. the WRAP button (wrap.ts), building on the latest buying signal if there was one;
 *   (M4) a click on one of Keith's open must-learns on the plan line: the line that gets there;
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
import { TO_LEARN_LABEL } from './accountMemory'
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
/** Another angle on another angle: HELP is also told up to this many cards before the one on screen (Keith passed on them too). */
export const ANGLE_EARLIER_MAX = 2

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
  /** another_angle (or plan_item, clicking the same must-learn again for the same moment): the line and move Keith already got. */
  prior?: PriorCard
  /** another_angle on an another-angle card: the cards before it he passed on too, oldest first (at most ANGLE_EARLIER_MAX). */
  earlier?: PriorCard[]
  /** opening: Keith's must-learns for this call, as they were at the press. */
  must_learn?: string[]
  /**
   * opening: there were earlier calls with this account, even if nothing from them reached the context
   * (the only items were must-learns he set out to learn again, or none at all): a follow-up, never a first call.
   */
  earlier_calls?: boolean
  /** WRAP (or closing words): the latest buying signal of the call, for the next step to build on. */
  wrap_signal?: SignalSeen
  /**
   * WRAP: the call notes still had a must-learn open at the press, so FOLLOW asked it. Kept with the
   * request because a replay has no call notes to read it from (wrap.ts planStillOpen).
   */
  wrap_plan?: boolean
  /**
   * plan_item (M4): the must-learn Keith clicked on the plan line, in his words as set for this call.
   * another_angle on a must-learn card: that must-learn, so the new line stays on it.
   */
  plan_item?: string
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
/** ...but not a trial of something else ("a trial of the new model from OpenAI", "a pilot with another vendor"). */
const NOT_OTHERS = String.raw`(?! (?:of|from) (?!(?:arize|phoenix|your|you|it|this)\b)| with (?:another|a different|other|the other)\b)`
/** ...nor the cost of their own work ("cost us in latency", "cost us to run the evals", "cost us when a bad answer gets through"). */
const NOT_THEIR_COST = String.raw`(?!,? (?:(?:us |you |me )?(?:in (?:terms of )?(?:latency|performance|throughput|overhead|speed|engineering|dev(?:eloper)? time|time|effort|headcount|compute|tokens|gpus?)\b|when\b|per (?:run|query|request|call|token)\b|each (?:time|night|day|run)\b)|(?:us|you|me) to run\b))`

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
      new RegExp(String.raw`\b(?:can|could|would) (?:we|i|you) (?:do|run|set up|start|get|try|have) (?:a |an |some )?(?:quick |short |small |free |paid |two-week |limited )?${TRIAL}\b${NOT_OTHERS}`),
      // "do you offer a free trial?", "do you guys do POCs"
      new RegExp(String.raw`\bdo you(?: guys)? (?:offer|do|have|run|support|allow) (?:a |an |any )?(?:free )?${TRIAL}s?\b${NOT_OTHERS}`),
      new RegExp(String.raw`\bis there (?:a |an |any )?(?:free )?${TRIAL}\b${NOT_OTHERS}`),
      // "what would a pilot look like?", "how long does a POC take", "how much is a trial" (not "what did the pilot look like": theirs, done)
      new RegExp(String.raw`\b(?:what (?:would|does|do)|how long (?:would|does|is)|how much (?:would|does|is)|how (?:would|does|do)) (?:a |an |the |your )?${TRIAL}s? (?:look like|involve|take|cost|need|work|run|be)\b`),
      // "we'd want to run a pilot first", "I'd love a trial"
      new RegExp(String.raw`\b(?:we'd|we would|i'd|i would) (?:want|like|need|love|prefer)(?: to (?:do|run|start|try|set up))? (?:a |an )?(?:quick |short |small |free )?${TRIAL}\b${NOT_OTHERS}`),
      // "how do we start a pilot?", "how would we kick off a POC"
      new RegExp(String.raw`\bhow (?:do|would|could|can) (?:we|i) (?:start|set up|get|run|kick off|begin) (?:a |an |the )?${TRIAL}\b${NOT_OTHERS}`),
    ],
  },
  {
    kind: 'rollout',
    res: [
      // "how long does implementation take?", "how long is onboarding" (not "how long did the rollout take": theirs, done;
      // nor "onboarding take for a new support agent": their own people or product)
      new RegExp(String.raw`\bhow long (?:does|would|will|is) (?:the |an |a |your )?(?:typical )?${ROLL}\b(?!(?: take)? (?:for|of) (?:a |an |the |our |their |each |every )?(?:new )?(?:support|hires?|employees?|agents?|customers?|users?|reps?|staff|models?|prompts?|features?|releases?)\b)`),
      // "how long does it take to roll out?", "how long would it take to get us up and running"
      /\bhow long (?:does|would|will|might) it (?:usually |typically |normally )?take to (?:implement|roll (?:it |this )?out|deploy|set (?:it |this )?up|onboard|get (?:it |this |us |everyone )?(?:up and running|running|live|set up|going|onboarded))\b(?! (?:a|an|our|any|new|that|those|these|each|every)\b| the (?!(?:platform|product|tool|sdk|integration|tracing|arize|phoenix)\b))/,
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
      // "how much does it cost?", "how much would that run us", "how much do you charge" (not their own costs: NOT_THEIR_COST)
      new RegExp(String.raw`\bhow much (?:does|would|will|do|might|is) (?:it|this|that|arize|phoenix|the (?:platform|product|tool|license|licence|enterprise (?:plan|tier))|you(?: guys)?) (?:cost|charge|run (?:us|me))\b${NOT_THEIR_COST}`),
      // "what does it cost?", "what would this cost us"
      new RegExp(String.raw`\bwhat (?:does|would|will|might) (?:it|this|that|arize) (?:cost|run (?:us|me))\b${NOT_THEIR_COST}`),
      // "what's your pricing?", "can you share Arize's pricing", "your price per seat" (not "comparing your pricing to ...": their process)
      /(?<!\bcompar(?:e|ed|ing) )\b(?:your|arize's|arize) (?:pricing|prices?|price point|licensing|license cost|cost per (?:seat|user|trace|span))\b/,
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
      // Only something summary-like: "send the invite to my manager" or "share the recording with my director" is not one.
      new RegExp(String.raw`\b(?:can|could|would) you (?:send|share|put together|give|pull together|write up|email|forward)(?: (?:me|us|over))*[^.?!\n]{0,20}?\b(?:one-pager|one pager|summary|deck|doc|document|overview|recap|write-?up|business case|pricing|slides?|something|anything|materials?|info|information)\b[^.?!\n]{0,30}?\b(?:to|for|with) ${BOSS}`),
      // "something short I can forward to my VP", "a summary we could share with leadership"
      new RegExp(String.raw`\b(?:something|anything|a (?:short |quick |one-page |simple )?(?:one-pager|one pager|summary|deck|doc|document|write-?up|recap|overview|slide|business case))(?: (?:short|quick|simple|written))?(?: that)? (?:i|we) (?:can|could) (?:send|share|forward|show|pass along|take|bring)(?: (?:it|this))?(?: (?:to|with|up to))? ${BOSS}`),
      // "my boss will want to see something", "our CTO is going to ask for a business case" (not "a summary of the incident")
      new RegExp(String.raw`\b${BOSS} (?:will|would|is going to|'ll|is gonna) (?:want|need|ask for|ask to see)(?: to see)? (?:something|a (?:summary|one-pager|one pager|deck|business case|write-?up|recap)|the business case)(?! (?:of|on|about) (?:the|our|that|this|a|an) (?:incident|outage|bug|issue|problem|failure|postmortem|post-mortem|hallucination|escalation)s?\b)`),
    ],
  },
]

function norm(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\S\n]+/g, ' ')
}

/**
 * Words they're repeating, not asking: what their users or their bot get asked ("customers ask the
 * chatbot is there a free trial", "stuff like what's your pricing"). A sentence like that never counts.
 */
const REPORTED = /\b(?:customers|users|people|clients|callers|agents) (?:ask|asking|always ask|keep asking)\b|\b(?:our|the) (?:bot|chatbot|assistant|agent|copilot|support bot)s? (?:gets?|hears?|is asked|answers)\b|\b(?:stuff|things|questions|queries) like\b/

/** What the words ask about, if they're a buying signal ("can we run a pilot?" -> 'pilot'), else null. */
export function buyingSignal(text: string): SignalKind | null {
  const sentences = norm(text).split(/(?<=[.?!\n])\s*/).filter((x) => x && !REPORTED.test(x))
  for (const s of SIGNALS) if (s.res.some((r) => sentences.some((t) => r.test(t)))) return s.kind
  return null
}

/** The other side: meeting audio, except someone Keith tagged as an Arize teammate. */
function theirs(memory: CallMemory, t: { stream: Stream; cluster: string | null }): boolean {
  return memory.fromTheirSide(t)
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
  // Newest first: what they asked last is what the next step builds on. A newer question of theirs
  // that is not a signal comes first ("Got it. And do you integrate with LangSmith?"): a normal press.
  for (const text of [...live, ...turns.reverse()]) {
    const kind = buyingSignal(text)
    if (kind) return kind
    if (text.includes('?')) return null
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
 * another angle on (the engine decides that: see anotherAngleOk), null otherwise; `earlier` the cards
 * he passed on before it in the same run of re-presses, oldest first. `planItem` is the must-learn
 * Keith clicked (M4): he asked for that line, so it comes before everything but the WRAP button. With
 * `prior` too, he clicked the same must-learn again for the same moment (the engine checks that): the
 * block names the line he already has, so he gets a different way in.
 */
export function decidePress(origin: HelpOrigin, memory: CallMemory, atMs: number, prior: PriorCard | null = null, earlier: readonly PriorCard[] = [], planItem: string | null = null): PressDecision {
  const withSignal = (wrap: WrapWhy): PressDecision => {
    const s = latestSignal(memory, atMs)
    return { wrap, mode: null, detail: s ? { wrap_signal: s } : {} }
  }
  if (origin === 'wrap_requested') return withSignal('button')
  if (origin !== 'help_requested') return { wrap: null, mode: null, detail: {} }
  const item = planItem === null ? '' : cleanPlanItem(planItem)
  if (item) {
    const before = prior ? earlier.slice(-ANGLE_EARLIER_MAX) : []
    return { wrap: null, mode: 'plan_item', detail: { plan_item: item, ...(prior ? { prior } : {}), ...(before.length ? { earlier: before } : {}) } }
  }
  if (prior) {
    const before = earlier.slice(-ANGLE_EARLIER_MAX)
    return { wrap: null, mode: 'another_angle', detail: { prior, ...(before.length ? { earlier: before } : {}) } }
  }
  if (wrapReason(origin, memory, atMs) === 'closing') return withSignal('closing')
  const signal = recentSignal(memory, atMs)
  if (signal) return { wrap: null, mode: 'signal', detail: { signal } }
  if (isOpening(memory, atMs)) {
    const ml = mustLearn(memory.setup)
    // From the account memory itself, not the <earlier_calls> block: that leaves out the must-learns
    // Keith set out to learn again, so a return call could otherwise read as a first one.
    const before = memory.hadEarlierCalls || memory.earlierCalls.length > 0
    return { wrap: null, mode: 'opening', detail: { ...(ml.length ? { must_learn: ml } : {}), ...(before ? { earlier_calls: true } : {}) } }
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
  const block = /<earlier_calls\b[^\n]*>\n([\s\S]*?)\n<\/earlier_calls>/.exec(contextText)?.[1] ?? null
  // Something they said, owed or agreed on earlier calls to pick up from: not just what Keith still
  // wanted to learn (his own plan, never something they said).
  const pickUp = block !== null && block.split('\n').some((l) => !l.includes(` · ${TO_LEARN_LABEL}: `))
  // A return call with nothing of theirs on file: earlier calls left only Keith's must-learns (or
  // nothing), or Keith typed it as a follow-up. Never "the first call with them".
  const followUp = !pickUp && (block !== null || detail.earlier_calls === true || /\ntype: follow_up\n/.test(contextText))
  const ml = detail.must_learn ?? []
  // No goal and no must-learns: nothing to build an agenda from, so ask what they'd like from today.
  const noGoal = /\ngoal: \(not set\)\n/.test(contextText) && !ml.length
  const lines = [
    'Keith pressed HELP at the start of the call: the other side has said little so far.',
    '- If they just asked a question or raised something, answer or handle that first (the normal rules) and put the opening in FOLLOW.',
    pickUp
      ? `- This is not the first call with them (earlier_calls). ASK: pick up where they left off: check, as a question, what they said they would do or the next step agreed last time ("Last time you mentioned pulling a sample of answers together. Did you get a chance to, or should we start elsewhere?"). Only what earlier_calls says, as a past statement: never say it happened, or that it is still true. A "${TO_LEARN_LABEL}" line is his plan, not something they said.`
      : followUp
        ? noGoal
          ? `- This is a follow-up call, with nothing they said on earlier calls on file. ASK: reconnect briefly, then what they'd like to get out of today, and check the time they have. Never say what happened or was said last time.`
          : `- This is a follow-up call, with nothing they said on earlier calls on file. ASK or SAY: reconnect briefly, then set a short agenda from the call goal${ml.length ? " and Keith's must-learns" : ''}, and check it works for them (the shape only: what you'd like to cover, then "Does that work?"). Never say what happened or was said last time. Never state a must-learn${block !== null ? ` or a "${TO_LEARN_LABEL}" line` : ''} as something they said: it is Keith's own question.`
        : noGoal
          ? "- This is the first call with them, and no call goal is set. ASK what they'd like to get out of today, and check the time they have."
          : `- This is the first call with them. ASK or SAY: set a short agenda from the call goal${ml.length ? " and Keith's must-learns" : ''}, and check it works for them (the shape only: what you'd like to cover, then "Does that work?"). Never state a must-learn as something they said.`,
    "- If Keith already set the agenda or did the check-in on this call (his lines in the transcript), don't repeat it: give the next natural question toward the goal or a must-learn.",
    ...(ml.length ? [`- Keith's must-learns for this call: ${ml.map((m) => `"${oneLine(m, MUST_LEARN_MAX_CHARS)}"`).join('; ')}.`] : []),
    '- Use only the call setup, earlier_calls and what was said on this call: no outside research or guesses about their company, and no pain, problem or need they have not voiced.',
    `- MOVE: ${pickUp ? 'clarify_current_state for the check-in' : noGoal ? 'call_control' : 'call_control for the agenda'}; when the line answers what they just asked, the move that fits that.`,
    '- FOLLOW: the opening, when the line answered their question; otherwise "-".',
  ]
  return `<opening_press>\n${lines.join('\n')}\n</opening_press>`
}

function signalBlock(detail: PressDetail): string {
  // A hand-edited scenario may lack the kind: say nothing more specific than the words could hold.
  const what = detail.signal ? SIGNAL_TEXT[detail.signal] : 'a next step'
  return `<next_step_press>
Keith pressed HELP and in the last 30 seconds they may have asked about ${what}: a possible buying signal. If those words were about their own product, costs, rollout or what their users ask, ignore this block.
- If they just asked something else, or raised a concern, answer that first (the normal rules). If Keith already answered or deferred it, don't repeat it: only FOLLOW carries the next step.
- ASK or SAY: answer or defer as usual: only approved knowledge is Arize fact; never a price, discount, contract term or delivery date. If approved knowledge doesn't answer it, offer to follow up.
- FOLLOW: one concrete next step that moves it forward, as a question: what it is, who should be there and when, asked, not picked ("Who on your side should join a short call to scope that, and what day works?"). Never pick a date, a name or a commitment nobody said. A next step already agreed (call_notes "agreed") is built on, not replaced. If it's early and little is known about their needs, FOLLOW may instead ask what they'd need to see first, or "-".
- MOVE: the move that fits the line (technical_answer only with approved knowledge).
</next_step_press>`
}

const cardText = (p: PriorCard) => `MOVE ${oneLine(p.move, 40)}; ${p.primary_kind === 'say' ? 'SAY' : 'ASK'} "${oneLine(p.primary, PRIOR_MAX_CHARS)}"`

function angleBlock(detail: PressDetail): string {
  const p = detail.prior
  // The card on screen first (priorMoveOf reads its move), then the ones he passed on before it, so a
  // third press can't bounce back to the first card's line.
  const had = p ? `He already has: ${cardText(p)}` : 'He already has a card for this moment.'
  const passed = (detail.earlier ?? []).map((e) => `He already passed on: ${cardText(e)}`)
  const those = passed.length ? 'any of these lines' : 'that line'
  // Another angle on a must-learn card: still a way to that must-learn, not a change of topic.
  const stay = detail.plan_item ? [`- That card was his way to get to one of his must-learns: "${quotedItem(detail.plan_item)}". Stay on that must-learn: a different way to get there.`] : []
  return `<another_angle>
Keith pressed HELP again for the same moment: nothing new was said since his last card, and he wants another angle on it.
${[had, ...passed, ...stay].join('\n')}
- Give a genuinely different move or question, not a rewording of ${those}. Keep the same move only if no other move fits, and then a clearly different line.
- If they just asked a question or raised a concern, the new line still answers or handles it: a different way in (a shorter or plainer answer, a defer with a check, or one clarifying question about it), never a change of subject.
- The normal rules still hold: only approved knowledge is Arize fact; nothing they haven't said.
</another_angle>`
}

/** The must-learn as the block quotes it: one line, no tags, and its own double quotes made single so the quote can't end early. */
const quotedItem = (s: string) => oneLine(s, MUST_LEARN_MAX_CHARS).replace(/"/g, "'")

function planBlock(detail: PressDetail): string {
  // A hand-edited scenario may lack the item: then it's one of the must-learns the call setup lists.
  const item = detail.plan_item ? `"${quotedItem(detail.plan_item)}"` : 'one of the "must learn" items in call_setup'
  // Clicked again for the same moment: the line(s) he already has, so the new one is a different way in.
  const p = detail.prior
  const again = p
    ? [
        `He clicked it again for the same moment: nothing new was said since. He already has: ${cardText(p)}`,
        ...(detail.earlier ?? []).map((e) => `He already passed on: ${cardText(e)}`),
        '- Give a different way in to the same must-learn (another angle or a narrower part of it), not a rewording of that line.',
      ]
    : []
  return `<plan_press>
Keith clicked one of his must-learns for this call: ${item}. He wants one natural way to get there from where the talk is now.
${again.length ? `${again.join('\n')}\n` : ''}- If they just asked something or raised a concern, answer or handle that first (the normal rules) and put the bridge to it in FOLLOW.
- If they are mid-answer (their words are still being transcribed in the last 30 seconds), still ASK the question he clicked for, ready for when they finish, and say in HAPPENING: "They're still talking - let them finish first."
- Otherwise ASK: one natural question in Keith's voice that gets there from the current topic, with a short bridge from what was just said when there is one.
- It is Keith's own question, never something they said: never imply they mentioned it, raised it or need it, and assume no pain, problem, urgency or deadline.
- If the transcript shows they already answered it (the notes may lag), don't ask it again: ASK one question that confirms it and goes one step deeper on their own words (for example who else weighs in), and say in HAPPENING that they answered it.
- Asked is not answered: if Keith already asked it on this call and they didn't answer, ask it a different way or a narrower part of it. If they answered part of it, ask about the part still open, building on their words.
- MOVE: the move that fits the question (for example identify_owner for who decides, explore_process for how something works).
- FOLLOW: the bridge when the line answered them first; otherwise "-".
</plan_press>`
}

/** The latest buying signal, for a WRAP card to build on (a separate block, so wrap.ts stays as it is). */
function wrapSignalBlock(s: SignalSeen): string {
  return `<buying_signal>
At ${fmtClock(s.at_ms)} they may have asked about ${SIGNAL_TEXT[s.kind]}. If it fits, the next step can build on it (for example, scoping it together), still asked, not picked. If those words were about their own product, costs or rollout, ignore this.
</buying_signal>`
}

/**
 * The user message for any press: the call context, then the wrap card or this press's block (a
 * normal press gets none). Also what is kept on disk, and what a practice moment replays.
 */
export function pressUserMessage(contextText: string, wrap: WrapWhy | null, mode: PressMode | null, detail: PressDetail = {}): string {
  if (wrap) {
    const msg = wrapUserMessage(contextText, wrap, detail.wrap_plan)
    if (!detail.wrap_signal) return msg
    // Right before the last line ("Give Keith his line to lock the next step."), after </wrap_card>.
    const i = msg.lastIndexOf('\n\n')
    return `${msg.slice(0, i)}\n\n${wrapSignalBlock(detail.wrap_signal)}${msg.slice(i)}`
  }
  if (mode === 'opening') return `${contextText}\n\n${openingBlock(contextText, detail)}\n\nGive Keith his next line.`
  if (mode === 'signal') return `${contextText}\n\n${signalBlock(detail)}\n\nGive Keith his next line.`
  if (mode === 'another_angle') return `${contextText}\n\n${angleBlock(detail)}\n\nGive Keith a different line.`
  if (mode === 'plan_item') return `${contextText}\n\n${planBlock(detail)}\n\nGive Keith his next line.`
  return buildUserMessage(contextText)
}

/** Which press block a request carries (the offline MOCK model answers each one in kind). */
export function pressModeOf(user: string): PressMode | null {
  if (user.includes('<another_angle>')) return 'another_angle'
  if (user.includes('<next_step_press>')) return 'signal'
  if (user.includes('<opening_press>')) return 'opening'
  if (user.includes('<plan_press>')) return 'plan_item'
  return null
}

/** The must-learn a plan_item request quotes (MOCK only), or null when the block names none. */
export function planItemOf(user: string): string | null {
  return /<plan_press>\nKeith clicked one of his must-learns for this call: "([^"\n]*)"\./.exec(user)?.[1] ?? null
}

/** The move of the card Keith already had, from an another-angle request (MOCK only). */
export function priorMoveOf(user: string): string | null {
  return /<another_angle>[\s\S]*?He already has: MOVE ([a-z_]+);/.exec(user)?.[1] ?? null
}

// ------------------------------------------------------------------ stored and replayed

const PRESS_MODES: readonly PressMode[] = ['opening', 'signal', 'another_angle', 'plan_item']

/** A press mode read from a file or a database row (anything else: a normal press). */
export function cleanPressMode(x: unknown): PressMode | null {
  return (PRESS_MODES as readonly unknown[]).includes(x) ? (x as PressMode) : null
}

/** A must-learn as a press carries it (the same length and spacing rules as Keith's must-learns); '' when there is none. */
function cleanPlanItem(x: unknown): string {
  return mustLearn({ must_learn: [x] })[0] ?? ''
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
  const earlier = Array.isArray(d.earlier) ? d.earlier.map(cleanPrior).filter((x): x is PriorCard => !!x).slice(-ANGLE_EARLIER_MAX) : []
  if (prior && earlier.length) out.earlier = earlier
  const ml = mustLearn({ must_learn: d.must_learn })
  if (ml.length) out.must_learn = ml
  if (d.earlier_calls === true) out.earlier_calls = true
  const ws = cleanSignal(d.wrap_signal)
  if (ws) out.wrap_signal = ws
  if (d.wrap_plan === true) out.wrap_plan = true
  const item = cleanPlanItem(d.plan_item)
  if (item) out.plan_item = item
  return out
}

/**
 * A saved press (help_requests.timing_json keeps codes, ids and call times for the press; a shown row
 * also keeps the heard line) as a practice moment carries it: the mode, plus what its block showed.
 * The must-learns come from the setup the request was built with; another angle's lines from the card
 * it was asked on and, when that was itself another angle, the ones before it (followed by angle_of);
 * a must-learn press's item from the request itself (press_plan_item: he may have changed the list since),
 * and, when he clicked it again for the same moment, the card it was clicked on (angle_of, like another angle).
 */
export function savedPress(
  timing: { press_mode?: unknown; press_signal?: unknown; angle_of?: unknown; wrap_signal?: unknown; press_earlier?: unknown; wrap_plan?: unknown; press_plan_item?: unknown },
  setupAtPress: { must_learn?: unknown } | null | undefined,
  cardOf: (requestId: string) => { card_json: string | null; timing_json?: string | null } | undefined,
): { press_mode?: PressMode; press_detail?: PressDetail } {
  const mode = cleanPressMode(timing.press_mode)
  const detail: PressDetail = {}
  const ws = cleanSignal(timing.wrap_signal)
  if (ws) detail.wrap_signal = ws
  if (timing.wrap_plan === true) detail.wrap_plan = true
  if (mode === 'signal' && (SIGNAL_KINDS as readonly unknown[]).includes(timing.press_signal)) detail.signal = timing.press_signal as SignalKind
  if (mode === 'opening') {
    const ml = mustLearn(setupAtPress ?? {})
    if (ml.length) detail.must_learn = ml
    if (timing.press_earlier === true) detail.earlier_calls = true
  }
  // Another angle on a must-learn card keeps that must-learn too, so it replays on the same topic.
  if (mode === 'plan_item' || mode === 'another_angle') {
    const item = cleanPlanItem(timing.press_plan_item)
    if (item) detail.plan_item = item
  }
  // A must-learn clicked again for the same moment has the card it was clicked on, like another angle.
  if ((mode === 'another_angle' || mode === 'plan_item') && typeof timing.angle_of === 'string') {
    // Newest first: the card it was asked on, then (while each was itself another angle) the one before.
    const cards: PriorCard[] = []
    let id: unknown = timing.angle_of
    for (let hop = 0; hop <= ANGLE_EARLIER_MAX && typeof id === 'string'; hop++) {
      const row = cardOf(id)
      let card: unknown = null
      let t: { press_mode?: unknown; angle_of?: unknown } = {}
      try {
        card = JSON.parse(row?.card_json ?? 'null')
        t = JSON.parse(row?.timing_json ?? '{}') ?? {}
      } catch {
        /* unreadable: replayed without it (and anything before it) */
      }
      const prior = cleanPrior(card)
      if (!prior) break
      cards.push(prior)
      const was = cleanPressMode(t.press_mode)
      id = was === 'another_angle' || was === 'plan_item' ? t.angle_of : null
    }
    if (cards.length) detail.prior = cards[0]
    if (cards.length > 1) detail.earlier = cards.slice(1).reverse()
  }
  return { ...(mode ? { press_mode: mode } : {}), ...(Object.keys(detail).length ? { press_detail: detail } : {}) }
}
