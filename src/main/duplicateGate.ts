/**
 * Transcript-level duplicate suppression (second line of defence after the
 * audio echo gate). If a FINAL mic segment repeats words the system stream said
 * at about the same time, it is meeting audio leaking into the mic, not Keith.
 *
 * Mic segments are held briefly (holdMs) so the matching system words can
 * arrive; then released or suppressed. Suppressions are counted and logged.
 * When the system stream was silent around a mic segment there is nothing to
 * duplicate, so the segment is released immediately (no added latency).
 */
import type { DiarizedWord } from '../shared/contracts'

export interface DuplicateGateOptions {
  holdMs?: number
  windowMs?: number
  minTokens?: number
  threshold?: number
}

export interface Suppressed {
  words: DiarizedWord[]
  score: number
  matchedText: string
}

interface Pending {
  words: DiarizedWord[]
  readyAt: number
}

export function normalizeToken(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')
}

/** Longest common subsequence length of two token lists. */
export function lcs(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  let prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[b.length]
}

export class DuplicateGate {
  private system: DiarizedWord[] = []
  private pending: Pending[] = []
  private readonly holdMs: number
  private readonly windowMs: number
  private readonly minTokens: number
  private readonly threshold: number
  suppressedCount = 0

  constructor(opts: DuplicateGateOptions = {}) {
    this.holdMs = opts.holdMs ?? 1500
    this.windowMs = opts.windowMs ?? 1500
    this.minTokens = opts.minTokens ?? 2
    this.threshold = opts.threshold ?? 0.6
  }

  addSystemWords(words: DiarizedWord[]): void {
    for (const w of words) if (w.is_final) this.system.push(w)
    const newest = this.system.length ? this.system[this.system.length - 1].end_ms : 0
    // Keep ~30 s of system words.
    while (this.system.length && this.system[0].end_ms < newest - 30000) this.system.shift()
  }

  /**
   * @param systemMayOverlap false when the system stream had no audible sound around this
   *   segment: a duplicate is impossible, so the segment is released without the hold delay.
   */
  addMicWords(words: DiarizedWord[], nowWallMs: number, systemMayOverlap = true): void {
    const finals = words.filter((w) => w.is_final)
    if (finals.length) this.pending.push({ words: finals, readyAt: nowWallMs + (systemMayOverlap ? this.holdMs : 0) })
  }

  /** Release mic segments whose hold time has passed (or all, when force). */
  poll(nowWallMs: number, force = false): { release: DiarizedWord[][]; suppressed: Suppressed[] } {
    const release: DiarizedWord[][] = []
    const suppressed: Suppressed[] = []
    while (this.pending.length && (force || this.pending[0].readyAt <= nowWallMs)) {
      const p = this.pending.shift()!
      const verdict = this.check(p.words)
      if (verdict) {
        this.suppressedCount++
        suppressed.push(verdict)
      } else release.push(p.words)
    }
    return { release, suppressed }
  }

  check(micWords: DiarizedWord[]): Suppressed | null {
    const micTokens = micWords.map((w) => normalizeToken(w.word)).filter(Boolean)
    if (micTokens.length < this.minTokens) return null
    const start = micWords[0].start_ms - this.windowMs
    const end = micWords[micWords.length - 1].end_ms + this.windowMs
    const near = this.system.filter((w) => w.end_ms >= start && w.start_ms <= end)
    if (near.length === 0) return null
    const sysTokens = near.map((w) => normalizeToken(w.word)).filter(Boolean)
    const score = lcs(micTokens, sysTokens) / micTokens.length
    if (score >= this.threshold) {
      return { words: micWords, score, matchedText: near.map((w) => w.word).join(' ') }
    }
    return null
  }
}
