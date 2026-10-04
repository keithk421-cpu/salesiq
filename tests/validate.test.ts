import { describe, expect, it } from 'vitest'
import { cleanLabel, invalidNativeEvent, isApiKeyInput, isEndpointId, isStream } from '../src/main/validate'

describe('boundary validation', () => {
  it('native events', () => {
    const ok = { kind: 'audio', data: Buffer.alloc(4), samples: 2, monotonicMs: 5, discontinuity: false, syntheticSilence: false }
    expect(invalidNativeEvent(ok)).toBeNull()
    expect(invalidNativeEvent({ ...ok, samples: 3 })).toMatch(/samples/)
    expect(invalidNativeEvent({ ...ok, monotonicMs: NaN })).toMatch(/monotonicMs/)
    expect(invalidNativeEvent({ kind: 'error', code: 'x', message: 'y' })).toBeNull()
    expect(invalidNativeEvent({ kind: 'stopped', reason: 'weird' })).toMatch(/reason/)
    expect(invalidNativeEvent(null)).toMatch(/object/)
  })
  it('IPC args', () => {
    expect(isEndpointId('{0.0.1.00000000}.{abc}')).toBe(true)
    expect(isEndpointId(42)).toBe(false)
    expect(isEndpointId('x'.repeat(600))).toBe(false)
    expect(isStream('local_mic')).toBe(true)
    expect(isStream('probe_render:1')).toBe(false)
    expect(cleanLabel('../../etc')).toBe('etc')
    expect(isApiKeyInput('short')).toBe(false)
    expect(isApiKeyInput('a'.repeat(40))).toBe(true)
    expect(isApiKeyInput('has space'.repeat(5))).toBe(false)
  })
})
