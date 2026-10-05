/**
 * The approved passage: the moment Keith presses HELP, before Claude answers, the card shows the best
 * approved, current, in-scope knowledge section for what the other side just said, so he has something
 * trustworthy on screen straight away. Claude's line still comes and stays the main thing on the card.
 *
 * A wrong passage is worse than none, so it is shown only on a strong match. The question (the other
 * side's latest words, see retrieval.ts) is searched on its own across every approved document, and
 *   - the best section overall must be current and in scope for the call's deployment (if the best
 *     match is stale or for the other deployment, the next one would only be a stand-in: none is shown);
 *   - its heading must name at least two of the question's concepts, or one rare concept that is a
 *     named term: an alias from aliases.json, or, when they asked something ("?"), one of the
 *     document's own tags (a lone ordinary word such as "different" or "take" says little about the
 *     topic, and tags are free-form search hints that can be words a buyer also uses about their own
 *     setup: "We're mostly on AWS." is not a question about running in AWS); a concept that many
 *     sections mention (e.g. "Arize", "use") never counts;
 *   - its heading must name something from what they said last (retrieval.ts, questionParts). That
 *     is searched on its own first; only when it has no strong match is the whole question searched,
 *     about the last thing they asked (their question, then a remark: "Do you have a SOC 2 report?"
 *     "Good question." "Sure, no rush."). So an earlier question that Keith already answered in a few
 *     words can't bring back its note once they've moved on to something with its own note;
 *   - it must be clearly ahead of the best match from any other section.
 * A competitor's section is shown only when someone named that competitor in the last 30 s, and not
 * when what they said last is put to Keith ("How does yours handle it?") without naming it: then the
 * box stays empty rather than showing another section in its place.
 * Unapproved documents are never searched at all. The box shows the section's first sentence or two,
 * leaving out "Possible reason" lines (objection notes: hypotheses about buyers in general, not facts
 * and not something to say); the whole note keeps them.
 */
import type { ApprovedPassage, Deployment } from '../../shared/help'
import { ftsConcepts } from '../db'
import { inScope, isCompetitor, type KnowledgeBase, type RankedSearch } from '../knowledge'
import type { CallMemory } from './callMemory'
import { QUESTION_WINDOW_MS, questionParts } from './retrieval'

/** Put to Keith: "Can your platform…", "How does yours…". */
const TO_KEITH = /\b(?:you|your|yours)\b/i

/**
 * A concept mentioned by more than this share of the searchable sections is too common to count, unless
 * it is rare by number (a small pack has few sections, so one section can be a big share).
 */
export const PASSAGE_COMMON_SHARE = 1 / 3
/** A lone concept is rare enough only if at most this many sections mention it. */
export const PASSAGE_RARE_MAX_SECTIONS = 3
/** The best match from another section must rank at most this share of the top one. */
export const PASSAGE_MARGIN = 0.65
/** The box shows about this many characters (the first sentence or two) until Keith opens it. */
export const PASSAGE_SNIPPET_CHARS = 200
/** A second sentence is added only if both together stay within this. */
const SNIPPET_STRETCH = 1.25

/** What strongMatch() decides on, per search (all numbers, so each threshold can be tested on both sides). */
export interface MatchFacts {
  /**
   * One entry per concept of the question that the top section mentions (`alias`: a term from
   * aliases.json; `tag`: one of the top document's tags; `fromLatest`: in what they said last).
   */
  concepts: Array<{ sections: number; inHeading: boolean; alias: boolean; tag: boolean; fromLatest: boolean }>
  /** What they said last asks something ("?"). */
  asked: boolean
  /** Sections in the approved, in-scope documents searched. */
  sections: number
  topRank: number
  /** Rank of the best chunk from any other section; null when nothing else matched. */
  runnerUpRank: number | null
}

export function strongMatch(f: MatchFacts): boolean {
  const common = (c: MatchFacts['concepts'][number]) => c.sections > PASSAGE_RARE_MAX_SECTIONS && c.sections > f.sections * PASSAGE_COMMON_SHARE
  const inHeading = f.concepts.filter((c) => c.inHeading && !common(c))
  const two = inHeading.length >= 2
  // A tag is a named term only in a question (see the header).
  const named = (c: MatchFacts['concepts'][number]) => c.alias || (c.tag && f.asked)
  const oneRare = inHeading.some((c) => named(c) && c.sections <= PASSAGE_RARE_MAX_SECTIONS)
  const aboutLatest = inHeading.some((c) => c.fromLatest)
  const ahead = f.runnerUpRank === null || f.runnerUpRank <= f.topRank * PASSAGE_MARGIN
  return (two || oneRare) && aboutLatest && ahead
}

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREV = /(?:\be\.g|\bi\.e|\bvs|\betc|\bInc|\bapprox)\.$/i
/** A line that starts like this is a hypothesis about buyers in general (the objection-note format), not something to say. */
const HYPOTHESIS = /^[\s>*_-]*possible reasons?\b/i

/** The text without its "Possible reason" lines (and their wrapped lines, which go on in lower case). */
function withoutHypotheses(text: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (HYPOTHESIS.test(line)) skipping = true
    else if (!(skipping && /^\s*\p{Ll}/u.test(line))) {
      skipping = false
      kept.push(line)
    }
  }
  return kept.join('\n').trim()
}

/**
 * The first sentence, plus the second when both fit in about PASSAGE_SNIPPET_CHARS; a long first
 * sentence is cut at a word. "Possible reason" lines are left out ('' if that is all there is).
 */
export function passageSnippet(text: string, max = PASSAGE_SNIPPET_CHARS): string {
  const flat = withoutHypotheses(text).replace(/\s+/g, ' ').trim()
  const sentences: string[] = []
  let from = 0
  // A sentence ends at . ! or ? (after any closing quote or bracket) followed by a space and a capital, digit or quote.
  for (const m of flat.matchAll(/[.!?]["')\]]*\s+(?=["'(\[]?[\p{Lu}\p{N}])/gu)) {
    const end = (m.index ?? 0) + m[0].trimEnd().length
    if (ABBREV.test(flat.slice(from, end))) continue
    sentences.push(flat.slice(from, end))
    from = (m.index ?? 0) + m[0].length
  }
  if (from < flat.length) sentences.push(flat.slice(from))
  let out = sentences[0] ?? ''
  if (sentences[1] && out.length < max && out.length + 1 + sentences[1].length <= max * SNIPPET_STRETCH) out = `${out} ${sentences[1]}`
  if (out.length > max * SNIPPET_STRETCH) {
    const cut = out.lastIndexOf(' ', max)
    out = `${out.slice(0, cut > max / 2 ? cut : max).replace(/[\s,;:]+$/, '')}…`
  }
  return out
}

/**
 * The passage for the top section of a search over every approved document (searchRanked with
 * everyApproved), or null unless it is usable for this deployment and a strong match (see the header).
 * `latest` is what they said last, or the last thing they asked (questionParts).
 */
export function passageFrom(kb: KnowledgeBase, s: RankedSearch | null, deployment: Deployment, latest: string): ApprovedPassage | null {
  const top = s?.ranked[0]
  if (!s || !top || top.stale || !inScope(top.meta, deployment)) return null
  const runnerUp = s.ranked.find((c) => c.doc_id !== top.doc_id || c.heading !== top.heading)
  const tags = new Set(top.meta.tags.map((t) => t.toLowerCase()))
  const said = new Set(ftsConcepts(latest, kb.aliasMap).flat())
  const facts: MatchFacts = {
    concepts: top.matched.map((i) => ({
      sections: s.concepts[i].sections, inHeading: top.in_heading.includes(i), alias: s.concepts[i].terms.some((t) => kb.aliasMap.has(t)),
      tag: s.concepts[i].terms.some((t) => tags.has(t)), fromLatest: s.concepts[i].terms.some((t) => said.has(t)),
    })),
    asked: latest.includes('?'),
    sections: s.sections,
    topRank: top.rank,
    runnerUpRank: runnerUp?.rank ?? null,
  }
  if (!strongMatch(facts)) return null
  const chunks = kb.sectionChunks(top.doc_id, top.heading)
  const text = chunks.length ? chunks.map((c) => c.text).join('\n\n') : top.text
  const snippet = passageSnippet(text)
  // Nothing but hypotheses: nothing Keith could say from it.
  if (!snippet) return null
  return {
    doc_id: top.doc_id,
    title: top.meta.title,
    heading: top.heading,
    chunk_ids: chunks.length ? chunks.map((c) => c.chunk_id) : [top.chunk_id],
    snippet,
    text,
    source_ref: top.source_ref || `Source: ${top.meta.source}`,
    applies_to: top.meta.applies_to,
    used_by_card: false,
  }
}

/** At a HELP press: the approved passage for what the other side just said, or null (no question, no knowledge, or no strong match). */
export function findApprovedPassage(opts: { kb: KnowledgeBase | null; memory: CallMemory; atMs: number; today?: Date }): ApprovedPassage | null {
  const kb = opts.kb
  if (!kb) return null
  const q = questionParts(opts.memory, opts.atMs)
  if (!q.text) return null
  const deployment = opts.memory.setup.deployment ?? 'unknown'
  const today = opts.today ?? new Date()
  // Who was named in the last 30 s (both sides, with words still being transcribed).
  const recent = [
    q.text,
    ...opts.memory.turnsAsOf(opts.atMs).filter((t) => t.end_ms >= opts.atMs - QUESTION_WINDOW_MS).map((t) => t.text),
    ...opts.memory.interimsAsOf(opts.atMs).map((i) => i.text),
  ].join(' ')
  const named = new Set(kb.competitorsNamed(recent))
  const namedLast = new Set(kb.competitorsNamed(q.newest))
  const toKeith = TO_KEITH.test(q.newest)
  const find = (search: string, about: string) => {
    const p = passageFrom(kb, kb.searchRanked(search, today, deployment, { everyApproved: true }), deployment, about)
    const meta = p ? kb.getDoc(p.doc_id) : null
    // A competitor's note only when they're being discussed; hidden, never swapped for another note (see the header).
    if (meta && isCompetitor(meta) && (!named.has(meta.vendor!) || (toKeith && !namedLast.has(meta.vendor!)))) return null
    return p
  }
  // What they said last, on its own; else the whole question, about the last thing they asked (see the header).
  const last = q.newest ? find(q.newest, q.newest) : null
  // Nothing more to try when they asked nothing, or what they said last was all they said.
  if (last || !q.asked || q.text === q.newest) return last
  return find(q.text, q.asked)
}
