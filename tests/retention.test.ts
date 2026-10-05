import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/main/db'
import { deleteCall, deleteCalls, listSavedCalls, olderThan, startedAtFromId } from '../src/main/retention'

function call(root: string, db: Db, id: string, account: string) {
  const dir = path.join(root, 'sessions', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '{"text":"BUYER WORDS"}\n')
  fs.writeFileSync(path.join(dir, 'diagnostics.jsonl'), '{}\n')
  db.sql.prepare('INSERT INTO sessions (id, started_at, setup_json) VALUES (?, ?, ?)').run(id, startedAtFromId(id)!, JSON.stringify({ account }))
  db.sql.prepare("INSERT INTO turns (session_id, turn_id, stream, start_ms, end_ms, available_ms, text) VALUES (?, 't1', 'system_remote', 0, 1, 1, 'BUYER WORDS')").run(id)
  db.sql.prepare("INSERT INTO turns_fts (text, session_id, turn_id) VALUES ('BUYER WORDS', ?, 't1')").run(id)
  db.sql.prepare("INSERT INTO speaker_labels (session_id, cluster, role, name, updated_at) VALUES (?, 'e1:s0', 'buyer', 'Dana', 't')").run(id)
  db.sql.prepare("INSERT INTO help_requests (id, session_id, origin, created_at, status, model_json, request_text) VALUES (?, ?, 'help_requested', 't', 'complete', '{}', 'BUYER WORDS')").run(`r-${id}`, id)
  db.sql.prepare("INSERT INTO feedback (card_id, origin, type, ts) VALUES (?, 'help_requested', 'useful', 't')").run(`r-${id}`)
}

describe('saved calls and retention', () => {
  it('lists calls from the database and from folders, oldest first, and finds those past the limit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-'))
    const db = new Db(':memory:')
    call(root, db, 's-2026-08-01T15-00-00-000Z-aaaaaa', 'Northwind')
    call(root, db, 's-2026-10-01T15-00-00-000Z-bbbbbb', 'Fernhollow')
    // A call recorded while HELP was unavailable has a folder but no database row.
    fs.mkdirSync(path.join(root, 'sessions', 's-2026-07-15T10-00-00-000Z-cccccc'), { recursive: true })
    fs.mkdirSync(path.join(root, 'sessions', 'not-a-call'), { recursive: true })
    const calls = listSavedCalls(root, db)
    expect(calls.map((c) => [c.id.slice(2, 12), c.account])).toEqual([['2026-07-15', ''], ['2026-08-01', 'Northwind'], ['2026-10-01', 'Fernhollow']])
    expect(olderThan(calls, 30, new Date('2026-10-05T12:00:00Z')).map((c) => c.id.slice(2, 12))).toEqual(['2026-07-15', '2026-08-01'])
  })

  it('deleting a call removes its transcript, labels, HELP requests, feedback and folder, and nothing else', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-'))
    const file = path.join(root, 'copilot.db')
    const db = new Db(file)
    const gone = 's-2026-08-01T15-00-00-000Z-aaaaaa'
    const kept = 's-2026-10-01T15-00-00-000Z-bbbbbb'
    call(root, db, gone, 'Northwind')
    call(root, db, kept, 'Fernhollow')
    // Words said only in each call, stored only in its transcript and transcript search index.
    const said = (id: string, text: string) => {
      db.sql.prepare("INSERT INTO turns (session_id, turn_id, stream, start_ms, end_ms, available_ms, text) VALUES (?, 't2', 'system_remote', 2, 3, 3, ?)").run(id, text)
      db.sql.prepare("INSERT INTO turns_fts (text, session_id, turn_id) VALUES (?, ?, 't2')").run(text, id)
    }
    said(gone, 'zanzibarite quokkaflux rollout')
    said(kept, 'marmalith pilot')
    expect(deleteCalls(root, db, [gone])).toEqual({ deleted: 1, failed: 0 })
    for (const [t, col] of [['sessions', 'id'], ['turns', 'session_id'], ['turns_fts', 'session_id'], ['speaker_labels', 'session_id'], ['help_requests', 'session_id']]) {
      const ids = (db.sql.prepare(`SELECT DISTINCT ${col} AS id FROM ${t}`).all() as Array<{ id: string }>).map((r) => r.id)
      expect(ids, t).toEqual([kept])
    }
    expect((db.sql.prepare('SELECT card_id FROM feedback').all() as Array<{ card_id: string }>).map((r) => r.card_id)).toEqual([`r-${kept}`])
    expect(fs.existsSync(path.join(root, 'sessions', gone))).toBe(false)
    expect(fs.existsSync(path.join(root, 'sessions', kept, 'transcript.jsonl'))).toBe(true)
    // Compacted while the app keeps running: the deleted call's words are in neither the file nor its log.
    // That includes the transcript search index, whose deleted entries outlive VACUUM unless merged.
    for (const f of [file, `${file}-wal`]) {
      if (!fs.existsSync(f)) continue
      const bytes = fs.readFileSync(f).toString('latin1')
      for (const word of ['Northwind', 'zanzibar', 'quokkaflux']) expect(bytes.includes(word), `${word} in ${f}`).toBe(false)
    }
    expect(fs.readFileSync(file).toString('latin1')).toContain('Fernhollow')
    expect(fs.readFileSync(file).toString('latin1')).toContain('marmalith')
    // The kept call is still searchable.
    expect(db.sql.prepare("SELECT session_id FROM turns_fts WHERE turns_fts MATCH 'marmalith'").all()).toEqual([{ session_id: kept }])
    db.close()
  })

  it('refuses anything that is not a session id (no path tricks)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-'))
    fs.writeFileSync(path.join(root, 'copilot.db'), 'x')
    expect(deleteCall(root, null, '../copilot.db')).toBe(false)
    expect(deleteCall(root, null, 's-../../x')).toBe(false)
    expect(fs.existsSync(path.join(root, 'copilot.db'))).toBe(true)
  })
})
