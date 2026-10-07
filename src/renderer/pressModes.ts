/**
 * Smarter presses on the call screen (M3):
 * - the card says what kind of press it answered: "Opening", "Next step" (they asked about a pilot,
 *   rollout, pricing or something for their boss) or "Another angle" (Keith pressed again), next to
 *   the line like "Wrapping up" (styles.css, .help-card[data-press]); M4 adds "Must learn" (Keith clicked
 *   one of his must-learns on the plan line, planPress.ts);
 * - the WRAP button carries a small quiet tag with the call's latest buying signal ("pilot asked ·
 *   14:22"), so Keith knows the next WRAP builds on it. Shown only during a call (styles.css), cleared
 *   when a new call starts;
 * - the after-call review marks a card Keith pressed again on: "You pressed for another angle".
 * M5 Hold cards: a card whose move is no_move means "wait, with this question ready for the pause". The
 * card gets data-move from the first event that carries its move (MOVE is the first line, so the label
 * is there before the ASK streams in, and the card never restyles while Keith reads it): a small muted
 * "Hold · at the pause" tag at the top, "Hold ·" before the line in the compact strip (styles.css). The
 * ASK keeps its full weight: it's the one thing on the card Keith doesn't already know. The after-call
 * review labels such a card "Hold".
 * Nothing pops up: the labels ride on cards Keith pressed for, the tag is quiet state.
 */
import type { CopilotApi } from '../preload/preload'
import type { CallCard, HelpCardEvent } from '../shared/help'

const SIGNAL_TAG: Record<string, string> = { pilot: 'pilot', rollout: 'rollout', pricing: 'pricing', send_to_boss: 'recap' }
/** The tag's tooltip, which keeps the whole thing when the compact strip shortens it. */
const SIGNAL_TIP: Record<string, string> = { pilot: 'a pilot', rollout: 'rollout time', pricing: 'pricing', send_to_boss: 'a recap for their boss' }

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
  // M5: the Hold tag (shown by styles.css only on a card whose move is no_move), next to the MOCK badge.
  const hold = document.createElement('span')
  hold.className = 'hc-hold'
  hold.textContent = 'Hold · at the pause'
  hold.title = 'Wait for a pause, then ask this'
  $('hcBadge').after(hold)
  /** The request whose move set data-move: later events for it never change it. */
  let moveOf = ''
  api.onHelp((raw) => {
    const ev = raw as HelpCardEvent
    if (ev.seq < shownSeq) return
    shownSeq = ev.seq
    const mode = ev.press_mode ?? null
    const el = $('helpCard')
    if (mode) el.dataset.press = mode
    else delete el.dataset.press
    // M5: a new request starts unlabelled until its move arrives; then it keeps that one.
    if (moveOf !== ev.request_id) {
      const move = ev.content?.move
      if (move) {
        el.dataset.move = move
        moveOf = ev.request_id
      } else delete el.dataset.move
    }
  })

  // ---- the WRAP button's tag: the latest buying signal of this call ----
  const tag = document.createElement('span')
  tag.id = 'wrapSignal'
  tag.className = 'wrap-signal'
  tag.hidden = true
  $('wrapBtn').after(tag)
  const showSignal = (s: { kind: string; at_ms: number } | null) => {
    tag.hidden = !s
    if (!s) {
      tag.replaceChildren()
      tag.title = ''
      return
    }
    // "pilot asked · 14:22"; the compact strip shows just the kind ("pilot"), so HELP and the Them/You
    // dots always fit: " asked" and the time are spans it hides (styles.css). The tooltip keeps the time.
    const what = SIGNAL_TAG[s.kind] ?? 'next step'
    const asked = document.createElement('span')
    asked.className = 'ws-asked'
    asked.textContent = ' asked'
    const at = document.createElement('span')
    at.className = 'ws-at'
    at.textContent = ` · ${clock(s.at_ms)}`
    tag.replaceChildren(what, asked, at)
    tag.title = `They asked about ${SIGNAL_TIP[s.kind] ?? 'a next step'} at ${clock(s.at_ms)}: WRAP builds on it`
  }
  api.onBuyingSignal(showSignal)
  void api.helpSignal().then(showSignal).catch(() => showSignal(null))

  api.onSession((raw) => {
    const ev = raw as { type?: string; state?: string }
    // A new call: request numbers start again, and the last call's signal is gone.
    if (ev.type === 'state' && ev.state === 'checking') {
      shownSeq = 0
      moveOf = ''
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
    // M5: a Hold card reads "Hold" ahead of its line.
    const holds = new Set(cards.filter((c) => c.hold).map((c) => c.id))
    for (const c of fresh) {
      if (!holds.has(c.dataset.id ?? '')) continue
      c.dataset.move = 'no_move'
      const tag = document.createElement('span')
      tag.className = 'kind rv-hold'
      tag.textContent = 'Hold'
      c.querySelector('.rv-line')?.prepend(tag)
    }
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
