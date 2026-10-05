import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CallLogs, HideToggle, callActive, loadAppSettings, protectWindow } from '../src/main/appRules'

describe('app settings on load', () => {
  it('one-time fix: an unconfirmed 30-day limit saved by older builds goes back to keeping calls forever', () => {
    const r = loadAppSettings({ hide_from_capture: true, retention_days: 30, retention_confirmed: false })
    expect(r.settings.retention_days).toBeNull()
    expect(r.changed).toBe(true)
    // Saved with the fix applied, a 30-day limit Keith picks from now on stays.
    const again = loadAppSettings({ ...r.settings, retention_days: 30 })
    expect(again.settings.retention_days).toBe(30)
    expect(again.changed).toBe(false)
  })

  it('keeps a limit Keith confirmed, and other limits', () => {
    expect(loadAppSettings({ retention_days: 30, retention_confirmed: true }).settings).toMatchObject({ retention_days: 30, retention_confirmed: true })
    expect(loadAppSettings({ retention_days: 14, retention_confirmed: false }).settings.retention_days).toBe(14)
  })

  it('first launch and damaged files fall back to the defaults', () => {
    expect(loadAppSettings({}).settings).toMatchObject({ hide_from_capture: true, retention_days: null, retention_confirmed: false })
    expect(loadAppSettings({ hide_from_capture: 'yes', retention_days: 5 } as never).settings).toMatchObject({ hide_from_capture: true, retention_days: null })
  })
})

describe('hide/show hotkey', () => {
  it('the first press always shows, even when the window is merely behind Zoom; then it alternates', () => {
    const t = new HideToggle()
    const behindZoom = { minimized: false, visible: true }
    expect(t.next(behindZoom)).toBe('show')
    expect(t.next(behindZoom)).toBe('minimize')
    expect(t.next({ minimized: true, visible: true })).toBe('show')
    expect(t.next(behindZoom)).toBe('minimize')
    // Minimized some other way since: show it.
    expect(t.next({ minimized: true, visible: true })).toBe('show')
    expect(t.next({ minimized: true, visible: true })).toBe('show')
  })
})

describe('hidden from screen sharing only during a call', () => {
  it('protects the window while a call is going, never in Setup or after Stop', () => {
    for (const s of ['checking', 'live', 'paused', 'stopping'] as const) expect(protectWindow(true, s), s).toBe(true)
    for (const s of ['idle', 'stopped', undefined] as const) expect(protectWindow(true, s), String(s)).toBe(false)
    expect(protectWindow(false, 'live')).toBe(false)
    expect(callActive('paused')).toBe(true)
    expect(callActive('stopped')).toBe(false)
  })
})

describe("a call's log files", () => {
  const ID = 's-2026-10-05T12-00-00-000Z-abc123'

  it('opens them on first use, keeping lines logged before the call had an id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'))
    const dirFor = (id: string) => {
      const d = path.join(root, 'sessions', id)
      fs.mkdirSync(d, { recursive: true })
      return d
    }
    const logs = new CallLogs(dirFor)
    logs.begin()
    logs.write(null, 'start_requested')
    expect(fs.existsSync(path.join(root, 'sessions'))).toBe(false)
    logs.write(ID, 'session_created', { n: 1 })
    logs.transcript({ kind: 'turn', text: 'Hello there' })
    const diag = fs.readFileSync(path.join(root, 'sessions', ID, 'diagnostics.jsonl'), 'utf8')
    expect(diag).toMatch(/start_requested[\s\S]*session_created/)
    expect(fs.readFileSync(path.join(root, 'sessions', ID, 'transcript.jsonl'), 'utf8')).toContain('Hello there')
    logs.close()
  })

  it('never brings back the folder of a call that was deleted (e.g. the quit log line after "Delete all")', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'))
    const logs = new CallLogs((id) => {
      const d = path.join(root, 'sessions', id)
      fs.mkdirSync(d, { recursive: true })
      return d
    })
    logs.begin()
    logs.write(ID, 'state', { state: 'stopped' })
    logs.purge([ID])
    fs.rmSync(path.join(root, 'sessions', ID), { recursive: true, force: true })
    logs.write(ID, 'shutdown_now')
    logs.transcript({ kind: 'gap_close' })
    expect(fs.existsSync(path.join(root, 'sessions', ID))).toBe(false)
    logs.close()
  })
})
