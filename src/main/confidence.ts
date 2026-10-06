/**
 * How sure the speech service was of the meeting audio's words, over one call: numbers only (how many
 * words, the lowest, the median, and the share under 0.6). Logged at Stop so the heard line's dimming
 * can be calibrated on real calls before anything on screen depends on it (M3 A). Never any words.
 */
import type { DiarizedWord } from '../shared/contracts'

/** Below this a word counts as unsure. */
export const LOW_CONFIDENCE = 0.6

export interface ConfidenceSummary {
  words: number
  min: number | null
  median: number | null
  /** Share of words under LOW_CONFIDENCE (0..1, two decimals). */
  under_060: number | null
}

export class ConfidenceSpread {
  /** Words per hundredth of confidence (0.00 .. 1.00): a long call stays a fixed 101 numbers. */
  private bins = new Array<number>(101).fill(0)
  private count = 0
  private low = 0
  private lowest: number | null = null

  add(words: Array<Pick<DiarizedWord, 'confidence'>>): void {
    for (const w of words) {
      const c = w.confidence
      if (typeof c !== 'number' || !Number.isFinite(c)) continue
      const v = Math.min(1, Math.max(0, c))
      this.bins[Math.round(v * 100)]++
      this.count++
      if (v < LOW_CONFIDENCE) this.low++
      this.lowest = this.lowest === null ? v : Math.min(this.lowest, v)
    }
  }

  summary(): ConfidenceSummary {
    if (!this.count) return { words: 0, min: null, median: null, under_060: null }
    // The middle word's bin (the lower middle for an even count), to the hundredth.
    const mid = Math.ceil(this.count / 2)
    let seen = 0
    let median = 0
    for (let i = 0; i < this.bins.length; i++) {
      seen += this.bins[i]
      if (seen >= mid) {
        median = i / 100
        break
      }
    }
    const r2 = (x: number) => Math.round(x * 100) / 100
    return { words: this.count, min: r2(this.lowest ?? 0), median, under_060: r2(this.low / this.count) }
  }
}
