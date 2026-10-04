import { describe, expect, it } from 'vitest'
import type { DiarizedWord, GapRecord } from '../src/shared/contracts'
import { speakerLabel, TurnBuilder } from '../src/main/turnBuilder'

let n = 0
function w(stream: DiarizedWord['stream'], word: string, start: number, end: number, cluster: string | null): DiarizedWord {
  return { word_id: `w${n++}`, session_id: 's', stream, word, start_ms: start, end_ms: end, confidence: 0.9, speaker_cluster: cluster, is_final: true, provider_segment_id: 'p', connection_epoch: 1 }
}

describe('TurnBuilder', () => {
  it('groups words by speaker cluster and splits on cluster change', () => {
    const tb = new TurnBuilder('s')
    const ev = tb.addFinalWords([
      w('system_remote', 'Hi', 0, 200, 'e1:s0'),
      w('system_remote', 'there', 250, 500, 'e1:s0'),
      w('system_remote', 'Hello', 600, 900, 'e1:s1'),
    ])
    const finals = ev.filter((e) => e.type === 'turn_final')
    expect(finals).toHaveLength(1)
    expect(finals[0].turn.text).toBe('Hi there')
    expect(finals[0].turn.start_ms).toBe(0)
    expect(finals[0].turn.end_ms).toBe(500)
    expect(finals[0].turn.speaker_role).toBe('unknown')
    const rest = tb.flushAll()
    expect(rest[0].turn.text).toBe('Hello')
    expect(rest[0].turn.speaker_cluster).toBe('e1:s1')
  })

  it('never coerces remote speech to buyer; mic is keith', () => {
    const tb = new TurnBuilder('s')
    tb.addFinalWords([w('local_mic', 'So', 0, 100, null), w('system_remote', 'Yes', 50, 150, null)])
    const all = tb.flushAll().map((e) => e.turn)
    expect(all.find((t) => t.stream === 'local_mic')!.speaker_role).toBe('keith')
    expect(all.find((t) => t.stream === 'system_remote')!.speaker_role).toBe('unknown')
    expect(all.every((t) => t.speaker_role !== 'buyer')).toBe(true)
  })

  it('preserves overlap between streams', () => {
    const tb = new TurnBuilder('s')
    tb.addFinalWords([w('local_mic', 'I', 1000, 1200, null), w('system_remote', 'We', 1100, 1300, 'e1:s0'), w('local_mic', 'think', 1250, 1500, null)])
    const all = tb.flushAll().map((e) => e.turn)
    const mic = all.find((t) => t.stream === 'local_mic')!
    const sys = all.find((t) => t.stream === 'system_remote')!
    expect(mic.text).toBe('I think')
    expect(sys.start_ms).toBeLessThan(mic.end_ms)
  })

  it('splits on long silence and keeps timestamps', () => {
    const tb = new TurnBuilder('s', { maxGapMs: 1000 })
    const ev = tb.addFinalWords([w('local_mic', 'one', 0, 300, null), w('local_mic', 'two', 2000, 2300, null)])
    expect(ev.find((e) => e.type === 'turn_final')!.turn.text).toBe('one')
  })

  it('a gap marker closes the turn and is attached to the next turn', () => {
    const tb = new TurnBuilder('s')
    tb.addFinalWords([w('system_remote', 'before', 0, 300, 'e1:s0')])
    const gap: GapRecord = { gap_id: 'g1', stream: 'system_remote', cause: 'device_lost', start_ms: 400, end_ms: null, duration_ms: null, device_state: 'notpresent', provider_state: 'none', recovery: 'pending', detail: '' }
    const closed = tb.markGap(gap)
    expect(closed[0].turn.text).toBe('before')
    const ev = tb.addFinalWords([w('system_remote', 'after', 500, 700, 'e1:s0')])
    expect(ev[0].turn.gap_before?.gap_id).toBe('g1')
    expect(ev[0].turn.text).toBe('after')
  })

  it('labels', () => {
    expect(speakerLabel({ stream: 'local_mic', speaker_cluster: null })).toBe('KEITH')
    expect(speakerLabel({ stream: 'system_remote', speaker_cluster: null })).toBe('UNKNOWN')
    expect(speakerLabel({ stream: 'system_remote', speaker_cluster: 'e2:s1' })).toBe('REMOTE_1 (epoch 2)')
  })
})
