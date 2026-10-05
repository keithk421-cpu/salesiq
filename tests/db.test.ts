import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/main/db'

describe('database startup', () => {
  it('opens even when a background request has an unreadable timing record, and still drops unseen text', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'copilot.db')
    const old = new Db(file)
    const ins = old.sql.prepare(
      `INSERT INTO help_requests (id, origin, created_at, status, model_json, request_text, output_raw, card_json, timing_json, prefetch) VALUES (?, 'help_requested', 't', 'complete', '{}', 'BUYER WORDS', 'raw', '{}', ?, 1)`,
    )
    ins.run('broken', '{"served_from_prefetch": tru')
    ins.run('unseen', JSON.stringify({ served_from_prefetch: false }))
    ins.run('no-timing', null)
    ins.run('adopted', JSON.stringify({ served_from_prefetch: true }))
    old.close()
    // Used to throw "malformed JSON" here, so HELP failed to start on every launch.
    const db = new Db(file)
    const rows = db.sql.prepare('SELECT id, request_text FROM help_requests ORDER BY id').all()
    expect(rows).toEqual([
      { id: 'adopted', request_text: 'BUYER WORDS' },
      // Can't tell whether Keith saw it: left as it is.
      { id: 'broken', request_text: 'BUYER WORDS' },
      { id: 'no-timing', request_text: null },
      { id: 'unseen', request_text: null },
    ])
    db.close()
  })
})
