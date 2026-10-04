/**
 * Maps provider audio time (seconds since the first sample sent on one STT
 * connection epoch) back to session-relative ms. Each sent chunk records where
 * its first sample sits on the session clock, so dropped audio, gaps and
 * reconnects never skew word timestamps.
 */
import { SAMPLE_RATE } from './pcm'

interface Entry {
  offsetSamples: number
  sessionMs: number
  samples: number
}

const MAX_ENTRIES = 30000 // ~10 min at 20 ms chunks

export class SampleClock {
  private entries: Entry[] = []
  private sentSamples = 0

  record(samples: number, sessionMs: number): void {
    this.entries.push({ offsetSamples: this.sentSamples, sessionMs, samples })
    this.sentSamples += samples
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
  }

  get totalSamples(): number {
    return this.sentSamples
  }

  /** Provider seconds -> session ms. Null when nothing has been sent yet. */
  toSessionMs(providerSeconds: number): number | null {
    if (this.entries.length === 0) return null
    const offset = providerSeconds * SAMPLE_RATE
    let lo = 0
    let hi = this.entries.length - 1
    if (offset <= this.entries[0].offsetSamples) {
      return this.entries[0].sessionMs + ((offset - this.entries[0].offsetSamples) * 1000) / SAMPLE_RATE
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.entries[mid].offsetSamples <= offset) lo = mid
      else hi = mid - 1
    }
    const e = this.entries[lo]
    return e.sessionMs + ((offset - e.offsetSamples) * 1000) / SAMPLE_RATE
  }
}
