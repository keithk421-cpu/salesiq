/**
 * "For next time" (M4) at the top of the wrap-up: a few short lines built from the items Keith kept
 * (forNextTimeDraft, never a model's words), which he can edit, save to the top of "What I know about
 * <account>" or copy. A Practice-mode (MOCK) wrap-up only says there's nothing to save.
 *
 * Kept in its own file so the wrap-up window's own code doesn't change: renderer.ts only calls
 * initForNextTime(), and this fills #wuNext from the same wrap-up updates.
 */
import type { CopilotApi } from '../preload/preload'
import type { CallWrapup } from '../shared/help'
import { forNextTimeDraft } from '../main/help/forNextTime'
import { NOTES_EVENT, copyText } from './accountNotes'

export function initForNextTime(api: CopilotApi): void {
  const box = document.getElementById('wuNext') as HTMLElement
  box.innerHTML = `
    <div class="wn-head"><span class="nt-h">For next time</span><span id="wnHint" class="muted small"></span></div>
    <div id="wnPractice" class="muted small" hidden>Practice mode: nothing to save (the wrap-up is placeholders).</div>
    <div id="wnEdit">
      <textarea id="wnText" class="input wn-text" rows="3" aria-label="For next time"></textarea>
      <div class="row wn-foot">
        <button id="wnSave" class="btn btn-sm btn-secondary">Save to What I know</button>
        <button id="wnCopy" class="btn btn-sm btn-ghost">Copy</button>
        <span id="wnMsg" class="muted small"></span>
      </div>
    </div>`
  const text = document.getElementById('wnText') as HTMLTextAreaElement
  const save = document.getElementById('wnSave') as HTMLButtonElement
  const msg = document.getElementById('wnMsg') as HTMLElement

  let wrap: CallWrapup | null = null
  /** The call the box was filled for, the draft it shows, and whether Keith edited it. */
  let shownFor = ''
  let draft = ''
  let edited = false
  /** Saved as it stands: "Saved" until he edits it again. */
  let saved = false
  /**
   * What he last saved from this wrap-up. A later save (he removed or fixed an item since) replaces it
   * in his notes rather than stacking a second copy. Kept in memory only, per call: notes text never
   * goes into browser storage.
   */
  let savedText = ''
  const savedFor = new Map<string, string>()
  const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

  /**
   * After a restart nothing is in memory: when every line of the draft is already in his notes, it was
   * saved before, so the button reads "Saved" (and a later change updates those lines).
   */
  async function alreadySaved(w: CallWrapup, lines: string): Promise<void> {
    const n = lines.trim() ? await api.notesGet(w.account.trim()) : null
    if (!n || shownFor !== w.session_id || savedText || edited || draft !== lines) return
    const have = new Set(n.text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()))
    if (!lines.split('\n').every((l) => have.has(l.replace(/\s+/g, ' ').trim()))) return
    savedText = lines
    savedFor.set(w.session_id, lines)
    saved = true
    render()
  }

  function render(): void {
    const w = wrap
    const ready = !!w && (w.status === 'ready' || w.status === 'drafting') && !!w.account.trim()
    if (!w || !ready) {
      box.hidden = true
      return
    }
    const fresh = w.session_id !== shownFor
    if (fresh) {
      shownFor = w.session_id
      edited = false
      savedText = savedFor.get(w.session_id) ?? ''
      saved = false
      draft = ''
      msg.textContent = ''
    }
    const practice = w.mock
    const next = practice ? '' : forNextTimeDraft(w)
    // Follows Keith's ticks and edits in the list until he edits these lines himself.
    if (!edited && next !== draft) {
      draft = next
      text.value = next
      saved = !!savedText && same(next, savedText)
    }
    if (fresh && !practice && !savedText) void alreadySaved(w, next)
    box.hidden = !practice && !text.value.trim() && !edited
    ;(document.getElementById('wnPractice') as HTMLElement).hidden = !practice
    ;(document.getElementById('wnEdit') as HTMLElement).hidden = practice
    document.getElementById('wnHint')!.textContent = practice
      ? ''
      : savedText && !saved
        ? 'Changed since you saved. Update swaps in these lines.'
        : `Goes at the top of What I know about ${w.account.trim()}.`
    text.rows = Math.min(6, Math.max(2, text.value.split('\n').length))
    save.disabled = saved || !text.value.trim()
    save.textContent = saved ? 'Saved' : savedText ? 'Update What I know' : 'Save to What I know'
  }

  text.addEventListener('input', () => {
    edited = true
    saved = !!savedText && same(text.value, savedText)
    msg.textContent = ''
    render()
  })
  save.addEventListener('click', async () => {
    const w = wrap
    if (!w || w.mock || !text.value.trim()) return
    save.disabled = true
    const sent = text.value
    const r = await api.notesPrepend(w.account, sent, savedText || undefined)
    if (!r) {
      msg.textContent = "That didn't save. Try again."
      save.disabled = false
      return
    }
    if (shownFor === w.session_id) {
      savedText = sent
      savedFor.set(w.session_id, sent)
      saved = same(text.value, sent)
    }
    const dropped = r.dropped_lines ?? 0
    msg.textContent = dropped ? `${dropped} older line${dropped === 1 ? '' : 's'} dropped to fit.` : ''
    window.dispatchEvent(new CustomEvent(NOTES_EVENT, { detail: { account: r.account } }))
    render()
  })
  document.getElementById('wnCopy')!.addEventListener('click', async () => {
    msg.textContent = (await copyText(text.value)) ? 'Copied.' : "Couldn't copy. Select the lines and press Ctrl+C."
  })

  api.onWrapup((raw) => {
    wrap = raw as CallWrapup | null
    render()
  })
  void (api.wrapupGet() as Promise<CallWrapup | null>).then((w) => {
    wrap = w
    render()
  })
}
