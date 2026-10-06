/**
 * "What I know about <account>" (M4): Keith's own notes on an account, typed or pasted by him (calls
 * before the app, who's who, their setup, research he looked up). Kept per account (accountKey) across
 * calls in the account_notes table; deleting saved calls leaves them (they're his, not a call's), and
 * Clear empties them.
 *
 * This file is only the store and the line reading the other M4 parts share. What HELP gets of the
 * notes, the box on screen and "For next time" are built on top of it.
 */
import { ACCOUNT_NOTES_MAX_CHARS, accountKey, type AccountNotes } from '../../shared/help'
import type { Db } from '../db'

/** The labels a pasted prep answer uses (the "Copy prep prompt" asks Claude for these). */
export const NOTE_LABELS = ['Who', 'Their setup', 'Before the app', 'They owe', 'We promised', 'Research (not said by them)', 'To learn', 'Deal so far'] as const
export type NoteLabel = (typeof NOTE_LABELS)[number]

/** One line of the notes, with its label when it starts with one ("Who · Oct 2: ..." or "Who: ..."). */
export interface NoteLine {
  label: NoteLabel | null
  text: string
}

function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Windows line ends and stray spaces don't count against the limit; blank runs fold to one empty line.
  const t = raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > ACCOUNT_NOTES_MAX_CHARS ? t.slice(0, ACCOUNT_NOTES_MAX_CHARS).trimEnd() : t
}

function cleanAccount(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
}

/** The notes for an account (empty text and no date when there are none). */
export function getAccountNotes(db: Db, account: string): AccountNotes {
  const name = cleanAccount(account)
  const key = accountKey(name)
  if (!key) return { account: name, text: '', updated_at: null }
  const row = db.sql.prepare('SELECT account, text, updated_at FROM account_notes WHERE account_key = ?').get(key) as { account: string; text: string; updated_at: string } | undefined
  return row ? { account: row.account, text: row.text, updated_at: row.updated_at } : { account: name, text: '', updated_at: null }
}

/**
 * Save the notes for an account (trimmed, at most ACCOUNT_NOTES_MAX_CHARS). Empty text removes them.
 * Returns what was kept, or null when there is no account to save them under.
 */
export function setAccountNotes(db: Db, account: unknown, text: unknown, now = new Date()): AccountNotes | null {
  const name = cleanAccount(account)
  const key = accountKey(name)
  if (!key) return null
  const t = cleanText(text)
  if (!t) {
    db.sql.prepare('DELETE FROM account_notes WHERE account_key = ?').run(key)
    return { account: name, text: '', updated_at: null }
  }
  const at = now.toISOString()
  db.sql.prepare(
    `INSERT INTO account_notes (account_key, account, text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_key) DO UPDATE SET account = excluded.account, text = excluded.text, updated_at = excluded.updated_at`,
  ).run(key, name, t, at)
  return { account: name, text: t, updated_at: at }
}

/**
 * Add lines at the top of an account's notes (newest first, like "For next time" after a call), keeping
 * the whole within the limit by dropping the oldest lines at the bottom.
 */
export function prependAccountNotes(db: Db, account: unknown, lines: unknown, now = new Date()): AccountNotes | null {
  const name = cleanAccount(account)
  if (!accountKey(name)) return null
  const add = cleanText(lines)
  if (!add) return getAccountNotes(db, name)
  const old = getAccountNotes(db, name).text
  let all = old ? `${add}\n\n${old}` : add
  if (all.length > ACCOUNT_NOTES_MAX_CHARS) {
    const kept = all.split('\n')
    while (kept.length > 1 && kept.join('\n').length > ACCOUNT_NOTES_MAX_CHARS) kept.pop()
    all = kept.join('\n')
  }
  return setAccountNotes(db, name, all, now)
}

/**
 * The same account typed a little differently: a typo fixed ("Bramblway" -> "Brambleway"), or a word
 * added or taken off ("Brambleway" -> "Brambleway (EU)"). The notes box asks whether to move notes
 * Keith just wrote under the old spelling only then, so two different accounts never trade notes.
 */
export function nearAccountName(a: string, b: string): boolean {
  const x = accountKey(a)
  const y = accountKey(b)
  if (!x || !y || x === y) return false
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) >= 3
  // At most 2 letters added, dropped or changed (edit distance), for names of 5 letters or more.
  if (Math.min(x.length, y.length) < 5 || Math.abs(x.length - y.length) > 2) return false
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[y.length] <= 2
}

/** Every account with notes, keyed by accountKey (for listing; the text stays in the database). */
export function accountsWithNotes(db: Db): Array<{ account: string; updated_at: string }> {
  return db.sql.prepare('SELECT account, updated_at FROM account_notes ORDER BY updated_at DESC').all() as unknown as Array<{ account: string; updated_at: string }>
}

const LABEL_RE = new RegExp(String.raw`^(${NOTE_LABELS.map((l) => l.replace(/[()]/g, '\\$&')).join('|')})(?=[\s·(:])(?:\s*[·(][^:]*)?\s*:\s*`, 'i')

/**
 * The notes as lines, each with its label when it has one ("Who · Oct 2: Dana, VP of AI" -> Who).
 * List bullets are dropped; a line without a known label is kept as a plain note.
 */
export function noteLines(text: string): NoteLine[] {
  const out: NoteLine[] = []
  for (const raw of cleanText(text).split('\n')) {
    const l = raw.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim()
    if (!l) continue
    const m = LABEL_RE.exec(l)
    const label = m ? (NOTE_LABELS.find((x) => x.toLowerCase() === m[1].toLowerCase()) ?? null) : null
    const body = m ? l.slice(m[0].length).trim() : l
    if (body) out.push({ label, text: body })
  }
  return out
}

/**
 * The "To learn" items in the notes ("To learn: who signs off · SaaS or self-hosted"), each short and
 * trimmed of a trailing "[source, date]": they become must-learn ideas.
 */
export function notesToLearn(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of noteLines(text)) {
    if (l.label !== 'To learn') continue
    for (const part of l.text.replace(/\s*\[[^\]]*\]\s*$/, '').split(/\s*(?:·|;|\|)\s*/)) {
      const t = part.replace(/[.\s]+$/, '').trim()
      const k = t.toLowerCase()
      if (t && !seen.has(k)) {
        seen.add(k)
        out.push(t)
      }
    }
  }
  return out
}
