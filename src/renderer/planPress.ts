/**
 * Click a must-learn mid-call (M4): during a live call, clicking an open or partial item on the plan
 * line (top of the Call notes panel, or the compact strip) is a HELP press for a line that gets there
 * from where the talk is. The card comes back labelled "Must learn" (styles.css, data-press="plan_item").
 *
 * - Only while live: a pointer cursor and a hover hint on those items then, nothing otherwise (the plan
 *   line stays on screen after the call, showing what it ended with).
 * - One at a time: a click while that card is still coming is ignored.
 * - Nothing pops up: the card replaces the one on screen, as a HELP press does.
 *
 * Kept in its own file so it doesn't touch the rest of the call screen: renderer.ts only calls
 * initPlanPress(). The plan line itself is drawn by callPlan.ts, which rebuilds it on every notes
 * update, so clicks and hovers are caught on the page (delegated) and read the item's data-item and
 * data-status. The main process checks the item is one of this call's must-learns (HelpService).
 */
import type { CopilotApi } from '../preload/preload'
import type { HelpCardEvent } from '../shared/help'

/** Items that can still be asked about (a done one is answered). */
const CLICKABLE = new Set(['open', 'partial'])
const ITEM = '#planLine .pl-item[data-item], #planCompact .pl-item[data-item]'
const HINT = 'Click for a line that gets there'
const FINISHED = new Set(['complete', 'failed', 'timeout', 'cancelled', 'superseded'])
/** If the card's events never arrive (a lost message), clicks work again after this long. */
const STUCK_MS = 20_000

export function initPlanPress(api: CopilotApi, notice: (text: string) => void): void {
  let live = false
  /** The newest card seen (request numbers start again each call). */
  let lastSeq = 0
  /** A click's press is in flight: the newest card number before it; cleared when a newer card finishes. */
  let waitFrom: number | null = null
  let guard: ReturnType<typeof setTimeout> | null = null

  const clickable = (el: HTMLElement) => CLICKABLE.has(el.dataset.status ?? '') && !!el.dataset.item

  function done(): void {
    waitFrom = null
    if (guard) clearTimeout(guard)
    guard = null
    document.body.classList.remove('pp-busy')
  }

  api.onSession((raw) => {
    const ev = raw as { type?: string; state?: string }
    if (ev.type !== 'state' || !ev.state) return
    live = ev.state === 'live'
    document.body.classList.toggle('pp-live', live)
    if (ev.state === 'checking') lastSeq = 0
    // Pause or Stop cancels the card that was coming.
    if (!live) done()
  })

  api.onHelp((raw) => {
    const ev = raw as HelpCardEvent
    if (ev.seq < lastSeq) return
    lastSeq = ev.seq
    // The click's card (or a HELP press after it, which replaces it) has finished: clicks work again.
    if (waitFrom !== null && ev.seq > waitFrom && FINISHED.has(ev.status)) done()
  })

  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(ITEM)
    if (!el || !live || waitFrom !== null || !clickable(el)) return
    waitFrom = lastSeq
    document.body.classList.add('pp-busy')
    guard = setTimeout(done, STUCK_MS)
    void api.helpPressPlanItem(el.dataset.item!).then(
      (r) => {
        if (r.ok) return
        done()
        if (r.reason) notice(r.reason)
      },
      () => done(),
    )
  })

  // The hint goes on the item's tooltip as the pointer arrives, so it shows only while live (callPlan.ts
  // sets the rest of the tooltip and redraws the line whenever the call state changes).
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(ITEM)
    if (!el) return
    const base = el.title.endsWith(`\n${HINT}`) ? el.title.slice(0, -HINT.length - 1) : el.title
    el.title = live && clickable(el) ? `${base}\n${HINT}` : base
  })
}
