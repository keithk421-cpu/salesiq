/**
 * Transcript stall watchdog, one per stream.
 *
 * The speech-service socket can stay open but stop sending anything back. HELP would then run on a
 * frozen transcript and nobody would notice. With interim results on, Deepgram answers within a
 * second or two of speech, so when sound has gone out on a connection and nothing at all has come
 * back (no words, no empty result, no metadata) for a while, the connection is treated as stalled.
 *
 * Only sound counts. Whether Deepgram answers a long silence is not something we rely on: a quiet
 * stretch never looks like a stall, and nothing said is lost while nobody talks.
 */

/** No message of any kind from the speech service for this long... */
export const STT_STALL_MS = 15_000
/** ...while at least this much sound was sent to it (a healthy service answers well within this). */
export const STT_STALL_MIN_SOUND_MS = 5_000
/** At most one stall reconnect per stream in this long: a service that stays silent can't cause a reconnect storm. */
export const STT_STALL_COOLDOWN_MS = 30_000

export class TranscriptWatch {
  /** Monotonic ms the service last sent anything, or audio first went out on this connection. */
  heardAt = 0
  /** Sound (ms) offered to the connection since `heardAt`. */
  soundMs = 0
  private sending = false
  private lastStallAt: number | null = null

  /** A new connection was installed. The clock starts when audio first goes out on it. */
  reset(): void {
    this.sending = false
    this.soundMs = 0
  }

  /** The speech service sent something (anything). */
  heard(nowMs: number): void {
    this.heardAt = nowMs
    this.soundMs = 0
  }

  /** Audio offered to the open connection: `ms` long, `sound` when it was above the stream's activity threshold. */
  offered(nowMs: number, ms: number, sound: boolean): void {
    if (!this.sending) {
      this.sending = true
      this.heardAt = nowMs
      this.soundMs = 0
    }
    if (sound) this.soundMs += ms
  }

  /** True while the service has said nothing for STT_STALL_MS although enough sound was sent to it. */
  stalled(nowMs: number): boolean {
    return this.sending && nowMs - this.heardAt >= STT_STALL_MS && this.soundMs >= STT_STALL_MIN_SOUND_MS
  }

  /** True (once) when a stall reconnect is due: stalled, and none in the last STT_STALL_COOLDOWN_MS. */
  reconnectDue(nowMs: number): boolean {
    if (!this.stalled(nowMs)) return false
    if (this.lastStallAt !== null && nowMs - this.lastStallAt < STT_STALL_COOLDOWN_MS) return false
    this.lastStallAt = nowMs
    return true
  }
}
