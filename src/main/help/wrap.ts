/**
 * "Before you hang up": the WRAP card. Keith presses WRAP (or Ctrl+Alt+W) near the end of a call and
 * gets one line that locks a concrete next step (what, who attends, a date or time), building on
 * anything already agreed; FOLLOW recaps what he still owes them. A HELP press whose last 30 seconds
 * already sound like the call is ending gets the same instruction, softened: a question they just
 * asked is answered first. Nothing appears without a press.
 *
 * The instruction goes in the user message, after the call context, so the cached system prompt
 * stays the same for every press.
 */
import type { CallMemory } from './callMemory'
import { HOT_WINDOW_MS } from './context'

/** Why this press asks for a wrap card: the WRAP button, or closing words just before a HELP press. */
export type WrapWhy = 'button' | 'closing'

/**
 * Where a "leaving" phrase has to stop for it to mean leaving the call: the end of what was said, or
 * "now", "soon", "in a minute", "at 2", "to my next meeting". So "I have to run" counts, but "we have
 * to run the evals", "we're short on time for this project" or "I'll let you go first" don't.
 */
const LEAVING_END =
  String.raw`(?= ?(?:[.,!?;\n]|$|now\b|soon\b|shortly\b|then\b|in (?:a|one|two|three|five|\d+) (?:sec|second|minute|min|moment|bit)s?\b|at (?:\d|the top of the hour\b)|(?:to|for) (?:(?:another|a|my|the|our)\s+)?(?:next\s+|other\s+)?(?:call|meeting)\b))`
/** "Time" as in "we're out of time", but not "short on time for this project" or "running out of time to pick a vendor". */
const TIME_END = String.raw`\btime\b(?!\s+(?:to|for|with|on|before|this|that|last|in)\b)`

/**
 * Words people use when a call is ending. Each one is tied to the phrase around it, so everyday
 * talk ("jump through hoops", "our next steps are to migrate", "we ran out of time last quarter",
 * "we have to run the evals", "the job runs at the top of the hour", "wrap it up in a Docker image")
 * doesn't count. The tests list both kinds; a phrase that slips through belongs there.
 */
const CLOSING: RegExp[] = [
  // "we're out of time", "I'm almost out of time", "we're at time", "we're running short on time"
  new RegExp(String.raw`\b(?:we're|we are|i'm|i am)\s+(?:(?:almost|nearly|just about|about|basically|kind of|pretty much|running|right)\s+)*(?:out of|at|over|up on|short on|tight on) ${TIME_END}`),
  new RegExp(String.raw`\b(?:running|run)\s+(?:short on|low on|out of) ${TIME_END}`),
  /\bhard stop\b/,
  // "I have to jump", "I need to hop off soon", "I've got to drop off", but not "jump through hoops",
  // "hop on a call next week", "drop support for the old SDK" or "drop the old tables"
  new RegExp(String.raw`\b(?:have|need|got|gotta|going) to (?:(?:jump|hop)(?: off(?: (?:the|this) call)?)?|drop off(?: (?:the|this) call)?|drop(?= at \d| in a))\b${LEAVING_END}`),
  // "I've got to run." / "I have to run to my next meeting", but not "we have to run the evals" or "go live"
  new RegExp(String.raw`\b(?:i|we)(?:'ve| have|'ll| will)? (?:got to|gotta|have to|need to) (?:run|go|head out|get going)${LEAVING_END}`),
  // "I'll let you go." / "let you get back to your day", but not "I'll let you go first" or "let you go ahead"
  new RegExp(String.raw`\blet you go${LEAVING_END}`),
  /\blet you get back to (?:your|it\b|work\b|the rest)/,
  // "it's nearly the top of the hour", "another call at the top of the hour", but not "the job runs at the top of the hour"
  /\b(?:it's|it is|we're|we are|almost|nearly|coming up on|close to|(?:call|meeting) at) (?:the )?top of the hour\b/,
  // "before we wrap", "before we hang up", but not "before we go live" or "before we wrap the SDK calls"
  /\bbefore (?:we|you|i) (?:hang up|drop off|jump off|hop off|close out|run out of time|end the call|finish up|let you go|wrap(?: (?:things |this |it )?up)?(?= ?(?:[.,!?;\n]|$|here\b|today\b|the call\b)))/,
  // "let's wrap up here", "we should wrap this up", "to wrap up, ...", but not "we wrap it up in a Docker
  // image" or "we want to wrap up the evaluation by Q3"
  /\b(?:let's|let us|we should|we can|we'll|we will|we need to|we have to|we're going to|time to|to|i'll|i will|i should|i'll start|let's start|start|we're|we are|i'm)\s+(?:wrap(?:ping)?|wind(?:ing)?)(?: (?:things|this|it|us))? (?:up|down)(?: (?:here|now|for today|the call))?(?= ?(?:[.,!?;\n]|$|so\b|and\b|then\b|with (?:a|one|the) (?:last|final|quick)\b))/,
  // "what are the next steps?", "in terms of next steps", "as a next step", "next steps?", but not
  // "our next steps are to migrate", "next steps for us internally" or "the next steps in the pipeline"
  /\b(?:what(?:'s| is| are| would be| should be)?|talk about|talk through|discuss|cover|agree on|align on|figure out|map out|lock in|nail down|in terms of|as for|as) (?:the |some |any |a |our )?next steps?\b(?!\s+(?:in|of|after|within|inside|for (?:the|your|their|this|that|each|our)|on (?:the|your|their|that)|with (?:the|your|their|that))\b)/,
  /\bnext steps\s*\?/,
  // "Should we wrap up?", "can we wrap things up here", but not "should we wrap up the evaluation by Q3"
  /\b(?:should|shall|can|could) (?:we|i) (?:wrap|wind)(?: (?:things|this|it))? (?:up|down)(?= ?(?:[.,!?;\n]|$|here\b|now\b|for today\b))/,
  // "we've only got five minutes left", "just a couple of minutes left"
  /\b(?:only|just|got|have|we've|i've)(?: (?:about|got|only|just))? (?:a (?:few|couple(?: of)?)|one|two|three|four|five|ten|\d+) (?:more )?minutes? left\b/,
  // "I have another meeting in two minutes", "my next call starts in five"
  /\b(?:another|my next|a|the next) (?:call|meeting) (?:in (?:a (?:few |couple (?:of )?)?|one |two |three |five |ten |\d+ )?(?:sec|second|minute|min|moment)s?\b|(?:starting|coming up|starts) (?:now|soon|in (?:a|one|two|three|five|ten|\d+)\b))/,
]

/** The text sounds like the call is ending ("we're out of time", "hard stop", "next steps", ...). */
export function closingLanguage(text: string): boolean {
  // Line breaks (between turns) are kept: a turn that ends on "I have to run" ends a clause.
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\S\n]+/g, ' ')
  return CLOSING.some((r) => r.test(t))
}

/** Everything said in the last 30 seconds (finished turns from everyone, plus words still being transcribed). */
export function recentText(memory: CallMemory, atMs: number): string {
  const turns = memory.turnsAsOf(atMs).filter((t) => t.end_ms >= atMs - HOT_WINDOW_MS).map((t) => t.text)
  const live = memory.interimsAsOf(atMs).map((i) => i.text)
  return [...turns, ...live].join('\n')
}

/** Which press asks for a wrap card: WRAP always; HELP when the last 30 s contain closing words. */
export function wrapReason(origin: string, memory: CallMemory, atMs: number): WrapWhy | null {
  if (origin === 'wrap_requested') return 'button'
  if (origin === 'help_requested' && closingLanguage(recentText(memory, atMs))) return 'closing'
  return null
}

const WRAP_REASON: Record<WrapWhy, string> = {
  button: 'Keith pressed WRAP: the call is about to end.',
  // Closing words can be heard while a question is still open ("I have a hard stop, but quickly, can
  // we self-host?"), so Keith pressed HELP for that: it comes first, and the block only applies if the call is ending.
  closing:
    'Keith pressed HELP and the last 30 seconds sound like the call may be ending. If they just asked a question or raised a concern, answer or handle that first (the normal rules) and put the next-step question in FOLLOW instead. If the call is not actually ending, ignore this block.',
}

/** The user message for a wrap card: the same call context, then what this card is for. */
export function wrapUserMessage(contextText: string, why: WrapWhy): string {
  return `${contextText}

<wrap_card>
${WRAP_REASON[why]} Before they hang up, help Keith lock a concrete next step.
- ASK or SAY: one line that pins down the next step: what happens, who attends, and a date or time. If a next step is already agreed (call_notes "agreed", or the transcript), confirm its details instead of proposing a new one. A step that was only proposed is not agreed: ask whether it works for them.
- If no date or time was said, ask for one ("What day works for you?"); never pick a date, a name or a commitment nobody said. Keep to any timeframe they named ("after our Q1 planning").
- If they said not now or not interested, don't push for a meeting: ask how and when they'd like Keith to follow up.
- MOVE: ${why === 'button' ? 'confirm_next_step. Use call_control only if they are mid-thought and Keith should let them finish.' : 'confirm_next_step when the line locks the next step; when it answers what they just asked, the move that fits that.'}
- FOLLOW: ${why === 'button' ? '' : 'the next-step question, when the line answers something else; otherwise '}what Keith still owes them from this call, as a short line in Keith's voice recapping only what he or a teammate promised to send or do ("I'll send over the SOC 2 report."); no new items or dates; "-" if nothing.
</wrap_card>

${why === 'button' ? 'Give Keith his line to lock the next step.' : 'Give Keith his next line.'}`
}

/** A request asking for a wrap card (the offline MOCK model answers it with a next-step line). */
export function isWrapRequest(user: string): boolean {
  return user.includes('<wrap_card>')
}
