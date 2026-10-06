/**
 * What HELP gets of "What I know about <account>" (M4), and the Level 1 check that goes with it.
 *
 * Keith's notes are his own: calls before the app, who's who, their setup, research he looked up.
 * HELP may use them as check questions only ("My understanding is you're on X today. Is that still
 * right?"), never as something said on this call and never as Arize fact. So the block says so in its
 * label, leaves out his "To learn" lines (his plan, not facts), and puts research last so it's the
 * first to go when the block is too long.
 *
 * The check (keithNotesChecks) flags a finished card that says they told Keith something ("you
 * mentioned", "I saw", ...) when the words it rests on are only in his notes, not in anything said.
 */
import type { HelpCardContent } from '../../shared/help'
import { KEITH_NOTES_BLOCK_MAX_CHARS } from '../../shared/help'
import { noteLines } from './accountNotes'

const HEAD = '<keith_notes note="Keith\'s own notes and research from before this call: not said by anyone on this call, not Arize fact, may be out of date">'
const TAIL = '</keith_notes>'
/** One pasted paragraph can't take the whole block: it's cut at a word. */
const LINE_MAX_CHARS = 200
const RESEARCH = 'Research (not said by them)'

/** The plain check shown on the card (and the Level 1 failure's reason). */
export const CHECK_NOTES_ONLY = 'Says they told you something only your notes say: check it'

function clip(s: string, max: number): string {
  // The block's own tags must stay the only ones: nothing in the notes can open or close a block.
  const t = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/**
 * The HELP block, at most KEITH_NOTES_BLOCK_MAX_CHARS with its tags: each line as Keith wrote it (its
 * label and date kept, so an old line reads as old), "To learn" lines left out, research lines last.
 * Returns the lines it used too, so the request records exactly what HELP saw (a practice moment
 * replays them). Null when there's nothing to send.
 */
export function keithNotesBlock(text: unknown): { text: string; used: string } | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const plain: string[] = []
  const research: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = clip(raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), LINE_MAX_CHARS)
    if (!line) continue
    const label = noteLines(line)[0]?.label ?? null
    if (label === 'To learn') continue
    ;(label === RESEARCH ? research : plain).push(line)
  }
  let room = KEITH_NOTES_BLOCK_MAX_CHARS - HEAD.length - TAIL.length - 1
  const lines: string[] = []
  // His own notes first; research only once all of them fit, so it's what goes when the notes are long.
  let full = false
  for (const [i, l] of [...plain, ...research].entries()) {
    if (full && i >= plain.length) break
    if (l.length + 1 > room) {
      full = true
      continue
    }
    room -= l.length + 1
    lines.push(l)
  }
  if (!lines.length) return null
  return { text: `${HEAD}\n${lines.join('\n')}\n${TAIL}`, used: lines.join('\n') }
}

// ---------------------------------------------------------------- the Level 1 check

/**
 * Wording that says the other side told Keith something, or that he looked them up. A question about
 * it ("Have you mentioned this to Dana?", "Did I read that right?") isn't saying so.
 */
const TOLD = /(?<!\b(?:have|had|has|did|do|does)\s)\b(?:(?:as |what |like )?you(?:'ve|'d| have| had)? (?:mentioned|said|told (?:us|me))|I (?:saw|noticed|read))\b/i

/** Small words that say nothing about where a fact came from. */
const COMMON = new Set(`
the and for are but not you your yours you're you've you'd that this these those with from have has had was were will would could should
can our ours their theirs they them they're there here what which who whom whose when where why how about into onto over under just also
still really very much more most some any all each every one two its it's let let's me my mine we we're us is am be been being do does did
done say said saying mentioned mention told tell telling saw see seen seeing noticed notice read reading earlier before last time today
now then than so if or as at by of on in to up out off an a i i'm i've i'd ok okay right yes no sure thing things way get got going go
hi oh ah uh um eh yeah
know think thought want wanted need needed like looks look use using used work working team call calls week weeks month months
`.split(/\s+/).filter(Boolean))

/** Words of a text, lower case. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
}

/** A plural or possessive "s" taken off, so "evals" and "eval" match. */
const stem = (w: string) => w.replace(/['’]s$/, '').replace(/(?<=\w{3})s$/, '')

/** The body of each block with this tag in the request (tags carry attributes, e.g. note="..."). */
function blocks(contextText: string, tag: string): string[] {
  return [...contextText.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1])
}

/** What anyone actually said, as the request had it: this call's lines and notes, and earlier calls. */
const SAID_BLOCKS = ['last_30_seconds', 'recent_thread', 'earlier_in_call', 'call_notes', 'earlier_calls']

/**
 * The card's check: one of ASK/SAY or FOLLOW says they told Keith (or he saw) something whose words
 * are only in his notes. Words that are also in something said (this call or an earlier one) are
 * fine: "You mentioned evals earlier" about evals they talked about is true. Read from the request's
 * own text, so the live card and the speed test judge the same thing. [] when the request had no notes.
 */
export function keithNotesChecks(card: Pick<HelpCardContent, 'primary' | 'follow_up'>, contextText: string): string[] {
  const block = blocks(contextText, 'keith_notes').join('\n')
  if (!block.trim()) return []
  // What the notes say, without their labels, dates and [source, date]: "You mentioned your setup..."
  // isn't from his notes just because a line starts "Their setup ·".
  const notes = block.split('\n').map((l) => (noteLines(l)[0]?.text ?? '').replace(/\[[^\]]*\]/g, ' ')).join('\n')
  const said = SAID_BLOCKS.flatMap((t) => blocks(contextText, t)).join('\n')
  const saidWords = new Set(words(said).map(stem))
  // Speech-to-text splits names ("Lang Smith"): a long word also counts as said when it's there without the space.
  const saidRun = said.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const noteWords = new Set(words(notes).map(stem))
  const fromNotesOnly = (w: string) => {
    if (COMMON.has(w) || (w.length < 2 && !/\d/.test(w))) return false
    const s = stem(w)
    return noteWords.has(s) && !saidWords.has(s) && !(s.length >= 5 && saidRun.includes(s.replace(/[^\p{L}\p{N}]+/gu, '')))
  }
  for (const field of [card.primary ?? '', card.follow_up ?? '']) {
    for (const sentence of field.split(/(?<=[.!?;])\s+/)) {
      if (TOLD.test(sentence) && words(sentence).some(fromNotesOnly)) return [CHECK_NOTES_ONLY]
    }
  }
  return []
}
