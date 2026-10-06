/**
 * Electron main process for the M0 debug app.
 * Read-only toward Windows/Zoom audio settings. Local-only storage.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, powerMonitor, safeStorage, shell } from 'electron'
import WebSocket from 'ws'
import type { AudioEndpointConfig, BuildInfo } from '../shared/contracts'
import type { EndpointInfo, NativeAudioModule } from '../shared/nativeApi'
import type { WsFactory, WsLike } from './deepgram'
import { DeviceScanner } from './deviceTest'
import { resolveConfig, shortId, toEndpointRef } from './endpoints'
import { saveSupportFiles } from './support'
import { loadNative } from './native'
import { HELP_HOTKEY, HelpService } from './helpService'
import { IdleWatch } from './idleWatch'
import { CallLogs, DEFAULT_APP_SETTINGS, HideToggle, RETENTION_CHOICES, StartWait, callActive, loadAppSettings, protectWindow, type AppSettings, type AwayReason } from './appRules'
import { stripOnTop } from './appRules'
import { deleteCalls, listSavedCalls, olderThan } from './retention'
import { PAUSE_DETAIL, SessionController, type SessionEvent, type SessionState } from './session'
import { JsonlWriter, Storage } from './storage'
import { cleanLabel, isApiKeyInput, isEndpointId, isStream } from './validate'
import { screen } from 'electron'
import { defaultCompactRect, defaultNormalRect, placeFor, type Rect } from './compactWindow'
import { accountMemory, listAccounts } from './help/accountMemory'
import { accountKey } from '../shared/help'

let win: BrowserWindow | null = null
let native: NativeAudioModule
let demoMode = false
let nativeSource = ''
let storage: Storage
let appLog: JsonlWriter
let scanner: DeviceScanner
let session: SessionController | null = null
let callLogs: CallLogs
let help: HelpService | null = null
let idle: IdleWatch | null = null
let hideHotkeyRegistered = false
const hideToggle = new HideToggle()
/** Why the call was paused automatically, until it goes live again or ends. */
let autoPausedFor: AwayReason | null = null
/** Locking or sleep cancelled Start's wait: Keith sees why, not "Stopped by Keith". */
const startWait = new StartWait()

/**
 * Show/hide the window without taking focus from Zoom. Registering only fails if another program
 * registered the same keys system-wide; it can't see shortcuts apps like Zoom handle inside their own
 * windows, so this one is chosen from keys Zoom for Windows doesn't use (Ctrl+Alt+Shift+H is Zoom's
 * "show/hide floating meeting controls").
 */
const HIDE_HOTKEY = 'Control+Alt+J'
const HIDE_HOTKEY_LABEL = 'Ctrl+Alt+J'

let appSettings: AppSettings = { ...DEFAULT_APP_SETTINGS }

function saveAppSettings(): void {
  storage.writeJson('app-settings.json', appSettings)
}

/** Knowledge file names can name a customer; logs keep a short fingerprint instead. */
const docRef = (docId: string) => createHash('sha256').update(docId).digest('hex').slice(0, 8)
declare const __BUILD_INFO__: BuildInfo
/** Which build this is (tests and dev runs without the build script get a placeholder). */
export const BUILD: BuildInfo = typeof __BUILD_INFO__ === 'undefined' ? { version: app?.getVersion?.() ?? '0', build: 'dev', sha: 'dev', date: '' } : __BUILD_INFO__

const wsFactory: WsFactory = (url, headers) => new WebSocket(url, { headers }) as unknown as WsLike

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function log(event: string, data?: Record<string, unknown>): void {
  appLog?.write({ event, ...data })
}

function endpointsForUi(): Array<EndpointInfo & { shortId: string }> {
  return native.listEndpoints().map((e) => ({ ...e, shortId: shortId(e.id) }))
}

function snapshotDevices(label: string): string {
  const eps = native.listEndpoints()
  const snap = {
    label,
    taken_at: new Date().toISOString(),
    windows_defaults: {
      output_console: eps.find((e) => e.flow === 'render' && e.isDefaultConsole)?.friendlyName ?? null,
      output_communications: eps.find((e) => e.flow === 'render' && e.isDefaultCommunications)?.friendlyName ?? null,
      input_console: eps.find((e) => e.flow === 'capture' && e.isDefaultConsole)?.friendlyName ?? null,
      input_communications: eps.find((e) => e.flow === 'capture' && e.isDefaultCommunications)?.friendlyName ?? null,
    },
    endpoints: eps.map((e) => ({ id: e.id, flow: e.flow, name: e.friendlyName, state: e.state, formFactor: e.formFactor, defaultConsole: e.isDefaultConsole, defaultComms: e.isDefaultCommunications, mixFormat: e.mixFormat })),
  }
  const dir = path.join(storage.logsDir(), 'device-snapshots')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${snap.taken_at.replace(/[:.]/g, '-')}-${label.replace(/[^a-z0-9-]+/gi, '_')}.json`)
  fs.writeFileSync(file, JSON.stringify(snap, null, 2))
  log('device_snapshot', { label, file, defaults: snap.windows_defaults })
  return file
}

function onSessionEvent(ev: SessionEvent): void {
  send('session-event', startWait.shown(ev))
  const s = session
  if (help && s) help.onSessionEvent(ev, s.sessionId, () => s.nowSessionMs())
  watchIdle(ev)
  if (ev.type === 'state') onStateChange(ev.state)
  if (ev.type === 'turn' && ev.event.type === 'turn_final') callLogs.transcript({ kind: 'turn', ...ev.event.turn })
  if (ev.type === 'gap_open' || ev.type === 'gap_close') callLogs.transcript({ kind: ev.type, ...ev.gap })
  if (ev.type === 'state' && ev.state === 'stopped') {
    if (s && s.sessionId) {
      fs.writeFileSync(path.join(storage.sessionDir(s.sessionId), 'summary.json'), JSON.stringify({ sessionId: s.sessionId, endedAt: new Date().toISOString(), counters: s.counters }, null, 2))
    }
    // Skipped during the call; old calls (if Keith set a limit) are cleared now it's over, once
    // Stop itself has finished.
    setImmediate(runRetention)
  }
}

function onStateChange(state: SessionState): void {
  applyWindowSettings()
  compactOnTop(state)
  if (state === 'live' || state === 'idle' || state === 'stopped') {
    autoPausedFor = null
    win?.flashFrame(false)
  }
}

/**
 * Forgotten-call guard: fresh per call. The clock restarts on resume and whenever anyone on the call
 * finishes saying something, and doesn't run while a device is disconnected.
 */
function watchIdle(ev: SessionEvent): void {
  if (ev.type === 'state') {
    if (ev.state === 'checking') idle = new IdleWatch(() => Date.now())
    if (ev.state === 'live') clearIdleWarning()
    if (ev.state === 'stopped' || ev.state === 'idle') {
      clearIdleWarning()
      idle = null
    }
    return
  }
  const was = !!idle?.warning
  if (idle?.observe(ev) && was) hideIdleWarning()
}

function clearIdleWarning(): void {
  const was = idle?.warning
  idle?.reset()
  if (was) hideIdleWarning()
}

function hideIdleWarning(): void {
  send('idle', { warning: false })
  win?.flashFrame(false)
}

function checkIdle(): void {
  if (!idle || session?.state !== 'live') return
  const v = idle.tick()
  if (v === 'warn') {
    log('idle_warning')
    send('idle', { warning: true, seconds: 60 })
    // Up front (without taking Zoom's focus) and flashing, so Keith sees it even with the window hidden.
    showWithoutFocus()
    win?.flashFrame(true)
  } else if (v === 'pause') {
    // Pause, not stop: if Keith was on the call after all, Resume carries on with the same call.
    clearIdleWarning()
    const r = session.pause(PAUSE_DETAIL.nobodyHeard)
    log('idle_pause', { ok: r.ok })
    if (!r.ok) return
    showWithoutFocus()
    win?.flashFrame(true)
    send('app-notice', { level: 'warning', text: 'Paused: nothing was said on the call for over 10 minutes, and nobody answered "Still on a call?". Press Resume if the call is still going.' })
  }
}

/**
 * Locking the PC or sleep pauses a live call, so nothing is captured while Keith is away. While
 * Start is still waiting for the call, the wait is cancelled instead.
 */
function autoPause(why: AwayReason): void {
  if (session?.state === 'checking') {
    log('auto_cancel_start', { why })
    startWait.cancel(why)
    void session.stop()
    return
  }
  if (session?.state !== 'live') return
  const r = session.pause(PAUSE_DETAIL[why])
  log('auto_pause', { why, ok: r.ok })
  if (!r.ok) return
  autoPausedFor = why
  send('app-notice', { level: 'warning', text: `Paused because the PC ${why === 'lock' ? 'was locked' : 'went to sleep'}. Press Resume when you're back on the call.` })
}

/** Back at the PC after an automatic pause: bring the window up (Zoom keeps focus) and say how to carry on. */
function backAtPc(how: 'unlock' | 'wake'): void {
  if (session?.state !== 'paused' || !autoPausedFor) return
  log('back_at_pc', { how })
  showWithoutFocus()
  win?.flashFrame(true)
  send('app-notice', { level: 'warning', text: `Still paused since the PC ${autoPausedFor === 'lock' ? 'was locked' : 'went to sleep'}. Press Resume to carry on listening.` })
}

/** The call that is running (or waiting to start), which is never deleted. */
function activeCallId(): string | null {
  return session && !['idle', 'stopped'].includes(session.state) ? session.sessionId : null
}

function dueForDeletion() {
  if (appSettings.retention_days === null) return []
  return olderThan(listSavedCalls(storage.root, help?.db ?? null), appSettings.retention_days).filter((c) => c.id !== activeCallId())
}

function purgeCalls(ids: string[], why: string): { deleted: number; failed: number } {
  // The last call's files stay open until the next Start: close them so Windows lets them go, and
  // never reopen them (a log line at quit would otherwise bring the folder back).
  callLogs.purge(ids)
  for (const id of ids) help?.forgetCall(id)
  const r = deleteCalls(storage.root, help?.db ?? null, ids)
  // Account memory: HELP and the "Last time" box stop showing what was just deleted.
  help?.refreshEarlierCalls()
  send('calls-deleted', { deleted: r.deleted })
  log('calls_deleted', { why, ...r })
  return r
}

/** Old calls: the first time any are due, show them and ask; once Keith agrees, delete without asking. */
function runRetention(): void {
  // Never during a call: the preview would cover HELP and compacting the database holds up the app.
  // It runs again when the call stops. Without the database (HELP didn't start) it can't delete fully.
  if (callActive(session?.state) || !help) return
  try {
    const due = dueForDeletion()
    if (!due.length) return
    if (!appSettings.retention_confirmed) {
      send('retention-preview', { days: appSettings.retention_days, calls: due.map((c) => ({ started_at: c.started_at, account: c.account })) })
      return
    }
    purgeCalls(due.map((c) => c.id), 'retention')
  } catch (err) {
    // E.g. the database is busy. Clean-up never takes down Stop, Settings or the app; it tries again later.
    log('retention_failed', { message: (err as Error).message })
  }
}

function callsInfo() {
  const calls = listSavedCalls(storage.root, help?.db ?? null)
  return { count: calls.length, oldest: calls[0]?.started_at ?? null, retention_days: appSettings.retention_days, choices: RETENTION_CHOICES }
}

/** Hidden from screen sharing only during a call (when the setting is on); Setup screenshots just work. */
function applyWindowSettings(): void {
  if (!win || win.isDestroyed()) return
  win.setContentProtection(protectWindow(appSettings.hide_from_capture, session?.state))
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    demoMode, nativeSource, platform: process.platform, version: app.getVersion(),
    userData: app.getPath('userData'), hasApiKey: !!storage.loadApiKey(), settings: appSettings,
    hideHotkey: hideHotkeyRegistered ? HIDE_HOTKEY_LABEL : null,
  }))
  ipcMain.handle('app:setSettings', (_e, raw: unknown) => {
    const r = (raw ?? {}) as Record<string, unknown>
    if (typeof r.hide_from_capture === 'boolean') appSettings.hide_from_capture = r.hide_from_capture
    let limitChanged = false
    if (r.retention_days === null || RETENTION_CHOICES.includes(r.retention_days as number)) {
      // A new limit is shown and confirmed again before anything is deleted under it.
      limitChanged = r.retention_days !== appSettings.retention_days
      if (limitChanged) appSettings.retention_confirmed = false
      appSettings.retention_days = r.retention_days as number | null
    }
    saveAppSettings()
    applyWindowSettings()
    log('app_settings', { ...appSettings })
    if (limitChanged) runRetention()
    return appSettings
  })
  ipcMain.handle('calls:info', () => callsInfo())
  ipcMain.handle('calls:confirmRetention', (_e, yes: unknown) => {
    if (yes !== true) {
      log('retention_declined')
      return { ok: true, deleted: 0 }
    }
    appSettings.retention_confirmed = true
    saveAppSettings()
    return { ok: true, ...purgeCalls(dueForDeletion().map((c) => c.id), 'retention') }
  })
  ipcMain.handle('calls:deleteAll', () => {
    // Without the database only the folders could go, and the calls' text would stay in it.
    if (!help) {
      log('calls_delete_all_no_db')
      return { ok: false, deleted: 0, failed: 0, error: "Couldn't delete saved calls: the call database didn't open when the app started. Close the app, open it again and try again." }
    }
    const ids = listSavedCalls(storage.root, help.db).map((c) => c.id).filter((id) => id !== activeCallId())
    const r = purgeCalls(ids, 'keith_all')
    return { ok: r.failed === 0, ...r }
  })

  ipcMain.handle('devices:list', () => endpointsForUi())

  ipcMain.handle('devices:config', () => {
    const config = storage.loadConfig()
    if (!config) return { config: null, resolved: null }
    return { config, resolved: resolveConfig(config, native.listEndpoints()) }
  })

  const sessionBusy = () => !!session && !['idle', 'stopped'].includes(session.state)

  ipcMain.handle('devices:find', () => {
    if (sessionBusy()) return { ok: false, error: 'Stop the session before scanning devices.' }
    return scanner.find()
  })

  ipcMain.handle('devices:test', (_e, systemId: unknown, micId: unknown) => {
    if (!isEndpointId(systemId) || !isEndpointId(micId)) return { ok: false, error: 'Invalid device.' }
    if (sessionBusy()) return { ok: false, error: 'Stop the session before testing devices.' }
    return scanner.test(systemId, micId)
  })

  ipcMain.handle('devices:stopScan', () => {
    scanner.stop()
    return { ok: true }
  })

  ipcMain.handle('devices:save', (_e, systemId: unknown, micId: unknown) => {
    if (!isEndpointId(systemId) || !isEndpointId(micId)) return { ok: false, error: 'Invalid device.' }
    if (!scanner.passedFor(systemId, micId)) return { ok: false, error: 'These two devices have not both been heard yet. Play Zoom\'s Test Speaker and talk, then try again.' }
    const eps = native.listEndpoints()
    const sys = eps.find((e) => e.id === systemId)
    const mic = eps.find((e) => e.id === micId)
    if (!sys || sys.flow !== 'render' || !mic || mic.flow !== 'capture') return { ok: false, error: 'Devices changed; refresh and test again.' }
    const now = new Date().toISOString()
    const config: AudioEndpointConfig = {
      config_id: randomUUID(),
      system_output: toEndpointRef(sys),
      microphone: toEndpointRef(mic),
      confirmed_at: now,
      confirmed_by_test: true,
      last_verified_at: now,
    }
    storage.saveConfig(config)
    scanner.stop()
    log('devices_saved', { system: systemId, mic: micId })
    return { ok: true, config }
  })

  ipcMain.handle('devices:snapshot', (_e, label: unknown) => ({ ok: true, file: snapshotDevices(cleanLabel(label)) }))

  ipcMain.handle('key:set', (_e, key: unknown) => {
    if (!isApiKeyInput(key)) return { ok: false, error: 'That does not look like a Deepgram key.' }
    try {
      storage.saveApiKey(key)
      log('api_key_saved')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('session:start', async () => {
    if (session && ['checking', 'live', 'paused', 'stopping'].includes(session.state)) return { ok: false, reason: 'A session is already running.' }
    scanner.stop()
    const config = storage.loadConfig()
    if (!config) return { ok: false, reason: 'Pick, test and save your devices first.' }
    // Unticked for a screenshot last time? Hidden from screen sharing again for this call.
    if (!appSettings.hide_from_capture) {
      appSettings.hide_from_capture = true
      saveAppSettings()
      log('hide_from_capture_back_on')
      send('app-settings', appSettings)
    }
    callLogs.begin()
    startWait.begin()
    session = new SessionController({
      native,
      wsFactory,
      apiKey: storage.loadApiKey(),
      config,
      emit: onSessionEvent,
      log: (event, data) => {
        callLogs.write(session?.sessionId ?? null, event, data)
        log(`session.${event}`, event === 'alert' || event === 'state' || event.startsWith('gap') || event.startsWith('start') ? data : undefined)
      },
    })
    const done = startWait.finish(await session.start())
    if (done.result.ok) {
      config.last_verified_at = new Date().toISOString()
      storage.saveConfig(config)
    }
    // Locked (or asleep) just as the call went live: pause it like any call on a locked PC.
    if (done.pauseFor) autoPause(done.pauseFor)
    return done.result
  })

  ipcMain.handle('session:pause', () => session?.pause() ?? { ok: false, reason: 'No session' })
  ipcMain.handle('session:resume', () => session?.resume() ?? { ok: false, reason: 'No session' })
  ipcMain.handle('session:stop', async () => {
    await session?.stop()
    return { ok: true }
  })
  ipcMain.handle('session:stillHere', () => {
    log('idle_still_here')
    clearIdleWarning()
    return { ok: true }
  })
  ipcMain.handle('session:switchEndpoint', async (_e, stream: unknown, endpointId: unknown) => {
    if (!isStream(stream) || !isEndpointId(endpointId)) return { ok: false, reason: 'Invalid request' }
    if (!session) return { ok: false, reason: 'No session' }
    const ep = native.listEndpoints().find((e) => e.id === endpointId)
    if (!ep) return { ok: false, reason: 'Device not found' }
    return session.switchEndpoint(stream, ep)
  })

  ipcMain.handle('app:openFolder', () => shell.openPath(app.getPath('userData')))
  ipcMain.handle('app:build', () => BUILD)
  ipcMain.handle('app:supportFiles', () => {
    try {
      const out = saveSupportFiles(storage.root, app.getPath('downloads'))
      log('support_files_saved', { files: out.files.length, skipped: out.skipped.length })
      shell.showItemInFolder(path.join(out.dir, 'README.txt'))
      return { ok: true, dir: out.dir, files: out.files.length, skipped: out.skipped.length }
    } catch (err) {
      log('support_files_failed', { error: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return { ok: false, error: (err as Error).message }
    }
  })

  // ---- M1 HELP ----
  ipcMain.handle('help:info', () => help?.info() ?? null)
  ipcMain.handle('help:checkReady', () => help?.checkReady() ?? null)
  ipcMain.handle('help:press', () => help?.press() ?? { ok: false, reason: 'HELP unavailable' })
  ipcMain.handle('help:feedback', (_e, raw: unknown) => help?.feedback(raw) ?? { ok: false })
  ipcMain.handle('help:callCards', () => help?.callCards() ?? [])
  ipcMain.handle('help:setSettings', (_e, raw: unknown) => help?.setSettings((raw ?? {}) as Record<string, never>))
  ipcMain.handle('help:setSetup', (_e, raw: unknown) => help?.setSetup(raw))
  ipcMain.handle('help:setLabel', (_e, raw: unknown) => help?.setLabel(raw) ?? { ok: false })
  ipcMain.handle('help:labels', () => help?.labels() ?? [])
  ipcMain.handle('help:callNotes', () => help?.callNotes() ?? null)
  ipcMain.handle('help:setKey', (_e, key: unknown) => {
    if (typeof key !== 'string' || !/^sk-ant-[\x21-\x7e]{20,300}$/.test(key.trim())) return { ok: false, error: 'That does not look like an Anthropic API key (starts with sk-ant-).' }
    try {
      storage.saveSecret('anthropic', key)
      log('anthropic_key_saved')
      void help?.checkReady()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('knowledge:list', () => help?.kb.listDocs() ?? [])
  ipcMain.handle('knowledge:reindex', () => help?.reindexKnowledge() ?? [])
  ipcMain.handle('knowledge:approve', (_e, docId: unknown, approved: unknown) => {
    if (!help || typeof docId !== 'string' || typeof approved !== 'boolean') return { ok: false }
    help.kb.approve(docId, approved)
    log('knowledge_approval', { doc: docRef(docId), approved })
    return { ok: true, docs: help.kb.listDocs() }
  })
  ipcMain.handle('knowledge:openFolder', async () => {
    if (!help) return { ok: false, error: 'HELP did not start, so the knowledge folder is unavailable. Send the app log.' }
    const error = await shell.openPath(help.knowledgeDir)
    if (error) shell.showItemInFolder(path.join(help.knowledgeDir, 'README.md'))
    return { ok: !error, path: help.knowledgeDir, error }
  })
  ipcMain.handle('knowledge:import', async (_e, mode: unknown) => {
    if (!help || !win) return { ok: false, error: 'HELP did not start. Send the app log.' }
    const folder = mode === 'folder'
    const r = await dialog.showOpenDialog(win, folder
      ? { title: 'Choose the folder with your knowledge files (for a review pack, the unzipped pack folder)', properties: ['openDirectory'] }
      : { title: 'Choose knowledge files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Knowledge files', extensions: ['md', 'txt'] }] })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    try {
      return { ok: true, ...help.importKnowledge(r.filePaths, folder) }
    } catch (err) {
      log('knowledge_import_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('knowledge:remove', (_e, docId: unknown) => {
    if (!help || typeof docId !== 'string') return { ok: false }
    return help.removeKnowledge(docId)
  })
  ipcMain.handle('playbook:open', () => (help ? shell.openPath(help.playbookPath()) : ''))
  ipcMain.handle('playbook:info', () => help?.reloadPlaybook() ?? null)
  ipcMain.handle('playbook:useBuiltIn', () => help?.useBuiltInPlaybook() ?? null)
  ipcMain.handle('playbook:keepMine', () => help?.keepMyPlaybook() ?? null)
  ipcMain.handle('help:benchmark', async (_e, raw: unknown) =>
    help ? help.runBenchmark(raw, (p) => send('benchmark-progress', p)) : { ok: false, reason: 'HELP unavailable' })
  ipcMain.handle('help:openReport', (_e, file: unknown) =>
    typeof file === 'string' && help && file.startsWith(path.join(app.getPath('userData'), 'reports')) ? shell.openPath(file) : '')
  // ---- practice moments from real calls (data folder only) and the HELP feedback export (Downloads) ----
  ipcMain.handle('help:saveMoment', (_e, cardId: unknown) => help?.saveMoment(cardId) ?? { ok: false, reason: 'HELP unavailable' })
  ipcMain.handle('practice:info', () => help?.practiceInfo() ?? { count: 0, saved: [] })
  ipcMain.handle('practice:openFolder', async () => {
    if (!help) return { ok: false, error: 'HELP did not start. Send the app log.' }
    fs.mkdirSync(help.practiceDir, { recursive: true })
    const error = await shell.openPath(help.practiceDir)
    return { ok: !error, error }
  })
  ipcMain.handle('help:exportFeedback', (_e, period: unknown) => {
    if (!help) return { ok: false, reason: 'HELP unavailable' }
    const r = help.exportFeedback(period, app.getPath('downloads'))
    if (r.ok && r.file) shell.showItemInFolder(r.file)
    return r
  })
  // ---- M2: WRAP button ("before you hang up") and the compact window ----
  ipcMain.handle('help:wrap', () => help?.press('wrap_requested') ?? { ok: false, reason: 'WRAP unavailable' })
  ipcMain.handle('window:compact', (_e, on: unknown) => setCompact(on === true))
  // ---- M3: the card shows what it heard (listening blind: sound on the meeting audio, no words back yet) ----
  if (help) help.listeningBlindMs = () => (session?.state === 'live' ? session.untranscribedMs('system_remote') : 0)
  // ---- account memory: "Last time with <account>" (read only, from saved calls; the running call is left out) ----
  ipcMain.handle('memory:accounts', () => (help ? listAccounts(help.db, activeCallId()) : []))
  ipcMain.handle('memory:account', (_e, account: unknown) => {
    if (!help || typeof account !== 'string' || account.length > 120 || !accountKey(account)) return null
    return accountMemory(help.db, account, activeCallId())
  })
  // ---- M3 call plan: the setup strip's "Must learn" box (at most 3 short items, checked in HelpService) ----
  ipcMain.handle('help:setMustLearn', (_e, raw: unknown) => help?.setMustLearn(raw) ?? null)
  // × on a wrap-up "Still to learn" item (the item's text, checked against the list in WrapupKeeper)
  ipcMain.handle('wrapup:removeToLearn', (_e, raw: unknown) => help?.removeWrapupToLearn(raw) ?? { ok: false, wrapup: null })
  // ---- M2 wrap-up after Stop and the follow-up draft (a draft Keith copies; nothing is sent) ----
  // Every input is checked in HelpService / WrapupKeeper (item id, state, text length, section).
  if (help) help.onWrapup = (w) => send('wrapup', w)
  ipcMain.handle('wrapup:get', () => help?.wrapup() ?? null)
  ipcMain.handle('wrapup:updateItem', (_e, raw: unknown) => help?.updateWrapupItem(raw) ?? { ok: false, wrapup: null })
  ipcMain.handle('wrapup:addItem', (_e, raw: unknown) => help?.addWrapupItem(raw) ?? { ok: false, wrapup: null })
  ipcMain.handle('wrapup:draft', () => (help ? help.draftFollowup() : { ok: false, reason: 'HELP unavailable', wrapup: null }))
  ipcMain.handle('wrapup:retry', () => (help ? help.retryWrapup() : { ok: false, wrapup: null }))
  // ---- M3 smarter presses: the latest buying signal of the call, a quiet tag on the WRAP button ----
  if (help) help.onSignal = (s) => send('buying-signal', s)
  ipcMain.handle('help:signal', () => help?.signal ?? null)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 900,
    title: demoMode ? 'Sales Copilot M0 (DEMO - not Windows)' : 'Sales Copilot M0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  applyWindowSettings()
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

/** Bring the window up without taking focus from Zoom (so Keith keeps typing/talking there). */
function showWithoutFocus(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized() || !win.isVisible()) win.showInactive()
  win.moveTop()
  // Up on top now, so the next hide/show press tucks it away.
  hideToggle.markShown()
}

function tryRegister(accelerator: string, fn: () => void): boolean {
  try {
    return globalShortcut.register(accelerator, fn) && globalShortcut.isRegistered(accelerator)
  } catch {
    return false
  }
}

/** Ctrl+Alt+H and Ctrl+Alt+J: only if Windows lets us register them. The buttons always work. */
function registerHotkey(): void {
  hideHotkeyRegistered = tryRegister(HIDE_HOTKEY, () => {
    if (!win || win.isDestroyed()) return
    // A window behind Zoom still counts as visible, so the hotkey goes by what it did last time.
    if (hideToggle.next({ minimized: win.isMinimized(), visible: win.isVisible() }) === 'show') showWithoutFocus()
    else win.minimize()
  })
  log('hide_hotkey', { hotkey: HIDE_HOTKEY, registered: hideHotkeyRegistered })
  if (!help) return
  const ok = tryRegister(HELP_HOTKEY, () => {
    const r = help?.press()
    // Up either way: the card is coming, or the reason it can't (e.g. paused) needs to be seen.
    showWithoutFocus()
    if (r && !r.ok) send('help-notice', r.reason)
    else send('help-focus', null)
  })
  help.hotkeyRegistered = ok
  log('help_hotkey', { hotkey: HELP_HOTKEY, registered: ok })
}

// ---- M2: WRAP hotkey and the compact window ----
const WRAP_HOTKEY = 'Control+Alt+W'
/** The window is the small strip, on top of Zoom during a call (it starts in normal mode every time the app opens). */
let compact = false

/** Ctrl+Alt+W: a WRAP card, like Ctrl+Alt+H for HELP. Only if Windows lets us register it; the button always works. */
function registerWrapHotkey(): void {
  if (!help) return
  const ok = tryRegister(WRAP_HOTKEY, () => {
    const r = help?.press('wrap_requested')
    showWithoutFocus()
    if (r && !r.ok) send('help-notice', r.reason)
    else send('help-focus', null)
  })
  help.wrapHotkeyRegistered = ok
  log('wrap_hotkey', { hotkey: WRAP_HOTKEY, registered: ok })
}

function workAreas(): Rect[] {
  return screen.getAllDisplays().map((d) => d.workArea)
}

/** Remember where the window is in the mode it's in now (its place before any maximize or minimize). */
function rememberBounds(): void {
  if (!win || win.isDestroyed()) return
  const b = win.getNormalBounds()
  appSettings.window_bounds = { ...appSettings.window_bounds, [compact ? 'compact' : 'normal']: b }
  saveAppSettings()
}

/** Compact: the small strip, on top of Zoom. Expand: back where it was. Same window, so hiding from screen sharing is unchanged. */
function setCompact(on: boolean): { compact: boolean } {
  if (!win || win.isDestroyed() || on === compact) return { compact }
  rememberBounds()
  compact = on
  if (on) {
    if (win.isFullScreen()) win.setFullScreen(false)
    if (win.isMaximized()) win.unmaximize()
    const place = placeFor(appSettings.window_bounds?.compact, workAreas(), defaultCompactRect(screen.getDisplayMatching(win.getBounds()).workArea))
    if (place) win.setBounds(place)
    compactOnTop(session?.state)
  } else {
    win.setAlwaysOnTop(false)
    // No remembered place still on a screen (a monitor unplugged meanwhile): the usual size, centred.
    const place = placeFor(appSettings.window_bounds?.normal, workAreas(), defaultNormalRect(screen.getDisplayMatching(win.getBounds()).workArea))
    if (place) win.setBounds(place)
  }
  log('window_compact', { compact })
  return { compact }
}

/** On top of Zoom only while compact during a call (appRules stripOnTop). */
function compactOnTop(state: SessionState | null | undefined): void {
  if (!win || win.isDestroyed()) return
  if (stripOnTop(compact, state)) win.setAlwaysOnTop(true, 'floating')
  else if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false)
}

/** At start: normal mode, where the window was last time (if that's still on a screen); remember it on close. */
function initCompactWindow(): void {
  if (!win || win.isDestroyed()) return
  const place = placeFor(appSettings.window_bounds?.normal, workAreas(), null)
  if (place) win.setBounds(place)
  win.on('close', () => rememberBounds())
}

function shutdownCapture(reason: string): void {
  try {
    scanner?.stop()
    session?.shutdownNow()
    native?.stopAll()
    help?.engine?.cancelAll('shutdown')
    log('capture_shutdown', { reason })
  } catch {
    /* best effort */
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    storage = new Storage(app.getPath('userData'), safeStorage)
    appLog = new JsonlWriter(path.join(storage.logsDir(), 'app.jsonl'))
    try {
      const loaded = loadNative({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
      native = loaded.module
      demoMode = loaded.demo
      nativeSource = loaded.source
    } catch (err) {
      dialog.showErrorBox('Audio module missing', (err as Error).message)
      app.quit()
      return
    }
    // The module's file name only: its full path includes the Windows user name.
    log('app_start', { version: app.getVersion(), build: BUILD.build, sha: BUILD.sha, built: BUILD.date, demoMode, nativeSource: path.basename(nativeSource), platform: process.platform })
    const loadedSettings = loadAppSettings(storage.readJson<Partial<AppSettings>>('app-settings.json', {}))
    appSettings = loadedSettings.settings
    if (loadedSettings.changed) {
      saveAppSettings()
      log('app_settings_updated', { retention_days: appSettings.retention_days })
    }
    callLogs = new CallLogs((id) => storage.sessionDir(id))
    scanner = new DeviceScanner(native, (e) => send('scan-event', e), log)
    try {
      help = new HelpService(storage, app.getAppPath(), (e) => send('help-event', e), log)
    } catch (err) {
      log('help_init_failed', { message: (err as Error).message })
    }
    if (help) help.onReadiness = (r) => send('help-ready', r)
    if (help) help.onNotes = (s) => send('call-notes', s)
    registerIpc()
    createWindow()
    initCompactWindow()
    registerHotkey()
    registerWrapHotkey()
    void help?.checkReady()
    powerMonitor.on('lock-screen', () => autoPause('lock'))
    powerMonitor.on('suspend', () => autoPause('sleep'))
    powerMonitor.on('unlock-screen', () => backAtPc('unlock'))
    powerMonitor.on('resume', () => backAtPc('wake'))
    setInterval(checkIdle, 5000)
    win?.webContents.once('did-finish-load', () => runRetention())
    setInterval(runRetention, 6 * 3_600_000)
  })

  app.on('before-quit', () => shutdownCapture('before-quit'))
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    help?.shutdown()
  })
  app.on('window-all-closed', () => {
    shutdownCapture('window-all-closed')
    app.quit()
  })
  process.on('exit', () => shutdownCapture('process-exit'))
}
