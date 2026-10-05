/**
 * The wrap-up window after Stop (M2): what Arize owes them, what they owe, the agreed next step, what
 * was only proposed, and their questions still open. It opens by itself once per call, says
 * "Finishing notes and wrap-up…" while it's built, and a "Wrap-up" button next to the review button
 * reopens it. Keith ticks, edits, removes or adds items, and can ask for a follow-up email draft to copy.
 * Nothing is sent anywhere.
 *
 * Kept in its own file so it doesn't touch the rest of the call screen: renderer.ts only calls
 * initWrapup(). The "Wrap-up" button and the Setup checkbox are added here for the same reason.
 */
import type { CopilotApi } from '../preload/preload'
import type { SessionEvent } from '../main/session'
import type { CallWrapup, WrapupItem, WrapupSection } from '../shared/help'
import { WRAPUP_SECTIONS } from '../shared/help'

/** Plain section names (short: Keith reads them right after a call). */
const SECTION: Record<WrapupSection, string> = {
  we_owe: 'We owe them',
  they_owe: "They said they'd do",
  agreed: 'Agreed next steps',
  proposed: 'Proposed, not agreed',
  open_questions: 'Their questions, not answered yet',
}
const ADD_HINT: Record<WrapupSection, string> = {
  we_owe: "Something you said you'd send or do",
  they_owe: "Something they said they'd do",
  agreed: 'A next step they said yes to',
  proposed: 'A next step that was only suggested',
  open_questions: "A question of theirs you didn't answer",
}

type ItemResult = { ok: boolean; wrapup: CallWrapup | null }

export function initWrapup(api: CopilotApi): void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const clock = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
  }

  let wrap: CallWrapup | null = null
  let sessionState = 'idle'
  /** The call the window already opened by itself for (once per call). */
  let openedFor: string | null = null
  /** The draft now in the email box (Keith's edits there are kept until a new draft arrives). */
  let emailShown: string | null = null
  /** The section whose "+ Add" box is open. */
  let adding: WrapupSection | null = null
  /** An update arrived while Keith was typing in the list: drawn when he leaves the box. */
  let dirty = false
  /** The window was closed to show the card review; it comes back when the review closes. */
  let backAfterReview = false
  /** Start was pressed and the call hasn't gone live yet. */
  let starting = false
  /** When each line of this call was said (for the quotes). */
  const said = new Map<string, number>()

  // "Wrap-up" in the call controls, next to the card review (shown after Stop while there is one).
  const btn = document.createElement('button')
  btn.id = 'wrapupBtn'
  btn.className = 'btn btn-secondary btn-sm'
  btn.textContent = 'Wrap-up'
  btn.title = "What you owe them, what they owe you, the agreed next step and their open questions"
  btn.hidden = true
  $('reviewCallBtn').before(btn)

  // Setup, step 3: next to "Keep running call notes".
  const setting = document.createElement('label')
  setting.className = 'inline check'
  setting.title = "After Stop, lists what you promised, what they promised, the agreed next step and their open questions, for you to check. Can draft a follow-up email for you to copy."
  setting.innerHTML = '<input id="aiWrapup" type="checkbox" checked /> Wrap-up after each call'
  $('aiNotes').closest('label')?.after(setting)
  const box = $<HTMLInputElement>('aiWrapup')

  const open = () => {
    // The wrap-up needs the full window: leave the compact strip first (compact.ts).
    if (document.body.classList.contains('compact')) $('expandBtn').click()
    $('wrapupModal').hidden = false
    render()
  }
  const close = () => {
    $('wrapupModal').hidden = true
    adding = null
  }
  const isOpen = () => !$('wrapupModal').hidden
  const typing = () => {
    const a = document.activeElement
    return !!a && $('wuList').contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && (a as HTMLInputElement).type !== 'checkbox'
  }

  function statusText(w: CallWrapup): string {
    switch (w.status) {
      case 'building': return 'Finishing notes and wrap-up…'
      case 'drafting': return 'Writing the email…'
      case 'failed': return ''
      default: return w.account ? `· ${w.account}` : ''
    }
  }

  function itemRow(i: WrapupItem): string {
    const removed = i.state === 'removed'
    const at = said.get(i.turn_ids[0] ?? '')
    const meta = [
      i.who ? `Who: ${esc(i.who)}` : '',
      i.when ? `When: ${esc(i.when)}` : '',
      i.quote ? `<span class="wu-quote">“${esc(i.quote)}”</span>${at !== undefined ? ` · ${clock(at)}` : ''}` : '',
      i.added_by_keith ? 'Added by you' : '',
    ].filter(Boolean).join(' · ')
    return `<div class="wu-item ${i.state}" data-id="${esc(i.id)}">
      <input type="checkbox" class="wu-tick" ${i.state === 'confirmed' ? 'checked' : ''} ${removed ? 'disabled' : ''} title="Right: keep it" aria-label="Right" />
      <div><input class="input wu-text" value="${esc(i.text)}" maxlength="160" ${removed ? 'disabled' : ''} aria-label="Item" />${meta ? `<div class="wu-meta muted small">${meta}</div>` : ''}</div>
      ${removed ? '<button class="link wu-restore">Undo</button>' : '<button class="icon-btn wu-remove" title="Remove: this is wrong">✕</button>'}
    </div>`
  }

  function renderList(): void {
    const w = wrap
    if (!w) return
    dirty = false
    const building = w.status === 'building'
    $('wuList').innerHTML = WRAPUP_SECTIONS.map((s) => {
      const rows = w.items.filter((i) => i.section === s)
      return `<section class="wu-sec">
        <div class="wu-sec-head"><span class="nt-h">${SECTION[s]}</span><button class="link small" data-add="${s}">+ Add</button></div>
        ${rows.map(itemRow).join('') || (building ? '' : '<div class="muted small wu-none">Nothing noted.</div>')}
        ${adding === s ? `<div class="wu-new"><input class="input wu-new-text" data-section="${s}" maxlength="160" placeholder="${esc(ADD_HINT[s])}" /><button class="btn btn-sm btn-primary" data-save="${s}">Add</button></div>` : ''}
      </section>`
    }).join('')
    if (building) $('wuList').insertAdjacentHTML('afterbegin', '<div class="wu-building">Finishing notes and wrap-up… (you can add items meanwhile)</div>')
  }

  function render(): void {
    const w = wrap
    btn.hidden = !w || !['stopped', 'idle'].includes(sessionState)
    if (!w) {
      close()
      return
    }
    if (!isOpen()) return
    $('wuBadge').hidden = !w.mock
    $('wuStatus').textContent = statusText(w)
    const problem = w.status === 'failed' ? (w.error ?? "Couldn't build the wrap-up this time.") : w.error
    $('wuProblem').hidden = !problem
    $('wuProblemText').textContent = problem ?? ''
    $('wuRetry').hidden = w.status !== 'failed'
    // Don't redraw under Keith's cursor: it's drawn when he leaves the box.
    if (typing()) dirty = true
    else renderList()
    const usable = w.items.some((i) => i.state !== 'removed')
    const draft = $<HTMLButtonElement>('wuDraft')
    draft.disabled = !usable || w.status === 'building' || w.status === 'drafting'
    draft.textContent = w.status === 'drafting' ? 'Writing the email…' : w.email ? 'Draft the email again' : 'Draft follow-up email'
    draft.title = usable ? 'Uses the items you ticked and the ones you added (or all of them if you ticked none)' : 'Tick or add an item first'
    const e = w.email
    $('wuEmail').hidden = !e
    if (e && e.created_at !== emailShown) {
      emailShown = e.created_at
      $<HTMLInputElement>('wuSubject').value = e.subject
      $<HTMLTextAreaElement>('wuBody').value = e.body
      $('wuEmailBadge').hidden = !e.mock
      $('wuChecks').hidden = !e.checks.length
      delete $('wuChecks').dataset.edited
      $('wuChecks').innerHTML = e.checks.map((c) => `<div>${esc(c)}</div>`).join('')
      $('wuCopyMsg').textContent = ''
    }
  }

  function take(w: CallWrapup | null): void {
    if (w && wrap && w.session_id !== wrap.session_id) emailShown = null
    wrap = w
    // Opens by itself once per call (after Stop); the button reopens it.
    if (w && w.session_id !== openedFor && w.status === 'building') {
      openedFor = w.session_id
      open()
      return
    }
    render()
  }

  async function change(p: Promise<unknown>): Promise<void> {
    const r = (await p) as ItemResult
    if (!r.ok) $('wuMsg').textContent = "That didn't save. Try again."
    else $('wuMsg').textContent = ''
    if (r.wrapup) take(r.wrapup)
  }

  async function addFrom(input: HTMLInputElement | null): Promise<void> {
    const section = input?.dataset.section
    const text = input?.value.trim() ?? ''
    if (!section || !text) return
    adding = null
    input!.blur()
    await change(api.wrapupAddItem({ section, text }))
  }

  async function copy(text: string, what: string): Promise<void> {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // The clipboard API can refuse without focus: copy through a selected box instead.
      const t = document.createElement('textarea')
      t.value = text
      document.body.append(t)
      t.select()
      ok = document.execCommand('copy')
      t.remove()
    }
    $('wuCopyMsg').textContent = ok ? `${what} copied. Paste it into your email.` : "Couldn't copy. Select the text and press Ctrl+C."
  }

  // ---- list: tick, edit, remove, undo, add ----
  $('wuList').addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement
    const id = el.closest<HTMLElement>('.wu-item')?.dataset.id
    if (!id) return
    if (el.classList.contains('wu-tick')) void change(api.wrapupUpdateItem({ id, state: el.checked ? 'confirmed' : 'pending' }))
    else if (el.classList.contains('wu-text') && el.value.trim()) void change(api.wrapupUpdateItem({ id, text: el.value }))
  })
  $('wuList').addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const id = t.closest<HTMLElement>('.wu-item')?.dataset.id
    if (id && t.closest('.wu-remove')) void change(api.wrapupUpdateItem({ id, state: 'removed' }))
    else if (id && t.closest('.wu-restore')) void change(api.wrapupUpdateItem({ id, state: 'pending' }))
    const add = t.closest<HTMLElement>('[data-add]')?.dataset.add as WrapupSection | undefined
    if (add) {
      adding = add
      renderList()
      $('wuList').querySelector<HTMLInputElement>('.wu-new-text')?.focus()
    }
    if (t.closest('[data-save]')) void addFrom($('wuList').querySelector<HTMLInputElement>('.wu-new-text'))
  })
  $('wuList').addEventListener('keydown', (e) => {
    const el = e.target as HTMLInputElement
    if (el.classList.contains('wu-new-text')) {
      if (e.key === 'Enter') void addFrom(el)
      if (e.key === 'Escape') {
        e.stopPropagation()
        adding = null
        el.blur()
        renderList()
      }
    } else if (el.classList.contains('wu-text')) {
      if (e.key === 'Enter') el.blur()
      if (e.key === 'Escape') {
        // Cancels the edit, and the window stays open: the saved text comes back, so leaving the box saves nothing.
        e.stopPropagation()
        el.value = el.defaultValue
        el.blur()
      }
    }
  })
  $('wuList').addEventListener('focusout', () => {
    // Moving from one box to the next keeps the cursor; leaving the list draws what arrived meanwhile.
    setTimeout(() => { if (dirty && !typing()) renderList() }, 0)
  })

  // ---- buttons ----
  btn.addEventListener('click', open)
  $('wuDone').addEventListener('click', close)
  $('wuRetry').addEventListener('click', () => void change(api.wrapupRetry()))
  $('wuDraft').addEventListener('click', async () => {
    $<HTMLButtonElement>('wuDraft').disabled = true
    $('wuMsg').textContent = ''
    const r = (await api.wrapupDraft()) as { ok: boolean; reason?: string; wrapup: CallWrapup | null }
    if (!r.ok && r.reason) $('wuMsg').textContent = r.reason
    take(r.wrapup)
  })
  // The warnings are about the draft as written: once Keith edits it, say so (he checks the email as it is now).
  const editedSinceDraft = () => {
    const c = $('wuChecks')
    if (c.hidden || c.dataset.edited) return
    c.dataset.edited = '1'
    c.insertAdjacentHTML('afterbegin', '<div class="wu-checks-note">From the draft before your edits. Check the email as it is now.</div>')
  }
  $('wuBody').addEventListener('input', editedSinceDraft)
  $('wuSubject').addEventListener('input', editedSinceDraft)
  $('wuCopy').addEventListener('click', () => void copy($<HTMLTextAreaElement>('wuBody').value, 'Email'))
  $('wuCopySubject').addEventListener('click', () => void copy($<HTMLInputElement>('wuSubject').value, 'Subject'))
  $('wuReview').addEventListener('click', () => {
    backAfterReview = true
    close()
    $('reviewCallBtn').click()
  })
  // Back to the wrap-up when the card review closes.
  new MutationObserver(() => {
    if (!backAfterReview || !$('reviewModal').hidden) return
    backAfterReview = false
    // After this event: the Escape that closed the review mustn't close the wrap-up as well.
    setTimeout(() => { if (wrap) open() }, 0)
  }).observe($('reviewModal'), { attributes: true, attributeFilter: ['hidden'] })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close() })

  // ---- the call: a new Start closes it; lines on screen give the quotes their time ----
  api.onSession((raw) => {
    const ev = raw as SessionEvent
    if (ev.type === 'state') {
      sessionState = ev.state
      // The last call's wrap-up stays until the next call's arrives: a Start the buyer never joins
      // (back to idle) brings its button back. The button is hidden while the next call runs.
      if (ev.state === 'checking') {
        backAfterReview = false
        starting = true
        close()
      }
      // The next call's lines start (not after a Pause): the last call's quote times go.
      if (ev.state === 'live' && starting) {
        starting = false
        said.clear()
      }
      render()
    } else if (ev.type === 'turn') said.set(ev.event.turn.turn_id, ev.event.turn.start_ms)
  })
  api.onWrapup((raw) => take(raw as CallWrapup | null))
  // A reload while a wrap-up exists shows its button, without opening the window again.
  void (api.wrapupGet() as Promise<CallWrapup | null>).then((w) => {
    if (w) openedFor = w.session_id
    wrap = w
    render()
  })

  // ---- Setup, step 3 ----
  void (api.helpInfo() as Promise<{ settings?: { wrapup?: boolean } } | null>).then((i) => { box.checked = i?.settings?.wrapup !== false })
  box.addEventListener('change', async () => {
    const s = (await api.helpSetSettings({ wrapup: box.checked })) as { wrapup?: boolean } | undefined
    if (s) box.checked = s.wrapup !== false
  })
}
