/**
 * "What I know about <account>" (M4) on the call screen, under the Last time box: Keith's own notes on
 * the account he typed (first call or not), which he types or pastes in. Saved when he leaves the box
 * and with Save; Clear asks once. "Copy prep prompt" copies a request he pastes into Claude (Sumble,
 * Notion and Drive are connected there); he pastes the answer back here. The app sends nothing.
 *
 * Open before Start; during the call it folds to one line ("What I know · 6 lines") he can open, and
 * folds again when a HELP card comes, as the Last time box does. Kept in its own file: renderer.ts
 * only calls initAccountNotes().
 */
import type { CopilotApi } from '../preload/preload'
import type { AccountNotes } from '../shared/help'
import { ACCOUNT_NOTES_MAX_CHARS, accountKey } from '../shared/help'
import { plainAnswer } from '../main/help/prepPrompt'

const IN_CALL = new Set(['checking', 'live', 'paused', 'stopping'])
/** Fired after a save, so other parts of the setup (the must-learn ideas) can read the notes again. */
export const NOTES_EVENT = 'copilot:account-notes'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** "Oct 6" (with the year when it isn't this year). */
function dayLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

const lineCount = (t: string) => t.split('\n').filter((l) => l.trim()).length

/** Copy to the clipboard; without focus the clipboard API can refuse, so a selected box is the fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const t = document.createElement('textarea')
    t.value = text
    document.body.append(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}

export function initAccountNotes(api: CopilotApi): void {
  const input = $<HTMLInputElement>('csAccount')
  const box = $('akBox')
  box.innerHTML = `
    <div class="ak-head">
      <button id="akToggle" class="am-toggle ak-toggle" aria-expanded="true"><span id="akTitle"></span> <span id="akMeta" class="muted small"></span></button>
      <button id="akPrep" class="btn btn-sm btn-ghost" title="Copies a request to paste into Claude, where Sumble, Notion and Drive are connected. Paste its answer back here.">Copy prep prompt</button>
    </div>
    <div id="akBody" class="ak-body">
      <textarea id="akText" class="input ak-text" rows="3" aria-label="What I know"
        placeholder="Who's who, their setup, what happened before. Or paste Claude's prep answer here."></textarea>
      <div class="ak-foot">
        <span id="akCount" class="muted small"></span>
        <span id="akMsg" class="muted small"></span>
        <span class="ak-grow"></span>
        <span id="akAsk" class="ak-ask small" hidden>Clear all of it? <button id="akClearYes" class="link">Yes, clear</button> · <button id="akClearNo" class="link">Keep</button></span>
        <button id="akClear" class="btn btn-sm btn-ghost">Clear</button>
        <button id="akSave" class="btn btn-sm btn-secondary">Save</button>
      </div>
    </div>`
  const text = $<HTMLTextAreaElement>('akText')

  /** The account the box shows (as typed), and its notes as last saved. */
  let shownKey = ''
  let notes: AccountNotes | null = null
  let seq = 0
  let inCall = false
  /** One line: from Start until Keith opens it, or whenever he folds it. */
  let folded = false
  let lastCardId = ''

  const dirty = () => !!notes && text.value !== notes.text

  /** Characters past the limit (no maxlength: a cut-off paste would lose its last lines unseen). */
  const over = () => Math.max(0, text.value.length - ACCOUNT_NOTES_MAX_CHARS)

  function counter(): void {
    const n = text.value.length
    $('akCount').textContent = over() ? `${n}/${ACCOUNT_NOTES_MAX_CHARS}: ${over()} over, shorten before saving` : `${n}/${ACCOUNT_NOTES_MAX_CHARS}`
    $('akCount').classList.toggle('ak-near', n > ACCOUNT_NOTES_MAX_CHARS * 0.9)
  }

  function render(): void {
    box.hidden = !notes
    if (!notes) return
    const lines = lineCount(text.value)
    box.classList.toggle('am-chip', folded)
    $('akTitle').textContent = folded ? 'What I know' : `What I know about ${notes.account}`
    $('akMeta').textContent = folded
      ? `· ${lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'nothing yet'}`
      : notes.updated_at ? `· updated ${dayLabel(notes.updated_at)}` : ''
    $('akToggle').setAttribute('aria-expanded', String(!folded))
    $('akBody').hidden = folded
    // Prep is for before the call.
    $('akPrep').hidden = folded || inCall
    $('akClear').hidden = !text.value && !notes.text
    // Tall enough to read a pasted answer at a glance, like the wrap-up's For next time box.
    text.rows = Math.min(8, Math.max(3, text.value.split('\n').length))
    counter()
  }

  function say(msg: string): void {
    $('akMsg').textContent = msg
  }

  /** A save in flight (leaving the box and clicking Save both save: the second waits for the first). */
  let saving: Promise<void> | null = null

  /**
   * Save what's in the box under the account it was loaded for (never under a name being typed). Too
   * long, leaving the box or Save waits for him to shorten it; switching account or Start can't wait,
   * so they keep what fits (`cut`).
   */
  async function save(cut = false): Promise<void> {
    while (saving) await saving
    const n = notes
    if (!n || !dirty()) return
    if (over() && !cut) {
      say(`Not saved: ${over()} characters too long.`)
      return
    }
    const sent = text.value
    saving = (async () => {
      const saved = await api.notesSet(n.account, sent)
      if (!saved) {
        say("That didn't save. Try again.")
        return
      }
      if (notes === n) {
        notes = { ...saved, account: n.account }
        // Show what was kept (trimmed, at most the limit), unless he typed on meanwhile (saved when he leaves).
        if (text.value === sent) text.value = saved.text
        say(!saved.text ? 'Cleared' : sent.length > ACCOUNT_NOTES_MAX_CHARS ? `Saved the first ${ACCOUNT_NOTES_MAX_CHARS} characters` : 'Saved')
        render()
      }
      window.dispatchEvent(new CustomEvent(NOTES_EVENT, { detail: { account: saved.account, from: 'box' } }))
    })()
    try {
      await saving
    } finally {
      saving = null
    }
  }

  /** Load the typed account's notes (any account with a name: a first call too). */
  async function check(force = false): Promise<void> {
    const name = input.value.replace(/\s+/g, ' ').trim()
    const key = accountKey(name)
    if (key === shownKey && !force) return
    const changed = key !== shownKey
    // Edits not saved yet belong to the account they were typed for.
    if (changed && dirty()) await save(true)
    shownKey = key
    const mine = ++seq
    const n = key ? await api.notesGet(name) : null
    if (mine !== seq) return
    notes = n ? { ...n, account: name } : null
    // Reloading the same account never replaces what he's typing.
    if (changed || document.activeElement !== text) text.value = n?.text ?? ''
    say('')
    cancelClear()
    render()
  }

  function cancelClear(): void {
    $('akAsk').hidden = true
    $('akClear').classList.remove('ak-hide')
  }

  input.addEventListener('input', () => void check())
  input.addEventListener('change', () => void check())
  text.addEventListener('input', () => {
    say('')
    render()
  })
  // A pasted answer in Markdown (bold labels, headings) is made plain, so its labels read as labels.
  text.addEventListener('paste', (e) => {
    const raw = e.clipboardData?.getData('text/plain') ?? ''
    const plain = plainAnswer(raw)
    if (!raw || plain === raw) return
    e.preventDefault()
    text.setRangeText(plain, text.selectionStart, text.selectionEnd, 'end')
    text.dispatchEvent(new Event('input'))
  })
  // Leaving the box saves it (Save is there too, for peace of mind).
  text.addEventListener('blur', () => void save())
  $('akSave').addEventListener('click', () => void save())
  $('akClear').addEventListener('click', () => {
    $('akAsk').hidden = false
    $('akClear').classList.add('ak-hide')
  })
  $('akClearNo').addEventListener('click', cancelClear)
  $('akClearYes').addEventListener('click', () => {
    cancelClear()
    text.value = ''
    void save()
  })
  $('akToggle').addEventListener('click', () => {
    folded = !folded
    render()
  })
  $('akPrep').addEventListener('click', async () => {
    const n = notes
    if (!n) return
    // His latest edits first, so the request doesn't ask for what he just typed.
    await save()
    const prompt = await api.notesPrepPrompt(n.account)
    say(prompt && (await copyText(prompt)) ? 'Copied. Paste it into Claude, then paste the answer here.' : "Couldn't copy. Try again.")
  })
  // "Save to What I know" after a call (forNextTime.ts) puts lines on top: show them if it's this account.
  window.addEventListener(NOTES_EVENT, (e) => {
    const d = (e as CustomEvent<{ account?: string; from?: string }>).detail
    if (d?.from !== 'box' && notes && accountKey(d?.account ?? '') === shownKey && !dirty()) void check(true)
  })
  api.onSession((raw) => {
    const ev = raw as { type: string; state?: string }
    if (ev.type !== 'state' || !ev.state) return
    const was = inCall
    inCall = IN_CALL.has(ev.state)
    if (inCall && !was) {
      // Typed but not saved yet: HELP should have it from the start.
      void save(true)
      folded = true
      render()
    }
    // Stop clears the account box a moment later; the box stays one line until then.
    if (ev.state === 'stopped' || ev.state === 'idle') {
      setTimeout(() => {
        if (!inCall) folded = false
        render()
      }, 400)
    }
  })
  // A HELP card on screen: fold back to one line so the box never pushes the card out of view
  // (unless Keith is typing in it).
  api.onHelp((raw) => {
    const id = (raw as { request_id?: string } | null)?.request_id ?? ''
    if (!inCall || !id || id === lastCardId) return
    lastCardId = id
    if (!folded && document.activeElement !== text) {
      folded = true
      render()
    }
  })
  // The strip is also filled in by the app itself (on open, after Stop, Reuse last setup), which fires no input events.
  setInterval(() => void check(), 1000)
  void check()
}
