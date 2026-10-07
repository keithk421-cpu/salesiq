/**
 * M5 call modes in the setup strip: each call type has its own job, so the strip helps set it up.
 * - A small length select next to the call type ("30 min"), for HELP's "about 10 minutes left" cue.
 *   Before the call it follows the type's usual length (CALL_LENGTH_DEFAULTS: discovery 30, demo 60,
 *   ...) until Keith picks one; then a type change leaves their pick alone. It can be changed
 *   mid-call (the next HELP press uses it), but a type change mid-call doesn't move it: the meeting
 *   is still as long as it was booked for.
 * - "No SA today", only on a demo or a technical deep-dive (Keith presents alone).
 * - The goal and outcomes boxes show what this type of call is for as grey placeholder text only:
 *   nothing is ever typed into them for Keith.
 * Both new fields save with the rest of the strip (renderer.ts saveSetup spreads setupExtras()), and
 * the main process merges them like the must-learns, so a save that leaves them out keeps them. Stop
 * clears them with the rest of the per-call setup (the call type stays).
 *
 * Kept in its own file so it doesn't touch the rest of the call screen: the controls are added to the
 * page here, and renderer.ts only calls initCallSetup() and setupExtras().
 */
import type { CopilotApi } from '../preload/preload'
import { CALL_LENGTH_CHOICES, CALL_LENGTH_DEFAULTS, CALL_TYPES, type CallSetup, type CallType } from '../shared/help'

const IN_CALL = new Set(['checking', 'live', 'paused', 'stopping'])

/** The call types where an Arize SA usually presents: only these offer "No SA today". */
const SA_TYPES: ReadonlySet<CallType> = new Set(['demo', 'technical_deep_dive'])

/** What each type of call is for (docs/M5_PLAN.md §2), as the goal and outcomes boxes' grey placeholder. */
export const GOAL_PLACEHOLDER: Record<CallType, { goal: string; outcomes: string }> = {
  discovery: {
    goal: "Goal: learn if there's a real problem, why now, who else cares; book the next meeting",
    outcomes: 'Outcomes: their top problems in their words, next meeting booked',
  },
  demo: {
    goal: 'Goal: show their top problems getting easier; learn what lands; book a dated next step',
    outcomes: 'Outcomes: what landed and for whom, who else should see it, dated next step',
  },
  technical_deep_dive: {
    goal: 'Goal: check fit; if a test is worth it, agree 1–3 written goals, owners, decision date',
    outcomes: 'Outcomes: goals with baseline and target, owners, readout and decision date booked',
  },
  follow_up: {
    goal: 'Goal: close owed items, hear what changed, move one thing forward',
    outcomes: 'Outcomes: owed items closed or re-dated, dated next step with names',
  },
  negotiation: {
    goal: "Goal: agree a fair deal: value first, trade don't give; path to signature with dates",
    outcomes: 'Outcomes: path to signature with dates, nothing unapproved given',
  },
  // Other: the strip's own examples, as before.
  other: { goal: 'Call goal (e.g. understand how they evaluate LLM outputs today)', outcomes: 'Desired outcomes, comma separated' },
}

/** A call type from the strip or a saved setup (anything unknown reads as discovery, as the main process does). */
export function typeOf(x: unknown): CallType {
  return (CALL_TYPES as readonly string[]).includes(x as string) ? (x as CallType) : 'discovery'
}

/** The type's usual length (minutes). */
export function defaultLength(type: unknown): number {
  return CALL_LENGTH_DEFAULTS[typeOf(type)]
}

/** The lengths the select offers: the usual ones, plus a saved one that isn't among them. */
export function lengthChoices(current: number | null): number[] {
  const all: number[] = [...CALL_LENGTH_CHOICES]
  if (current !== null && Number.isInteger(current) && current > 0 && !all.includes(current)) all.push(current)
  return all.sort((a, b) => a - b)
}

/** Only a demo or a technical deep-dive offers "No SA today". */
export function offersNoSa(type: unknown): boolean {
  return SA_TYPES.has(typeOf(type))
}

/** What the strip saves along with its other fields (renderer.ts saveSetup); nothing before init. */
let extras: () => { length_min?: number; no_sa?: boolean } = () => ({})
export function setupExtras(): { length_min?: number; no_sa?: boolean } {
  return extras()
}

/**
 * `save` is the strip's own save (renderer.ts saveSetup), so the new fields always go with the others.
 * Call this before renderer.ts adds its 'change' listeners: then, on a type change, the length preset
 * is set before the one save that carries it.
 */
export function initCallSetup(api: CopilotApi, save: () => void): void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  const typeEl = $<HTMLSelectElement>('csType')

  const lengthEl = document.createElement('select')
  lengthEl.id = 'csLength'
  lengthEl.className = 'input cs-length'
  lengthEl.title = 'How long the call is booked for: HELP uses it to save time for the next step near the end'
  lengthEl.setAttribute('aria-label', 'Call length')
  const noSaWrap = document.createElement('label')
  noSaWrap.className = 'inline check cs-nosa'
  noSaWrap.title = 'You present alone today: HELP won\'t hand questions to an SA'
  noSaWrap.innerHTML = '<input type="checkbox" id="csNoSa" /> No SA today'
  typeEl.after(lengthEl, noSaWrap)
  const noSaEl = $<HTMLInputElement>('csNoSa')

  let inCall = false
  /** Keith picked the length (before the call): a type change then leaves it alone. */
  let picked = false

  function setLength(n: number): void {
    const opts = lengthChoices(n)
    // Rebuilt only when the list changes (a saved length that isn't one of the usual ones).
    if (lengthEl.options.length !== opts.length || [...lengthEl.options].some((o, i) => Number(o.value) !== opts[i])) {
      lengthEl.innerHTML = opts.map((m) => `<option value="${m}">${m} min</option>`).join('')
    }
    lengthEl.value = String(n)
  }

  /** The placeholders and "No SA today" follow the type (the one in the strip now, unless given). */
  function showType(type: CallType = typeOf(typeEl.value)): void {
    const ph = GOAL_PLACEHOLDER[type]
    $<HTMLInputElement>('csGoal').placeholder = ph.goal
    $<HTMLInputElement>('csOutcomes').placeholder = ph.outcomes
    noSaWrap.hidden = !offersNoSa(type)
  }

  /** Before the call, the length follows the type until Keith picks one. */
  function presetLength(): void {
    if (inCall || picked) return
    const n = defaultLength(typeEl.value)
    if (lengthEl.value !== String(n)) setLength(n)
  }

  extras = () => ({ length_min: Number(lengthEl.value) || defaultLength(typeEl.value), no_sa: noSaEl.checked })

  // The type changed, by Keith or by the app (faster setup and its Undo fire 'change'). These listeners
  // are added before renderer.ts's save on the same fields, so the one save carries the new length.
  // "Reuse last setup" sets the type and fires 'change' on the goal box only: followed from there too.
  for (const id of ['csType', 'csGoal', 'csOutcomes', 'csAccount', 'csDeploy']) {
    $(id).addEventListener('change', () => {
      presetLength()
      showType()
    })
  }
  lengthEl.addEventListener('change', () => {
    if (!inCall) picked = true
    save()
  })
  noSaEl.addEventListener('change', save)

  /** What the main process has (on open, and after Stop cleared the per-call setup). */
  async function reload(): Promise<void> {
    const info = (await api.helpInfo()) as { setup?: Partial<CallSetup> } | null
    const su = info?.setup ?? null
    const type = typeOf(su?.call_type ?? typeEl.value)
    const saved = typeof su?.length_min === 'number' ? su.length_min : null
    setLength(saved ?? defaultLength(type))
    // A saved length that isn't the type's usual one was Keith's pick.
    picked = saved !== null && saved !== defaultLength(type)
    noSaEl.checked = su?.no_sa === true
    // The saved type: renderer.ts puts the same one in the strip, maybe a moment after this.
    showType(type)
  }

  api.onSession((raw) => {
    const ev = raw as { type?: string; state?: string }
    if (ev.type !== 'state' || !ev.state) return
    inCall = IN_CALL.has(ev.state)
    if (ev.state === 'stopped' || ev.state === 'idle') void reload()
  })
  setLength(defaultLength(typeEl.value))
  showType()
  void reload()
}
