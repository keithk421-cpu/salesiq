/**
 * Builds the HELP context as of the press time:
 *   HOT   - last ~30 s verbatim from ALL speakers (+ provisional interim text, labelled)
 *   WARM  - call setup, who-is-who (manual labels; unknown is fine), the recent thread
 *   COLD  - relevant earlier-in-call turns (FTS5) + approved, current knowledge (FTS5 + aliases;
 *           the other side's latest question and the last 30 s searched separately, then merged)
 *   STATUS- transcript gaps and lag, so HELP never pretends it heard something it didn't
 * Turn and knowledge references are short ids ([T3], [K1]) mapped back to real ids for validation.
 */
import type { Stream } from '../../shared/contracts'
import type { HelpContextRefs, KnowledgeChunk, MemoryTurn } from '../../shared/help'
import type { KnowledgeBase } from '../knowledge'
import type { CallMemory } from './callMemory'
import { questionParts, retrieveKnowledge } from './retrieval'

export const HOT_WINDOW_MS = 30_000
export const THREAD_WINDOW_MS = 180_000
const THREAD_MAX_CHARS = 1800
const EARLIER_MAX = 3
const KNOWLEDGE_MAX = 3
/** A source reference longer than this is shortened for the model only; the card's sources show it in full. */
const SOURCE_REF_MODEL_MAX = 400

export interface SourceInfo {
  id: string
  kind: 'turn' | 'knowledge'
  label: string
  detail: string
}

export interface BuiltContext {
  /** User-message body sent to the model. */
  text: string
  refs: HelpContextRefs
  /** Shown on the card: gaps/lag HELP could not hear. */
  warnings: string[]
  /** Short id ("T3"/"K1") -> source. */
  sources: Map<string, SourceInfo>
  /** How long the knowledge search took (ms, on the given clock). */
  knowledge_ms: number
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function speakerName(memory: CallMemory, t: { stream: Stream; cluster: string | null }): string {
  if (t.stream === 'local_mic') return 'Keith'
  const label = t.cluster ? memory.labels.get(t.cluster) : undefined
  const tag = t.cluster ? (/s(\d+)$/.exec(t.cluster)?.[1] ?? '?') : '?'
  if (!label || label.role === 'unknown') return label?.name ? `${label.name} (role unknown)` : `Speaker ${tag} (unlabeled)`
  const role = label.role === 'teammate' ? 'Arize teammate' : 'buyer'
  return label.name ? `${label.name} (${role})` : `Speaker ${tag} (${role})`
}

function scopeLabel(applies: string[]): string {
  if (!applies.length || applies.includes('all')) return 'all deployments'
  return applies.map((a) => (a === 'saas' ? "Arize's SaaS" : a === 'self_hosted' ? 'self-hosted' : a.replace(/_/g, ' '))).join(', ')
}

export function buildHelpContext(opts: {
  memory: CallMemory
  kb: KnowledgeBase | null
  atMs: number
  now?: Date
  /** Clock for the stage timing (ms); the engine passes its own so tests stay deterministic. */
  clock?: () => number
}): BuiltContext {
  const { memory, kb, atMs } = opts
  const sources = new Map<string, SourceInfo>()
  const realToShort = new Map<string, string>()
  let tN = 0
  const ref = (t: MemoryTurn): string => {
    let s = realToShort.get(t.id)
    if (!s) {
      s = `T${++tN}`
      realToShort.set(t.id, s)
      sources.set(s, { id: t.id, kind: 'turn', label: `${fmtClock(t.start_ms)} ${speakerName(memory, t)}`, detail: t.text })
    }
    return s
  }
  const line = (t: MemoryTurn) => `[${ref(t)}] (${fmtClock(t.start_ms)}) ${speakerName(memory, t)}: ${t.text}`

  const all = memory.turnsAsOf(atMs)
  // HOT: everything ending in the last 30 s, and at least the last 3 turns (after a silence).
  let hot = all.filter((t) => t.end_ms >= atMs - HOT_WINDOW_MS)
  if (hot.length < 3) hot = all.slice(-3)
  const hotIds = new Set(hot.map((t) => t.id))
  const hotStart = hot.length ? Math.min(...hot.map((t) => t.start_ms)) : atMs

  // WARM thread: the few minutes before HOT, most recent first within a char budget.
  const threadCandidates = all.filter((t) => !hotIds.has(t.id) && t.end_ms >= hotStart - THREAD_WINDOW_MS)
  const thread: MemoryTurn[] = []
  let chars = 0
  for (let i = threadCandidates.length - 1; i >= 0; i--) {
    const t = threadCandidates[i]
    chars += t.text.length + 40
    if (chars > THREAD_MAX_CHARS) break
    thread.unshift(t)
  }
  const threadStart = thread.length ? thread[0].start_ms : hotStart
  const used = new Set([...hotIds, ...thread.map((t) => t.id)])

  // COLD: earlier evidence relevant to what is being discussed now.
  const hotText = hot.map((t) => t.text).join(' ') + ' ' + memory.interimsAsOf(atMs).map((i) => i.text).join(' ')
  const earlier = memory.searchEarlier(hotText, threadStart, atMs, EARLIER_MAX).filter((t) => !used.has(t.id))

  const deployment = memory.setup.deployment ?? 'unknown'
  let usable: KnowledgeChunk[] = []
  let staleTitles: string[] = []
  let scopedOut: Array<{ title: string; applies_to: string[] }> = []
  const clock = opts.clock ?? (() => performance.now())
  const k0 = clock()
  // The other side's latest words (and what they said last) searched on their own, merged with the whole last 30 s (retrieval.ts).
  if (kb) {
    const q = questionParts(memory, atMs)
    const pick = retrieveKnowledge(kb, { question: q.text, newest: q.newest, hotText, limit: KNOWLEDGE_MAX, today: opts.now, deployment })
    usable = pick.usable
    staleTitles = pick.staleTitles
    scopedOut = pick.scopedOut
  }
  const knowledgeMs = Math.max(0, Math.round(clock() - k0))
  const kShort: string[] = []
  usable.forEach((c, i) => {
    const s = `K${i + 1}`
    kShort.push(s)
    // The card's sources show the whole section and its full reference, so a line can be traced exactly.
    sources.set(s, { id: c.chunk_id, kind: 'knowledge', label: c.meta.title, detail: `${c.heading ? c.heading + ': ' : ''}${c.text}${c.source_ref ? `\n${c.source_ref}` : ''}` })
  })

  // STATUS: gaps and lag. Never pretend coverage was continuous.
  const warnings: string[] = []
  const gapNotes: string[] = []
  for (const g of memory.gapsAsOf(atMs)) {
    const end = g.end_ms ?? atMs
    if (end < atMs - 120_000 || g.cause === 'pause') continue
    const what = g.stream === 'local_mic' ? "Keith's mic" : 'meeting audio'
    const span = `${fmtClock(g.start_ms)}–${g.end_ms === null ? 'now' : fmtClock(g.end_ms)}`
    gapNotes.push(`Transcript gap ${span} on ${what} (${g.cause.replace(/_/g, ' ')}): nothing was heard then.`)
    warnings.push(`Gap ${span} (${what}) — HELP didn't hear that part.`)
  }
  const interims = memory.interimsAsOf(atMs)
  const lags = [...memory.lagMs.values()]
  const lag = lags.length ? Math.max(...lags) : null
  if (interims.length) warnings.push('Last few seconds still being transcribed.')
  else if (lag !== null && lag > 2500) warnings.push(`Transcript running ~${(lag / 1000).toFixed(1)} s behind.`)

  // Render.
  const s = memory.setup
  const roster = [
    'Keith (Arize account executive, on the mic)',
    ...[...memory.labels.values()].map((l) => `${l.name ?? `Speaker ${/s(\d+)$/.exec(l.cluster)?.[1] ?? '?'}`} = ${l.role === 'teammate' ? 'Arize teammate (e.g. SA)' : l.role}`),
  ]
  const unlabeled = new Set(all.filter((t) => t.stream === 'system_remote' && (!t.cluster || !memory.labels.has(t.cluster))).map((t) => t.cluster ?? '?'))
  if (unlabeled.size) roster.push(`${unlabeled.size} remote speaker(s) not labeled - roles unknown (that is normal)`)

  const parts: string[] = []
  parts.push(
    `<call_setup>\ntype: ${s.call_type}\ngoal: ${s.call_goal || '(not set)'}\ndesired outcomes: ${s.desired_outcomes.join('; ') || '(not set)'}\naccount: ${s.account || '(not set)'}\ndeployment: ${deployment === 'unknown' ? 'not known (SaaS or self-hosted)' : deployment === 'saas' ? "Arize's SaaS" : 'self-hosted'}\n</call_setup>`,
  )
  parts.push(`<participants>\n${roster.join('\n')}\n</participants>`)
  if (earlier.length) parts.push(`<earlier_in_call note="relevant moments from earlier; speaker statements, not verified facts">\n${earlier.map(line).join('\n')}\n</earlier_in_call>`)
  if (thread.length) parts.push(`<recent_thread>\n${thread.map(line).join('\n')}\n</recent_thread>`)
  const provisional = interims.map((i) => `(still being transcribed, may be inaccurate) ${i.stream === 'local_mic' ? 'Keith' : 'Remote'}: ${i.text}`)
  parts.push(`<last_30_seconds>\n${[...hot.map(line), ...provisional].join('\n') || '(nothing transcribed yet)'}\n</last_30_seconds>`)
  if (gapNotes.length || interims.length || (lag !== null && lag > 2500)) {
    const notes = [...gapNotes]
    if (lag !== null && lag > 2500) notes.push(`Final transcript is running about ${(lag / 1000).toFixed(1)} s behind live audio.`)
    parts.push(`<transcript_status>\n${notes.join('\n') || 'Latest words are provisional.'}\n</transcript_status>`)
  }
  if (usable.length) {
    parts.push(
      `<approved_knowledge note="the ONLY material you may state as Arize fact. These are search matches: use an item only if it directly answers what was asked; if none does, say you'll follow up">\n${usable
        .map((c, i) => {
          const scope = scopeLabel(c.meta.applies_to)
          const ref = c.source_ref.length > SOURCE_REF_MODEL_MAX ? `${c.source_ref.slice(0, SOURCE_REF_MODEL_MAX)}... (full reference in card sources)` : c.source_ref
          return `[${kShort[i]}] ${c.meta.title}${c.heading ? ` - ${c.heading}` : ''} (applies to: ${scope}; version ${c.meta.version}): ${c.text}\n   ${ref || `Source: ${c.meta.source}`}`
        })
        .join('\n')}\n</approved_knowledge>`,
    )
  } else {
    parts.push('<approved_knowledge>(none relevant) - do not state Arize product facts; ask or offer to follow up instead.</approved_knowledge>')
  }
  if (scopedOut.length) {
    parts.push(`<other_deployment>\n${scopedOut.map((d) => `"${d.title}" covers ${scopeLabel(d.applies_to)} only, not this buyer's deployment: do not state it for them; offer to check.`).join('\n')}\n</other_deployment>`)
  }
  if (staleTitles.length) parts.push(`<not_current>\n${staleTitles.map((t) => `"${t}" exists but is past its review date: do not state its content as current; offer to confirm.`).join('\n')}\n</not_current>`)
  parts.push(`Keith pressed HELP at ${fmtClock(atMs)}.`)

  const refs: HelpContextRefs = {
    at_session_ms: Math.round(atMs),
    hot_turn_ids: hot.map((t) => t.id),
    thread_turn_ids: thread.map((t) => t.id),
    earlier_turn_ids: earlier.map((t) => t.id),
    knowledge_chunk_ids: usable.map((c) => c.chunk_id),
    knowledge_hashes: usable.map((c) => c.meta.content_hash),
    // As they were at the press: both can change later in the call (a saved practice moment replays these).
    call_setup: { ...s, desired_outcomes: [...s.desired_outcomes] },
    labels: [...memory.labels.values()].map((l) => ({ ...l })),
    gaps_noted: gapNotes,
    provisional_text: interims.length > 0,
    transcript_lag_ms: lag,
  }
  return { text: parts.join('\n\n'), refs, warnings, sources, knowledge_ms: knowledgeMs }
}
