/**
 * Keith's call plan on the call screen (M3): a "Must learn" box in the setup strip (up to 3 short
 * items as chips: Enter adds one, × removes it), and one quiet line showing how far each got:
 * ○ open, ◐ partial, ● done, in Keith's words, at the top of the Call notes panel and in the compact
 * strip. Hover shows the line a status rests on. No timer, score or percentage; nothing pops up.
 *
 * M4: before Start, a quiet "Ideas" row under the chips: up to 4 grey "+ text" suggestions (from the
 * account's earlier calls, Keith's notes and starters for the call type; mustLearnIdeas.ts). One click
 * makes it a must-learn; hover says where it came from. Hidden during a call and once 3 are set.
 *
 * Kept in its own file so it doesn't touch the rest of the call screen: renderer.ts only calls
 * initCallPlan(), and the box and both lines are added to the page here. The statuses come from the
 * call notes (main process, callPlan.ts); mid-call the chips are what counts, so an item added since
 * the last notes update shows as open straight away.
 */
import type { CopilotApi } from '../preload/preload'
import type { CallNotesState, CallSetup, MustLearnIdea, PlanItemStatus } from '../shared/help'
import { MUST_LEARN_MAX, MUST_LEARN_MAX_CHARS, PLAN_MARK, planKey, planNow, shortItem } from '../main/help/callPlan'

const IN_CALL = new Set(['checking', 'live', 'paused', 'stopping'])
const STATUS_WORD: Record<PlanItemStatus['status'], string> = { open: 'Not answered yet', partial: 'Partly answered', done: 'Answered' }

/** "Reuse last setup" (accountMemory.ts) brings over what the last call still had to learn. */
let fill: ((items: string[]) => void) | null = null
export function fillMustLearn(items: string[]): void {
  fill?.(items)
}
/** The must-learns in the box now (M4 faster setup fills an empty box only, and Undo puts these back). */
let current: () => string[] = () => []
export function currentMustLearn(): string[] {
  return current()
}

export function initCallPlan(api: CopilotApi): void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const clock = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  let items: string[] = []
  let notes: CallNotesState | null = null
  let inCall = false
  /** This call's lines, for the hover ("rests on"). */
  const said = new Map<string, { text: string; start_ms: number }>()

  // The "Must learn" box, in the setup strip before the hotkey hint (which has a row of its own).
  const box = document.createElement('div')
  box.id = 'mlBox'
  box.className = 'ml-box'
  box.title = 'Up to 3 things you must learn on this call. The notes track them: ○ open, ◐ partial, ● done.'
  box.innerHTML = `<span class="ml-label">Must learn</span><span id="mlChips" class="ml-chips"></span><input id="mlInput" class="input ml-input" maxlength="${MUST_LEARN_MAX_CHARS}" placeholder="e.g. who signs off · Enter adds" aria-label="Must learn on this call" />`
  $('hotkeyHint').before(box)
  const input = $<HTMLInputElement>('mlInput')

  // M4: the Ideas row, under the chips (a row of its own in the strip).
  const ideasRow = document.createElement('div')
  ideasRow.id = 'mlIdeas'
  ideasRow.className = 'ml-ideas'
  ideasRow.hidden = true
  box.after(ideasRow)
  let ideas: MustLearnIdea[] = []

  // The plan line: at the top of the Call notes panel, and in the compact strip under the buttons.
  const line = document.createElement('div')
  line.id = 'planLine'
  line.className = 'plan-line'
  line.hidden = true
  $('notesPanel').querySelector('summary')?.after(line)
  const strip = document.createElement('div')
  strip.id = 'planCompact'
  strip.className = 'plan-compact'
  strip.hidden = true
  document.querySelector('#callView > .sources')?.after(strip)

  function renderChips(): void {
    $('mlChips').innerHTML = items.map((t, i) => `<span class="ml-chip" title="${esc(t)}">${esc(shortItem(t, 40))}<button class="ml-x" data-i="${i}" title="Remove" aria-label="Remove">×</button></span>`).join('')
    const full = items.length >= MUST_LEARN_MAX
    input.hidden = full
    input.placeholder = items.length ? 'Add another · Enter' : 'e.g. who signs off · Enter adds'
  }

  /** What the line shows: mid-call Keith's chips with the notes' statuses; after the call, what the call ended with. */
  function plan(): PlanItemStatus[] {
    const fromNotes = notes?.notes?.plan
    return inCall ? planNow(items, fromNotes) : Array.isArray(fromNotes) ? fromNotes : []
  }

  function hover(p: PlanItemStatus): string {
    const t = said.get(p.turn_ids[0] ?? '')
    const rest = p.status === 'open' ? '' : t ? `\nRests on (${clock(t.start_ms)}): “${t.text.length > 160 ? `${t.text.slice(0, 159)}…` : t.text}”` : ''
    return `${p.item}\n${STATUS_WORD[p.status]}${rest}`
  }

  function renderLine(): void {
    const ps = plan()
    // The compact strip is about 440px wide: shorter words there, so all three fit and none is cut to a fragment.
    for (const [el, max] of [[line, 28], [strip, 17]] as const) {
      el.hidden = !ps.length
      // data-item / data-status: a click on an open item asks HELP for the line that gets there (M4, planPress.ts).
      el.innerHTML = ps.map((p) => `<span class="pl-item pl-${p.status}" data-item="${esc(p.item)}" data-status="${p.status}" title="${esc(hover(p))}"><span class="pl-mark">${PLAN_MARK[p.status]}</span> ${esc(shortItem(p.item, max))}</span>`).join('<span class="pl-sep"> · </span>')
    }
    strip.title = ps.map((p) => `${PLAN_MARK[p.status]} ${p.item}`).join('\n')
  }

  function show(next: string[]): void {
    items = next
    renderChips()
    renderLine()
    renderIdeas()
  }

  async function save(next: string[]): Promise<void> {
    show(next)
    // The main process keeps at most 3 short items; show what it kept.
    const su = (await api.helpSetMustLearn(next)) as CallSetup | null
    if (su) show(Array.isArray(su.must_learn) ? su.must_learn : [])
    refreshIdeas()
  }

  // ---- M4: must-learn ideas ----
  function renderIdeas(): void {
    // Never during a call (nothing changes by itself then), and not once all 3 are set.
    const have = new Set(items.map(planKey))
    // A click saves the whole item (full, when the chip text is cut), so that is what counts as set.
    const whole = (x: MustLearnIdea) => (typeof x.full === 'string' && x.full ? x.full : x.text)
    const shown = ideas.filter((x) => !have.has(planKey(whole(x))))
    ideasRow.hidden = inCall || items.length >= MUST_LEARN_MAX || !shown.length
    if (ideasRow.hidden) return
    ideasRow.innerHTML = `<span class="ml-ideas-label">Ideas</span>${shown
      .map((x) => `<button type="button" class="ml-idea" data-text="${esc(whole(x))}" title="${esc(x.hint)}">+ ${esc(x.text)}</button>`)
      .join('')}`
  }

  let ideasSeq = 0
  let ideasTimer: ReturnType<typeof setTimeout> | undefined
  /** Ask again (a moment later, so a burst of changes asks once); a slower older answer never wins. */
  function refreshIdeas(): void {
    clearTimeout(ideasTimer)
    ideasTimer = setTimeout(async () => {
      if (inCall) return renderIdeas()
      const mine = ++ideasSeq
      const next = ((await api.helpMustLearnIdeas()) as MustLearnIdea[] | null) ?? []
      if (mine !== ideasSeq) return
      ideas = Array.isArray(next) ? next : []
      renderIdeas()
    }, 120)
  }

  ideasRow.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.ml-idea')?.dataset.text
    if (!t || inCall || items.length >= MUST_LEARN_MAX || items.some((x) => planKey(x) === planKey(t))) return
    void save([...items, t])
  })
  // The account typed (the ideas come from its earlier calls and notes): the strip saves fields on
  // 'change', so a pause in typing saves it, then the ideas are asked again.
  let accountTimer: ReturnType<typeof setTimeout> | undefined
  $('csAccount').addEventListener('input', () => {
    clearTimeout(accountTimer)
    accountTimer = setTimeout(() => {
      if (inCall) return
      $('csAccount').dispatchEvent(new Event('change'))
    }, 400)
  })
  for (const id of ['csAccount', 'csType', 'csDeploy']) $(id).addEventListener('change', refreshIdeas)
  // The "What I know" box saved his notes (its "To learn" lines are ideas too).
  window.addEventListener('copilot:account-notes', refreshIdeas)

  async function reload(): Promise<void> {
    // The box is for the next call now: text typed but never added doesn't look carried over.
    input.value = ''
    const info = (await api.helpInfo()) as { setup?: CallSetup } | null
    show(Array.isArray(info?.setup?.must_learn) ? info.setup.must_learn : [])
    refreshIdeas()
  }

  /** What's typed in the box becomes a chip: on Enter, on leaving the box, and at Start. */
  function commit(): void {
    const t = input.value.replace(/\s+/g, ' ').trim()
    if (!t || items.length >= MUST_LEARN_MAX) return
    input.value = ''
    if (items.some((x) => planKey(x) === planKey(t))) return
    void save([...items, t.slice(0, MUST_LEARN_MAX_CHARS)])
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    commit()
  })
  // Like the strip's other fields, leaving the box saves what's in it (clicking the goal box or Start).
  input.addEventListener('change', commit)
  $('mlChips').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.ml-x')
    if (!b) return
    const i = Number(b.dataset.i)
    void save(items.filter((_, j) => j !== i))
    input.focus()
  })
  fill = (next) => void save(next.slice(0, MUST_LEARN_MAX))
  current = () => [...items]

  api.onCallNotes((raw) => {
    notes = raw as CallNotesState | null
    renderLine()
  })
  api.onSession((raw) => {
    const ev = raw as { type?: string; state?: string; event?: { turn?: { turn_id: string; text: string; start_ms: number } } }
    if (ev.type === 'state' && ev.state) {
      inCall = IN_CALL.has(ev.state)
      // A new call starts with an empty notes panel and no lines yet.
      if (ev.state === 'checking') {
        notes = null
        said.clear()
        // Started from the hotkey with something still typed in the box: it counts for this call.
        commit()
      }
      // Stop clears the must-learns with the rest of the per-call setup (the line keeps what the call ended with).
      if (ev.state === 'stopped' || ev.state === 'idle') void reload()
      renderLine()
      renderIdeas()
    } else if (ev.type === 'turn' && ev.event?.turn) {
      const t = ev.event.turn
      said.set(t.turn_id, { text: t.text, start_ms: t.start_ms })
    }
  })
  void (api.helpCallNotes() as Promise<CallNotesState | null>).then((s) => {
    notes = s
    renderLine()
  })
  void reload()
}
