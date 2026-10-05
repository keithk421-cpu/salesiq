/**
 * Main-process decisions that don't need Electron (index.ts wires them up), so they can be tested:
 * app settings on load, the hide/show hotkey, when the window hides from screen sharing, a Start
 * wait cancelled by locking the PC, and a call's log files.
 */
import path from 'node:path'
import type { SessionEvent, SessionState } from './session'
import { JsonlWriter } from './storage'
import { cleanBounds, type WindowBounds } from './compactWindow'

export interface AppSettings {
  /** Keep this window out of screen shares, recordings and screenshots during calls (Windows 10 2004 and later). */
  hide_from_capture: boolean
  /** Delete saved calls older than this many days; null (the default) keeps them. */
  retention_days: number | null
  /** Keith said yes to the first deletion preview; after that, old calls are deleted without asking. */
  retention_confirmed: boolean
  /** Which one-time fixes have been applied to the saved file. */
  settings_version?: number
  /** Where the window was last time, normal and compact (M2 compact window). */
  window_bounds?: WindowBounds
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
  const bounds = cleanBounds(saved.window_bounds)
  if (bounds) settings.window_bounds = bounds
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
 * The compact strip stays on top of Zoom only during a call, when it is also hidden from screen
 * sharing (if that's on). Between calls it would sit on top of a shared screen with the last call's card.
 */
export function stripOnTop(compact: boolean, state: SessionState | null | undefined): boolean {
  return compact && callActive(state)
}

/**
 * Hide/show hotkey. Windows can't tell us whether the window is behind Zoom, so the hotkey goes by
 * the last time the window was brought up or tucked away: the first press always shows; a press
 * after the window was brought up (by the hotkey or by the app itself) minimizes.
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

  /** The app brought the window up itself (Ctrl+Alt+H, "Still on a call?", after unlocking). */
  markShown(): void {
    this.shown = true
  }
}

export type AwayReason = 'lock' | 'sleep'

/** Shown when locking the PC or sleep cancelled Start's wait for the call. */
export function startCancelText(why: AwayReason): string {
  return `Stopped waiting for the call because the PC ${why === 'lock' ? 'was locked' : 'went to sleep'}. Press Start when you're back.`
}

/**
 * Locking the PC or sleep while Start waits for the call cancels the wait, which the session
 * reports as "Stopped by Keith". This keeps the real reason for Keith to see, both on the session's
 * own 'idle' event and in Start's result (the banner he sees last). If the call went live in the
 * same moment, Start's caller pauses it like any call on a locked PC.
 */
export class StartWait {
  private cancelledFor: AwayReason | null = null

  /** A new Start: nothing cancelled yet. */
  begin(): void {
    this.cancelledFor = null
  }

  /** Just before the session is told to stop waiting. */
  cancel(why: AwayReason): void {
    this.cancelledFor = why
  }

  /** A session event as Keith should see it. */
  shown(ev: SessionEvent): SessionEvent {
    if (!this.cancelledFor || ev.type !== 'state' || ev.state !== 'idle') return ev
    return { ...ev, detail: startCancelText(this.cancelledFor) }
  }

  /** Start has finished: its result as Keith should see it, and whether the call that went live needs pausing. */
  finish(r: { ok: boolean; reason?: string }): { result: { ok: boolean; reason?: string }; pauseFor: AwayReason | null } {
    const why = this.cancelledFor
    this.cancelledFor = null
    if (!why) return { result: r, pauseFor: null }
    if (!r.ok) return { result: { ok: false, reason: startCancelText(why) }, pauseFor: null }
    return { result: r, pauseFor: why }
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
