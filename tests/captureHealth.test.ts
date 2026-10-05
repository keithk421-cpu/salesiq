import { describe, expect, it } from 'vitest'
import { HEALTH_LABEL, captureHealth, type CaptureHealth, type HealthInput } from '../src/shared/captureHealth'

const base: HealthInput = { session: 'live', device: 'active', capture: 'capturing', provider: 'open', soundRecently: true, muted: false, unanswered: false }
const h = (over: Partial<HealthInput>) => captureHealth({ ...base, ...over })

describe('capture health (source tiles)', () => {
  it('keeps the three cases apart: quiet, no audio arriving, not transcribing', () => {
    expect(h({})).toBe('listening')
    expect(h({ soundRecently: false })).toBe('quiet')
    expect(h({ capture: 'lost' })).toBe('no_audio')
    expect(h({ capture: 'recovering' })).toBe('reconnecting_device')
    expect(h({ provider: 'none' })).toBe('not_transcribing')
    expect(h({ provider: 'connecting', soundRecently: false })).toBe('not_transcribing')
    // The socket looks open but nothing has come back while there was sound.
    expect(h({ unanswered: true })).toBe('not_transcribing')
  })

  it('a device that stopped delivering audio is never shown as just quiet', () => {
    expect(h({ capture: 'lost', soundRecently: false, provider: 'none' })).toBe('no_audio')
  })

  it('while Start is still waiting nothing is sent, so the speech service is not judged yet', () => {
    expect(h({ session: 'checking', provider: 'connecting' })).toBe('listening')
    expect(h({ session: 'checking', provider: 'none', soundRecently: false })).toBe('quiet')
  })

  it('a mic that has been pure silence for a minute asks about mute', () => {
    expect(h({ muted: true, soundRecently: false })).toBe('muted')
  })

  it('not capturing: idle, paused, or the device is off', () => {
    expect(h({ session: 'idle', capture: 'off', provider: 'none' })).toBe('idle')
    expect(h({ session: 'paused', capture: 'off', provider: 'none' })).toBe('paused')
    expect(h({ session: 'paused', capture: 'off', device: 'unplugged' })).toBe('unavailable')
  })

  it('every state has its own short, plain label; problems are never green', () => {
    const states = Object.keys(HEALTH_LABEL) as CaptureHealth[]
    const texts = states.map((s) => HEALTH_LABEL[s].text)
    expect(new Set(texts).size).toBe(texts.length)
    for (const s of states) {
      expect(HEALTH_LABEL[s].text.length).toBeLessThanOrEqual(32)
      expect(HEALTH_LABEL[s].hint).toMatch(/\.$/)
    }
    expect(HEALTH_LABEL.listening).toMatchObject({ text: 'Listening', cls: 'ok' })
    expect(HEALTH_LABEL.quiet).toMatchObject({ text: 'Quiet', cls: 'quiet' })
    expect(HEALTH_LABEL.no_audio).toMatchObject({ text: 'No audio arriving', cls: 'err' })
    expect(HEALTH_LABEL.not_transcribing.text).toMatch(/^Not transcribing/)
    expect(HEALTH_LABEL.not_transcribing.cls).toBe('warn')
    for (const s of ['no_audio', 'reconnecting_device', 'not_transcribing', 'muted', 'unavailable'] as const) {
      expect(HEALTH_LABEL[s].cls === 'warn' || HEALTH_LABEL[s].cls === 'err').toBe(true)
    }
  })
})
