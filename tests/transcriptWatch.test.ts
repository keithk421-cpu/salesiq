import { describe, expect, it } from 'vitest'
import { STT_STALL_COOLDOWN_MS, STT_STALL_MIN_SOUND_MS, STT_STALL_MS, TranscriptWatch } from '../src/main/transcriptWatch'

/** Offer 100 ms windows from `from` to `to` (ms); `sound` says whether each is above the activity threshold. */
function offer(w: TranscriptWatch, from: number, to: number, sound: boolean): void {
  for (let t = from; t < to; t += 100) w.offered(t, 100, sound)
}

describe('transcript stall watchdog', () => {
  it('thresholds are the documented ones', () => {
    expect([STT_STALL_MS, STT_STALL_MIN_SOUND_MS, STT_STALL_COOLDOWN_MS]).toEqual([15_000, 5_000, 30_000])
  })

  it('sound going out with nothing back for 15 s is a stall; a reconnect is due once', () => {
    const w = new TranscriptWatch()
    w.reset()
    offer(w, 1000, 15_900, true)
    expect(w.stalled(15_900)).toBe(false)
    offer(w, 15_900, 16_000, true)
    expect(w.stalled(16_000)).toBe(true)
    expect(w.reconnectDue(16_000)).toBe(true)
    expect(w.reconnectDue(16_500)).toBe(false)
  })

  it('silence never stalls it, however long nothing comes back', () => {
    const w = new TranscriptWatch()
    w.reset()
    offer(w, 0, 600_000, false)
    expect(w.stalled(600_000)).toBe(false)
    expect(w.reconnectDue(600_000)).toBe(false)
  })

  it('a few words with nothing back are not enough; a real stretch of talk is', () => {
    const w = new TranscriptWatch()
    w.reset()
    offer(w, 0, 2000, true) // "Yes, hi"
    offer(w, 2000, 20_000, false)
    expect(w.stalled(20_000)).toBe(false)
    offer(w, 20_000, 24_900, true)
    expect(w.stalled(24_900)).toBe(false)
    offer(w, 24_900, 25_000, true)
    expect(w.stalled(25_000)).toBe(true)
  })

  it('only sound from the last 15 s counts: odd short sounds after a long unanswered silence never add up', () => {
    const w = new TranscriptWatch()
    w.reset()
    offer(w, 0, 5000, true)
    w.heard(5000) // the service answered the talk
    offer(w, 5000, 125_000, false) // two minutes of quiet; suppose nothing comes back during silence
    for (let t = 125_000; t < 425_000; t += 5000) {
      offer(w, t, t + 300, true) // a cough or click every 5 s
      offer(w, t + 300, t + 5000, false)
      expect(w.stalled(t + 5000)).toBe(false)
    }
    expect(w.soundMs(425_000)).toBeLessThanOrEqual(1200)
    // Sound that went out long ago doesn't count later either, even if nothing was offered since.
    const v = new TranscriptWatch()
    v.reset()
    offer(v, 0, 6000, true)
    expect(v.soundMs(6000)).toBe(6000)
    expect(v.stalled(21_000)).toBe(false)
  })

  it('keeps only the last 15 s of sound in memory through a long call', () => {
    const w = new TranscriptWatch()
    w.reset()
    for (let t = 0; t < 3_600_000; t += 2000) {
      offer(w, t, t + 2000, true)
      w.heard(t + 2000)
    }
    expect((w as unknown as { sound: unknown[] }).sound.length).toBeLessThanOrEqual(STT_STALL_MS / 100 + 1)
  })

  it('any message from the service starts the clock again', () => {
    const w = new TranscriptWatch()
    w.reset()
    for (let t = 0; t < 120_000; t += 2000) {
      offer(w, t, t + 2000, true)
      w.heard(t + 2000)
      expect(w.stalled(t + 2000)).toBe(false)
    }
  })

  it('the clock starts when audio first goes out on a connection, not when it was installed', () => {
    const w = new TranscriptWatch()
    w.reset() // opened while Start was still waiting for the call
    offer(w, 600_000, 608_000, true)
    expect(w.stalled(608_000)).toBe(false)
    expect(w.heardAt).toBe(600_000)
  })

  it('at most one stall reconnect per cool-down, then again if the next connection is silent too', () => {
    const w = new TranscriptWatch()
    w.reset()
    offer(w, 0, 15_000, true)
    expect(w.cooldownLeftMs(15_000)).toBe(0)
    expect(w.reconnectDue(15_000)).toBe(true)
    w.reset() // the new connection
    offer(w, 15_500, 44_900, true)
    expect(w.stalled(44_900)).toBe(true) // the gap is marked and the tile says "not transcribing" meanwhile
    expect(w.reconnectDue(44_900)).toBe(false)
    expect(w.cooldownLeftMs(44_900)).toBe(100)
    offer(w, 44_900, 45_000, true)
    expect(w.reconnectDue(45_000)).toBe(true)
  })
})
