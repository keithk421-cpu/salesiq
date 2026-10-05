/**
 * Forgotten-call guard: after a stretch with nothing heard from the other side, ask "Still on a
 * call?" and stop if nobody answers. Keith's own mic doesn't count: after a call ends it would keep
 * transcribing office talk.
 */
export const IDLE_WARN_MS = 10 * 60_000
export const IDLE_STOP_AFTER_WARN_MS = 60_000

export type IdleVerdict = 'ok' | 'warn' | 'stop'

export class IdleWatch {
  private last: number
  private warnedAt: number | null = null

  constructor(private readonly now: () => number, private readonly warnMs = IDLE_WARN_MS, private readonly stopMs = IDLE_STOP_AFTER_WARN_MS) {
    this.last = now()
  }

  /** The other side spoke, Keith said he's still on the call, or the call resumed. */
  reset(): void {
    this.last = this.now()
    this.warnedAt = null
  }

  /** 'warn' once when the quiet stretch starts, 'stop' when the warning went unanswered. */
  tick(): IdleVerdict {
    const t = this.now()
    if (t - this.last < this.warnMs) return 'ok'
    if (this.warnedAt === null) {
      this.warnedAt = t
      return 'warn'
    }
    return t - this.warnedAt >= this.stopMs ? 'stop' : 'ok'
  }

  get warning(): boolean {
    return this.warnedAt !== null
  }
}
