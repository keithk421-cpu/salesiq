import type { CopilotApi } from '../preload/preload'
import type { AudioEndpointConfig, GapRecord, Turn } from '../shared/contracts'
import type { EndpointInfo } from '../shared/nativeApi'
import type { DeviceScanEvent, ProbeStats } from '../main/deviceTest'
import type { ResolvedConfig } from '../main/endpoints'
import type { SessionEvent, StreamStatusEvent } from '../main/session'

declare global {
  interface Window { copilot: CopilotApi }
}

type UiEndpoint = EndpointInfo & { shortId: string }
const api = window.copilot
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

// ------------------------------------------------------------------ state
let devices: UiEndpoint[] = []
let config: AudioEndpointConfig | null = null
let resolved: ResolvedConfig | null = null
/** Function form so TypeScript does not narrow across awaits. */
const isReady = (): boolean => hasKey && !!resolved?.ready
let hasKey = false
let scan: DeviceScanEvent | null = null
let selectedOut: string | null = null
let selectedMic: string | null = null
let userPicked = { out: false, mic: false }

let sessionState = 'idle'
let liveSince: number | null = null
let elapsedOffset = 0
const turns = new Map<string, Turn>()
const gaps = new Map<string, GapRecord>()
const supp: Array<{ at: number; text: string }> = []
const statuses: Record<string, StreamStatusEvent> = {}
let lossStream: string | null = null
let echoFiltered = 0
/** Provisional (interim) text per stream, display-only. Cleared when finals arrive. */
const interims: Record<string, string> = {}
const delays: Record<string, number | null> = {}

// ------------------------------------------------------------------ helpers
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
function fmtMs(ms: number | null): string {
  if (ms === null) return '…'
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
function pct(db: number): number {
  return Math.max(0, Math.min(100, ((db + 65) / 60) * 100))
}
/** "Headset Earphone (Razer Wireless Headset)" -> { main: "Razer Wireless Headset", kind: "Headset Earphone" } */
function pretty(name: string): { main: string; kind: string } {
  const m = /^(.*?)\s*\((.+)\)\s*$/.exec(name)
  return m ? { main: m[2], kind: m[1] } : { main: name, kind: '' }
}

// ------------------------------------------------------------------ views
function showView(v: 'setup' | 'call'): void {
  $('setupView').hidden = v !== 'setup'
  $('callView').hidden = v !== 'call'
  $('navSetup').hidden = v === 'setup'
  $('navCall').hidden = v === 'call' || !isReady()
  if (v === 'setup') renderSetup()
}

// ------------------------------------------------------------------ setup
async function refreshConfig(): Promise<void> {
  devices = await api.listDevices()
  const c = await api.getConfig()
  config = c.config
  resolved = c.resolved
  if (config && !userPicked.out) selectedOut = config.system_output.endpoint_id
  if (config && !userPicked.mic) selectedMic = config.microphone.endpoint_id
}

function deviceStatus(st: ProbeStats | undefined, flow: 'render' | 'capture'): { text: string; cls: string } {
  if (!st) return { text: '', cls: '' }
  if (st.error) return { text: `Can't open (${st.error.split(':')[0]})`, cls: 'bad' }
  if (st.passed) return { text: flow === 'render' ? '✓ Audio detected' : '✓ Voice detected', cls: 'heard' }
  if (st.soundChunks > 0) return { text: 'Some sound…', cls: 'silent' }
  if (flow === 'capture' && st.silentChunks > 0) return { text: 'Pure silence (muted or off?)', cls: 'silent' }
  if (flow === 'render' && st.idleChunks > 0 && st.silentChunks === 0) return { text: 'Nothing playing here', cls: 'silent' }
  return { text: 'Silent', cls: 'silent' }
}

function renderDeviceList(flow: 'render' | 'capture'): void {
  const list = devices.filter((d) => d.flow === flow)
  list.sort((a, b) => (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1))
  const selected = flow === 'render' ? selectedOut : selectedMic
  const suggested = flow === 'render' ? scan?.suggestedOutputId : scan?.suggestedMicId
  const savedId = flow === 'render' ? config?.system_output.endpoint_id : config?.microphone.endpoint_id
  const html = list
    .map((d) => {
      const st = scan?.devices.find((x) => x.id === d.id)
      const status = d.state === 'active' ? deviceStatus(st, flow) : { text: d.state === 'notpresent' || d.state === 'unplugged' ? 'Not connected' : d.state, cls: 'silent' }
      const tags = [
        d.id === suggested ? `<span class="tag tag-ok">${flow === 'render' ? 'Audio playing here' : 'Hearing you here'}</span>` : '',
        d.id === savedId ? '<span class="tag tag-accent">Saved</span>' : '',
        d.isDefaultConsole || d.isDefaultCommunications ? '<span class="tag">Windows default</span>' : '',
      ].join('')
      const live = scan?.running && st ? `<span class="mini-meter"><div data-meter="${esc(d.id)}"></div></span>` : ''
      const disabled = d.state !== 'active'
      return `<label class="device ${d.id === selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-id="${esc(d.id)}" data-flow="${flow}">
        <input type="radio" name="${flow}" ${d.id === selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span class="device-name" title="${esc(d.friendlyName)}">${esc(pretty(d.friendlyName).main)}<span class="kind">${esc(pretty(d.friendlyName).kind)}</span></span>
        <span class="device-sub">${tags}${live}<span class="${status.cls}">${esc(status.text)}</span></span>
      </label>`
    })
    .join('')
  const box = $(flow === 'render' ? 'outList' : 'micList')
  box.innerHTML = html || '<div class="muted">No devices found.</div>'
  // Meter widths via CSSOM (CSP-safe).
  for (const el of box.querySelectorAll<HTMLElement>('[data-meter]')) {
    const st = scan?.devices.find((x) => x.id === el.dataset.meter)
    el.style.width = `${st ? pct(st.rmsDbfs) : 0}%`
  }
}

function renderSetup(): void {
  // Step 1
  $('keyDone').hidden = !hasKey
  $('keyForm').hidden = hasKey
  $('keyChange').hidden = !hasKey
  $('keyStep').classList.toggle('done', hasKey)
  // Step 2
  const ready = !!resolved?.ready
  $('devDone').hidden = !ready
  $('devStep').classList.toggle('done', ready)
  const note = $('savedNote')
  if (config && resolved && !scan) {
    note.hidden = false
    note.className = `note ${ready ? 'ok' : 'err'}`
    note.textContent = ready
      ? `Saved: "${config.system_output.friendly_name}" and "${config.microphone.friendly_name}". Both connected.`
      : `${resolved.problems.join(' ')} Nothing is switched automatically. Turn the headset on, or click Start listening to pick again.`
  } else note.hidden = true

  renderDeviceList('render')
  renderDeviceList('capture')

  const running = !!scan?.running
  $<HTMLButtonElement>('findBtn').textContent = running ? 'Listening…' : scan ? 'Listen again' : 'Start listening'
  $<HTMLButtonElement>('findBtn').disabled = running
  $('scanStop').hidden = !running
  $('scanInfo').textContent = running ? `${Math.ceil((scan?.remainingMs ?? 0) / 1000)} s left` : ''

  const out = devices.find((d) => d.id === selectedOut)
  const mic = devices.find((d) => d.id === selectedMic)
  const outOk = !!scan?.devices.find((d) => d.id === selectedOut)?.passed
  const micOk = !!scan?.devices.find((d) => d.id === selectedMic)?.passed
  $('pairSummary').innerHTML =
    out && mic
      ? `${outOk ? '✓' : '○'} Meeting audio: ${esc(pretty(out.friendlyName).main)} &nbsp;·&nbsp; ${micOk ? '✓' : '○'} Mic: ${esc(pretty(mic.friendlyName).main)}`
      : 'Pick one of each.'
  $<HTMLButtonElement>('saveDevices').disabled = !(out && mic && outOk && micOk)
}

function onDevicePick(e: Event): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.device')
  if (!row || row.classList.contains('disabled')) return
  if (row.dataset.flow === 'render') { selectedOut = row.dataset.id!; userPicked.out = true }
  else { selectedMic = row.dataset.id!; userPicked.mic = true }
  renderSetup()
}

// ------------------------------------------------------------------ call view
function setPill(): void {
  const pill = $('statusPill')
  pill.className = 'pill'
  let text = 'Ready'
  if (sessionState === 'checking') { pill.classList.add('checking'); text = 'Getting ready…' }
  else if (sessionState === 'live') { pill.classList.add('live'); text = `Live · ${fmtMs(elapsed())}` }
  else if (sessionState === 'paused') { pill.classList.add('paused'); text = `Paused · ${fmtMs(elapsed())}` }
  else if (sessionState === 'stopping') text = 'Stopping…'
  else if (sessionState === 'stopped') text = `Ended · ${fmtMs(elapsed())}`
  $('statusText').textContent = text
}
function elapsed(): number {
  return elapsedOffset + (liveSince ? Date.now() - liveSince : 0)
}

function setButtons(): void {
  const s = sessionState
  $('startBtn').hidden = !['idle', 'stopped'].includes(s)
  $('pauseBtn').hidden = s !== 'live'
  $('resumeBtn').hidden = s !== 'paused'
  $('stopBtn').hidden = !['checking', 'live', 'paused'].includes(s)
  $('checkCard').hidden = s !== 'checking'
  $('navSetup').toggleAttribute('disabled', !['idle', 'stopped'].includes(s))
  setPill()
}

function renderSources(): void {
  const names = {
    system_remote: statuses.system_remote?.friendly_name ?? config?.system_output.friendly_name ?? '—',
    local_mic: statuses.local_mic?.friendly_name ?? config?.microphone.friendly_name ?? '—',
  }
  $('sysName').textContent = pretty(names.system_remote).main
  $('micName').textContent = pretty(names.local_mic).main
  $('sysName').title = names.system_remote
  $('micName').title = names.local_mic
  const sysId = statuses.system_remote?.endpoint_id ?? config?.system_output.endpoint_id ?? ''
  const micId = statuses.local_mic?.endpoint_id ?? config?.microphone.endpoint_id ?? ''
  $('sysId').textContent = `${pretty(names.system_remote).kind || 'output'} · ID …${sysId.slice(-10)}`
  $('micId').textContent = `${pretty(names.local_mic).kind || 'input'} · ID …${micId.slice(-10)}`
  for (const [stream, id] of [['system_remote', 'sysState'], ['local_mic', 'micState']] as const) {
    const st = statuses[stream]
    const el = $(id)
    let cls = ''
    let text = 'Idle'
    if (st) {
      if (st.capture === 'lost') { cls = 'err'; text = 'Disconnected' }
      else if (st.capture === 'recovering') { cls = 'warn'; text = 'Reconnecting…' }
      else if (st.state === 'silent') { cls = 'warn'; text = 'Silent' }
      else if (st.capture === 'capturing') { cls = 'ok'; text = st.provider === 'open' || sessionState === 'checking' ? 'Listening' : 'Speech service…' }
      else if (st.state !== 'active') { cls = 'err'; text = 'Not connected' }
    }
    el.className = `state ${cls}`
    el.lastElementChild!.textContent = text
    $(stream === 'local_mic' ? 'srcMic' : 'srcSys').classList.toggle('lost', cls === 'err')
  }
  const rows = (['system_remote', 'local_mic'] as const)
    .map((s) => statuses[s])
    .filter(Boolean)
    .map((st) => `<tr><td>${st.stream === 'local_mic' ? 'Mic' : 'Meeting audio'}</td>
      <td>${esc(st.friendly_name)} <span class="muted">${esc(st.endpoint_id.slice(-10))}</span></td>
      <td>${esc(st.state)}${st.is_windows_default ? ' <span class="muted">(Windows default)</span>' : ''}</td>
      <td>${esc(st.capture)}</td><td>${esc(st.provider)}${st.epoch ? ` · e${st.epoch}` : ''}</td></tr>`)
  $('statusRows').innerHTML = rows.join('')

  // Device-loss banner with explicit device picker.
  const lost = (['system_remote', 'local_mic'] as const).map((s) => statuses[s]).find((s) => s && (s.capture === 'lost' || s.capture === 'recovering'))
  if (lost && sessionState === 'live') {
    lossStream = lost.stream
    const flow = lost.stream === 'local_mic' ? 'capture' : 'render'
    showBanner('error', `${lost.stream === 'local_mic' ? 'Your mic' : 'Meeting audio'} disconnected ("${lost.friendly_name}"). The gap is marked in the transcript. Waiting for it to come back. We won't switch devices on our own.`, true)
    const sel = $<HTMLSelectElement>('switchSelect')
    if (sel.dataset.flow !== flow) {
      sel.dataset.flow = flow
      sel.innerHTML = devices.filter((d) => d.flow === flow && d.state === 'active' && d.id !== lost.endpoint_id)
        .map((d) => `<option value="${esc(d.id)}">${esc(d.friendlyName)}</option>`).join('')
    }
  } else if (lossStream) {
    lossStream = null
    $<HTMLSelectElement>('switchSelect').dataset.flow = ''
    $('switchRow').hidden = true
  }
}

function showBanner(level: 'error' | 'warning' | 'info', text: string, withSwitch = false): void {
  const b = $('banner')
  b.hidden = false
  b.className = `banner ${level}`
  $('bannerText').textContent = text
  $('switchRow').hidden = !withSwitch
}

function speakerClass(cluster: string | null): string {
  const m = cluster ? /s(\d+)$/.exec(cluster) : null
  return m ? `spk${Number(m[1]) % 6}` : 'spkU'
}

function renderTranscript(): void {
  type Row = { at: number; html: string }
  const rows: Row[] = []
  for (const t of turns.values()) {
    const me = t.stream === 'local_mic'
    // Channel is explicit. Remote speaker = Deepgram cluster, scoped to one connection epoch:
    // "s0" after a reconnect is NOT necessarily the same person as "s0" before it.
    const m = t.speaker_cluster ? /^e(\d+):s(\d+)$/.exec(t.speaker_cluster) : null
    const who = me ? 'Keith · mic' : m ? `Remote · speaker ${m[2]}` : 'Remote · unknown speaker'
    const tag = me ? 'local_mic' : m ? `system · cluster s${m[2]} · conn ${m[1]}` : 'system · no cluster'
    rows.push({
      at: t.start_ms,
      html: `<div class="msgrow ${me ? 'me' : 'them'} ${t.final ? '' : 'open'}">
        <div class="who ${me ? '' : speakerClass(t.speaker_cluster)}">${esc(who)}<span class="t">${fmtMs(t.start_ms)}–${fmtMs(t.end_ms)}</span><span class="t">${esc(tag)}</span></div>
        <div class="bubble">${esc(t.text)}</div></div>`,
    })
  }
  const shownPauses: GapRecord[] = []
  for (const g of gaps.values()) {
    if (g.cause === 'pause') {
      // Both streams pause together: show one line.
      if (shownPauses.some((p) => Math.abs(p.start_ms - g.start_ms) < 250)) continue
      shownPauses.push(g)
      const dur = g.duration_ms !== null ? ` · ${(g.duration_ms / 1000).toFixed(1)} s` : ''
      rows.push({ at: g.start_ms, html: `<div class="gapline pause">Paused${dur}</div>` })
      continue
    }
    const what = g.stream === 'local_mic' ? 'Mic' : 'Meeting audio'
    const why = g.cause === 'provider_disconnect' ? 'speech service interrupted (speaker clusters restart after reconnect)' : g.cause.replace(/_/g, ' ')
    const dur = g.duration_ms !== null ? ` · ${(g.duration_ms / 1000).toFixed(1)} s` : ' · ongoing'
    rows.push({ at: g.start_ms, html: `<div class="gapline">${what} gap · ${esc(why)}${dur}</div>` })
  }
  for (const s of supp.slice(-20)) rows.push({ at: s.at, html: `<div class="supp">Filtered echo: “${esc(s.text)}”</div>` })
  rows.sort((a, b) => a.at - b.at)
  // Live (interim) text goes last: provisional, replaced by final turns.
  for (const stream of ['system_remote', 'local_mic'] as const) {
    const text = interims[stream]
    if (!text) continue
    const me = stream === 'local_mic'
    rows.push({ at: Infinity, html: `<div class="msgrow ${me ? 'me' : 'them'} live"><div class="who">${me ? 'Keith · mic' : 'Remote'}<span class="t">live, not final</span></div><div class="bubble">${esc(text)}</div></div>` })
  }
  const box = $('transcript')
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40
  if (rows.length === 0) {
    box.innerHTML = ''
    box.appendChild(emptyState)
  } else box.innerHTML = rows.map((r) => r.html).join('')
  if (atBottom) box.scrollTop = box.scrollHeight
  const finals = [...turns.values()].filter((t) => t.final).length
  const realGaps = [...gaps.values()].filter((g) => g.cause !== 'pause').length
  const d = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${(x / 1000).toFixed(1)} s`)
  const delayText = delays.local_mic !== undefined || delays.system_remote !== undefined ? ` · delay: Keith ${d(delays.local_mic)}, remote ${d(delays.system_remote)}` : ''
  $('counts').textContent = `${finals} turns · ${realGaps} gaps · ${echoFiltered + supp.length} echo filtered${delayText}`
}
const emptyState = $('emptyState')

function addActivity(level: string, message: string): void {
  const div = document.createElement('div')
  div.className = level
  div.textContent = `${new Date().toLocaleTimeString()} · ${message}`
  const box = $('activity')
  box.prepend(div)
  while (box.children.length > 60) box.lastChild?.remove()
}

// ------------------------------------------------------------------ events
let lastRender = 0
api.onSession((raw) => {
  const ev = raw as SessionEvent
  switch (ev.type) {
    case 'state':
      if (ev.state === 'checking') {
        turns.clear(); gaps.clear(); supp.length = 0; echoFiltered = 0; elapsedOffset = 0; liveSince = null
        for (const k of Object.keys(interims)) delete interims[k]
        for (const k of Object.keys(delays)) delete delays[k]
        $('banner').hidden = true
        renderTranscript()
      }
      if (ev.state === 'live') liveSince = Date.now()
      if (sessionState === 'live' && ev.state !== 'live' && liveSince) { elapsedOffset += Date.now() - liveSince; liveSince = null }
      sessionState = ev.state
      if (ev.state !== 'live') {
        for (const k of Object.keys(interims)) delete interims[k]
        renderTranscript()
      }
      if (ev.state === 'idle' && ev.detail) showBanner('error', ev.detail)
      if (ev.detail) addActivity(ev.state === 'idle' ? 'error' : 'info', ev.detail)
      setButtons()
      renderSources()
      break
    case 'levels':
      $('sysBar').style.width = `${pct(ev.system.rmsDbfs)}%`
      $('micBar').style.width = `${pct(ev.mic.rmsDbfs)}%`
      break
    case 'check':
      $('ckSys').classList.toggle('pass', ev.systemPassed)
      $('ckMic').classList.toggle('pass', ev.micPassed)
      $('ckDg').classList.toggle('pass', ev.providersOpen)
      $('ckLeft').textContent = `${Math.ceil(ev.remainingMs / 1000)} s left`
      break
    case 'stream_status':
      statuses[ev.status.stream] = ev.status
      renderSources()
      break
    case 'gap_open':
    case 'gap_close':
      gaps.set(ev.gap.gap_id, ev.gap)
      renderTranscript()
      break
    case 'turn':
      turns.set(ev.event.turn.turn_id, ev.event.turn)
      if (Date.now() - lastRender > 150 || ev.event.type === 'turn_final') { lastRender = Date.now(); renderTranscript() }
      break
    case 'interim':
      interims[ev.stream] = ev.text
      if (Date.now() - lastRender > 120 || !ev.text) { lastRender = Date.now(); renderTranscript() }
      break
    case 'timing':
      delays[ev.stream] = ev.sttDelayMs
      renderTranscript()
      break
    case 'alert':
      addActivity(ev.level, ev.message)
      if (ev.level === 'warning') showBanner('warning', ev.message)
      if (ev.level === 'info' && /reconnected/.test(ev.message)) showBanner('info', ev.message)
      break
    case 'suppressed':
      if (ev.kind === 'duplicate_text') supp.push({ at: Math.max(0, ...[...turns.values()].map((t) => t.end_ms)), text: ev.detail.replace(/^.*?"|"$/g, '') })
      else echoFiltered++
      addActivity('warning', ev.detail)
      break
  }
})

api.onScan(async (raw) => {
  const ev = raw as DeviceScanEvent
  scan = ev
  if (ev.suggestedOutputId && !userPicked.out) selectedOut = ev.suggestedOutputId
  if (ev.suggestedMicId && !userPicked.mic) selectedMic = ev.suggestedMicId
  if (!ev.running) $('devMsg').textContent = ''
  renderSetup()
})

// ------------------------------------------------------------------ actions
$('navSetup').addEventListener('click', async () => { await refreshConfig(); showView('setup') })
$('navCall').addEventListener('click', () => { void api.stopScan(); showView('call') })

$('keySave').addEventListener('click', async () => {
  const r = await api.setKey($<HTMLInputElement>('keyInput').value)
  $<HTMLInputElement>('keyInput').value = ''
  const msg = $('keyMsg')
  msg.className = `msg ${r.ok ? 'ok' : 'err'}`
  msg.textContent = r.ok ? '' : r.error
  if (r.ok) hasKey = true
  renderSetup()
})
$('keyChange').addEventListener('click', () => { $('keyForm').hidden = false; $('keyChange').hidden = true })

$('findBtn').addEventListener('click', async () => {
  userPicked = { out: false, mic: false }
  devices = await api.listDevices()
  const r = await api.findDevices()
  const msg = $('devMsg')
  msg.className = 'msg err'
  msg.textContent = r.ok ? '' : `Couldn't listen: ${r.error}`
})
$('scanStop').addEventListener('click', () => void api.stopScan())
$('outList').addEventListener('click', onDevicePick)
$('micList').addEventListener('click', onDevicePick)
$('saveDevices').addEventListener('click', async () => {
  if (!selectedOut || !selectedMic) return
  const r = await api.saveDevices(selectedOut, selectedMic)
  const msg = $('devMsg')
  msg.className = `msg ${r.ok ? 'ok' : 'err'}`
  msg.textContent = r.ok ? '' : r.error
  if (!r.ok) return
  scan = null
  await refreshConfig()
  renderSetup()
  if (isReady()) showView('call')
  renderSources()
})

$('startBtn').addEventListener('click', async () => {
  $('banner').hidden = true
  $<HTMLButtonElement>('startBtn').disabled = true
  const r = await api.start()
  $<HTMLButtonElement>('startBtn').disabled = false
  if (!r.ok) showBanner('error', r.reason)
  await refreshConfig()
  setButtons()
})
$('pauseBtn').addEventListener('click', async () => { const r = await api.pause(); if (!r.ok) showBanner('error', r.reason) })
$('resumeBtn').addEventListener('click', async () => { const r = await api.resume(); if (!r.ok) showBanner('error', r.reason) })
$('stopBtn').addEventListener('click', () => void api.stop())
$('bannerClose').addEventListener('click', () => { $('banner').hidden = true })
$('switchBtn').addEventListener('click', async () => {
  const id = $<HTMLSelectElement>('switchSelect').value
  const d = devices.find((x) => x.id === id)
  if (!d || !lossStream) return
  if (!confirm(`Use "${d.friendlyName}" for the rest of this call?\n\nWindows and Zoom settings stay unchanged.`)) return
  const r = await api.switchEndpoint(lossStream, id)
  if (!r.ok) showBanner('error', r.reason)
})
$('snapBefore').addEventListener('click', async () => { const r = await api.snapshot('before'); $('snapMsg').textContent = `Saved ${r.file}` })
$('snapAfter').addEventListener('click', async () => { const r = await api.snapshot('after'); $('snapMsg').textContent = `Saved ${r.file}` })
$('openFolder').addEventListener('click', () => void api.openFolder())

setInterval(() => { if (sessionState === 'live' || sessionState === 'paused') setPill() }, 500)

void (async () => {
  const info = await api.info()
  hasKey = info.hasApiKey
  $('demoTag').hidden = !info.demoMode
  await refreshConfig()
  setButtons()
  renderSources()
  renderTranscript()
  showView(isReady() ? 'call' : 'setup')
})()
