/**
 * "Copy prep prompt" (M4, "What I know about <account>"): a ready-made request Keith pastes into
 * Claude, where his Sumble, Notion and Drive are connected, before a call. He pastes the answer back
 * into the box. The app sends nothing: this only builds the text.
 *
 * The answer it asks for is what the box reads best: at most 8 short lines, each starting with one
 * of the note labels (noteLines reads them), the source and date in brackets, a few neutral "To learn"
 * items short enough to read in full on the plan line (notesToLearn makes them must-learn ideas).
 * Pure: the same inputs always give the same text.
 */
import type { AccountMemory, AccountMemoryKind, CallSetup, CallType } from '../../shared/help'
import { NOTE_LABELS } from './accountNotes'

/** The labels the answer may use ("Deal so far" is written by the app after a call, not by research). */
export const PREP_LABELS = NOTE_LABELS.filter((l) => l !== 'Deal so far')
export const PREP_MAX_LINES = 8
export const PREP_TO_LEARN_MAX = 3
/** Same as a must-learn idea that reads in full on the plan line. */
export const PREP_TO_LEARN_MAX_CHARS = 28

const CALL_TYPE_WORDS: Record<CallType, string> = {
  discovery: 'Discovery', demo: 'Demo', technical_deep_dive: 'Technical deep-dive', follow_up: 'Follow-up', negotiation: 'Negotiation', other: 'Other',
}

/** How each kind of earlier-call item reads in the request (who said it, past tense). */
const KIND_WORDS: Record<AccountMemoryKind, string> = {
  promised: 'We promised', they_owe: 'They owe', agreed: 'Agreed next step', open: 'Still open', to_learn: 'Still to learn', wants: 'They wanted', fact: 'They told us',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sep 28" from a call day (YYYY-MM-DD); anything else as it is. */
function day(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : s
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The request Keith copies, from the setup strip, what earlier calls left behind and his notes so far. */
export function prepPrompt(o: { setup: CallSetup; memory: AccountMemory | null; notes: string; today: Date }): string {
  const s = o.setup
  const account = oneLine(s.account) || '(account not set)'
  const date = `${MONTHS[o.today.getMonth()]} ${o.today.getDate()}, ${o.today.getFullYear()}`
  const mustLearn = (s.must_learn ?? []).map(oneLine).filter(Boolean)
  const known = (o.memory?.items ?? []).map((it) => `- ${day(it.date)} · ${KIND_WORDS[it.kind] ?? 'Said'}: ${oneLine(it.text)}`)
  const notes = o.notes.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean)
  const out = [
    `I have a sales call with ${account} and want short prep notes I can paste into my call app. Please look in Sumble, Notion and Google Drive for what we know about them.`,
    '',
    `Account: ${account}`,
    `Call: ${CALL_TYPE_WORDS[s.call_type] ?? 'Other'}, ${date}`,
    `My goal: ${oneLine(s.call_goal) || '(not set)'}`,
    `What I want to learn on the call: ${mustLearn.join(' · ') || '(not set)'}`,
  ]
  if (known.length) out.push('', 'From my earlier calls with them (I have these already):', ...known)
  if (notes.length) out.push('', 'In my notes already (I have these too):', ...notes.map((l) => `- ${l}`))
  out.push(
    '',
    `Answer with at most ${PREP_MAX_LINES} short lines and nothing else. Start each line with one of these labels and a colon: ${PREP_LABELS.join(' / ')}.`,
    'End each line with the source and its date in brackets, like: Who: Dana Reyes, VP of AI [Notion, Sep 30]',
    'Plain text only: no bold, bullets, headings or numbering. Write each label exactly as above, including "Research (not said by them)", then a colon.',
    'Rules:',
    '- Only what the sources show. No guesses and no guessed numbers. If you are unsure of something, add "(unsure)".',
    '- Leave out what I already have above.',
    '- "Research (not said by them)" is for anything they did not tell us themselves (Sumble, job posts, news).',
    `- At most ${PREP_TO_LEARN_MAX} "To learn" lines: one thing to find out on this call each, ${PREP_TO_LEARN_MAX_CHARS} characters or fewer, worded neutrally (no assumed problem, pain, urgency or deadline).`,
    '- If the sources show nothing new, answer with one line: Nothing new.',
  )
  return out.join('\n')
}

/**
 * A pasted answer made readable to the notes reader: Claude often answers in Markdown anyway
 * ("- **Who:** Dana", "## Prep notes"), and a label in bold isn't a label to noteLines. Strips bold and
 * headings, and reads a bare "Research:" as the research label. Pure; the box runs it on paste.
 */
export function plainAnswer(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/\*\*|__/g, '')
        .replace(/^(\s*(?:[-*•]|\d+[.)])?\s*)Research\s*:/i, '$1Research (not said by them):'),
    )
    .join('\n')
}
