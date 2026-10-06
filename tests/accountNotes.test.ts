import { describe, expect, it } from 'vitest'
import { ACCOUNT_NOTES_MAX_CHARS } from '../src/shared/help'
import { Db } from '../src/main/db'
import { deleteCall } from '../src/main/retention'
import { accountsWithNotes, getAccountNotes, noteLines, notesToLearn, prependAccountNotes, setAccountNotes } from '../src/main/help/accountNotes'

/** Invented accounts and notes: none of this is a real company, person or product fact. */
describe('"What I know" notes per account', () => {
  it('are kept per account as typed (any case or spacing), dated, and emptied by saving nothing', () => {
    const db = new Db(':memory:')
    expect(getAccountNotes(db, 'Larkspur Health')).toEqual({ account: 'Larkspur Health', text: '', updated_at: null })
    const at = new Date('2026-10-06T09:00:00Z')
    expect(setAccountNotes(db, '  Larkspur   Health ', 'Who: Dana, VP of AI\r\n\r\n\r\n\r\nTheir setup:  homegrown evals  ', at)).toEqual({
      account: 'Larkspur Health', text: 'Who: Dana, VP of AI\n\nTheir setup: homegrown evals', updated_at: at.toISOString(),
    })
    expect(getAccountNotes(db, 'larkspur health').text).toBe('Who: Dana, VP of AI\n\nTheir setup: homegrown evals')
    expect(accountsWithNotes(db)).toEqual([{ account: 'Larkspur Health', updated_at: at.toISOString() }])
    expect(setAccountNotes(db, 'Larkspur Health', '   ')).toEqual({ account: 'Larkspur Health', text: '', updated_at: null })
    expect(accountsWithNotes(db)).toEqual([])
    // No account, nothing to save under.
    expect(setAccountNotes(db, '  ', 'Who: someone')).toBeNull()
    expect(setAccountNotes(db, 42, 'Who: someone')).toBeNull()
  })

  it('are cut at the limit, and "For next time" lines go on top, dropping the oldest lines at the bottom', () => {
    const db = new Db(':memory:')
    expect(setAccountNotes(db, 'Acme Bio', 'x'.repeat(ACCOUNT_NOTES_MAX_CHARS + 50))!.text).toHaveLength(ACCOUNT_NOTES_MAX_CHARS)
    setAccountNotes(db, 'Acme Bio', ['Who: Sam, ML lead', ...Array.from({ length: 60 }, (_, i) => `Line ${i} about their setup and who is involved`)].join('\n'))
    const after = prependAccountNotes(db, 'Acme Bio', 'Deal so far · Oct 6: they are pulling an eval sample together')!
    expect(after.text.startsWith('Deal so far · Oct 6: they are pulling an eval sample together\n\nWho: Sam, ML lead')).toBe(true)
    expect(after.text.length).toBeLessThanOrEqual(ACCOUNT_NOTES_MAX_CHARS)
    expect(after.text).not.toContain('Line 59')
  })

  it("stay when the account's saved calls are deleted (they're Keith's, not a call's)", () => {
    const db = new Db(':memory:')
    db.sql.prepare("INSERT INTO sessions (id, started_at, setup_json) VALUES ('s1', '2026-10-01T10:00:00Z', ?)").run(JSON.stringify({ account: 'Acme Bio' }))
    setAccountNotes(db, 'Acme Bio', 'Who: Sam')
    deleteCall('/nonexistent-root-for-test', db, 's1')
    expect(getAccountNotes(db, 'Acme Bio').text).toBe('Who: Sam')
  })

  it('read as labelled lines; a line without a known label is a plain note', () => {
    expect(noteLines('- Who · Oct 2: Dana, VP of AI\n* Research (not said by them) · Sumble, Oct 1: open roles on the ML team\nThey were nice\nwhoever joins: tbd\n1. To learn: who signs off')).toEqual([
      { label: 'Who', text: 'Dana, VP of AI' },
      { label: 'Research (not said by them)', text: 'open roles on the ML team' },
      { label: null, text: 'They were nice' },
      { label: null, text: 'whoever joins: tbd' },
      { label: 'To learn', text: 'who signs off' },
    ])
  })

  it('"To learn" lines become separate short items, without the source in brackets, each once', () => {
    expect(notesToLearn('Who: Dana\nTo learn: who signs off · SaaS or self-hosted [Notion, Oct 2]\nto learn · Oct 3: timeline to decide; who signs off.\nTheir setup: to learn more later')).toEqual([
      'who signs off', 'SaaS or self-hosted', 'timeline to decide',
    ])
    expect(notesToLearn('')).toEqual([])
  })
})
