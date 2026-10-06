import type { CopilotApi } from '../preload/preload'
import type { AudioEndpointConfig, GapRecord, Turn } from '../shared/contracts'
import type { EndpointInfo } from '../shared/nativeApi'
import type { DeviceScanEvent, ProbeStats } from '../main/deviceTest'
import type { ResolvedConfig } from '../main/endpoints'
import type { SessionEvent, StreamStatusEvent } from '../main/session'
import type { HelpCardEvent, KnowledgeDocMeta, SpeakerLabel } from '../shared/help'
import type { CallNoteItem, CallNotesState } from '../shared/help'
import { expiresLabel, isPastReview } from '../shared/dates'
import { passageLabel } from '../shared/passageLabel'
import { HEALTH_LABEL } from '../shared/captureHealth'
import { initHeard } from './heard'
import { initCompact } from './compact'
import { initAccountMemory } from './accountMemory'
import { initCallPlan } from './callPlan'
import { initWrapup } from './wrapup'
import { initPressModes } from './pressModes'
import { initPlanPress } from './planPress'
import { initAccountNotes } from './accountNotes'
import { initForNextTime } from './forNextTime'

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
/** Manual per-call speaker labels (cluster -> label). */
const labels = new Map<string, SpeakerLabel>()
/** The HELP card currently displayed (only the newest request is ever shown). */
let card: HelpCardEvent | null = null
let cardShownAt = 0
type ReadyState = { readiness: string; message: string }
let helpInfo: { hasKey: boolean; settings: { model: string; prefetch: boolean }; setup: { call_type: string; call_goal: string; desired_outcomes: string[]; account: string; deployment?: string }; hotkeyRegistered: boolean; modelLabel: string; mock: boolean; knowledgeDir?: string; ready?: ReadyState; playbook?: PlaybookInfo } | null = null
let hideHotkey: string | null = null
let lastCallDeleted = false

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
  $('reviewCallBtn').hidden = s !== 'stopped' || lastCallDeleted
  $('checkCard').hidden = s !== 'checking'
  $('navSetup').toggleAttribute('disabled', !['idle', 'stopped'].includes(s))
  $<HTMLButtonElement>('helpBtn').disabled = s !== 'live'
  $<HTMLButtonElement>('wrapBtn').disabled = s !== 'live'
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
    // Quiet (nobody talking) vs no audio arriving vs not transcribing: worked out in the main process.
    const { text, cls, hint } = HEALTH_LABEL[st?.health ?? 'idle']
    el.className = `state ${cls}`
    el.title = hint
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
    const lab = t.speaker_cluster ? labels.get(t.speaker_cluster) : undefined
    const roleText = lab ? (lab.role === 'teammate' ? 'teammate' : lab.role === 'buyer' ? 'buyer' : 'role unknown') : 'tap to label'
    const who = me ? 'Keith · mic' : m ? `${lab?.name ?? `Remote · speaker ${m[2]}`} · ${roleText}` : 'Remote · unknown speaker'
    const tag = me ? 'local_mic' : m ? `system · cluster s${m[2]} · conn ${m[1]}` : 'system · no cluster'
    rows.push({
      at: t.start_ms,
      html: `<div class="msgrow ${me ? 'me' : 'them'} ${t.final ? '' : 'open'}">
        <div class="who ${me ? '' : `${speakerClass(t.speaker_cluster)} ${m ? 'clickable' : ''}`}" ${m ? `data-cluster="${esc(t.speaker_cluster!)}"` : ''}>${esc(who)}<span class="t">${fmtMs(t.start_ms)}–${fmtMs(t.end_ms)}</span><span class="t">${esc(tag)}</span></div>
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
    const why = g.cause === 'provider_disconnect' ? 'speech service interrupted (speaker clusters restart after reconnect)'
      : g.cause === 'provider_stalled' ? 'speech service stopped responding (speaker clusters restart after reconnect)'
      : g.cause.replace(/_/g, ' ')
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

// After a pause or a reconnect, the speech service numbers speakers afresh: labels Keith set
// earlier don't carry over. Say so once per new connection, only if he had labelled someone.
let relabelPromptedEpoch = 0
function promptRelabel(cluster: string | null): void {
  const epoch = Number(/^e(\d+):/.exec(cluster ?? '')?.[1] ?? 0)
  if (!epoch || epoch <= relabelPromptedEpoch || labels.size === 0) return
  const labelled = Math.max(...[...labels.keys()].map((c) => Number(/^e(\d+):/.exec(c)?.[1] ?? 0)))
  if (epoch <= labelled) return
  relabelPromptedEpoch = epoch
  showBanner('info', 'Speaker numbers restarted after the pause or reconnect. Tap the remote speaker\'s name to label them again (optional).')
}

// ------------------------------------------------------------------ events
let lastRender = 0
api.onSession((raw) => {
  const ev = raw as SessionEvent
  switch (ev.type) {
    case 'state':
      if (ev.state === 'checking') {
        lastCallDeleted = false
        relabelPromptedEpoch = 0
        turns.clear(); gaps.clear(); supp.length = 0; echoFiltered = 0; elapsedOffset = 0; liveSince = null
        for (const k of Object.keys(interims)) delete interims[k]
        for (const k of Object.keys(delays)) delete delays[k]
        labels.clear()
        card = null
        renderCard()
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
      // Stop clears who the call was with (the next call starts clean).
      if (ev.state === 'stopped') {
        void refreshHelpInfo()
        void renderCallsInfo()
      }
      if (ev.state !== 'live') $('idleBanner').hidden = true
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
      $('ckLeft').textContent = ev.remainingMs > 90_000 ? `Waits ${Math.ceil(ev.remainingMs / 60_000)} more min` : `${Math.ceil(ev.remainingMs / 1000)} s left`
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
      promptRelabel(ev.event.turn.speaker_cluster)
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
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  $('reviewModal').hidden = true
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
// ---- after the call: rate every card, tick the lines used, add notes ----
type CallCard = { id: string; at_session_ms: number | null; status: string; primary_kind: 'ask' | 'say' | null; primary: string | null; follow_up: string | null; rating: string | null; used: boolean; note: string | null }
const RATE_LABEL: Record<string, string> = { useful: 'Useful', should_have_stayed_quiet: "Should've stayed quiet", bad: 'Bad' }
$('reviewCallBtn').addEventListener('click', async () => {
  const cards = (await api.helpCallCards()) as CallCard[]
  $('rvList').innerHTML = cards.length
    ? cards.map((c) => `<div class="rv-card" data-id="${esc(c.id)}">
        <div class="rv-line"><span class="kind">${c.primary_kind === 'say' ? 'Say' : 'Ask'}</span> ${esc(c.primary ?? '')}</div>
        <div class="muted small">${c.at_session_ms !== null ? `at ${fmtMs(c.at_session_ms)}` : ''}${c.follow_up ? ` · Then: ${esc(c.follow_up)}` : ''}</div>
        <div class="row">
          ${Object.entries(RATE_LABEL).map(([k, v]) => `<button class="fb${c.rating === k ? ' chosen' : ''}" data-rate="${k}">${v}</button>`).join('')}
          <label class="inline check"><input type="checkbox" data-used ${c.used ? 'checked' : ''}/> I used this line</label>
        </div>
        <input class="input rv-note" placeholder="Note (optional): what would have been better?" maxlength="500" value="${esc(c.note ?? '')}" />
      </div>`).join('')
    : '<p class="muted">No HELP cards on this call.</p>'
  $('reviewModal').hidden = false
})
$('rvList').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-rate]')
  const id = b?.closest<HTMLElement>('.rv-card')?.dataset.id
  if (!b || !id) return
  b.parentElement!.querySelectorAll('button[data-rate]').forEach((x) => x.classList.toggle('chosen', x === b))
  await api.helpFeedback({ card_id: id, type: b.dataset.rate })
})
$('rvList').addEventListener('change', async (e) => {
  const el = e.target as HTMLInputElement
  const id = el.closest<HTMLElement>('.rv-card')?.dataset.id
  if (!id) return
  if (el.matches('[data-used]')) await api.helpFeedback({ card_id: id, type: el.checked ? 'used' : 'unused' })
  else if (el.matches('.rv-note')) await api.helpFeedback({ card_id: id, type: 'note', note: el.value })
})
$('rvDone').addEventListener('click', () => { $('reviewModal').hidden = true })

// ---- after the call: keep a card's moment as a practice moment (stays on this PC) ----
type PracticeInfo = { count: number; saved: string[] }
type SaveResult = { ok: boolean; already?: boolean; updated?: boolean; title?: string; reason?: string }
const SAVE_TEXT = { idle: 'Save as practice moment', saving: 'Saving…', saved: 'Saved as a practice moment' }
function setSaveState(btn: HTMLButtonElement, state: keyof typeof SAVE_TEXT): void {
  btn.textContent = SAVE_TEXT[state]
  btn.disabled = state !== 'idle'
  btn.dataset.state = state
}
// Each card the review lists gets its own button (added as the list is drawn), showing whether it's saved.
async function addSaveButtons(): Promise<void> {
  const fresh = [...$('rvList').querySelectorAll<HTMLElement>('.rv-card')].filter((c) => !c.querySelector('[data-save]'))
  if (!fresh.length) return
  const buttons = fresh.map((c) => {
    const row = document.createElement('div')
    row.className = 'row rv-save'
    row.innerHTML = '<button class="btn btn-ghost btn-sm" data-save disabled></button><span class="muted small" data-save-msg></span>'
    c.append(row)
    const btn = row.querySelector<HTMLButtonElement>('[data-save]')!
    btn.textContent = SAVE_TEXT.idle // enabled once we know whether it's already saved
    return { id: c.dataset.id ?? '', btn }
  })
  const info = (await api.practiceInfo()) as PracticeInfo
  const saved = new Set(info.saved)
  for (const b of buttons) setSaveState(b.btn, saved.has(b.id) ? 'saved' : 'idle')
}
new MutationObserver(() => void addSaveButtons()).observe($('rvList'), { childList: true })
$('rvList').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-save]')
  const cardEl = btn?.closest<HTMLElement>('.rv-card')
  const id = cardEl?.dataset.id
  if (!btn || !id) return
  const msg = cardEl.querySelector<HTMLElement>('[data-save-msg]')!
  setSaveState(btn, 'saving')
  msg.textContent = ''
  const r = (await api.helpSaveMoment(id).catch(() => ({ ok: false }))) as SaveResult
  if (!r.ok) {
    setSaveState(btn, 'idle')
    msg.textContent = r.reason ?? "Couldn't save it."
    return
  }
  setSaveState(btn, 'saved')
  msg.textContent = r.updated ? 'Already saved; your rating is updated in it.' : r.already ? 'Already saved as a practice moment.' : 'The speed test can replay it now.'
  void refreshPractice()
})
// A saved card whose rating, tick or note changes: write the new feedback into its moment. These
// listeners run after the ones above that store the feedback (same order in the main process).
async function refreshSavedMoment(target: EventTarget | null): Promise<void> {
  const cardEl = (target as HTMLElement | null)?.closest<HTMLElement>('.rv-card')
  const btn = cardEl?.querySelector<HTMLButtonElement>('button[data-save]')
  const id = cardEl?.dataset.id
  if (!cardEl || !id || btn?.dataset.state !== 'saved') return
  const r = (await api.helpSaveMoment(id).catch(() => ({ ok: false }))) as SaveResult
  cardEl.querySelector<HTMLElement>('[data-save-msg]')!.textContent = r.ok ? 'Practice moment updated with your rating.' : "Couldn't update the practice moment."
}
$('rvList').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button[data-rate]')) void refreshSavedMoment(e.target)
})
$('rvList').addEventListener('change', (e) => {
  if ((e.target as HTMLElement).matches('[data-used], .rv-note')) void refreshSavedMoment(e.target)
})

// ---- Diagnostics: my practice moments in the speed test, and the HELP feedback export ----
let benchMineTouched = false
async function refreshPractice(): Promise<void> {
  const i = (await api.practiceInfo()) as PracticeInfo
  $('practiceCount').textContent = String(i.count)
  $('benchMineLabel').textContent = `Include my saved moments (${i.count})`
  const box = $<HTMLInputElement>('benchMine')
  box.disabled = i.count === 0
  // On whenever there are any, unless Keith unticked it.
  if (!benchMineTouched || i.count === 0) box.checked = i.count > 0
}
$('benchMine').addEventListener('change', () => { benchMineTouched = true })
document.querySelector('details.diag')?.addEventListener('toggle', () => void refreshPractice())
$('practiceOpen').addEventListener('click', async () => {
  const r = (await api.practiceOpenFolder()) as { ok: boolean; error?: string }
  $('practiceMsg').textContent = r.ok ? '' : r.error ?? "Couldn't open the folder."
})
$('fbExport').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('fbExport')
  btn.disabled = true
  $('fbExportMsg').textContent = 'Saving…'
  const r = (await api.helpExportFeedback($<HTMLSelectElement>('fbPeriod').value).catch(() => ({ ok: false }))) as { ok: boolean; file?: string; calls?: number; cards?: number; reason?: string }
  btn.disabled = false
  $('fbExportMsg').textContent = r.ok
    ? `Saved ${r.cards} card${r.cards === 1 ? '' : 's'} from ${r.calls} call${r.calls === 1 ? '' : 's'} to ${r.file}. It has lines and notes from your calls: send me that file.`
    : r.reason ?? "Couldn't export."
})
void refreshPractice()

// ---- saved calls: delete this call, retention ----
function clearCallView(): void {
  turns.clear(); gaps.clear(); supp.length = 0; echoFiltered = 0
  labels.clear()
  card = null
  renderCard()
  renderTranscript()
}
async function renderCallsInfo(): Promise<void> {
  const i = (await api.callsInfo()) as { count: number; oldest: string | null; retention_days: number | null }
  $<HTMLSelectElement>('retention').value = i.retention_days === null ? 'never' : String(i.retention_days)
  $('callsInfo').textContent = i.count ? `${i.count} saved call${i.count === 1 ? '' : 's'}, oldest ${new Date(i.oldest!).toLocaleDateString()}` : 'No saved calls'
}
$('retention').addEventListener('change', async () => {
  const v = $<HTMLSelectElement>('retention').value
  await api.setAppSettings({ retention_days: v === 'never' ? null : Number(v) })
  void renderCallsInfo()
})
$('deleteAll').addEventListener('click', async () => {
  if (!confirm("Delete every saved call from this PC? Transcripts, HELP cards and notes are removed. This can't be undone.")) return
  const r = (await api.deleteAllCalls()) as { ok: boolean; deleted: number; error?: string }
  if (!r.error && (sessionState === 'stopped' || sessionState === 'idle')) {
    lastCallDeleted = true
    clearCallView()
    setButtons()
  }
  $('snapMsg').textContent = r.ok ? `Deleted ${r.deleted} saved call(s).` : r.error ?? "Some files couldn't be deleted. Close the app and try again."
  void renderCallsInfo()
})
api.onRetentionPreview((p) => {
  $('rmText').textContent = `${p.calls.length} saved call${p.calls.length === 1 ? ' is' : 's are'} older than ${p.days} days:`
  $('rmList').innerHTML = p.calls.slice(0, 8).map((c) => `<li>${esc(new Date(c.started_at).toLocaleDateString())}${c.account ? ` · ${esc(c.account)}` : ''}</li>`).join('') +
    (p.calls.length > 8 ? `<li>and ${p.calls.length - 8} more</li>` : '')
  $('retentionModal').hidden = false
})
$('rmYes').addEventListener('click', async () => {
  $('retentionModal').hidden = true
  const r = (await api.confirmRetention(true)) as { deleted: number; failed: number }
  $('snapMsg').textContent = `Deleted ${r.deleted} old call(s).${r.failed ? ` ${r.failed} couldn't be removed.` : ''}`
  void renderCallsInfo()
})
$('rmNo').addEventListener('click', () => {
  $('retentionModal').hidden = true
  void api.confirmRetention(false)
})

$('hideCapture').addEventListener('change', async () => {
  const on = $<HTMLInputElement>('hideCapture').checked
  await api.setAppSettings({ hide_from_capture: on })
  $('snapMsg').textContent = on ? 'This window is hidden from screen sharing during calls.' : 'This window can now be captured, even during a call. It hides again when you next press Start.'
})
// Start switches the hiding back on if it was off for a screenshot.
api.onAppSettings((s) => { $<HTMLInputElement>('hideCapture').checked = s.hide_from_capture })
void (api.buildInfo() as Promise<{ version: string; build: string; sha: string; date: string }>).then((b) => {
  $('buildTag').textContent = `· build ${b.build} (${b.sha}${b.date ? `, ${b.date}` : ''})`
})
$('supportFiles').addEventListener('click', async () => {
  const r = (await api.supportFiles()) as { ok: boolean; dir?: string; files?: number; skipped?: number; error?: string }
  $('snapMsg').textContent = r.ok
    ? `Saved ${r.files} support file(s) to ${r.dir} (no conversation text).${r.skipped ? ` ${r.skipped} couldn't be copied (listed in README.txt).` : ''} Zip that folder and send it.`
    : `Could not save support files: ${r.error ?? 'unknown error'}.`
})

setInterval(() => { if (sessionState === 'live' || sessionState === 'paused') setPill() }, 500)
initCompact(api)
initHeard(api)

// ------------------------------------------------------------------ M1: HELP card
const PENDING_TEXT: Record<string, string> = { pending: 'Working…', streaming: 'Working…' }
const STALE_MS = 60_000

function renderCard(): void {
  const el = $('helpCard')
  if (!card) {
    el.hidden = true
    return
  }
  el.hidden = false
  const c = card.content
  const done = card.status === 'complete'
  const usable = !!c.primary
  el.classList.toggle('pending', !usable)
  el.classList.toggle('stale', done && Date.now() - cardShownAt > STALE_MS)
  // A WRAP card is labelled "Wrapping up"; a HELP press while the call sounded like it was ending only
  // when the line is a next step (it may have answered a question they just asked instead).
  el.classList.toggle('wrap', card.origin === 'wrap_requested' || (card.wrap === true && c.move === 'confirm_next_step'))
  // Any wrap request, whatever its move: after closing words the next-step question can be in FOLLOW.
  el.classList.toggle('wrap-ask', card.origin === 'wrap_requested' || card.wrap === true)
  $('hcBadge').hidden = !card.mock
  // An answer that never finished (failed, timed out, cancelled by Pause/Stop) is never advice.
  const cut = card.status === 'cancelled' || card.status === 'superseded'
  const broken = card.status === 'failed' || card.status === 'timeout' || cut
  // Its read of the moment is hidden too: it never passed the checks.
  $('hcHappening').textContent = broken ? '' : c.happening ?? ''
  const su = card.setup
  $('hcFor').textContent = su ? `For ${su.account || 'account not set'} · ${DEPLOY_LABEL[su.deployment] ?? 'deployment not sure'}` : ''
  const prim = $('hcPrimary')
  // When HELP doesn't finish, the approved note found at the press stays on the card: say so plainly.
  const still = card.passage ? '<span class="hc-couldnt">You still have the approved note below.</span>' : ''
  if (usable && broken) {
    // A line that streamed in but whose answer then failed or was cut off is shown struck through.
    const why = card.error ?? (cut ? 'the answer was cut off before it finished its checks' : "the answer didn't finish its checks")
    prim.innerHTML = `<span class="struck">${esc(c.primary!)}</span><span class="hc-dontuse">Don't use this line: ${esc(why)}</span>${still}`
  } else if (usable) {
    prim.innerHTML = `<span class="kind">${c.primary_kind === 'say' ? 'Say' : 'Ask'}</span>${esc(c.primary_kind === 'ask' ? `"${c.primary}"` : c.primary!)}`
  } else if (cut) {
    prim.innerHTML = still ? `HELP stopped before it finished a line.${still}` : 'Cancelled.'
  } else if (broken) {
    const err = card.error ?? 'HELP could not produce a usable line. Press HELP again.'
    prim.innerHTML = still ? `HELP couldn't finish a line.<span class="hc-couldnt">${esc(err)} You still have the approved note below.</span>` : esc(err)
  } else {
    prim.textContent = PENDING_TEXT[card.status] ?? ''
  }
  renderPassage(card)
  const fol = $('hcFollow')
  fol.hidden = !c.follow_up || broken
  fol.textContent = c.follow_up ?? ''
  // Shown as soon as they're certain, while the line still streams; the finished card's checks replace them.
  const checks = broken ? [] : card.checks ?? []
  $('hcChecks').hidden = checks.length === 0
  $('hcChecks').textContent = checks.join(' ')
  const warns = [...card.warnings]
  if (c.note && done) warns.push(c.note)
  $('hcWarn').hidden = warns.length === 0
  $('hcWarn').textContent = warns.join(' · ')
  $('hcSources').hidden = card.sources.length === 0
  $('hcSourceList').innerHTML = card.sources.map((x) => `<div><b>${esc(x.label)}</b>: ${esc(x.detail)}</div>`).join('')
  const t = card.timing
  const ms = (x: number | null) => (x === null ? '' : `${(x / 1000).toFixed(1)} s`)
  const age = done ? ` · ${Math.round((Date.now() - cardShownAt) / 1000)} s ago` : ''
  const how = t.served_from_prefetch ? 'ready' : ms(t.first_usable_ms)
  $('hcMeta').textContent = [how ? `line ${how}` : '', card.model_label.split(' · ')[0]].filter(Boolean).join(' · ') + age
  el.querySelectorAll<HTMLButtonElement>('.fb').forEach((b) => (b.disabled = !done))
}

/** The request whose approved note is on the card (its "Whole note" folds shut when a new press replaces it). */
let passageFor: string | null = null

/** The approved passage found at the press: compact, under the line; marked once the finished card cites it. */
function renderPassage(ev: HelpCardEvent): void {
  const p = ev.passage ?? null
  $('hcPassage').hidden = !p
  if (!p) return
  if (passageFor !== ev.request_id) {
    passageFor = ev.request_id
    $<HTMLDetailsElement>('hcpMore').open = false
  }
  const label = passageLabel(p)
  $('hcpLabel').textContent = label
  $('hcpLabel').title = label
  $('hcpUsed').hidden = !(p.used_by_card && ev.status === 'complete')
  $('hcpSnippet').textContent = p.snippet
  $('hcpText').textContent = p.text
  $('hcpSource').textContent = p.source_ref
}

api.onHelp((raw) => {
  const ev = raw as HelpCardEvent
  // Only the newest request is ever displayed; an older one can't overwrite it.
  if (card && ev.seq < card.seq) return
  if (!card || ev.request_id !== card.request_id) {
    cardShownAt = Date.now()
    el_resetFeedback()
  }
  // A finished card is never rewritten in place.
  if (card && card.request_id === ev.request_id && card.status === 'complete') return
  card = ev
  if (ev.status === 'complete') cardShownAt = Date.now()
  renderCard()
})

api.onHelpNotice((msg) => showBanner('info', msg))
// Hotkey press: the window comes up without taking focus; bring the card into view.
api.onHelpFocus(() => $('helpCard').scrollIntoView({ block: 'nearest' }))
api.onAppNotice((n) => {
  showBanner(n.level, n.text)
  addActivity(n.level, n.text)
})

const DEPLOY_LABEL: Record<string, string> = { saas: 'SaaS', self_hosted: 'self-hosted', unknown: 'deployment not sure' }

// ---- HELP-ready light ----
function renderReady(r: ReadyState | undefined): void {
  const el = $('helpReady')
  const state = r?.readiness ?? 'checking'
  el.className = `ready-light ${state === 'ready' ? 'ready' : state === 'practice' || state === 'checking' ? 'practice' : state === 'offline' || state === 'busy' ? 'warn' : 'bad'}`
  $('helpReadyText').textContent = r?.message ?? 'Checking HELP…'
}
api.onHelpReady((r) => renderReady(r))
$('helpReady').addEventListener('click', async () => renderReady((await api.helpCheckReady()) ?? undefined))

// ---- "Still on a call?" ----
let idleTimer: ReturnType<typeof setInterval> | null = null
api.onIdle((st) => {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
  $('idleBanner').hidden = !st.warning
  if (!st.warning) return
  const until = Date.now() + (st.seconds ?? 60) * 1000
  const tick = () => { $('idleLeft').textContent = String(Math.max(0, Math.ceil((until - Date.now()) / 1000))) }
  tick()
  idleTimer = setInterval(tick, 1000)
})
$('idleKeep').addEventListener('click', () => {
  $('idleBanner').hidden = true
  void api.stillHere()
})

function el_resetFeedback(): void {
  $('helpCard').querySelectorAll('.fb').forEach((b) => b.classList.remove('chosen'))
  $('hcBadReasons').hidden = true
}

async function pressHelp(): Promise<void> {
  const r = await api.helpPress()
  if (!r.ok) showBanner('info', r.reason)
}

$('helpBtn').addEventListener('click', () => void pressHelp())
$('wrapBtn').addEventListener('click', async () => {
  const r = await api.helpWrap()
  if (!r.ok) showBanner('info', r.reason)
})
$('helpCard').querySelectorAll<HTMLButtonElement>('.fb').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!card) return
    const type = b.dataset.fb!
    $('helpCard').querySelectorAll('.fb').forEach((x) => x.classList.toggle('chosen', x === b))
    $('hcBadReasons').hidden = type !== 'bad'
    await api.helpFeedback({ card_id: card.request_id, type })
    addActivity('info', `Feedback recorded: ${b.textContent}`)
  }),
)
$('hcBadReasons').querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!card) return
    await api.helpFeedback({ card_id: card.request_id, type: 'bad', bad_reason: b.dataset.reason })
    $('hcBadReasons').hidden = true
    addActivity('info', `Feedback recorded: Bad (${b.textContent})`)
  }),
)
setInterval(() => { if (card?.status === 'complete') renderCard() }, 5000)

// ---- call setup strip ----
function saveSetup(): void {
  void api.helpSetSetup({
    call_type: $<HTMLSelectElement>('csType').value,
    call_goal: $<HTMLInputElement>('csGoal').value,
    desired_outcomes: $<HTMLInputElement>('csOutcomes').value.split(',').map((x) => x.trim()).filter(Boolean),
    account: $<HTMLInputElement>('csAccount').value,
    deployment: $<HTMLSelectElement>('csDeploy').value,
  })
}
for (const id of ['csType', 'csGoal', 'csOutcomes', 'csAccount', 'csDeploy']) $(id).addEventListener('change', saveSetup)
initAccountMemory(api)
initCallPlan(api)

// ---- tap-to-name speaker labels (per call; never required for HELP) ----
let labelCluster: string | null = null
$('transcript').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.who.clickable')
  if (!el?.dataset.cluster) return
  labelCluster = el.dataset.cluster
  const pop = $('labelPop')
  const r = el.getBoundingClientRect()
  pop.style.left = `${Math.min(window.innerWidth - 310, r.left)}px`
  pop.style.top = `${r.bottom + 6}px`
  $<HTMLInputElement>('lpName').value = labels.get(labelCluster)?.name ?? ''
  $('lpTitle').textContent = `Who is speaker ${/s(\d+)$/.exec(labelCluster)?.[1] ?? '?'}? (this call only)`
  pop.hidden = false
  $<HTMLInputElement>('lpName').focus()
})
$('labelPop').querySelectorAll<HTMLButtonElement>('button[data-role]').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!labelCluster) return
    const label = { cluster: labelCluster, role: b.dataset.role as SpeakerLabel['role'], name: $<HTMLInputElement>('lpName').value.trim() || null }
    const r = await api.helpSetLabel(label)
    if (r.ok) labels.set(label.cluster, label)
    $('labelPop').hidden = true
    renderTranscript()
  }),
)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('labelPop').hidden = true })
document.addEventListener('click', (e) => {
  const pop = $('labelPop')
  if (!pop.hidden && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest('.who.clickable')) pop.hidden = true
})

// ---- call notes panel: a running summary of the call, kept after Stop for the review ----
let notesState: CallNotesState | null = null
const NOTE_KIND: Record<string, string> = { timeline: 'Timeline', decision_process: 'Decision', current_tooling: 'Tools', success_criteria: 'Success', team: 'Team', budget: 'Budget', other: '' }
const NOT_COVERED: Record<string, string> = { timeline: 'timeline', decision_process: 'decision process', current_tooling: 'current tools', success_criteria: 'success criteria' }

function notesStatusText(s: CallNotesState): string {
  const sec = s.updated_at === null ? null : Math.max(0, Math.round((Date.now() - s.updated_at) / 1000))
  const age = sec === null ? '' : sec < 10 ? 'updated just now' : sec < 90 ? `updated ${sec} s ago` : `updated ${Math.round(sec / 60)} min ago`
  const withAge = (x: string) => (age ? `${age} · ${x}` : x)
  switch (s.status) {
    case 'blocked': return `not updating: ${s.problem ?? "Claude can't be used right now"}`
    case 'updating': return withAge('updating…')
    case 'paused': return withAge('paused')
    case 'finishing': return withAge('finishing the last minutes…')
    case 'stopped': return withAge('call ended')
    default: return age || 'starts after about a minute of the other side talking'
  }
}

function renderNotes(): void {
  const s = notesState
  // Switched off in Setup: nothing to show on the call screen.
  $('notesPanel').hidden = !s || s.status === 'off'
  if (!s || s.status === 'off') return
  $('notesBadge').hidden = !s.mock
  $('notesStatus').textContent = `· ${notesStatusText(s)}`
  const n = s.notes
  // Hover shows when it was said (from this call's transcript on screen).
  const said = (it: CallNoteItem) => {
    const t = turns.get(it.turn_ids[0] ?? '')
    return t ? ` title="Said at ${fmtMs(t.start_ms)}"` : ''
  }
  const list = (title: string, rows: Array<{ it: CallNoteItem; tag?: string; cls?: string }>) =>
    rows.length
      ? `<div class="nt-sec"><div class="nt-h">${title}</div><ul>${rows.map((r) => `<li${said(r.it)}>${r.tag ? `<span class="nt-k ${r.cls ?? ''}">${r.tag}</span> ` : ''}${esc(r.it.text)}</li>`).join('')}</ul></div>`
      : ''
  const html = n
    ? [
        n.topic ? `<div class="nt-line"${said(n.topic)}><span class="nt-h">Talking about</span> ${esc(n.topic.text)}</div>` : '',
        list('Their questions, not answered yet', n.open_questions.map((it) => ({ it }))),
        list('They want', n.buyer_wants.map((it) => ({ it }))),
        list('Concerns they raised', n.concerns.map((it) => ({ it }))),
        list('Facts they shared', n.facts.map((it) => ({ it, tag: NOTE_KIND[it.kind] || undefined }))),
        list('Next steps', n.next_steps.map((it) => ({ it, tag: it.status === 'agreed' ? 'Agreed' : 'Proposed', cls: it.status }))),
        n.not_covered.length ? `<div class="nt-line"><span class="nt-h">Not covered yet</span> ${n.not_covered.map((k) => esc(NOT_COVERED[k] ?? k)).join(' · ')}</div>` : '',
      ].join('')
    : ''
  $('notesBody').innerHTML = html || '<div class="muted small">Nothing noted yet.</div>'
}

api.onCallNotes((raw) => {
  notesState = raw as CallNotesState | null
  renderNotes()
})
// A new call starts with an empty panel (the last call's notes stay up until then).
api.onSession((raw) => {
  const ev = raw as SessionEvent
  if (ev.type === 'state' && ev.state === 'checking') {
    notesState = null
    renderNotes()
  }
})
setInterval(() => { if (notesState) $('notesStatus').textContent = `· ${notesStatusText(notesState)}` }, 5000)
void (api.helpCallNotes() as Promise<CallNotesState | null>).then((s) => {
  notesState = s
  renderNotes()
})
void (api.helpInfo() as Promise<{ settings?: { call_notes?: boolean } } | null>).then((i) => {
  $<HTMLInputElement>('aiNotes').checked = i?.settings?.call_notes !== false
})
$('aiNotes').addEventListener('change', async () => {
  const s = (await api.helpSetSettings({ call_notes: $<HTMLInputElement>('aiNotes').checked })) as { call_notes?: boolean } | undefined
  if (s) $<HTMLInputElement>('aiNotes').checked = s.call_notes !== false
})

// ---- setup: Claude key, model, prefetch, knowledge ----
async function refreshHelpInfo(): Promise<void> {
  helpInfo = await api.helpInfo()
  if (!helpInfo) {
    kbMessage("HELP didn't start, so knowledge files can't be added. Send me Diagnostics → Save support files.")
    return
  }
  $('aiDone').hidden = !helpInfo.hasKey
  $('aiForm').hidden = helpInfo.hasKey
  $('aiKeyChange').hidden = !helpInfo.hasKey
  $('aiStep').classList.toggle('done', helpInfo.hasKey)
  $<HTMLSelectElement>('aiModel').value = helpInfo.settings.model
  $<HTMLInputElement>('aiPrefetch').checked = helpInfo.settings.prefetch
  const su = helpInfo.setup
  $<HTMLSelectElement>('csType').value = su.call_type
  $<HTMLInputElement>('csGoal').value = su.call_goal
  $<HTMLInputElement>('csOutcomes').value = su.desired_outcomes.join(', ')
  $<HTMLInputElement>('csAccount').value = su.account
  $<HTMLSelectElement>('csDeploy').value = su.deployment ?? 'unknown'
  $('kbPath').textContent = helpInfo.knowledgeDir ? `Knowledge folder: ${helpInfo.knowledgeDir}` : ''
  $('hotkeyHint').textContent = (helpInfo.hotkeyRegistered ? 'HELP: Ctrl+Alt+H' : 'Ctrl+Alt+H unavailable (used by another app) - use the HELP button') +
    ((helpInfo as { wrapHotkeyRegistered?: boolean }).wrapHotkeyRegistered ? ' · WRAP: Ctrl+Alt+W' : ' · Ctrl+Alt+W unavailable - use the WRAP button') +
    (hideHotkey ? ` · hide/show: ${hideHotkey}` : '')
  renderReady(helpInfo.ready)
  renderPlaybook(helpInfo.playbook ?? null)
  $('helpBtn').title = helpInfo.hotkeyRegistered ? 'HELP (Ctrl+Alt+H)' : 'HELP'
}

async function renderKnowledge(docs?: KnowledgeDocMeta[]): Promise<void> {
  const list = docs ?? ((await api.knowledgeList()) as KnowledgeDocMeta[])
  const today = new Date()
  $('kbList').innerHTML = list.length
    ? list.map((d) => {
        // Same rule as the knowledge index: review_by is a local calendar date, stale from the day after.
        const stale = isPastReview(d.review_by, today)
        const expires = expiresLabel(d.review_by, today)
        return `<div class="kb-doc"><span class="grow" title="${esc(d.source)}"><b>${esc(d.title)}</b> <span class="muted">· ${esc(d.category)} · v${esc(d.version)}${d.applies_to.length ? ` · ${esc(d.applies_to.join(', '))}` : ''}</span></span>
          ${stale ? '<span class="tag tag-warn" title="Past its review date: HELP mentions it exists but states nothing from it">Stale</span>' : ''}
          ${expires ? `<span class="tag tag-warn" title="After its review date HELP stops stating facts from it. Ask for a refresh before then.">${expires}</span>` : ''}
          ${d.needs_reapproval ? '<span class="tag tag-warn" title="This file changed after you approved it. HELP will not use it until you approve the new content.">Changed: approve again</span>' : ''}
          <label class="inline check"><input type="checkbox" data-doc="${esc(d.doc_id)}" ${d.approved ? 'checked' : ''}/> Approved</label>
          <button class="btn btn-ghost btn-sm" data-remove="${esc(d.doc_id)}" title="Take this file out of use (moved to the _removed folder, not deleted)">Remove</button></div>`
      }).join('')
    : '<div class="muted small">No documents yet. HELP still works: it asks good questions and offers follow-ups instead of stating facts.</div>'
}

$('kbList').addEventListener('change', async (e) => {
  const cb = e.target as HTMLInputElement
  if (!cb.dataset.doc) return
  const r = await api.knowledgeApprove(cb.dataset.doc, cb.checked)
  if (r.ok) void renderKnowledge(r.docs)
})
function kbMessage(text: string): void {
  $('kbMsg').textContent = text
  $('kbMsg').hidden = !text
}
$('kbList').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-remove]')
  if (!b?.dataset.remove) return
  if (!confirm('Take this file out of use? It moves to the _removed folder inside the knowledge folder, so you can put it back.')) return
  const r = (await api.knowledgeRemove(b.dataset.remove)) as { ok: boolean; docs: KnowledgeDocMeta[] }
  kbMessage(r.ok ? 'Removed. HELP no longer uses it.' : 'Could not remove that file.')
  void renderKnowledge(r.docs)
})
async function importKnowledge(mode: 'folder' | 'files'): Promise<void> {
  const r = (await api.knowledgeImport(mode)) as { ok: boolean; canceled?: boolean; error?: string; added?: string[]; skipped?: Array<{ name: string; reason: string }>; docs?: KnowledgeDocMeta[] }
  if (r.canceled) return
  if (!r.ok) return kbMessage(r.error ?? 'Could not add files.')
  const skipped = r.skipped?.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((x) => `${x.name} (${x.reason})`).join('; ')}.` : ''
  kbMessage(`${r.added?.length ? `Added ${r.added.length} file(s), not approved yet: tick Approved on each one you've read.` : 'No knowledge files found there.'}${skipped}`)
  void renderKnowledge(r.docs)
}
$('kbAddFolder').addEventListener('click', () => void importKnowledge('folder'))
$('kbAddFiles').addEventListener('click', () => void importKnowledge('files'))
$('kbOpen').addEventListener('click', async () => {
  const r = (await api.knowledgeOpenFolder()) as { ok: boolean; path?: string; error?: string }
  kbMessage(r.ok ? '' : `Windows could not open the folder${r.error ? ` (${r.error})` : ''}. It is here: ${r.path ?? 'unknown'}. Or use "Add a folder…" instead.`)
})
$('kbReindex').addEventListener('click', async () => renderKnowledge(await api.knowledgeReindex()))
$('pbOpen').addEventListener('click', () => void api.playbookOpen())

// ---- playbook status: which one HELP uses, a broken edit, a newer built-in version ----
type PlaybookInfo = { using: 'yours' | 'built_in'; version: string; built_in_version: string; problem: string | null; newer_built_in: boolean; error?: string | null }
function renderPlaybook(pb: PlaybookInfo | null): void {
  const el = $('pbStatus')
  if (!pb) {
    el.textContent = ''
    return
  }
  const check = ' <button class="btn btn-ghost btn-sm" data-pb="check">Check again</button>'
  if (pb.error) {
    el.innerHTML = `<span class="err-text">${esc(pb.error)}</span> HELP still uses ${pb.using === 'yours' ? 'your edited playbook' : 'the built-in playbook'} (${esc(pb.version)}). ` +
      '<button class="btn btn-ghost btn-sm" data-pb="builtIn">Try again</button> <button class="btn btn-ghost btn-sm" data-pb="mine">Keep mine</button>'
  } else if (pb.problem) {
    el.innerHTML = `<span class="err-text">Your edited playbook has a mistake: ${esc(pb.problem)}. HELP uses the built-in one (${esc(pb.built_in_version)}) until it's fixed.</span>${check}`
  } else if (pb.newer_built_in) {
    el.innerHTML = `A different built-in playbook is available (${esc(pb.built_in_version)}); HELP is using your edited copy (${esc(pb.version)}). ` +
      '<button class="btn btn-ghost btn-sm" data-pb="builtIn">Use the new one (keeps a backup of yours)</button> <button class="btn btn-ghost btn-sm" data-pb="mine">Keep mine</button>'
  } else {
    el.innerHTML = `${pb.using === 'yours' ? 'HELP uses your edited playbook' : 'HELP uses the built-in playbook'} (${esc(pb.version)}). Edits apply from the next call.${check}`
  }
}
$('pbStatus').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-pb]')
  if (!b) return
  const action = b.dataset.pb
  try {
    renderPlaybook((await (action === 'builtIn' ? api.playbookUseBuiltIn() : action === 'mine' ? api.playbookKeepMine() : api.playbookInfo())) as PlaybookInfo | null)
  } catch {
    $('pbStatus').innerHTML = '<span class="err-text">That didn\'t work. Close the playbook file if it\'s open, then try again.</span> <button class="btn btn-ghost btn-sm" data-pb="check">Check again</button>'
  }
})
$('aiKeySave').addEventListener('click', async () => {
  const r = await api.helpSetKey($<HTMLInputElement>('aiKeyInput').value)
  $<HTMLInputElement>('aiKeyInput').value = ''
  const msg = $('aiMsg')
  msg.className = `msg ${r.ok ? 'ok' : 'err'}`
  msg.textContent = r.ok ? 'Saved. Takes effect on the next call.' : r.error
  await refreshHelpInfo()
})
$('aiKeyChange').addEventListener('click', () => { $('aiForm').hidden = false; $('aiKeyChange').hidden = true })
$('aiModel').addEventListener('change', async () => { await api.helpSetSettings({ model: $<HTMLSelectElement>('aiModel').value }); await refreshHelpInfo() })
$('aiPrefetch').addEventListener('change', async () => { await api.helpSetSettings({ prefetch: $<HTMLInputElement>('aiPrefetch').checked }); await refreshHelpInfo() })

let benchFile = ''
$('benchRun').addEventListener('click', async () => {
  $<HTMLButtonElement>('benchRun').disabled = true
  $('benchOpen').hidden = true
  $('benchStatus').textContent = 'Starting…'
  const r = await api.helpBenchmark({ repeats: Number($<HTMLSelectElement>('benchRepeats').value), includeMine: $<HTMLInputElement>('benchMine').checked })
  $<HTMLButtonElement>('benchRun').disabled = false
  if (!r.ok) {
    $('benchStatus').textContent = r.reason
    return
  }
  benchFile = r.reportFile
  $('benchStatus').textContent = 'Done. Report saved.'
  $('benchOpen').hidden = false
  $('benchSummary').hidden = false
  $('benchSummary').textContent = r.markdown
})
$('benchOpen').addEventListener('click', () => { if (benchFile) void api.helpOpenReport(benchFile) })
api.onBenchmarkProgress((p) => { $('benchStatus').textContent = `${p.done}/${p.total} · ${p.scenario}` })

void (async () => {
  await refreshHelpInfo()
  await renderKnowledge()
})()

initWrapup(api)
initPressModes(api)
initPlanPress(api, (text) => showBanner('info', text))
initAccountNotes(api)
initForNextTime(api)

void (async () => {
  const info = await api.info()
  hasKey = info.hasApiKey
  hideHotkey = info.hideHotkey ?? null
  if (hideHotkey) void refreshHelpInfo()
  $<HTMLInputElement>('hideCapture').checked = info.settings?.hide_from_capture ?? true
  $('demoTag').hidden = !info.demoMode
  await refreshConfig()
  setButtons()
  renderSources()
  renderTranscript()
  showView(isReady() ? 'call' : 'setup')
  void renderCallsInfo()
})()
