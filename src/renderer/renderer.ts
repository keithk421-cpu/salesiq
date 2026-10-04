import type { CopilotApi } from '../preload/preload'
import type { GapRecord, Turn } from '../shared/contracts'
import type { EndpointInfo } from '../shared/nativeApi'
import type { DeviceTestEvent } from '../main/deviceTest'
import type { SessionEvent, StreamStatusEvent } from '../main/session'
import { speakerLabel } from '../main/turnBuilder'

declare global {
  interface Window { copilot: CopilotApi }
}

type UiEndpoint = EndpointInfo & { shortId: string }
const api = window.copilot
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

let devices: UiEndpoint[] = []
let sessionState = 'idle'
let liveSince: number | null = null
let elapsedOffset = 0
const turns = new Map<string, Turn>()
const gaps = new Map<string, GapRecord>()
const supp: Array<{ at: number; text: string }> = []
const statuses: Record<string, StreamStatusEvent> = {}
let lastLossStream: string | null = null

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '…'
  const s = Math.max(0, ms) / 1000
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

function pct(db: number): number {
  return Math.max(0, Math.min(100, ((db + 70) / 70) * 100))
}

function optionLabel(e: UiEndpoint): string {
  const def = e.isDefaultConsole || e.isDefaultCommunications ? ' · Windows default' : ''
  const st = e.state === 'active' ? '' : ` · ${e.state.toUpperCase()}`
  return `${e.friendlyName} (${e.shortId})${def}${st}`
}

function fillSelect(sel: HTMLSelectElement, flow: 'render' | 'capture', selectedId?: string): void {
  const list = devices.filter((d) => d.flow === flow)
  list.sort((a, b) => (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1))
  sel.innerHTML = list
    .map((d) => `<option value="${esc(d.id)}" ${d.state !== 'active' ? 'disabled' : ''} ${d.id === selectedId ? 'selected' : ''}>${esc(optionLabel(d))}</option>`)
    .join('')
  if (!selectedId) {
    // Pre-highlight the current Windows default as a suggestion only. Nothing is saved until Keith tests and saves.
    const def = list.find((d) => d.state === 'active' && d.isDefaultCommunications) ?? list.find((d) => d.state === 'active')
    if (def) sel.value = def.id
  }
}

async function loadDevices(): Promise<void> {
  devices = await api.listDevices()
  const { config, resolved } = await api.getConfig()
  fillSelect($('sysSelect'), 'render', config?.system_output.endpoint_id)
  fillSelect($('micSelect'), 'capture', config?.microphone.endpoint_id)
  const box = $('savedStatus')
  if (!config) {
    box.innerHTML = `<div class="banner warn">No devices saved yet. Pick, test, then save.</div>`
  } else if (resolved.ready) {
    box.innerHTML = `<div class="ok">✓ Saved: meeting audio “${esc(config.system_output.friendly_name)}” · mic “${esc(config.microphone.friendly_name)}”. Both found on this PC.</div>`
  } else {
    const sugg = [resolved.system, resolved.mic]
      .flatMap((r: { candidates: UiEndpoint[] }) => r.candidates)
      .map((c: UiEndpoint) => `<li>Possible match: “${esc(c.friendlyName)}” (${esc(c.id.slice(-12))}). If it is your headset, select it above, test, and save.</li>`)
      .join('')
    box.innerHTML = `<div class="banner err"><div><b>Saved devices not available.</b> ${esc(resolved.problems.join(' '))}<ul>${sugg}</ul>Nothing is switched automatically.</div></div>`
  }
}

function renderStatuses(): void {
  const rows = ['system_remote', 'local_mic']
    .map((s) => statuses[s])
    .filter(Boolean)
    .map((st) => {
      const bad = st.state !== 'active' || st.capture === 'lost'
      return `<tr><td>${st.stream === 'local_mic' ? 'Microphone' : 'Meeting audio'}</td>
        <td>${esc(st.friendly_name)} <span class="muted">(${esc(st.endpoint_id.slice(-12))})</span></td>
        <td class="${bad ? 'bad' : 'ok'}">${esc(st.state)}${st.is_windows_default ? ' <span class="muted">(Windows default)</span>' : ''}</td>
        <td>${esc(st.capture)}</td><td>${esc(st.provider)}${st.epoch ? ` <span class="muted">e${st.epoch}</span>` : ''}</td></tr>`
    })
  $('statusRows').innerHTML = rows.join('')
  const lost = Object.values(statuses).find((s) => s.capture === 'lost' || s.capture === 'recovering')
  const panel = $('switchPanel')
  if (lost && sessionState === 'live') {
    panel.hidden = false
    lastLossStream = lost.stream
    const flow = lost.stream === 'local_mic' ? 'capture' : 'render'
    $('switchMsg').textContent = `${lost.stream === 'local_mic' ? 'Microphone' : 'Meeting audio'} lost. Waiting for “${lost.friendly_name}” to come back. Or pick a device explicitly:`
    const sel = $<HTMLSelectElement>('switchSelect')
    if (!sel.dataset.flow || sel.dataset.flow !== flow) {
      sel.dataset.flow = flow
      sel.innerHTML = devices.filter((d) => d.flow === flow).map((d) => `<option value="${esc(d.id)}" ${d.state !== 'active' ? 'disabled' : ''}>${esc(optionLabel(d))}</option>`).join('')
    }
  } else {
    panel.hidden = true
    $<HTMLSelectElement>('switchSelect').dataset.flow = ''
  }
}

function renderTranscript(): void {
  type Row = { at: number; html: string }
  const rows: Row[] = []
  for (const t of turns.values()) {
    const cls = `${t.stream === 'local_mic' ? 'keith' : 'remote'} ${t.final ? '' : 'open'}`
    rows.push({ at: t.start_ms, html: `<div class="turn ${cls}"><span class="t">${fmtMs(t.start_ms)}</span><span class="who">${esc(speakerLabel(t))}:</span>${esc(t.text)}</div>` })
  }
  for (const g of gaps.values()) {
    const who = g.stream === 'local_mic' ? 'MIC' : 'MEETING AUDIO'
    rows.push({ at: g.start_ms, html: `<div class="gap">GAP · ${who} · ${esc(g.cause)} · ${fmtMs(g.start_ms)} → ${fmtMs(g.end_ms)}${g.duration_ms !== null ? ` (${(g.duration_ms / 1000).toFixed(1)} s)` : ''} · ${esc(g.recovery)} · <span class="muted">${esc(g.detail)}</span></div>` })
  }
  for (const s of supp.slice(-20)) rows.push({ at: s.at, html: `<div class="supp">⤫ ${esc(s.text)}</div>` })
  rows.sort((a, b) => a.at - b.at)
  const box = $('transcript')
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30
  box.innerHTML = rows.map((r) => r.html).join('')
  if (atBottom) box.scrollTop = box.scrollHeight
}

function addAlert(level: string, message: string): void {
  const div = document.createElement('div')
  div.className = level
  div.textContent = `${new Date().toLocaleTimeString()} · ${message}`
  const box = $('alerts')
  box.prepend(div)
  while (box.children.length > 12) box.lastChild?.remove()
}

function setButtons(): void {
  const s = sessionState
  $<HTMLButtonElement>('startBtn').disabled = !['idle', 'stopped'].includes(s)
  $<HTMLButtonElement>('pauseBtn').disabled = s !== 'live'
  $<HTMLButtonElement>('resumeBtn').disabled = s !== 'paused'
  $<HTMLButtonElement>('stopBtn').disabled = !['checking', 'live', 'paused'].includes(s)
  $<HTMLButtonElement>('testDevices').disabled = !['idle', 'stopped'].includes(s)
  $('stateLabel').textContent = s
  $('checkPanel').hidden = s !== 'checking'
}

let lastTurnRender = 0
api.onSession((raw) => {
  const ev = raw as SessionEvent
  switch (ev.type) {
    case 'state':
      if (ev.state === 'live' && sessionState === 'checking') {
        turns.clear(); gaps.clear(); supp.length = 0; elapsedOffset = 0
      }
      if (ev.state === 'live') liveSince = Date.now()
      if (sessionState === 'live' && ev.state !== 'live' && liveSince) { elapsedOffset += Date.now() - liveSince; liveSince = null }
      sessionState = ev.state
      if (ev.detail) addAlert(ev.state === 'idle' ? 'error' : 'info', ev.detail)
      setButtons()
      break
    case 'levels':
      $('sysBar').style.width = `${pct(ev.system.rmsDbfs)}%`
      $('micBar').style.width = `${pct(ev.mic.rmsDbfs)}%`
      $('sysDb').textContent = `${ev.system.rmsDbfs.toFixed(0)} dB`
      $('micDb').textContent = `${ev.mic.rmsDbfs.toFixed(0)} dB`
      break
    case 'check':
      $('cSys').innerHTML = ev.systemPassed ? '<span class="ok">✓ Meeting audio</span>' : `○ Meeting audio (${ev.systemActiveMs} ms)`
      $('cMic').innerHTML = ev.micPassed ? '<span class="ok">✓ Microphone</span>' : `○ Microphone (${ev.micActiveMs} ms)`
      $('cDg').innerHTML = ev.providersOpen ? '<span class="ok">✓ Speech service</span>' : '○ Speech service'
      $('cLeft').textContent = `${Math.ceil(ev.remainingMs / 1000)} s left`
      break
    case 'stream_status':
      statuses[ev.status.stream] = ev.status
      renderStatuses()
      break
    case 'gap_open':
    case 'gap_close':
      gaps.set(ev.gap.gap_id, ev.gap)
      renderTranscript()
      break
    case 'turn':
      turns.set(ev.event.turn.turn_id, ev.event.turn)
      if (Date.now() - lastTurnRender > 150 || ev.event.type === 'turn_final') { lastTurnRender = Date.now(); renderTranscript() }
      break
    case 'interim':
      $('interims').textContent = `(live, not final) ${ev.stream === 'local_mic' ? 'KEITH' : 'REMOTE'}: ${ev.text}`
      break
    case 'alert':
      addAlert(ev.level, ev.message)
      break
    case 'suppressed':
      if (ev.kind === 'duplicate_text') supp.push({ at: Math.max(0, ...[...turns.values()].map((t) => t.end_ms)), text: ev.detail })
      addAlert('warning', ev.detail)
      break
  }
})

api.onTest((raw) => {
  const ev = raw as DeviceTestEvent
  $('testPanel').hidden = false
  $('stopTest').hidden = !ev.running
  $('tSysBar').style.width = `${pct(ev.system.rmsDbfs)}%`
  $('tMicBar').style.width = `${pct(ev.mic.rmsDbfs)}%`
  $('tSysOk').textContent = ev.system.passed ? '✓ heard' : ''
  $('tMicOk').textContent = ev.mic.passed ? '✓ heard' : ''
  const passed = ev.system.passed && ev.mic.passed
  const sameSel = $<HTMLSelectElement>('sysSelect').value === ev.systemId && $<HTMLSelectElement>('micSelect').value === ev.micId
  $<HTMLButtonElement>('saveDevices').disabled = !(passed && sameSel)
  const msgs: string[] = []
  if (ev.system.error) msgs.push(`Meeting audio error: ${ev.system.error}`)
  if (ev.mic.error) msgs.push(`Mic error: ${ev.mic.error}`)
  if (ev.mic.digitalZero) msgs.push('Mic is sending pure silence: is the headset on and unmuted?')
  if (passed) msgs.push('Both streams heard. Click “Save these devices”.')
  else if (!ev.running) msgs.push('Test ended before both streams were heard.')
  $('testMsg').textContent = msgs.join(' ')
})

$('keySave').addEventListener('click', async () => {
  const r = await api.setKey($<HTMLInputElement>('keyInput').value)
  $<HTMLInputElement>('keyInput').value = ''
  $('keyStatus').innerHTML = r.ok ? '<span class="ok">✓ Key saved</span>' : `<span class="bad">${esc(r.error)}</span>`
})
$('refreshDevices').addEventListener('click', () => void loadDevices())
$('testDevices').addEventListener('click', async () => {
  const r = await api.testDevices($<HTMLSelectElement>('sysSelect').value, $<HTMLSelectElement>('micSelect').value)
  $('testPanel').hidden = false
  $('testMsg').textContent = r.ok ? '' : `Could not open: ${r.error}`
})
$('stopTest').addEventListener('click', () => void api.stopTest())
for (const id of ['sysSelect', 'micSelect']) $(id).addEventListener('change', () => { $<HTMLButtonElement>('saveDevices').disabled = true })
$('saveDevices').addEventListener('click', async () => {
  const r = await api.saveDevices($<HTMLSelectElement>('sysSelect').value, $<HTMLSelectElement>('micSelect').value)
  if (!r.ok) addAlert('error', r.error)
  else $('testPanel').hidden = true
  $<HTMLButtonElement>('saveDevices').disabled = true
  await loadDevices()
})
$('startBtn').addEventListener('click', async () => {
  $<HTMLButtonElement>('startBtn').disabled = true
  const r = await api.start()
  if (!r.ok) addAlert('error', r.reason)
  await loadDevices()
  setButtons()
})
$('pauseBtn').addEventListener('click', async () => { const r = await api.pause(); if (!r.ok) addAlert('error', r.reason) })
$('resumeBtn').addEventListener('click', async () => { const r = await api.resume(); if (!r.ok) addAlert('error', r.reason) })
$('stopBtn').addEventListener('click', () => void api.stop())
$('switchBtn').addEventListener('click', async () => {
  const id = $<HTMLSelectElement>('switchSelect').value
  const d = devices.find((x) => x.id === id)
  if (!d || !lastLossStream) return
  if (!confirm(`Use “${d.friendlyName}” for the rest of this session? Windows and Zoom settings stay unchanged.`)) return
  const r = await api.switchEndpoint(lastLossStream, id)
  if (!r.ok) addAlert('error', r.reason)
})
$('snapBefore').addEventListener('click', async () => { const r = await api.snapshot('before'); $('snapMsg').textContent = `Saved ${r.file}` })
$('snapAfter').addEventListener('click', async () => { const r = await api.snapshot('after'); $('snapMsg').textContent = `Saved ${r.file}` })
$('openFolder').addEventListener('click', () => void api.openFolder())

setInterval(() => {
  const ms = elapsedOffset + (liveSince ? Date.now() - liveSince : 0)
  $('elapsed').textContent = ms > 0 ? fmtMs(ms) : ''
}, 500)

void (async () => {
  const info = await api.info()
  $('mode').textContent = info.demoMode ? 'DEMO (not Windows)' : `Windows · v${info.version}`
  $('demoBanner').hidden = !info.demoMode
  if (info.hasApiKey) $('keyStatus').innerHTML = '<span class="ok">✓ Key saved</span>'
  await loadDevices()
  setButtons()
})()
