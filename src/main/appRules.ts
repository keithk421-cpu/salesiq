/**
 * Main-process decisions that don't need Electron (index.ts wires them up), so they can be tested:
 * app settings on load, the hide/show hotkey, when the window hides from screen sharing, and a
 * call's log files.
 */
import path from 'node:path'
import type { SessionState } from './session'
import { JsonlWriter } from './storage'

export interface AppSettings {
  /** Keep this window out of screen shares, recordings and screenshots during calls (Windows 10 2004 and later). */
  hide_from_capture: boolean
  /** Delete saved calls older than this many days; null (the default) keeps them. */
  retention_days: number | null
  /** Keith said yes to the first deletion preview; after that, old calls are deleted without asking. */
  retention_confirmed: boolean
  /** Which one-time fixes have been applied to the saved file. */
  settings_version?: number
}

export const DEFAULT_APP_SETTINGS: AppSettings = { hide_from_capture: true, retention_days: null, retention_confirmed: false }
export const RETENTION_CHOICES = [7, 14, 30, 90]
const SETTINGS_VERSION = 2

/**
 * Saved settings -> settings to use (changed: write them back). One-time fix: some earlier builds
 * saved a 30-day limit whenever any setting was changed; unless Keith confirmed deleting under it,
 * it goes back to keeping calls forever.
 */
export function loadAppSettings(saved: Partial<AppSettings>): { settings: AppSettings; changed: boolean } {
  const settings: AppSettings = {
    hide_from_capture: typeof saved.hide_from_capture === 'boolean' ? saved.hide_from_capture : DEFAULT_APP_SETTINGS.hide_from_capture,
    retention_days: RETENTION_CHOICES.includes(saved.retention_days as number) ? (saved.retention_days as number) : null,
    retention_confirmed: saved.retention_confirmed === true,
    settings_version: SETTINGS_VERSION,
  }
  const old = (saved.settings_version ?? 1) < SETTINGS_VERSION
  if (old && settings.retention_days === 30 && !settings.retention_confirmed) settings.retention_days = null
  return { settings, changed: old }
}

/** A call is going: waiting to go live, live, paused or finishing. */
export function callActive(state: SessionState | null | undefined): boolean {
  return state === 'checking' || state === 'live' || state === 'paused' || state === 'stopping'
}

/** Hidden from screen sharing only during a call, so a Setup screenshot for support just works. */
export function protectWindow(setting: boolean, state: SessionState | null | undefined): boolean {
  return setting && callActive(state)
}

/**
 * Hide/show hotkey. Windows can't tell us whether the window is behind Zoom, so the hotkey goes by
 * its own last action: the first press always shows; a press after it showed the window minimizes.
 */
export class HideToggle {
  private shown = false

  next(win: { minimized: boolean; visible: boolean }): 'show' | 'minimize' {
    if (win.minimized || !win.visible || !this.shown) {
      this.shown = true
      return 'show'
    }
    this.shown = false
    return 'minimize'
  }
}

/**
 * One call's diagnostics.jsonl and transcript.jsonl, opened on first use (lines logged before the
 * call has an id are kept for then). A deleted call's files are never opened again, so a late log
 * line (e.g. at quit) can't bring its folder back.
 */
export class CallLogs {
  private diag: JsonlWriter | null = null
  private turns: JsonlWriter | null = null
  private openFor: string | null = null
  private pre: Array<Record<string, unknown>> = []
  private readonly purged = new Set<string>()

  constructor(private readonly dirFor: (sessionId: string) => string) {}

  /** A new call is starting: close the last call's files. */
  begin(): void {
    this.close()
    this.pre = []
  }

  write(sessionId: string | null, event: string, data?: Record<string, unknown>): void {
    if (sessionId && this.purged.has(sessionId)) return
    if (!this.diag && sessionId) {
      const dir = this.dirFor(sessionId)
      this.diag = new JsonlWriter(path.join(dir, 'diagnostics.jsonl'))
      this.turns = new JsonlWriter(path.join(dir, 'transcript.jsonl'))
      this.openFor = sessionId
      for (const p of this.pre.splice(0)) this.diag.write(p)
    }
    if (this.diag) this.diag.write({ event, ...data })
    else this.pre.push({ event, ...data })
  }

  /** Transcript lines go to the open call only. */
  transcript(obj: Record<string, unknown>): void {
    this.turns?.write(obj)
  }

  /** These calls were deleted: close their files (Windows can't delete open ones) and never reopen them. */
  purge(ids: string[]): void {
    for (const id of ids) this.purged.add(id)
    if (this.openFor && ids.includes(this.openFor)) this.close()
  }

  close(): void {
    this.diag?.close()
    this.turns?.close()
    this.diag = null
    this.turns = null
    this.openFor = null
  }
}
