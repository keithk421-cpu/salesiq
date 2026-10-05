import { describe, expect, it } from 'vitest'
import { IDLE_STOP_AFTER_WARN_MS, IDLE_WARN_MS, IdleWatch } from '../src/main/idleWatch'

describe('forgotten-call guard', () => {
  it('warns after 10 quiet minutes, stops 60 s later unless reset', () => {
    let t = 0
    const w = new IdleWatch(() => t)
    t = IDLE_WARN_MS - 1
    expect(w.tick()).toBe('ok')
    t = IDLE_WARN_MS
    expect(w.tick()).toBe('warn')
    expect(w.tick()).toBe('ok') // warned once
    t += IDLE_STOP_AFTER_WARN_MS - 1
    expect(w.tick()).toBe('ok')
    t += 1
    expect(w.tick()).toBe('stop')
  })

  it('"Still on the call" or the other side speaking starts the clock again', () => {
    let t = 0
    const w = new IdleWatch(() => t)
    t = IDLE_WARN_MS
    expect(w.tick()).toBe('warn')
    t += 30_000
    w.reset()
    expect(w.warning).toBe(false)
    t += IDLE_STOP_AFTER_WARN_MS
    expect(w.tick()).toBe('ok')
    t += IDLE_WARN_MS
    expect(w.tick()).toBe('warn')
  })
})
