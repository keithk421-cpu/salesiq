/**
 * Replay: build the exact HELP situation from a scenario file (or a saved session) as of the
 * HELP timestamp. Only information available at that moment is exposed:
 * - a finished utterance appears ~1 s after it ended (simulated final-transcript delay);
 * - an utterance still being spoken appears only as provisional interim text, cut ~1 s behind;
 * - later lines, post-call corrections and future gaps are never visible.
 */
import fs from 'node:fs'
import type { Stream } from '../../shared/contracts'
import type { CallSetup, CallType, Deployment, KnowledgeCategory, KnowledgeDocMeta, PressMode, SpeakerLabel } from '../../shared/help'
import { Db } from '../db'
import { KnowledgeBase } from '../knowledge'
import { cleanEarlierItems, type EarlierCallItem } from './accountMemory'
import { sanitizeMustLearn } from './callPlan'
import { CallMemory } from './callMemory'
import type { WrapWhy } from './wrap'
import type { PressDetail } from './pressModes'

export const FINAL_DELAY_MS = 1000
const WORDS_PER_SEC = 2.5

export interface ScenarioLine {
  t: number
  end?: number
  who: string
  text: string
}

export interface Scenario {
  id: string
  category: string
  tags?: string[]
  golden_approved: boolean
  synthetic?: boolean
  call_type: CallType
  call_goal: string
  desired_outcomes: string[]
  /** The buyer's deployment if Keith set it for the call (default unknown). */
  deployment?: Deployment
  /**
   * Keith's must-learns for the call, as set at the press (M3 call plan). Call notes aren't replayed,
   * so HELP sees them all as still open, as before the first notes of a live call.
   */
  must_learn?: string[]
  /** M5: how long the call is meant to run (minutes), for the time-left cue; absent: the type's default. */
  length_min?: number
  /** M5: no Arize SA on this demo or deep-dive (Keith presents alone). */
  no_sa?: boolean
  speakers: Record<string, { role: 'buyer' | 'teammate' | 'unknown'; name: string | null }>
  transcript: ScenarioLine[]
  gaps?: Array<{ start: number; end: number; stream: Stream; cause: string }>
  help_at_s: number
  knowledge?: Array<{
    id: string; title: string; text: string; category?: KnowledgeCategory; vendor?: string; source?: string; version?: string
    approved?: boolean; review_by?: string | null; applies_to?: string[]
  }>
  best_moves: string[]
  acceptable_moves: string[]
  unacceptable_behaviors: string[]
  forbid_regex?: string[]
  silence_preferred?: boolean
  acceptable_questions?: string[]
  keith_notes?: string
  // ---- Saved from one of Keith's real calls (practice/ in his data folder; never in the repo) ----
  /** 'real_call' for a moment Keith saved from a call; absent for the built-in, made-up scenarios. */
  source?: 'real_call'
  /** Readable name: account, date and time of the press. */
  title?: string
  /** Who the call was with, as set for the call (sent in the call setup like a live request). */
  account?: string
  /** The HELP request it was saved from (one practice moment per card). */
  request_id?: string
  /** Moves Keith's feedback says were wrong here (a card he rated Bad: wrong move). */
  unacceptable_moves?: string[]
  /** The card HELP gave on the call, and Keith's feedback on it. */
  observed?: ObservedCard
  /** What earlier calls with this account left behind, as HELP saw it at the press (the <earlier_calls> block). Absent on older moments. */
  earlier_calls?: EarlierCallItem[]
  /**
   * "What I know about <account>" (M4): Keith's own notes on the account, as HELP saw them at the press
   * (the <keith_notes> block's lines). Not keith_notes above, which is the reviewer's note on the scenario.
   */
  account_notes?: string
  /** Saved from a WRAP press ('button'), or a HELP press as the call sounded like it was ending ('closing'): replayed with the same wrap instruction. */
  wrap?: WrapWhy
  /** Saved from a smarter press (M3): the opening, a buying signal's next step, or another angle: replayed with the same block. */
  press_mode?: PressMode
  /** What that block (or a WRAP press's buying-signal note) showed: the signal, the line already given, the must-learns. */
  press_detail?: PressDetail
}

export interface ObservedCard {
  move: string | null
  primary_kind: 'ask' | 'say' | null
  primary: string | null
  follow_up: string | null
  model: string | null
  rating: string | null
  bad_reasons: string[]
  used: boolean
  note: string | null
}

export function loadScenario(file: string): Scenario {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario
}

export function lineEndS(l: ScenarioLine): number {
  return l.end ?? l.t + Math.max(1, l.text.split(/\s+/).length / WORDS_PER_SEC)
}

export interface ReplayState {
  memory: CallMemory
  kb: KnowledgeBase
  atMs: number
  /** Lines fully hidden at atMs (for test assertions). */
  hiddenLineIndexes: number[]
}

/** Build memory + knowledge exactly as they were at `atS` (defaults to the scenario's HELP time). */
export function replayAt(s: Scenario, atS = s.help_at_s): ReplayState {
  const db = new Db(':memory:')
  const kb = new KnowledgeBase(db, null)
  for (const k of s.knowledge ?? []) {
    const meta: KnowledgeDocMeta = {
      doc_id: k.id, title: k.title, category: k.category ?? 'other', ...(k.vendor ? { vendor: k.vendor } : {}), source: k.source ?? 'scenario fixture', version: k.version ?? 'fixture',
      content_hash: '', approved: false, needs_reapproval: false, approved_by: null, approved_at: null, review_by: k.review_by ?? null,
      applies_to: k.applies_to ?? [], tags: [], file: `${s.id}#${k.id}`,
    }
    kb.addDoc(meta, k.text)
    // Scenario fixtures stand in for Keith's in-app approval.
    if (k.approved ?? true) kb.approve(k.id, true)
  }
  const memory = new CallMemory(`replay:${s.id}`, db)
  const setup: CallSetup = { call_type: s.call_type, call_goal: s.call_goal, desired_outcomes: s.desired_outcomes, account: s.account ?? '', deployment: s.deployment ?? 'unknown' }
  const ml = sanitizeMustLearn(s.must_learn)
  if (ml.length) setup.must_learn = ml
  // M5 call modes: a scenario that needs a time ("minute 38 of 45") sets the call's length; read defensively.
  if (typeof s.length_min === 'number' && s.length_min > 0) setup.length_min = s.length_min
  if (s.no_sa === true) setup.no_sa = true
  memory.setup = setup
  memory.earlierCalls = cleanEarlierItems(s.earlier_calls)
  memory.keithNotes = typeof s.account_notes === 'string' ? s.account_notes : ''
  for (const [cluster, sp] of Object.entries(s.speakers)) {
    if (sp.role === 'unknown' && !sp.name) continue // unlabeled: Keith never tagged them
    const label: SpeakerLabel = { cluster, role: sp.role, name: sp.name }
    memory.setLabel(label)
  }
  const atMs = atS * 1000
  const hidden: number[] = []
  s.transcript.forEach((l, i) => {
    const stream: Stream = l.who === 'keith' ? 'local_mic' : 'system_remote'
    const cluster = l.who === 'keith' ? null : l.who
    const startMs = l.t * 1000
    const endMs = lineEndS(l) * 1000
    const availableMs = endMs + FINAL_DELAY_MS
    if (availableMs <= atMs) {
      memory.upsertTurn({ id: `${s.id}-L${i}`, stream, cluster, start_ms: startMs, end_ms: endMs, text: l.text, available_ms: availableMs }, true)
      return
    }
    hidden.push(i)
    // Being spoken right now: expose only the words said up to ~1 s ago, as provisional.
    const heardUntil = atMs - FINAL_DELAY_MS
    if (startMs < heardUntil) {
      const w = l.text.split(/\s+/)
      const frac = Math.min(1, (heardUntil - startMs) / Math.max(1, endMs - startMs))
      const n = Math.floor(w.length * frac)
      if (n > 0) memory.setInterim(stream, w.slice(0, n).join(' '), heardUntil, cluster)
    }
  })
  for (const [i, g] of (s.gaps ?? []).entries()) {
    if (g.start * 1000 > atMs) continue
    memory.upsertGap({ id: `${s.id}-G${i}`, stream: g.stream, cause: g.cause, start_ms: g.start * 1000, end_ms: g.end * 1000 <= atMs ? g.end * 1000 : null })
  }
  return { memory, kb, atMs, hiddenLineIndexes: hidden }
}

/**
 * Turn a saved real session (sessions/<id>/transcript.jsonl) into a replayable scenario,
 * so HELP can be re-run at any moment of a real call with only what was known then.
 * Stays local: real-call content is never written into the repo.
 */
export function scenarioFromSession(transcriptJsonl: string, helpAtS: number): Scenario {
  const lines = fs.readFileSync(transcriptJsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const turns = lines.filter((l) => l.kind === 'turn') as Array<{ stream: string; speaker_cluster: string | null; start_ms: number; end_ms: number; text: string }>
  const gaps = lines.filter((l) => l.kind === 'gap_close') as Array<{ stream: Stream; cause: string; start_ms: number; end_ms: number }>
  const speakers: Scenario['speakers'] = {}
  for (const t of turns) if (t.stream === 'system_remote' && t.speaker_cluster) speakers[t.speaker_cluster] = { role: 'unknown', name: null }
  return {
    id: `session-${transcriptJsonl.split(/[\\/]/).slice(-2, -1)[0] ?? 'real'}`,
    category: 'real_call', golden_approved: false, synthetic: false, call_type: 'other', call_goal: '', desired_outcomes: [],
    speakers,
    transcript: turns.sort((a, b) => a.start_ms - b.start_ms).map((t) => ({ t: t.start_ms / 1000, end: t.end_ms / 1000, who: t.stream === 'local_mic' ? 'keith' : (t.speaker_cluster ?? 'e0:s0'), text: t.text })),
    gaps: gaps.filter((g) => g.cause !== 'pause').map((g) => ({ start: g.start_ms / 1000, end: g.end_ms / 1000, stream: g.stream, cause: g.cause })),
    help_at_s: helpAtS, best_moves: [], acceptable_moves: [], unacceptable_behaviors: [],
  }
}
