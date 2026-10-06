/**
 * Must-learn ideas (M4): before Start, up to 4 grey suggestions under "Must learn" that Keith can add
 * with one click. No model request: built here, in code, from what the app already has.
 *
 * In this order, skipping anything already a must-learn (planKey), the same as an earlier idea, and a
 * topic the last call's notes say was covered:
 *   1. what Keith still wanted to learn when earlier calls ended (to_learn), dated;
 *   2. "status of <what they owed>" from the newest they_owe items, dated;
 *   3. topics the last call's final notes listed as not covered, in plain words;
 *   4. "Confirm: <fact>" for a decision-process or current-tools fact an earlier call gave, dated (so a
 *      stale one reads as a check, never as current fact);
 *   5. the "To learn" lines of Keith's own notes (What I know);
 *   6. "SaaS or self-hosted" while Deployment is "not sure";
 *   7. two or three starters for the call type.
 * Ideas are topics in plain words, never scripted questions, and neutral: no assumed pain, problem,
 * urgency or deadline. Keith's notes are his plan, never something the buyer said.
 *
 * Also here, because faster setup and the wrap-up share them: nextCallType() (the likely type of the
 * next call, from the last call's agreed next step) and NOT_COVERED_IDEA (the plain words for a topic
 * the call didn't cover). Pure functions: logs carry counts only, never the ideas.
 */
import { MUST_LEARN_IDEAS_MAX, MUST_LEARN_IDEA_MAX_CHARS, NOT_COVERED_TOPICS, type AccountMemory, type CallSetup, type CallType, type MustLearnIdea, type MustLearnIdeaSource, type NotCoveredTopic } from '../../shared/help'
import { notesToLearn } from './accountNotes'
import { MUST_LEARN_MAX_CHARS, mustLearnOf, planKey, sanitizeMustLearn, shortItem } from './callPlan'

/** A topic the call didn't cover, as a must-learn in plain words (the wrap-up's "+" chips use the same words). */
export const NOT_COVERED_IDEA: Record<NotCoveredTopic, string> = {
  timeline: 'timeline to decide',
  decision_process: 'who signs off and how',
  current_tooling: 'what they use today',
  success_criteria: 'what good looks like',
}

/** Starters read in full on the plan line (its items are cut at 28 characters). */
export const STARTER_MAX_CHARS = 28
/** Starters offered at most, after the account's own gaps. */
const STARTERS_MAX = 3
/** Per source, so four chips aren't all the same kind. */
const SOURCE_MAX: Partial<Record<MustLearnIdeaSource, number>> = { they_owe: 2, confirm: 2 }

/**
 * A neutral starter for the call type. `topic`: the not-covered topic it is about, so it isn't offered
 * next to that topic's own idea, nor when the last call already covered it.
 */
export interface Starter {
  text: string
  topic?: NotCoveredTopic
}

/** Fixed lists, in the order Keith reads them. Neutral: nothing assumes a pain, urgency or deadline. */
export const STARTERS: Record<CallType, readonly Starter[]> = {
  discovery: [
    { text: 'what prompted the call' },
    { text: 'how they test answers today', topic: 'current_tooling' },
    { text: 'who signs off', topic: 'decision_process' },
    { text: 'timeline to decide', topic: 'timeline' },
  ],
  demo: [{ text: 'which use case to show' }, { text: 'what they need to see' }, { text: 'who else should see it' }],
  technical_deep_dive: [{ text: 'how they send traces today' }, { text: 'where data must stay' }, { text: 'what a POC must prove' }],
  follow_up: [{ text: 'what changed since last call' }, { text: 'who else has weighed in' }, { text: 'next step and date' }],
  negotiation: [{ text: 'steps left to sign' }, { text: 'who signs and how', topic: 'decision_process' }, { text: 'start date they need' }],
  other: [{ text: 'what they want from today' }],
}

const TYPE_LABEL: Record<CallType, string> = {
  discovery: 'Discovery', demo: 'Demo', technical_deep_dive: 'Technical deep-dive', follow_up: 'Follow-up', negotiation: 'Negotiation', other: 'Other',
}

/** Facts worth checking again on the next call: who decides and what they use today. */
const CONFIRM_KINDS = new Set(['decision_process', 'current_tooling'])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sep 28" (with the year when it isn't this year) from a call day (YYYY-MM-DD) or a timestamp. */
export function ideaDay(s: string | null | undefined, now = new Date()): string {
  if (!s) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return s
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!MONTHS[mo - 1]) return s
  return `${MONTHS[mo - 1]} ${d}${y !== now.getFullYear() ? `, ${y}` : ''}`
}

/**
 * The first letter lower case when the first word is a plain word that starts a sentence ("Use an
 * in-house dashboard" -> "use an ..."). Anything else may be a name or a product and keeps its case
 * ("Datadog for monitoring", "Priya signs off", "VP signs off").
 */
function lowerFirst(s: string): string {
  const first = /^([A-Z][a-z]+)\b(?!['’-])/.exec(s)?.[1]
  return first && (PLAIN_STARTS.has(first.toLowerCase()) || VERBS.has(first.toLowerCase())) ? s[0].toLowerCase() + s.slice(1) : s
}

// What they said they'd hand over: the thing itself is the topic ("Share their eval dataset" -> "their eval dataset").
const DELIVER = /^(?:share|send(?: over)?|provide|forward|pull together|put together|gather|collect|prepare|draft|give us|get us)\s+/i
// Anything else they said they'd do reads as "status of <doing it>" ("Loop in their platform lead" -> "looping in ...").
const GERUND: Record<string, string> = {
  loop: 'looping', book: 'booking', set: 'setting', schedule: 'scheduling', check: 'checking', confirm: 'confirming', review: 'reviewing',
  find: 'finding', look: 'looking', follow: 'following', introduce: 'introducing', connect: 'connecting', test: 'testing', try: 'trying',
  run: 'running', evaluate: 'evaluating', sign: 'signing', talk: 'talking', ask: 'asking', decide: 'deciding', get: 'getting',
  invite: 'inviting', bring: 'bringing', circle: 'circling', come: 'coming', reach: 'reaching', email: 'emailing', update: 'updating',
  fill: 'filling', speak: 'speaking', reply: 'replying', go: 'going', respond: 'responding', write: 'writing', use: 'using', score: 'scoring',
}
/** Words an owed item starts with when it is what to do, not who does it ("Talk to ...", "Intro to ..."). */
const VERBS = new Set([
  ...Object.keys(GERUND), 'share', 'send', 'provide', 'forward', 'pull', 'put', 'gather', 'collect', 'prepare', 'draft', 'give', 'intro',
])
/** Plain words a sentence starts with (lower case is right for them mid-sentence): not names or products. */
const PLAIN_STARTS = new Set([
  'the', 'their', 'they', 'this', 'that', 'these', 'those', 'a', 'an', 'our', 'we', 'its', 'some', 'any', 'all', 'each', 'no', 'one',
  'two', 'three', 'most', 'only', 'eval', 'evals', 'budget', 'approval', 'access', 'pricing', 'sample', 'samples', 'feedback',
  'details', 'answers', 'security', 'legal', 'procurement', 'data', 'team', 'platform', 'decision', 'homegrown', 'manual', 'manually',
])
/** "Dana to ...", "Security team will ...": up to 3 words, then "to" or "will" (checked against VERBS below). */
const WHO_TO = /^((?:[\w.'’-]+ ){0,2}?[\w.'’-]+) (?:to|will)\s+/

/**
 * What they owed, as a topic: "Dana to share a sample of their eval dataset (Dana, by Friday)" ->
 * "a sample of their eval dataset". Who and when stay in the hover (the item as it was saved).
 */
export function owedTopic(text: string): string {
  let t = text.replace(/\s*\([^()]*\)\s*$/, '').replace(/[.\s]+$/, '').trim()
  // Who: "Dana to ...", "Their platform lead will ...", "They'll ..."
  t = t.replace(/^(?:[Tt]hey(?:['’]ll| will| would| to)|[Tt]heir [\w-]+(?: [\w-]+)? (?:to|will))\s+/, '')
  // "Dana to ...", "Security team will ...": only when what follows is what to do, and the item doesn't
  // start with it ("Talk to their CISO", "Intro to their platform lead", "Approval to start" stay whole).
  const who = WHO_TO.exec(t)
  if (who && !VERBS.has(who[1].split(' ')[0].toLowerCase())) {
    const rest = t.slice(who[0].length)
    if (DELIVER.test(rest) || VERBS.has((/^[A-Za-z]+/.exec(rest)?.[0] ?? '').toLowerCase())) t = rest
  }
  if (DELIVER.test(t)) return t.replace(DELIVER, '')
  const first = /^([A-Za-z]+)\b/.exec(t)?.[1]
  // "Intro to ..." is a thing, not a doing ("Intro us to ..." is).
  const g = first && !/^intro to\b/i.test(t) ? GERUND[first.toLowerCase()] ?? (first.toLowerCase() === 'intro' ? 'introducing' : undefined) : undefined
  return g ? `${g}${t.slice(first!.length)}` : lowerFirst(t)
}

// ---------------------------------------------------------------- the likely type of the next call

// Contract stage: the paperwork is next.
const NEGOTIATION = /\b(?:contracts?|procurement|order forms?|legal(?: review| team)?|MSA|redlines?|purchase orders?)\b/i
// The technical stage: a deep-dive, an architecture or security review, or scoping a POC or pilot.
const TECHNICAL = new RegExp([
  String.raw`\bdeep[- ]?dives?\b`,
  String.raw`\barchitecture (?:review|session|call|walk-?through|discussion|meeting|deep[- ]?dive)\b`,
  String.raw`\bwalk(?:ing)? through (?:their|the|our|your) architecture\b`,
  String.raw`\bsecurity (?:review|assessment|questionnaire call)\b`,
  String.raw`\b(?:poc|proof of concept|pilot)\b.*\bscop\w*`,
  String.raw`\bscop\w* (?:the |a |their |our )?(?:poc|proof of concept|pilot)\b`,
  String.raw`\btechnical (?:session|call|review|workshop)\b`,
].join('|'), 'i')
// A demo Arize gives: "a demo", "the product demo", "demo call", "demo of the eval workflow".
const DEMO = /\b(?:a|an|the|our|product|live|full|tailored|custom|platform|arize)\s+(?:[\w-]+\s+)?demo\b|\bdemo\s+(?:call|session|meeting|of|for|on|next|with)\b|^demo\b/i
// Their contract with someone else is not the paperwork with Arize ("after their Datadog contract
// renews", "once their current contract ends"): taken out of the step before NEGOTIATION is checked.
const THEIR_CONTRACT = [
  /\b(?:current|existing)\s+(?:[\w-]+\s+){0,2}?contracts?\b/gi,
  /\b[Tt]heir\s+[A-Z][\w-]*(?:\s+[A-Z][\w-]*)?\s+contracts?\b/g,
  /\bcontracts?\s+(?:with\s+[\w-]+\s+)?(?:renew\w*|ends?|ended|expir\w*|is up|runs? out)\b/gi,
  /\brenewals?\b/gi,
]
// A demo that already happened, or a thing from it ("questions from the demo", "the demo recording"):
// taken out of the step before DEMO is checked.
const PAST_DEMO = /\b(?:from|of|about|after|on|since)\s+the\s+demo\b(?!\s+(?:call|session|meeting|next|on|with|for)\b)|\bdemo\s+(?:recordings?|recaps?|decks?|slides?|videos?|notes)\b/gi
// Their own demo inside their company is not a call with Keith.
const NOT_OUR_DEMO = /\b(?:they(?:['’]ll| will| would)?|their \w+(?: \w+)? (?:will|to))\s+demo\b|\bdemo (?:it|this|that|arize)\s+(?:to|for|with)\s+(?:their|the|his|her)\b|\binternal(?:ly)?\b/i

/**
 * The likely type of the next call, from the last call's agreed next steps (in the wrap-up's order;
 * the first that says something wins): contract, procurement, order form or legal -> Negotiation (not
 * their contract with someone else); a deep-dive, architecture or security review, or POC scoping ->
 * Technical deep-dive; a demo Arize gives (not one already held) -> Demo; else Follow-up.
 */
export function nextCallType(agreed: readonly string[]): CallType {
  for (const raw of agreed) {
    if (typeof raw !== 'string') continue
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (NEGOTIATION.test(THEIR_CONTRACT.reduce((x, re) => x.replace(re, ' '), t))) return 'negotiation'
    if (TECHNICAL.test(t)) return 'technical_deep_dive'
    const d = t.replace(PAST_DEMO, ' ')
    if (DEMO.test(d) && !NOT_OUR_DEMO.test(d)) return 'demo'
  }
  return 'follow_up'
}

// ---------------------------------------------------------------- the ideas

export interface IdeasInput {
  /** The setup strip as it is now (call type, deployment, the must-learns already set). */
  setup: Partial<CallSetup> | null | undefined
  /** accountMemory() for the typed account (null: no earlier calls). */
  memory: AccountMemory | null | undefined
  /** The account's "What I know" notes (getAccountNotes().text). */
  notesText?: string | null
  now?: Date
}

/** Up to MUST_LEARN_IDEAS_MAX ideas, in the order above. */
export function mustLearnIdeas({ setup, memory, notesText, now = new Date() }: IdeasInput): MustLearnIdea[] {
  const out: MustLearnIdea[] = []
  const have = new Set(mustLearnOf(setup).map(planKey))
  const offered = new Set<NotCoveredTopic>()
  const perSource = new Map<MustLearnIdeaSource, number>()
  // What the last call's notes left uncovered (absent: no notes, a Practice call, or no earlier call).
  const notCovered = Array.isArray(memory?.last_not_covered) ? memory.last_not_covered.filter((x) => (NOT_COVERED_TOPICS as readonly unknown[]).includes(x)) : null
  const covered = (t: NotCoveredTopic) => !!notCovered && !notCovered.includes(t)
  const add = (raw: string, source: MustLearnIdeaSource, date: string | null, hint: string, topic?: NotCoveredTopic): void => {
    if (out.length >= MUST_LEARN_IDEAS_MAX) return
    if ((perSource.get(source) ?? 0) >= (SOURCE_MAX[source] ?? MUST_LEARN_IDEAS_MAX)) return
    // The chip shows a short form; a click saves the whole item, so the must-learn never ends in "…".
    const whole = wholeItem(raw)
    const text = shortItem(whole, MUST_LEARN_IDEA_MAX_CHARS)
    const k = planKey(whole)
    if (!k) return
    if (have.has(k)) {
      // Already a must-learn or an idea above (a still-to-learn item in the same words, say): its topic
      // counts as offered, so a starter on it ("who signs and how") doesn't show as a near-duplicate.
      if (topic) offered.add(topic)
      return
    }
    if (topic && (offered.has(topic) || covered(topic))) return
    have.add(k)
    if (topic) offered.add(topic)
    perSource.set(source, (perSource.get(source) ?? 0) + 1)
    out.push({ text, source, date, hint, ...(text !== whole ? { full: whole } : {}) })
  }
  const items = Array.isArray(memory?.items) ? memory.items.filter((it) => it && typeof it.text === 'string' && it.text.trim()) : []
  const day = (d: string | null | undefined) => ideaDay(d, now)

  for (const it of items) if (it.kind === 'to_learn') add(it.text, 'still_to_learn', it.date, `Still to learn after the ${day(it.date)} call`)
  for (const it of items) if (it.kind === 'they_owe') add(`status of ${owedTopic(it.text)}`, 'they_owe', it.date, `They said they'd do this on the ${day(it.date)} call: ${it.text}`)
  const lastDay = memory?.last_call_at ? callDayOf(memory.last_call_at) : null
  for (const t of notCovered ?? []) add(NOT_COVERED_IDEA[t], 'not_covered', lastDay, `Not covered on the ${day(lastDay)} call`, t)
  for (const it of items) {
    if (it.kind === 'fact' && it.fact_kind && CONFIRM_KINDS.has(it.fact_kind)) add(`Confirm: ${lowerFirst(it.text.replace(/[.\s]+$/, ''))}`, 'confirm', it.date, `Said on the ${day(it.date)} call, may have changed: ${it.text}`)
  }
  // A "To learn" line about a must-learn a later call already took on (answered it, or Keith removed it
  // after) isn't offered again: "For next time" wrote it, and nothing takes it back out of his notes.
  // One still open is offered above, dated, as a still-to-learn item.
  const tracked = new Set(Array.isArray(memory?.tracked_learn) ? memory.tracked_learn : [])
  for (const t of notesToLearn(typeof notesText === 'string' ? notesText : '')) {
    if (!tracked.has(planKey(wholeItem(t)))) add(t, 'my_notes', null, 'From your notes (What I know)')
  }
  if ((setup?.deployment ?? 'unknown') === 'unknown') add('SaaS or self-hosted', 'deployment', null, 'Deployment is set to "not sure"')
  const type: CallType = setup?.call_type && STARTERS[setup.call_type] ? setup.call_type : 'discovery'
  let starters = 0
  for (const s of STARTERS[type]) {
    if (starters >= STARTERS_MAX) break
    const before = out.length
    add(s.text, 'starter', null, `${TYPE_LABEL[type]} starter`, s.topic)
    if (out.length > before) starters++
  }
  return out
}

/** The item as a must-learn keeps it (one line, at most MUST_LEARN_MAX_CHARS); a longer one is cut at a word, with no "…". */
function wholeItem(raw: string): string {
  const t = sanitizeMustLearn([raw])[0] ?? ''
  // Only a cut item is exactly MUST_LEARN_MAX_CHARS long (a ';' turned into ',' doesn't make one look cut).
  if (t.length < MUST_LEARN_MAX_CHARS || raw.replace(/\s+/g, ' ').trim().length <= t.length) return t
  const space = t.lastIndexOf(' ')
  return (space > MUST_LEARN_MAX_CHARS / 2 ? t.slice(0, space) : t).replace(/[\s,;:.-]+$/, '')
}

/** The calendar day of a timestamp on this PC's clock (YYYY-MM-DD), as accountMemory dates its items. */
function callDayOf(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
