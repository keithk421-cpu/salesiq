/**
 * The card shows what it heard (M3 A).
 *
 * - One muted line at the top of the card: Heard: "…their words" (Speaker · 4 s ago). The words are
 *   the other side's at the press, so Keith can tell at a glance whether the card is about the moment
 *   he's in. In the compact strip it is one line, cut with "…".
 * - The compact strip's single status dot becomes two: Them (meeting audio) and You (mic), from the
 *   same capture health the source tiles show: green listening, grey quiet, amber not transcribing
 *   (red when no audio is arriving at all).
 */
import type { CopilotApi } from '../preload/preload'
import type { SessionEvent } from '../main/session'
import type { HelpCardEvent } from '../shared/help'
import { HEALTH_LABEL } from '../shared/captureHealth'

export function initHeard(api: CopilotApi): void {
  // A direct child of the card, first: the compact strip hides the card's top row.
  const line = document.createElement('div')
  line.id = 'hcHeard'
  line.className = 'hc-heard'
  line.hidden = true
  const label = document.createElement('span')
  label.className = 'hh-label'
  label.textContent = 'Heard: '
  const words = document.createElement('span')
  words.className = 'hh-words'
  // The compact strip has room for about half: there it shows their latest words (styles.css).
  const short = document.createElement('span')
  short.className = 'hh-words hh-short'
  const who = document.createElement('span')
  who.className = 'hh-who'
  line.append(label, words, short, who)
  document.getElementById('helpCard')?.prepend(line)

  let seq = -1
  api.onHelp((raw) => {
    const ev = raw as HelpCardEvent
    // Only the newest request is shown (the same rule as the card itself).
    if (ev.seq < seq) return
    seq = ev.seq
    const h = ev.heard ?? null
    line.hidden = !h
    if (!h) return
    words.textContent = `"${h.text}"`
    short.textContent = `"${tail(h.text, COMPACT_CHARS)}"`
    who.textContent = ` (${h.speaker} · ${agoText(h.ago_ms)})`
    line.title = "What this card answers: the other side's latest words when you pressed."
  })

  const dots = { system_remote: document.getElementById('hdThem'), local_mic: document.getElementById('hdYou') }
  const pair = document.getElementById('healthDots')
  api.onSession((raw) => {
    const ev = raw as SessionEvent
    // A new call numbers its presses from 1 again.
    if (ev.type === 'state' && ev.state === 'checking') seq = -1
    // Only while live: between calls and paused both would be grey, and Start or Resume needs the room on the strip.
    if (ev.type === 'state' && pair) pair.hidden = ev.state !== 'live'
    if (ev.type !== 'stream_status') return
    const el = dots[ev.status.stream]
    if (!el) return
    const { text, cls, hint } = HEALTH_LABEL[ev.status.health ?? 'idle']
    el.className = `hd ${cls}`.trim()
    el.title = `${ev.status.stream === 'local_mic' ? 'You (your mic)' : 'Them (meeting audio)'}: ${text}. ${hint}`
  })
}

/** About what fits on the compact strip's line next to "Heard:" and who said it. */
const COMPACT_CHARS = 38

/** The end of the words, from a word start, with "…" when cut (their latest words are what matter). */
export function tail(text: string, max: number): string {
  const t = text.replace(/^…/, '')
  if (t.length <= max) return text
  const end = t.slice(t.length - max)
  const sp = end.indexOf(' ')
  return `…${sp >= 0 && sp < max / 2 ? end.slice(sp + 1) : end}`
}

/** "4 s ago", "just now" (still talking at the press), "1 min ago". */
export function agoText(ms: number): string {
  if (!(ms >= 1000)) return 'just now'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}
