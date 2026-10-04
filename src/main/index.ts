/**
 * Electron main process for the M0 debug app.
 * Read-only toward Windows/Zoom audio settings. Local-only storage.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage, shell } from 'electron'
import WebSocket from 'ws'
import type { AudioEndpointConfig } from '../shared/contracts'
import type { EndpointInfo, NativeAudioModule } from '../shared/nativeApi'
import type { WsFactory, WsLike } from './deepgram'
import { DeviceScanner } from './deviceTest'
import { resolveConfig, shortId, toEndpointRef } from './endpoints'
import { loadNative } from './native'
import { HELP_HOTKEY, HelpService } from './helpService'
import { SessionController, type SessionEvent } from './session'
import { JsonlWriter, Storage } from './storage'
import { cleanLabel, isApiKeyInput, isEndpointId, isStream } from './validate'

let win: BrowserWindow | null = null
let native: NativeAudioModule
let demoMode = false
let nativeSource = ''
let storage: Storage
let appLog: JsonlWriter
let scanner: DeviceScanner
let session: SessionController | null = null
let sessionLog: JsonlWriter | null = null
let transcriptLog: JsonlWriter | null = null
let help: HelpService | null = null

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
  send('session-event', ev)
  const s = session
  if (help && s) help.onSessionEvent(ev, s.sessionId, () => s.nowSessionMs())
  if (!transcriptLog) return
  if (ev.type === 'turn' && ev.event.type === 'turn_final') transcriptLog.write({ kind: 'turn', ...ev.event.turn })
  if (ev.type === 'gap_open' || ev.type === 'gap_close') transcriptLog.write({ kind: ev.type, ...ev.gap })
  if (ev.type === 'state' && ev.state === 'stopped') {
    const s = session
    if (s && s.sessionId) {
      fs.writeFileSync(path.join(storage.sessionDir(s.sessionId), 'summary.json'), JSON.stringify({ sessionId: s.sessionId, endedAt: new Date().toISOString(), counters: s.counters }, null, 2))
    }
  }
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    demoMode, nativeSource, platform: process.platform, version: app.getVersion(),
    userData: app.getPath('userData'), hasApiKey: !!storage.loadApiKey(),
  }))

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
    sessionLog?.close()
    transcriptLog?.close()
    sessionLog = null
    transcriptLog = null
    const pre: Array<{ event: string; data?: Record<string, unknown> }> = []
    session = new SessionController({
      native,
      wsFactory,
      apiKey: storage.loadApiKey(),
      config,
      emit: onSessionEvent,
      log: (event, data) => {
        if (!sessionLog && session?.sessionId) {
          const dir = storage.sessionDir(session.sessionId)
          sessionLog = new JsonlWriter(path.join(dir, 'diagnostics.jsonl'))
          transcriptLog = new JsonlWriter(path.join(dir, 'transcript.jsonl'))
          for (const p of pre.splice(0)) sessionLog.write({ event: p.event, ...p.data })
        }
        if (sessionLog) sessionLog.write({ event, ...data })
        else pre.push({ event, data })
        log(`session.${event}`, event === 'alert' || event === 'state' || event.startsWith('gap') || event.startsWith('start') ? data : undefined)
      },
    })
    const r = await session.start()
    if (r.ok) {
      config.last_verified_at = new Date().toISOString()
      storage.saveConfig(config)
    }
    return r
  })

  ipcMain.handle('session:pause', () => session?.pause() ?? { ok: false, reason: 'No session' })
  ipcMain.handle('session:resume', () => session?.resume() ?? { ok: false, reason: 'No session' })
  ipcMain.handle('session:stop', async () => {
    await session?.stop()
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

  // ---- M1 HELP ----
  ipcMain.handle('help:info', () => help?.info() ?? null)
  ipcMain.handle('help:press', () => help?.press() ?? { ok: false, reason: 'HELP unavailable' })
  ipcMain.handle('help:feedback', (_e, raw: unknown) => help?.feedback(raw) ?? { ok: false })
  ipcMain.handle('help:setSettings', (_e, raw: unknown) => help?.setSettings((raw ?? {}) as Record<string, never>))
  ipcMain.handle('help:setSetup', (_e, raw: unknown) => help?.setSetup(raw))
  ipcMain.handle('help:setLabel', (_e, raw: unknown) => help?.setLabel(raw) ?? { ok: false })
  ipcMain.handle('help:labels', () => help?.labels() ?? [])
  ipcMain.handle('help:setKey', (_e, key: unknown) => {
    if (typeof key !== 'string' || !/^sk-ant-[\x21-\x7e]{20,300}$/.test(key.trim())) return { ok: false, error: 'That does not look like an Anthropic API key (starts with sk-ant-).' }
    try {
      storage.saveSecret('anthropic', key)
      log('anthropic_key_saved')
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
    log('knowledge_approval', { doc_id: docId, approved })
    return { ok: true, docs: help.kb.listDocs() }
  })
  ipcMain.handle('knowledge:openFolder', () => (help ? shell.openPath(help.knowledgeDir) : ''))
  ipcMain.handle('playbook:open', () => (help ? shell.openPath(help.playbookPath()) : ''))
  ipcMain.handle('help:benchmark', async (_e, raw: unknown) =>
    help ? help.runBenchmark(raw, (p) => send('benchmark-progress', p)) : { ok: false, reason: 'HELP unavailable' })
  ipcMain.handle('help:openReport', (_e, file: unknown) =>
    typeof file === 'string' && help && file.startsWith(path.join(app.getPath('userData'), 'reports')) ? shell.openPath(file) : '')
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
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

/** Ctrl+Alt+H: only if it registers without a conflict. The HELP button always works. */
function registerHotkey(): void {
  if (!help) return
  let ok = false
  try {
    ok = globalShortcut.register(HELP_HOTKEY, () => {
      const r = help?.press()
      if (r && !r.ok) send('help-notice', r.reason)
    }) && globalShortcut.isRegistered(HELP_HOTKEY)
  } catch {
    ok = false
  }
  help.hotkeyRegistered = ok
  log('help_hotkey', { hotkey: HELP_HOTKEY, registered: ok })
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
    log('app_start', { version: app.getVersion(), demoMode, nativeSource, platform: process.platform })
    scanner = new DeviceScanner(native, (e) => send('scan-event', e), log)
    try {
      help = new HelpService(storage, app.getAppPath(), (e) => send('help-event', e), log)
    } catch (err) {
      log('help_init_failed', { message: (err as Error).message })
    }
    registerIpc()
    createWindow()
    registerHotkey()
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
