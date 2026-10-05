import { describe, expect, it } from 'vitest'
import type { Stream, Turn } from '../src/shared/contracts'
import type { CaptureState, SessionEvent } from '../src/main/session'
import { IDLE_PAUSE_AFTER_WARN_MS, IDLE_WARN_MS, IdleWatch } from '../src/main/idleWatch'

const turn = (stream: Stream, final = true, text = 'Let me show you the tracing view.'): SessionEvent => ({
  type: 'turn',
  event: {
    type: final ? 'turn_final' : 'turn_update',
    turn: { turn_id: 't1', session_id: 's', stream, speaker_cluster: null, speaker_identity_id: null, speaker_role: 'unknown', start_ms: 0, end_ms: 1, text, final, source_word_ids: [], gap_before: null } as Turn,
  },
})
const device = (stream: Stream, capture: CaptureState): SessionEvent =>
  ({ type: 'stream_status', status: { stream, endpoint_id: 'x', friendly_name: 'Headset', state: 'active', capture, provider: 'open', epoch: 1 } }) as unknown as SessionEvent

describe('forgotten-call guard', () => {
  it('warns after 10 quiet minutes, pauses 60 s later unless reset', () => {
    let t = 0
    const w = new IdleWatch(() => t)
    t = IDLE_WARN_MS - 1
    expect(w.tick()).toBe('ok')
    t = IDLE_WARN_MS
    expect(w.tick()).toBe('warn')
    expect(w.tick()).toBe('ok') // warned once
    t += IDLE_PAUSE_AFTER_WARN_MS - 1
    expect(w.tick()).toBe('ok')
    t += 1
    expect(w.tick()).toBe('pause')
  })

  it('"Still on the call" or someone speaking starts the clock again', () => {
    let t = 0
    const w = new IdleWatch(() => t)
    t = IDLE_WARN_MS
    expect(w.tick()).toBe('warn')
    t += 30_000
    w.reset()
    expect(w.warning).toBe(false)
    t += IDLE_PAUSE_AFTER_WARN_MS
    expect(w.tick()).toBe('ok')
    t += IDLE_WARN_MS
    expect(w.tick()).toBe('warn')
  })

  it("Keith's own finished words count too: a long demo with a quiet buyer is still a call", () => {
    let t = 0
    const w = new IdleWatch(() => t)
    t = IDLE_WARN_MS - 1000
    expect(w.observe(turn('local_mic'))).toBe(true)
    t = IDLE_WARN_MS + 5000
    expect(w.tick()).toBe('ok')
    // So do the other side's; words still being transcribed and empty turns don't.
    t = 2 * IDLE_WARN_MS - 1000
    expect(w.observe(turn('system_remote'))).toBe(true)
    expect(w.observe(turn('system_remote', false))).toBe(false)
    expect(w.observe(turn('local_mic', true, '  '))).toBe(false)
    t = 3 * IDLE_WARN_MS - 1000
    expect(w.tick()).toBe('warn')
  })

  it("doesn't run while a device is disconnected or reconnecting (the device banner covers that)", () => {
    let t = 0
    const w = new IdleWatch(() => t)
    t = IDLE_WARN_MS
    expect(w.tick()).toBe('warn')
    // The headset drops while "Still on a call?" is up: the warning goes, and nothing pauses.
    expect(w.observe(device('system_remote', 'lost'))).toBe(true)
    expect(w.warning).toBe(false)
    t += 3 * IDLE_WARN_MS
    expect(w.tick()).toBe('ok')
    expect(w.observe(device('system_remote', 'recovering'))).toBe(false)
    t += IDLE_WARN_MS
    expect(w.tick()).toBe('ok')
    // Back: a full quiet stretch is needed again.
    expect(w.observe(device('system_remote', 'capturing'))).toBe(true)
    t += IDLE_WARN_MS - 1
    expect(w.tick()).toBe('ok')
    t += 1
    expect(w.tick()).toBe('warn')
  })
})
