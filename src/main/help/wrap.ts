/**
 * "Before you hang up": the WRAP card. Keith presses WRAP (or Ctrl+Alt+W) near the end of a call and
 * gets one line that locks a concrete next step (what, who attends, a date or time), building on
 * anything already agreed; FOLLOW lists what he still owes them. A HELP press whose last 30 seconds
 * already sound like the call is ending gets the same instruction. Nothing appears without a press.
 *
 * The instruction goes in the user message, after the call context, so the cached system prompt
 * stays the same for every press.
 */
import type { CallMemory } from './callMemory'
import { HOT_WINDOW_MS } from './context'

/** Why this press asks for a wrap card: the WRAP button, or closing words just before a HELP press. */
export type WrapWhy = 'button' | 'closing'

/**
 * Words people use when a call is ending. Each one is tied to the phrase around it, so everyday
 * talk ("jump through hoops", "the next steps in the pipeline", "we ran out of time last quarter",
 * "we have to run the evals") doesn't count.
 */
const CLOSING: RegExp[] = [
  // "we're out of time", "I'm almost out of time", "we're at time", "we're running out of time"
  /\b(?:we're|we are|i'm|i am)\s+(?:(?:almost|nearly|just about|about|basically|kind of|pretty much|running|right)\s+)*(?:out of|at|over|up on|short on|tight on)\s+time\b/,
  /\b(?:running|run)\s+(?:short on|low on|out of)\s+time\b/,
  /\bhard stop\b/,
  // "I have to jump", "I need to hop off", "I've got to drop", but not "jump through hoops", "jump into
  // the demo" or "hop on a call next week"
  /\b(?:have|need|got|gotta|going) to (?:jump|hop|drop)(?: off)?\b(?! (?:through|into|in (?!a (?:sec|second|minute|moment|bit)\b)|ahead|over|back|at|on (?!another\b|my next\b))\b)/,
  // "I've got to run." / "I have to run to another meeting", but not "we have to run the evals" or "go live"
  /\b(?:i|we)(?:'ve| have|'ll| will)? (?:got to|gotta|have to|need to) (?:run|go|head out|get going)(?= ?(?:[.,!?;\n]|$|now\b|soon\b|shortly\b|in a (?:sec|second|minute|moment)\b|to (?:another|a|my|the next) (?:call|meeting)\b))/,
  /\blet you (?:go|get back to)\b/,
  /\btop of the hour\b/,
  /\bbefore we (?:wrap|hang up|drop|jump|close out|run out of time|end the call|finish up|let you go)\b/,
  /\b(?:wrap|wrapping) (?:things |this |it |us )?up\b/,
  // "next steps", but not "the next steps in the pipeline" / "of the process"
  /\bnext steps\b(?!\s+(?:in|of)\s+(?:the|our|your|their|this|that|a|an|each)\b)/,
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
  closing: 'Keith pressed HELP and the last 30 seconds sound like the call is ending.',
}

/** The user message for a wrap card: the same call context, then what this card is for. */
export function wrapUserMessage(contextText: string, why: WrapWhy): string {
  return `${contextText}

<wrap_card>
${WRAP_REASON[why]} Before they hang up, help Keith lock a concrete next step.
- ASK or SAY: one line that pins down the next step: what happens, who attends, and a date or time. If a next step is already agreed (call_notes "agreed", or the transcript), confirm its details instead of proposing a new one. A step that was only proposed is not agreed: ask whether it works for them.
- If no date or time was said, ask for one ("What day next week works for you?"); never pick a date, a name or a commitment nobody said.
- MOVE: confirm_next_step. Use call_control only if they are mid-thought and Keith should let them finish.
- FOLLOW: what Keith still owes them from this call (what he or a teammate said they would send or do), briefly; "-" if nothing.
</wrap_card>

Give Keith his line to lock the next step.`
}

/** A request asking for a wrap card (the offline MOCK model answers it with a next-step line). */
export function isWrapRequest(user: string): boolean {
  return user.includes('<wrap_card>')
}
