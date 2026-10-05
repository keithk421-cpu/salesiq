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
 *     named term: an alias from aliases.json or one of the document's own tags (a lone ordinary word
 *     such as "different" or "take" says little about the topic); a concept that many sections
 *     mention (e.g. "Arize", "use") never counts;
 *   - its heading must name something from what they asked last (retrieval.ts, questionParts), so
 *     an earlier question that Keith already answered in a few words can't bring back its note;
 *   - it must be clearly ahead of the best match from any other section.
 * Unapproved documents are never searched at all.
 */
import type { ApprovedPassage, Deployment } from '../../shared/help'
import { ftsConcepts } from '../db'
import { inScope, type KnowledgeBase, type RankedSearch } from '../knowledge'
import type { CallMemory } from './callMemory'
import { questionParts } from './retrieval'

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
  /** One entry per concept of the question that the top section mentions (`fromLatest`: in what they asked last). */
  concepts: Array<{ sections: number; inHeading: boolean; named: boolean; fromLatest: boolean }>
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
  const oneRare = inHeading.some((c) => c.named && c.sections <= PASSAGE_RARE_MAX_SECTIONS)
  const aboutLatest = inHeading.some((c) => c.fromLatest)
  const ahead = f.runnerUpRank === null || f.runnerUpRank <= f.topRank * PASSAGE_MARGIN
  return (two || oneRare) && aboutLatest && ahead
}

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREV = /(?:\be\.g|\bi\.e|\bvs|\betc|\bInc|\bapprox)\.$/i

/** The first sentence, plus the second when both fit in about PASSAGE_SNIPPET_CHARS; a long first sentence is cut at a word. */
export function passageSnippet(text: string, max = PASSAGE_SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
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
 * `latest` is what they asked last (questionParts); without it the whole searched text counts.
 */
export function passageFrom(kb: KnowledgeBase, s: RankedSearch | null, deployment: Deployment, latest?: string): ApprovedPassage | null {
  const top = s?.ranked[0]
  if (!s || !top || top.stale || !inScope(top.meta, deployment)) return null
  const runnerUp = s.ranked.find((c) => c.doc_id !== top.doc_id || c.heading !== top.heading)
  const named = new Set([...kb.aliasMap.keys(), ...top.meta.tags.map((t) => t.toLowerCase())])
  const asked = latest === undefined ? null : new Set(ftsConcepts(latest, kb.aliasMap).flat())
  const facts: MatchFacts = {
    concepts: top.matched.map((i) => ({
      sections: s.concepts[i].sections, inHeading: top.in_heading.includes(i), named: s.concepts[i].terms.some((t) => named.has(t)),
      fromLatest: !asked || s.concepts[i].terms.some((t) => asked.has(t)),
    })),
    sections: s.sections,
    topRank: top.rank,
    runnerUpRank: runnerUp?.rank ?? null,
  }
  if (!strongMatch(facts)) return null
  const chunks = kb.sectionChunks(top.doc_id, top.heading)
  const text = chunks.length ? chunks.map((c) => c.text).join('\n\n') : top.text
  return {
    doc_id: top.doc_id,
    title: top.meta.title,
    heading: top.heading,
    chunk_ids: chunks.length ? chunks.map((c) => c.chunk_id) : [top.chunk_id],
    snippet: passageSnippet(text),
    text,
    source_ref: top.source_ref || `Source: ${top.meta.source}`,
    applies_to: top.meta.applies_to,
    used_by_card: false,
  }
}

/** At a HELP press: the approved passage for what the other side just said, or null (no question, no knowledge, or no strong match). */
export function findApprovedPassage(opts: { kb: KnowledgeBase | null; memory: CallMemory; atMs: number; today?: Date }): ApprovedPassage | null {
  if (!opts.kb) return null
  const q = questionParts(opts.memory, opts.atMs)
  if (!q.text) return null
  const deployment = opts.memory.setup.deployment ?? 'unknown'
  return passageFrom(opts.kb, opts.kb.searchRanked(q.text, opts.today ?? new Date(), deployment, { everyApproved: true }), deployment, q.latest)
}
