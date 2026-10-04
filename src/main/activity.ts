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

  constructor(readonly thresholds: ActivityThresholds) {}

  reset(): void {
    this.activeMs = 0
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
    if (!syntheticSilence && db > this.thresholds.activeDbfs) this.activeMs += ms
    if (!syntheticSilence && isDigitalZero(s)) this.digitalZeroRunMs += ms
    else this.digitalZeroRunMs = 0
  }

  get passed(): boolean {
    return this.activeMs >= this.thresholds.requiredActiveMs
  }

  /** ms since the last chunk of any kind, or null if none yet. */
  sinceLastChunk(nowMs: number): number | null {
    return this.lastChunkAtMs === null ? null : nowMs - this.lastChunkAtMs
  }
}
