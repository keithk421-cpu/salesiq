/**
 * Compact window (M2): "Compact" shrinks the window to a small strip that stays on top of Zoom during
 * a call; "Expand" brings the full window back. The main process moves and sizes the window; here the
 * page hides everything except HELP, WRAP, Start or Resume when they apply, a status dot, the card's
 * line with its checks and the approved note's first line (styles.css, body.compact). The window
 * always opens in normal mode.
 */
import type { CopilotApi } from '../preload/preload'

export function initCompact(api: CopilotApi): void {
  const $ = (id: string) => document.getElementById(id) as HTMLElement
  const compactBtn = $('compactBtn')
  const expandBtn = $('expandBtn')
  const dot = $('compactDot')

  const show = (on: boolean) => {
    document.body.classList.toggle('compact', on)
    compactBtn.hidden = on
    expandBtn.hidden = !on
    dot.hidden = !on
    // Coming back to the full window: the card is where Keith left it.
    if (!on) $('helpCard').scrollIntoView({ block: 'nearest' })
  }
  const toggle = async (on: boolean) => {
    try {
      show((await api.setCompact(on)).compact)
    } catch {
      // The window couldn't change size: stay as it is.
    }
  }
  compactBtn.addEventListener('click', () => void toggle(true))
  expandBtn.addEventListener('click', () => void toggle(false))

  // The status dot follows the top bar's status (hidden in compact): live, paused, getting ready.
  const pill = $('statusPill')
  const mirror = () => {
    dot.className = `compact-dot ${[...pill.classList].filter((c) => c !== 'pill').join(' ')}`.trim()
    dot.title = $('statusText').textContent ?? ''
  }
  new MutationObserver(mirror).observe(pill, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true, characterData: true })
  mirror()

  // Between calls the strip shows no card: the last call's line mustn't sit on a screen Keith shares
  // with the next customer (styles.css, body.compact:not(.in-call)).
  api.onSession((raw) => {
    const ev = raw as { type?: string; state?: string }
    if (ev.type === 'state') document.body.classList.toggle('in-call', IN_CALL.includes(ev.state ?? ''))
  })
}

/** The call states in which the main process keeps the strip on top and hidden from screen sharing (appRules callActive). */
const IN_CALL = ['checking', 'live', 'paused', 'stopping']
