/**
 * Replay: build the exact HELP situation from a scenario file (or a saved session) as of the
 * HELP timestamp. Only information available at that moment is exposed:
 * - a finished utterance appears ~1 s after it ended (simulated final-transcript delay);
 * - an utterance still being spoken appears only as provisional interim text, cut ~1 s behind;
 * - later lines, post-call corrections and future gaps are never visible.
 */
import fs from 'node:fs'
import type { Stream } from '../../shared/contracts'
import type { CallSetup, CallType, KnowledgeCategory, KnowledgeDocMeta, SpeakerLabel } from '../../shared/help'
import { Db } from '../db'
import { KnowledgeBase } from '../knowledge'
import { CallMemory } from './callMemory'

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
  speakers: Record<string, { role: 'buyer' | 'teammate' | 'unknown'; name: string | null }>
  transcript: ScenarioLine[]
  gaps?: Array<{ start: number; end: number; stream: Stream; cause: string }>
  help_at_s: number
  knowledge?: Array<{
    id: string; title: string; text: string; category?: KnowledgeCategory; source?: string; version?: string
    approved?: boolean; review_by?: string | null; applies_to?: string[]
  }>
  best_moves: string[]
  acceptable_moves: string[]
  unacceptable_behaviors: string[]
  forbid_regex?: string[]
  silence_preferred?: boolean
  acceptable_questions?: string[]
  keith_notes?: string
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
      doc_id: k.id, title: k.title, category: k.category ?? 'other', source: k.source ?? 'scenario fixture', version: k.version ?? 'fixture',
      approved: k.approved ?? true, approved_by: null, approved_at: null, review_by: k.review_by ?? null,
      applies_to: k.applies_to ?? [], tags: [], file: `${s.id}#${k.id}`,
    }
    kb.addDoc(meta, k.text)
  }
  const memory = new CallMemory(`replay:${s.id}`, db)
  const setup: CallSetup = { call_type: s.call_type, call_goal: s.call_goal, desired_outcomes: s.desired_outcomes, account: '' }
  memory.setup = setup
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
      if (n > 0) memory.setInterim(stream, w.slice(0, n).join(' '), heardUntil)
    }
  })
  for (const [i, g] of (s.gaps ?? []).entries()) {
    if (g.start * 1000 > atMs) continue
    memory.upsertGap({ id: `${s.id}-G${i}`, stream: g.stream, cause: g.cause, start_ms: g.start * 1000, end_ms: g.end * 1000 <= atMs ? g.end * 1000 : null })
  }
  return { memory, kb, atMs, hiddenLineIndexes: hidden }
}
