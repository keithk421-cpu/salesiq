/**
 * Forgotten-call guard: after a stretch with nothing said on the call, ask "Still on a call?" and
 * pause (never stop) if nobody answers. Finished words from either side count: in a long demo the
 * buyer can be quiet for a while. While a device is disconnected or reconnecting the clock doesn't
 * run; the device banner covers that.
 */
import type { Stream } from '../shared/contracts'
import type { SessionEvent } from './session'

export const IDLE_WARN_MS = 10 * 60_000
export const IDLE_PAUSE_AFTER_WARN_MS = 60_000

export type IdleVerdict = 'ok' | 'warn' | 'pause'

export class IdleWatch {
  private last: number
  private warnedAt: number | null = null
  /** Streams whose device is lost or reconnecting right now. */
  private readonly down = new Set<Stream>()

  constructor(private readonly now: () => number, private readonly warnMs = IDLE_WARN_MS, private readonly pauseMs = IDLE_PAUSE_AFTER_WARN_MS) {
    this.last = now()
  }

  /** Someone spoke, Keith said he's still on the call, or the call resumed. */
  reset(): void {
    this.last = this.now()
    this.warnedAt = null
  }

  /** Feed every session event. True when it started the clock again (a warning on screen can go). */
  observe(ev: SessionEvent): boolean {
    if (ev.type === 'turn' && ev.event.type === 'turn_final' && ev.event.turn.text.trim()) {
      this.reset()
      return true
    }
    if (ev.type === 'stream_status') {
      const lost = ev.status.capture === 'lost' || ev.status.capture === 'recovering'
      if (lost === this.down.has(ev.status.stream)) return false
      if (lost) this.down.add(ev.status.stream)
      else this.down.delete(ev.status.stream)
      this.reset()
      return true
    }
    return false
  }

  /** 'warn' once when the quiet stretch starts, 'pause' when the warning went unanswered. */
  tick(): IdleVerdict {
    const t = this.now()
    if (this.down.size) {
      this.last = t
      return 'ok'
    }
    if (t - this.last < this.warnMs) return 'ok'
    if (this.warnedAt === null) {
      this.warnedAt = t
      return 'warn'
    }
    return t - this.warnedAt >= this.pauseMs ? 'pause' : 'ok'
  }

  get warning(): boolean {
    return this.warnedAt !== null
  }
}
