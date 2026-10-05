/**
 * Saved calls: list, delete one, and delete those older than the retention setting. A call's
 * transcript, speaker labels, HELP requests/cards and feedback are removed from the database, and its
 * session folder (transcript.jsonl, diagnostics) is deleted. Numbers-only scorecards in reports/ stay.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Db } from './db'

export interface SavedCall {
  id: string
  started_at: string
  account: string
}

/** Session ids look like s-2026-10-05T04-58-48-123Z-abc123: the start time is in the name. */
export function startedAtFromId(id: string): string | null {
  const m = /^s-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id)
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null
}

const SESSION_ID = /^s-[\w-]+$/

/** Every saved call, oldest first: rows in the database plus session folders on disk. */
export function listSavedCalls(root: string, db: Db | null): SavedCall[] {
  const calls = new Map<string, SavedCall>()
  const rows = (db?.sql.prepare('SELECT id, started_at, setup_json FROM sessions').all() ?? []) as Array<{ id: string; started_at: string; setup_json: string }>
  for (const r of rows) {
    let account = ''
    try {
      account = String((JSON.parse(r.setup_json) as { account?: unknown }).account ?? '')
    } catch {
      /* unreadable setup: no account shown */
    }
    calls.set(r.id, { id: r.id, started_at: r.started_at, account })
  }
  const dir = path.join(root, 'sessions')
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (calls.has(id) || !SESSION_ID.test(id)) continue
    let started = startedAtFromId(id)
    if (!started) {
      try {
        started = fs.statSync(path.join(dir, id)).mtime.toISOString()
      } catch {
        continue
      }
    }
    calls.set(id, { id, started_at: started, account: '' })
  }
  return [...calls.values()].sort((a, b) => a.started_at.localeCompare(b.started_at))
}

export function olderThan(calls: SavedCall[], days: number, now = new Date()): SavedCall[] {
  const cutoff = now.getTime() - days * 86_400_000
  return calls.filter((c) => Date.parse(c.started_at) < cutoff)
}

/** Remove one call everywhere. Returns false if its folder couldn't be removed (e.g. a file is open). */
export function deleteCall(root: string, db: Db | null, id: string): boolean {
  if (!SESSION_ID.test(id)) return false
  if (db) {
    db.tx(() => {
      db.sql.prepare('DELETE FROM feedback WHERE card_id IN (SELECT id FROM help_requests WHERE session_id = ?)').run(id)
      for (const t of ['help_requests', 'turns', 'turns_fts', 'speaker_labels']) db.sql.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id)
      db.sql.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    })
  }
  try {
    fs.rmSync(path.join(root, 'sessions', id), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Delete these calls, then compact the database so the removed text doesn't linger in free pages. */
export function deleteCalls(root: string, db: Db | null, ids: string[]): { deleted: number; failed: number } {
  let deleted = 0
  let failed = 0
  for (const id of ids) {
    if (deleteCall(root, db, id)) deleted++
    else failed++
  }
  if (db && ids.length) db.sql.exec('VACUUM')
  return { deleted, failed }
}
