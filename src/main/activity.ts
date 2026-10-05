/**
 * Per-stream audio activity tracking used for:
 * - the session-start gate (real signal on both streams, not just API success),
 * - meters,
 * - stall detection (no chunks at all),
 * - digital-silence detection on the mic (exact zeros = headset off/muted at the device).
 */
import { isDigitalZero, peak, rmsDbfs, samplesToMs, toInt16 } from './pcm'

export interface ActivityThresholds {
  /** dBFS above which a chunk counts as active audio. */
  activeDbfs: number
  /** Accumulated active ms needed to pass the start gate. */
  requiredActiveMs: number
}

export const SYSTEM_THRESHOLDS: ActivityThresholds = { activeDbfs: -50, requiredActiveMs: 400 }
export const MIC_THRESHOLDS: ActivityThresholds = { activeDbfs: -45, requiredActiveMs: 400 }

/**
 * The start gate only counts sound from this recent stretch, so both sides must be heard at about
 * the same time (the buyer and Keith greeting each other, or Zoom's Test Speaker plus "testing"),
 * not two stray notification sounds minutes apart.
 */
export const RECENT_WINDOW_MS = 10_000

export interface Level {
  rmsDbfs: number
  peak: number
}

export class StreamActivity {
  activeMs = 0
  lastChunkAtMs: number | null = null
  digitalZeroRunMs = 0
  level: Level = { rmsDbfs: -100, peak: 0 }
  private peakHoldDb = -100
  /** Active chunks from the last RECENT_WINDOW_MS as [arrivedAtMs, ms], oldest first. */
  private recent: Array<[number, number]> = []

  constructor(readonly thresholds: ActivityThresholds) {}

  reset(): void {
    this.activeMs = 0
    this.recent = []
    this.lastChunkAtMs = null
    this.digitalZeroRunMs = 0
    this.level = { rmsDbfs: -100, peak: 0 }
    this.peakHoldDb = -100
  }

  push(pcm: Buffer, nowMs: number, syntheticSilence: boolean): void {
    this.lastChunkAtMs = nowMs
    const s = toInt16(pcm)
    const ms = samplesToMs(s.length)
    const db = rmsDbfs(s)
    this.peakHoldDb = Math.max(db, this.peakHoldDb - 1.5)
    this.level = { rmsDbfs: this.peakHoldDb, peak: peak(s) }
    if (!syntheticSilence && db > this.thresholds.activeDbfs) {
      this.activeMs += ms
      this.recent.push([nowMs, ms])
    }
    while (this.recent.length && this.recent[0][0] <= nowMs - RECENT_WINDOW_MS) this.recent.shift()
    if (!syntheticSilence && isDigitalZero(s)) this.digitalZeroRunMs += ms
    else this.digitalZeroRunMs = 0
  }

  /** Enough active audio in total since the last reset (device scan). */
  get passed(): boolean {
    return this.activeMs >= this.thresholds.requiredActiveMs
  }

  /** Active ms that arrived in the last RECENT_WINDOW_MS before `nowMs`. */
  recentActiveMs(nowMs: number): number {
    let total = 0
    for (const [at, ms] of this.recent) if (at > nowMs - RECENT_WINDOW_MS) total += ms
    return total
  }

  /** Enough active audio in the last RECENT_WINDOW_MS (session-start gate). */
  passedRecently(nowMs: number): boolean {
    return this.recentActiveMs(nowMs) >= this.thresholds.requiredActiveMs
  }

  /** ms since the last chunk of any kind, or null if none yet. */
  sinceLastChunk(nowMs: number): number | null {
    return this.lastChunkAtMs === null ? null : nowMs - this.lastChunkAtMs
  }
}
