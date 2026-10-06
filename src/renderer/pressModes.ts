/**
 * Smarter presses on the call screen (M3):
 * - the card says what kind of press it answered: "Opening", "Next step" (they asked about a pilot,
 *   rollout, pricing or something for their boss) or "Another angle" (Keith pressed again), next to
 *   the line like "Wrapping up" (styles.css, .help-card[data-press]);
 * - the WRAP button carries a small quiet tag with the call's latest buying signal ("pilot asked ·
 *   14:22"), so Keith knows the next WRAP builds on it. Cleared when a new call starts;
 * - the after-call review marks a card Keith pressed again on: "You pressed for another angle".
 * Nothing pops up: the labels ride on cards Keith pressed for, the tag is quiet state.
 */
import type { CopilotApi } from '../preload/preload'
import type { CallCard, HelpCardEvent } from '../shared/help'

const SIGNAL_TAG: Record<string, string> = { pilot: 'pilot asked', rollout: 'rollout asked', pricing: 'pricing asked', send_to_boss: 'recap asked' }

/** Call time as m:ss (h:mm:ss past an hour), like the transcript. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function initPressModes(api: CopilotApi): void {
  const $ = (id: string) => document.getElementById(id) as HTMLElement

  // ---- the card's label: the newest request only, as the card itself (renderer.ts onHelp) ----
  let shownSeq = 0
  api.onHelp((raw) => {
    const ev = raw as HelpCardEvent
    if (ev.seq < shownSeq) return
    shownSeq = ev.seq
    const mode = ev.press_mode ?? null
    const el = $('helpCard')
    if (mode) el.dataset.press = mode
    else delete el.dataset.press
  })

  // ---- the WRAP button's tag: the latest buying signal of this call ----
  const tag = document.createElement('span')
  tag.id = 'wrapSignal'
  tag.className = 'wrap-signal'
  tag.hidden = true
  $('wrapBtn').after(tag)
  const showSignal = (s: { kind: string; at_ms: number } | null) => {
    tag.hidden = !s
    tag.textContent = s ? `${SIGNAL_TAG[s.kind] ?? 'next step asked'} · ${clock(s.at_ms)}` : ''
    tag.title = s ? 'They asked about a next step: WRAP builds on it' : ''
  }
  api.onBuyingSignal(showSignal)
  void api.helpSignal().then(showSignal).catch(() => showSignal(null))

  api.onSession((raw) => {
    const ev = raw as { type?: string; state?: string }
    // A new call: request numbers start again, and the last call's signal is gone.
    if (ev.type === 'state' && ev.state === 'checking') {
      shownSeq = 0
      showSignal(null)
    }
  })

  // ---- the after-call review: a card Keith pressed again on for another angle ----
  const list = $('rvList')
  const markPassed = async () => {
    const fresh = [...list.querySelectorAll<HTMLElement>('.rv-card')].filter((c) => !c.dataset.passChecked)
    if (!fresh.length) return
    for (const c of fresh) c.dataset.passChecked = '1'
    let cards: CallCard[] = []
    try {
      cards = (await api.helpCallCards()) as CallCard[]
    } catch {
      return
    }
    const passed = new Set(cards.filter((c) => c.passed).map((c) => c.id))
    for (const c of fresh) {
      if (!passed.has(c.dataset.id ?? '')) continue
      const note = document.createElement('div')
      note.className = 'muted small rv-passed'
      note.textContent = 'You pressed for another angle'
      c.querySelector('.rv-line')?.after(note)
    }
  }
  new MutationObserver(() => void markPassed()).observe(list, { childList: true })
}
