/**
 * Account memory on the call screen: the account box suggests accounts from earlier calls, and when
 * the typed account has earlier calls, a "Last time with <account>" box shows what they left behind.
 * Open before Start; during the call it folds to a one-line chip Keith can open (and folds again when
 * a HELP card comes, so the card stays in view). "Reuse last setup" copies the last call's goal,
 * outcomes and deployment, as a Follow-up.
 */
import type { CopilotApi } from '../preload/preload'
import type { AccountMemory, AccountMemoryKind } from '../shared/help'
import { accountKey } from '../shared/help'

type Summary = { account: string; calls: number; last_call_at: string }

const SECTIONS: Array<{ kind: AccountMemoryKind; title: string }> = [
  { kind: 'promised', title: 'You promised' },
  { kind: 'they_owe', title: 'They owe' },
  { kind: 'agreed', title: 'Agreed next step' },
  { kind: 'open', title: 'Still open' },
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
  })
  $('amReuse').addEventListener('click', () => {
    const su = memory?.last_setup
    if (!su) return
    $<HTMLSelectElement>('csType').value = 'follow_up'
    $<HTMLInputElement>('csGoal').value = su.call_goal
    $<HTMLInputElement>('csOutcomes').value = su.desired_outcomes.join(', ')
    $<HTMLSelectElement>('csDeploy').value = su.deployment
    // The strip saves itself on change (all fields at once).
    $('csGoal').dispatchEvent(new Event('change'))
  })
  api.onSession((raw) => {
    const ev = raw as { type: string; state?: string }
    if (ev.type !== 'state' || !ev.state) return
    const was = inCall
    inCall = IN_CALL.has(ev.state)
    if (inCall && !was) {
      folded = true
      render()
    }
    // Stop clears the account box a moment later, and the call just held is now "last time". The box
    // stays a chip until then, so it doesn't flash open as the call ends.
    if (ev.state === 'stopped' || ev.state === 'idle') {
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
    }
  })
  // Saved calls were deleted (by Keith or by the keep-calls limit): show only what is left.
  api.onCallsDeleted(() => void recheck())
  // The strip is also filled in by the app itself (on open, after Stop), which fires no input events.
  setInterval(() => void check(), 1000)
  void recheck()
}
