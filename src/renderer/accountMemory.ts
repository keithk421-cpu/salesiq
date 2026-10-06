/**
 * Account memory on the call screen: the account box suggests accounts from earlier calls, and when
 * the typed account has earlier calls, a "Last time with <account>" box shows what they left behind.
 * Open before Start; during the call it folds to a one-line chip Keith can open (and folds again when
 * a HELP card comes, so the card stays in view). "Reuse last setup" copies the last call's goal,
 * outcomes and deployment, as a Follow-up, and what it still had to learn (M3 call plan).
 *
 * M4 faster setup: before Start, when the typed account has earlier calls and Keith hasn't changed the
 * call type or deployment himself since the app opened or the last Stop, they fill in from the last
 * calls (the likely next call type, the deployment last set) and an empty Must learn takes what the
 * last call still had to learn. One quiet line in the box says so, with Undo. Never during a call.
 */
import type { CopilotApi } from '../preload/preload'
import type { AccountMemory, AccountMemoryKind } from '../shared/help'
import { accountKey } from '../shared/help'
import { currentMustLearn, fillMustLearn } from './callPlan'

type Summary = { account: string; calls: number; last_call_at: string }

const SECTIONS: Array<{ kind: AccountMemoryKind; title: string }> = [
  { kind: 'promised', title: 'You promised' },
  { kind: 'they_owe', title: 'They owe' },
  { kind: 'agreed', title: 'Agreed next step' },
  { kind: 'open', title: 'Still open' },
  { kind: 'to_learn', title: 'Still to learn' },
  { kind: 'wants', title: 'They want' },
  { kind: 'fact', title: 'What they told us' },
]

const IN_CALL = new Set(['checking', 'live', 'paused', 'stopping'])

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** "Sep 28" (with the year when it isn't this year), from a call day (YYYY-MM-DD) or a timestamp. */
function dayLabel(s: string | null): string {
  if (!s) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

export function initAccountMemory(api: CopilotApi): void {
  const input = $<HTMLInputElement>('csAccount')
  input.setAttribute('list', 'amAccounts')
  let accounts: Summary[] = []
  let memory: AccountMemory | null = null
  let shownKey = ''
  let seq = 0
  let inCall = false
  /** A one-line chip: from Start until Keith opens it, or whenever he folds it. */
  let folded = false
  let lastCardId = ''

  // ---- M4 faster setup ----
  const typeEl = $<HTMLSelectElement>('csType')
  const deployEl = $<HTMLSelectElement>('csDeploy')
  type Fields = { type: string; deploy: string; ml: string[] }
  /** Keith changed the call type or deployment himself since the app opened or the last Stop: leave them be. */
  let touched = false
  /** Set around the app's own 'change' events (they save the strip), so they don't count as his. */
  let byApp = false
  /** The call went live: its Stop starts the next setup fresh. A Start that failed or was stopped while checking doesn't. */
  let wentLive = false
  /** What the last fill set, and what was there before it (for Undo). ml null: the must-learns weren't filled. */
  let filled: { key: string; day: string; prev: Fields; set: { type: string; deploy: string; ml: string[] | null } } | null = null
  const fillLine = document.createElement('span')
  fillLine.className = 'am-filled muted small'
  fillLine.hidden = true
  $('amReuse').before(fillLine)

  async function refreshAccounts(): Promise<void> {
    accounts = ((await api.memoryAccounts()) as Summary[] | null) ?? []
    $('amAccounts').innerHTML = accounts.map((a) => `<option value="${esc(a.account)}"></option>`).join('')
  }

  function render(): void {
    const box = $('amBox')
    box.hidden = !memory
    if (!memory) return
    const n = memory.calls
    const chip = folded
    box.classList.toggle('am-chip', chip)
    $('amTitle').textContent = `Last time with ${memory.account} · ${dayLabel(memory.last_call_at)} (${n} call${n === 1 ? '' : 's'})`
    $('amCount').textContent = chip ? (memory.items.length ? `${memory.items.length} thing${memory.items.length === 1 ? '' : 's'} to remember` : '') : ''
    $('amToggle').setAttribute('aria-expanded', String(!chip))
    $('amReuse').hidden = chip || !memory.last_setup
    $('amBody').hidden = chip
    if (chip) return
    // Every item says which call it is from, ahead of the text, so "next week" reads as then, not now.
    const html = SECTIONS.map((s) => {
      const rows = memory!.items.filter((it) => it.kind === s.kind)
      if (!rows.length) return ''
      return `<div class="am-sec"><div class="nt-h">${s.title}</div><ul>${rows
        .map((it) => `<li><span class="am-date muted small">${esc(dayLabel(it.date))}</span> ${esc(it.text)}</li>`)
        .join('')}</ul></div>`
    }).join('')
    $('amBody').innerHTML = html || '<div class="muted small">Nothing noted from those calls.</div>'
  }

  function renderFill(): void {
    fillLine.hidden = !filled || inCall || !memory || folded
    if (fillLine.hidden) return
    fillLine.innerHTML = `Filled from the ${esc(filled!.day)} call · <button type="button" class="link am-undo">Undo</button>`
  }

  /** Set the call type and deployment, and save the strip (its fields save together on 'change'). */
  function setFields(type: string, deploy: string): void {
    typeEl.value = type
    deployEl.value = deploy
    byApp = true
    try {
      typeEl.dispatchEvent(new Event('change'))
    } finally {
      byApp = false
    }
  }

  /** Put back what was there before a fill (must-learns Keith added since stay). */
  function restore(f: NonNullable<typeof filled>): void {
    setFields(f.prev.type, f.prev.deploy)
    const set = f.set.ml
    if (set) fillMustLearn([...f.prev.ml, ...currentMustLearn().filter((x) => !set.includes(x))])
  }

  /** After the typed account was looked up: fill the rest in from its earlier calls (see the top). */
  function autoFill(): void {
    if (inCall) return
    if (filled && filled.key === shownKey) return
    // A different account now: what came from the last one goes back (a hand change would have ended
    // the fill already; must-learns Keith added since stay).
    if (filled) {
      const f = filled
      filled = null
      restore(f)
    }
    if (touched || !memory) return renderFill()
    const prev: Fields = { type: typeEl.value, deploy: deployEl.value, ml: currentMustLearn() }
    const type = memory.next_call_type ?? 'follow_up'
    const deploy = memory.last_deployment ?? prev.deploy
    const ml = !prev.ml.length && memory.last_setup?.must_learn?.length ? memory.last_setup.must_learn.slice(0, 3) : null
    // Nothing would change: no line.
    if (type === prev.type && deploy === prev.deploy && !ml) return renderFill()
    setFields(type, deploy)
    if (ml) fillMustLearn(ml)
    filled = { key: shownKey, day: dayLabel(memory.last_call_at), prev, set: { type, deploy, ml } }
    renderFill()
  }

  for (const el of [typeEl, deployEl]) {
    el.addEventListener('change', () => {
      if (byApp) return
      touched = true
      // He took over: Undo would now undo his own choice.
      filled = null
      renderFill()
    })
  }
  fillLine.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.am-undo') || !filled || inCall) return
    const f = filled
    filled = null
    restore(f)
    // Undo is his choice: the next account he types doesn't fill them in again.
    touched = true
    renderFill()
  })

  /** Look up the typed account (only one that earlier calls had, so typing doesn't query on every key). */
  async function check(): Promise<void> {
    const key = accountKey(input.value)
    if (key === shownKey) return
    shownKey = key
    const match = key ? accounts.find((a) => accountKey(a.account) === key) : undefined
    const mine = ++seq
    const m = match ? ((await api.memoryAccount(match.account)) as AccountMemory | null) : null
    if (mine !== seq) return
    memory = m
    render()
    autoFill()
    renderFill()
  }

  /** Look again even if the account didn't change (a call just ended or was deleted). */
  async function recheck(): Promise<void> {
    await refreshAccounts()
    shownKey = '\u0000'
    await check()
  }

  input.addEventListener('input', () => void check())
  input.addEventListener('change', () => void check())
  input.addEventListener('focus', () => void refreshAccounts().then(check))
  $('amToggle').addEventListener('click', () => {
    folded = !folded
    render()
    renderFill()
  })
  $('amReuse').addEventListener('click', () => {
    const su = memory?.last_setup
    if (!su) return
    // M4: Reuse is his choice; the fill line goes and the account no longer fills in by itself.
    touched = true
    filled = null
    renderFill()
    $<HTMLSelectElement>('csType').value = 'follow_up'
    $<HTMLInputElement>('csGoal').value = su.call_goal
    $<HTMLInputElement>('csOutcomes').value = su.desired_outcomes.join(', ')
    $<HTMLSelectElement>('csDeploy').value = su.deployment
    // The strip saves itself on change (all fields at once).
    $('csGoal').dispatchEvent(new Event('change'))
    // What the last call still had to learn (M3 call plan; saved on its own).
    if (su.must_learn?.length) fillMustLearn(su.must_learn)
  })
  api.onSession((raw) => {
    const ev = raw as { type: string; state?: string }
    if (ev.type !== 'state' || !ev.state) return
    const was = inCall
    inCall = IN_CALL.has(ev.state)
    if (inCall && !was) {
      folded = true
      render()
      renderFill()
    }
    // Nothing changes by itself during a call: no Undo from here on. (While it's only checking, the
    // line is hidden; if the Start fails, the setup is still his and Undo comes back.)
    if (ev.state === 'live' && !wentLive) {
      wentLive = true
      filled = null
    }
    // Stop clears the account box a moment later, and the call just held is now "last time". The box
    // stays a chip until then, so it doesn't flash open as the call ends.
    if (ev.state === 'stopped' || ev.state === 'idle') {
      // After a call, the next call's setup starts fresh: the account may fill the rest in again. A
      // Start that never went live leaves his choices (and the fill) as they were.
      if (wentLive) {
        touched = false
        filled = null
      }
      wentLive = false
      setTimeout(() => {
        if (!inCall) folded = false
        void recheck()
      }, 400)
    }
  })
  // A HELP card on screen: fold back to the chip so the box never pushes the card out of view.
  api.onHelp((raw) => {
    const id = (raw as { request_id?: string } | null)?.request_id ?? ''
    if (!inCall || !id || id === lastCardId) return
    lastCardId = id
    if (!folded) {
      folded = true
      render()
      renderFill()
    }
  })
  // Saved calls were deleted (by Keith or by the keep-calls limit): show only what is left.
  api.onCallsDeleted(() => void recheck())
  // The last call's wrap-up landing (it can finish after the next call with them started): look again
  // once when it's done, not on each of Keith's edits.
  let wrapStatus: string | null = null
  api.onWrapup((w) => {
    const status = (w as { status?: string } | null)?.status ?? null
    if (status !== wrapStatus && (status === 'ready' || status === 'failed')) void recheck()
    wrapStatus = status
  })
  // The strip is also filled in by the app itself (on open, after Stop), which fires no input events.
  setInterval(() => void check(), 1000)
  void recheck()
}
