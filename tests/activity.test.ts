import { describe, expect, it } from 'vitest'
import { MIC_THRESHOLDS, RECENT_WINDOW_MS, StreamActivity } from '../src/main/activity'
import { tone, zeros } from './helpers/audio'

/** Push `ms` of 20 ms chunks starting at `atMs`; returns the time after the last chunk. */
function push(a: StreamActivity, atMs: number, ms: number, sound: boolean): number {
  for (let t = 0; t < ms; t += 20) a.push(sound ? tone(320, 7000) : zeros(320), atMs + t + 20, false)
  return atMs + ms
}

describe('StreamActivity', () => {
  it('counts only recent sound for the start gate, but keeps the running total for the device scan', () => {
    const a = new StreamActivity(MIC_THRESHOLDS)
    let t = push(a, 0, 600, true)
    expect(a.recentActiveMs(t)).toBe(600)
    expect(a.passedRecently(t)).toBe(true)
    t = push(a, t, 5000, false)
    expect(a.passedRecently(t)).toBe(true) // still within the window
    t = push(a, t, RECENT_WINDOW_MS, false)
    expect(a.recentActiveMs(t)).toBe(0)
    expect(a.passedRecently(t)).toBe(false)
    expect(a.activeMs).toBe(600)
    expect(a.passed).toBe(true)
  })

  it('stays honest when no chunks arrive at all for a while', () => {
    const a = new StreamActivity(MIC_THRESHOLDS)
    const t = push(a, 0, 600, true)
    expect(a.passedRecently(t + RECENT_WINDOW_MS + 1)).toBe(false)
  })

  it('two short sounds far apart never add up to a pass', () => {
    const a = new StreamActivity(MIC_THRESHOLDS)
    let t = push(a, 0, 300, true)
    t = push(a, t + 60_000, 300, true)
    expect(a.passed).toBe(true)
    expect(a.passedRecently(t)).toBe(false)
  })

  it('reset clears the recent sound too', () => {
    const a = new StreamActivity(MIC_THRESHOLDS)
    const t = push(a, 0, 600, true)
    a.reset()
    expect(a.recentActiveMs(t)).toBe(0)
  })
})
