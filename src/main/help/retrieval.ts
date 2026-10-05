/**
 * What HELP searches the approved knowledge with.
 *
 * "The question" is the other side's latest words: their last turn that ended in the last 30 s, with
 * the turns just before it that Keith only acknowledged in between, plus any of their words still being
 * transcribed (live, that is the rest of the same sentence; in replay, a buyer mid-question at the
 * press exists only as provisional text). On calls the question is often followed by "Fair question."
 * from Keith and "So, yeah." from the buyer, so the last turn alone is often just a filler. A question
 * or a real answer from Keith ends it: what the other side said before that belongs to an older
 * exchange. Searching it on its own keeps the buyer's question from being diluted by the rest of the
 * last 30 s.
 *
 * The model's knowledge comes from two searches, the question alone and the whole last 30 s, merged
 * by each chunk's best rank (each search scaled to its own best hit, so both best hits count as 1.0).
 * Hits well below the best are dropped so fewer distractors reach the model; at most `limit` are kept.
 */
import type { Deployment, KnowledgeChunk } from '../../shared/help'
import type { KnowledgeBase, KnowledgeSearch, RankedChunk, RankedSearch } from '../knowledge'
import type { CallMemory } from './callMemory'

/** The question is what the other side said in the last 30 s (the same window as HELP's verbatim context). */
export const QUESTION_WINDOW_MS = 30_000
/**
 * A merged hit is kept only if its scaled rank is at least this share of the best (1.0). Hits below half
 * the best mostly share one common word with what was said; the intended section is rarely that far behind.
 */
export const KNOWLEDGE_KEEP_SHARE = 0.5

/** A line of Keith's this short, without a question mark, is an acknowledgment ("Fair question.", "Okay, got it.") and doesn't end the question. */
export const ACK_MAX_WORDS = 8

/** The other side's latest words (see the header), or '' if they said nothing in the last 30 s. */
export function latestQuestion(memory: CallMemory, atMs: number): string {
  const turns = memory.turnsAsOf(atMs)
  const theirs: string[] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.stream === 'system_remote') {
      if (t.end_ms >= atMs - QUESTION_WINDOW_MS) theirs.unshift(t.text)
      continue
    }
    // Keith's own line after their last words (e.g. he started answering) doesn't hide their question.
    const ack = !t.text.includes('?') && t.text.trim().split(/\s+/).length <= ACK_MAX_WORDS
    if (theirs.length && !ack) break
  }
  const still = memory.interimsAsOf(atMs).find((i) => i.stream === 'system_remote')?.text ?? ''
  return [...theirs, still].join(' ').trim()
}

export interface KnowledgePick extends KnowledgeSearch {
  /** The question-alone search (null when there was no question), for the approved passage. */
  questionSearch: RankedSearch | null
}

/**
 * Ranked lists (best first, the question's own list first) merged by each chunk's best rank scaled to
 * its list's best hit; hits below KNOWLEDGE_KEEP_SHARE are dropped; at most `limit` are kept.
 */
export function mergeRanked(lists: Array<RankedChunk[] | null>, limit: number): KnowledgeChunk[] {
  const best = new Map<string, { chunk: RankedChunk; share: number; order: number }>()
  lists.forEach((ranked, list) => {
    const top = ranked?.[0]?.rank ?? 0
    if (!ranked || top <= 0) return
    ranked.forEach((chunk, i) => {
      const share = chunk.rank / top
      const prev = best.get(chunk.chunk_id)
      if (!prev || share > prev.share) best.set(chunk.chunk_id, { chunk, share, order: list * 1e6 + i })
    })
  })
  // On a tie, the earlier list (the question's own) comes first.
  return [...best.values()]
    .filter((x) => x.share >= KNOWLEDGE_KEEP_SHARE)
    .sort((a, b) => b.share - a.share || a.order - b.order)
    .slice(0, limit)
    .map(({ chunk: { rank: _rank, matched: _m, in_heading: _h, ...c } }) => c)
}

/** Merge the question-alone and last-30-s searches (see the header). */
export function retrieveKnowledge(kb: KnowledgeBase, opts: { question: string; hotText: string; limit: number; today?: Date; deployment: Deployment }): KnowledgePick {
  const today = opts.today ?? new Date()
  const questionSearch = opts.question.trim() ? kb.searchRanked(opts.question, today, opts.deployment) : null
  const hotSearch = kb.searchRanked(opts.hotText, today, opts.deployment)
  const usable = mergeRanked([questionSearch?.ranked ?? null, hotSearch.ranked], opts.limit)
  const staleTitles = [...new Set([...(questionSearch?.staleTitles ?? []), ...hotSearch.staleTitles])]
  const scopedOut = new Map<string, string[]>()
  for (const d of [...(questionSearch?.scopedOut ?? []), ...hotSearch.scopedOut]) scopedOut.set(d.title, d.applies_to)
  return { usable, staleTitles, scopedOut: [...scopedOut].map(([title, applies_to]) => ({ title, applies_to })), questionSearch }
}
