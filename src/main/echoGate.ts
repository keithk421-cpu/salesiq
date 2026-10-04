/**
 * Residual echo gate for the mic stream.
 *
 * Adapted from Project Raven src/main/residualEchoGate.ts
 * (https://github.com/Laxcorp-Research/project-raven, commit 692cd17606e9f2d0063e2c32c9e250eaa5f60ddc),
 * MIT License, Copyright (c) 2026 Laxcorp Software Design - FZCO. See THIRD_PARTY_NOTICES.md.
 *
 * Raven does not ship WebRTC AEC3 on Windows (see docs/RAVEN_IMPLEMENTATION_NOTES.md), so on
 * Windows this correlation gate is the audio-level echo defence. With Keith's headset,
 * echo should be rare; the gate catches the case where meeting audio leaks into the mic.
 *
 * Differences from Raven:
 * - No separate AEC-cleaned signal: raw mic is used for both decisions.
 * - Echo windows are replaced with zeros instead of withheld, so the mic timeline stays
 *   continuous for timestamp mapping.
 * - Counts every suppressed window for the M0 leakage report.
 */
import { rms, toInt16 } from './pcm'

const SAMPLE_RATE = 16000
const RING_SAMPLES = (SAMPLE_RATE * 400) / 1000
export const CORR_WINDOW = 1600 // 100 ms
const LAG_STEP = 80 // 5 ms
export const ECHO_CORR_THRESHOLD = 0.32
const HOLDOVER_SAMPLES = (SAMPLE_RATE * 400) / 1000
const SILENCE_RMS = 50

export type EchoDecision = 'send' | 'echo' | 'hold' | 'quiet'

export interface GatedMicWindow {
  pcm: Buffer
  decision: EchoDecision
  correlation: number
}

export class ResidualEchoGate {
  private readonly ring = new Int16Array(RING_SAMPLES)
  private write = 0
  private filled = 0
  private holdSamples = 0
  private pending: Buffer[] = []
  private pendingSamples = 0
  suppressedWindows = 0

  /** Samples buffered but not yet emitted as a window. */
  get pendingSampleCount(): number {
    return this.pendingSamples
  }
  totalWindows = 0

  reset(): void {
    this.ring.fill(0)
    this.write = 0
    this.filled = 0
    this.holdSamples = 0
    this.pending = []
    this.pendingSamples = 0
  }

  pushSystemPcm(buf: Buffer): void {
    const samples = toInt16(buf)
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i]
      this.write = (this.write + 1) % this.ring.length
      if (this.filled < this.ring.length) this.filled++
    }
  }

  /**
   * Accumulate mic PCM; returns completed 100 ms windows (echo windows zeroed).
   * Output sample count always equals input sample count over time.
   */
  pushMicPcm(buf: Buffer): GatedMicWindow[] {
    this.pending.push(buf)
    this.pendingSamples += Math.floor(buf.length / 2)
    const out: GatedMicWindow[] = []
    while (this.pendingSamples >= CORR_WINDOW) {
      const all = Buffer.concat(this.pending)
      const window = all.subarray(0, CORR_WINDOW * 2)
      const rest = all.subarray(CORR_WINDOW * 2)
      this.pending = rest.length > 0 ? [Buffer.from(rest)] : []
      this.pendingSamples = Math.floor(rest.length / 2)
      out.push(this.decide(Buffer.from(window)))
    }
    return out
  }

  /** Drain any partial window as-is (used on stop; never on resume). */
  discardPending(): void {
    this.pending = []
    this.pendingSamples = 0
  }

  private decide(window: Buffer): GatedMicWindow {
    this.totalWindows++
    const { echo, corr } = this.looksLikeEcho(window)
    if (echo) {
      this.holdSamples = HOLDOVER_SAMPLES
      this.suppressedWindows++
      return { pcm: Buffer.alloc(window.length), decision: 'echo', correlation: corr }
    }
    const micRms = rms(toInt16(window))
    if (this.holdSamples > 0) {
      this.holdSamples -= CORR_WINDOW
      // A quiet residual right after an echo hit is held; real near-end speech is loud and passes.
      if (micRms < 80) {
        this.suppressedWindows++
        return { pcm: Buffer.alloc(window.length), decision: 'hold', correlation: corr }
      }
    }
    return { pcm: window, decision: micRms < SILENCE_RMS ? 'quiet' : 'send', correlation: corr }
  }

  private looksLikeEcho(buf: Buffer): { echo: boolean; corr: number } {
    const mic = toInt16(buf)
    if (rms(mic) < SILENCE_RMS) return { echo: false, corr: 0 }
    if (this.filled < CORR_WINDOW) return { echo: false, corr: 0 }
    if (ringRms(this.ring, this.write, this.filled) < SILENCE_RMS) return { echo: false, corr: 0 }
    const windowLen = Math.min(CORR_WINDOW, mic.length)
    const micWindow = mic.subarray(mic.length - windowLen)
    const maxLag = this.filled - windowLen
    let best = 0
    for (let lag = 0; lag <= maxLag; lag += LAG_STEP) {
      const far = ringSlice(this.ring, this.write, this.filled, lag, windowLen)
      if (!far) break
      if (rms(far) < SILENCE_RMS) continue
      const c = Math.abs(pearson(micWindow, far))
      if (c > best) best = c
      if (best >= ECHO_CORR_THRESHOLD) break
    }
    return { echo: best >= ECHO_CORR_THRESHOLD, corr: best }
  }
}

export function pearson(a: Int16Array, b: Int16Array): number {
  const n = a.length
  if (n === 0 || n !== b.length) return 0
  let sa = 0, sb = 0, sab = 0, sa2 = 0, sb2 = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    sa += x
    sb += y
    sab += x * y
    sa2 += x * x
    sb2 += y * y
  }
  const cov = sab - (sa * sb) / n
  const da = sa2 - (sa * sa) / n
  const db = sb2 - (sb * sb) / n
  if (da < 1e-6 || db < 1e-6) return 0
  return cov / Math.sqrt(da * db)
}

function ringRms(ring: Int16Array, write: number, filled: number): number {
  if (filled === 0) return 0
  let ss = 0
  const start = write - filled
  for (let i = 0; i < filled; i++) {
    const s = ring[(((start + i) % ring.length) + ring.length) % ring.length]
    ss += s * s
  }
  return Math.sqrt(ss / filled)
}

function ringSlice(ring: Int16Array, write: number, filled: number, lag: number, length: number): Int16Array | null {
  if (lag + length > filled) return null
  const out = new Int16Array(length)
  let start = write - lag - length
  while (start < 0) start += ring.length
  for (let i = 0; i < length; i++) out[i] = ring[(start + i) % ring.length]
  return out
}
