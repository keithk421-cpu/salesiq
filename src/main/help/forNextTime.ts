/**
 * "For next time" (M4): a few short lines at the top of the wrap-up that Keith can save to the top of
 * "What I know about <account>". Built in code from the wrap-up items he kept (never a model's words),
 * each line starting with a label the notes reader knows ("They owe · Oct 6: ..."), so the box, HELP's
 * notes block and the must-learn ideas read them like any other line.
 *
 * Proposed stays "proposed", never "agreed". A Practice-mode (MOCK) wrap-up holds placeholders, not
 * anything said, so it gives nothing. Pure: runs in the wrap-up window too.
 */
import type { CallWrapup, WrapupItem } from '../../shared/help'
import type { NoteLabel } from './accountNotes'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Each item stays short, and a line holds a few of them. */
const ITEM_MAX_CHARS = 80
const ITEMS_PER_LINE = 3

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= ITEM_MAX_CHARS) return t
  const cut = t.slice(0, ITEM_MAX_CHARS - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > ITEM_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** The item with who and when as said on the call, unless its text already says them. */
function withWhoWhen(it: WrapupItem): string {
  const text = it.text.trim()
  const extra = [it.who, it.when].filter((x): x is string => typeof x === 'string' && !!x.trim() && !text.toLowerCase().includes(x.trim().toLowerCase())).map((x) => x.trim())
  return extra.length ? `${text} (${extra.join(', ')})` : text
}

/** "Oct 6", the call's own day (the date that makes "by Friday" readable later). */
function dayOf(startedAt: string | undefined, today: Date): string {
  const d = startedAt ? new Date(startedAt) : today
  const use = Number.isNaN(d.getTime()) ? today : d
  return `${MONTHS[use.getMonth()]} ${use.getDate()}`
}

/** The lines Keith can save, or '' when the wrap-up has nothing to carry over. */
export function forNextTimeDraft(w: Pick<CallWrapup, 'items' | 'plan_open' | 'started_at' | 'mock'> | null | undefined, today = new Date()): string {
  if (!w || w.mock === true) return ''
  // Only what Keith kept: confirmed, or not yet looked at; never what he removed.
  const kept = (Array.isArray(w.items) ? w.items : []).filter((i) => i && i.state !== 'removed' && typeof i.text === 'string' && i.text.trim())
  const of = (section: WrapupItem['section']) => kept.filter((i) => i.section === section).map((i) => clip(withWhoWhen(i)))
  const toLearn = (Array.isArray(w.plan_open) ? w.plan_open : []).filter((x): x is string => typeof x === 'string' && !!x.trim()).map(clip)
  const day = dayOf(w.started_at, today)
  const rows: Array<[NoteLabel, string[]]> = [
    ['Deal so far', [...of('agreed').map((t) => `agreed: ${t}`), ...of('proposed').map((t) => `proposed: ${t}`)]],
    ['They owe', of('they_owe')],
    ['We promised', of('we_owe')],
    ['To learn', toLearn],
  ]
  return rows
    .filter(([, items]) => items.length)
    .map(([label, items]) => `${label} · ${day}: ${items.slice(0, ITEMS_PER_LINE).join(' · ')}`)
    .join('\n')
}
