/**
 * Transcript stall watchdog, one per stream.
 *
 * The speech-service socket can stay open but stop sending anything back. HELP would then run on a
 * frozen transcript and nobody would notice. With interim results on, Deepgram answers within a
 * second or two of speech, so when a real stretch of sound has gone out on a connection recently and
 * nothing at all has come back (no words, no empty result, no metadata) for a while, the connection
 * is treated as stalled.
 *
 * Only recent sound counts. Whether Deepgram answers a long silence is not something we rely on: a
 * quiet stretch, or a quiet stretch with the odd cough or click, never looks like a stall, and nothing
 * said is lost while nobody talks.
 */

/** No message of any kind from the speech service for this long... */
export const STT_STALL_MS = 15_000
/** ...while at least this much sound was sent to it in that same last STT_STALL_MS (a healthy service answers well within this). */
export const STT_STALL_MIN_SOUND_MS = 5_000
/** At most one stall reconnect per stream in this long: a service that stays silent can't cause a reconnect storm. */
export const STT_STALL_COOLDOWN_MS = 30_000

export class TranscriptWatch {
  /** Monotonic ms the service last sent anything, or audio first went out on this connection. */
  heardAt = 0
  private sending = false
  /** Sound offered in the last STT_STALL_MS as [offeredAtMs, ms], oldest first. */
  private sound: Array<[number, number]> = []
  private lastStallAt: number | null = null

  /** A new connection was installed. The clock starts when audio first goes out on it. */
  reset(): void {
    this.sending = false
    this.sound = []
  }

  /** The speech service sent something (anything). */
  heard(nowMs: number): void {
    this.heardAt = nowMs
  }

  /** Audio offered to the open connection: `ms` long, `sound` when it was above the stream's activity threshold. */
  offered(nowMs: number, ms: number, sound: boolean): void {
    if (!this.sending) {
      this.sending = true
      this.heardAt = nowMs
    }
    if (sound) this.sound.push([nowMs, ms])
    while (this.sound.length && this.sound[0][0] <= nowMs - STT_STALL_MS) this.sound.shift()
  }

  /**
   * Sound (ms) offered in the last STT_STALL_MS. Once the service has been silent that long, all of
   * it went out after its last message.
   */
  soundMs(nowMs: number): number {
    let total = 0
    for (const [at, ms] of this.sound) if (at > nowMs - STT_STALL_MS) total += ms
    return total
  }

  /** True while audio is going out and the service has said nothing for STT_STALL_MS (sound or not). */
  silent(nowMs: number): boolean {
    return this.sending && nowMs - this.heardAt >= STT_STALL_MS
  }

  /** True while the service has said nothing for STT_STALL_MS although enough sound was sent to it in that time. */
  stalled(nowMs: number): boolean {
    return this.silent(nowMs) && this.soundMs(nowMs) >= STT_STALL_MIN_SOUND_MS
  }

  /** ms until another stall reconnect is allowed (0: now). */
  cooldownLeftMs(nowMs: number): number {
    return this.lastStallAt === null ? 0 : Math.max(0, STT_STALL_COOLDOWN_MS - (nowMs - this.lastStallAt))
  }

  /** True (once) when a stall reconnect is due: stalled, and none in the last STT_STALL_COOLDOWN_MS. */
  reconnectDue(nowMs: number): boolean {
    if (!this.stalled(nowMs) || this.cooldownLeftMs(nowMs) > 0) return false
    this.lastStallAt = nowMs
    return true
  }
}
