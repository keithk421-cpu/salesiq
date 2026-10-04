import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceScanner, type DeviceScanEvent } from '../src/main/deviceTest'
import { MOCK_IDS, MockNative } from '../src/main/mockNative'
import { noise, tone, zeros } from './helpers/audio'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup() {
  const native = new MockNative({ now: () => Date.now() })
  const events: DeviceScanEvent[] = []
  const scanner = new DeviceScanner(native, (e) => events.push(e), () => undefined)
  return { native, events, scanner }
}

describe('DeviceScanner (find my devices)', () => {
  it('listens to every active output and mic at once and suggests the ones carrying audio', async () => {
    const { native, events, scanner } = setup()
    expect(scanner.find().ok).toBe(true)
    const probes = native.startCalls.map((c) => c.stream)
    expect(probes.filter((s) => s.startsWith('probe_render:'))).toHaveLength(2)
    expect(probes.filter((s) => s.startsWith('probe_capture:'))).toHaveLength(2)
    // Session slots are never used by the scanner.
    expect(probes).not.toContain('system_remote')
    expect(probes).not.toContain('local_mic')
    const streamFor = (id: string) => native.startCalls.find((c) => c.endpointId === id)!.stream
    for (let t = 0; t < 1000; t += 20) {
      native.emitAudio(streamFor(MOCK_IDS.RAZER_OUT), noise(320, 5000, t + 1))
      native.emitAudio(streamFor(MOCK_IDS.LAPTOP_OUT), zeros(320), { syntheticSilence: true })
      native.emitAudio(streamFor(MOCK_IDS.RAZER_MIC), tone(320, 7000, 200, t * 16))
      native.emitAudio(streamFor(MOCK_IDS.LAPTOP_MIC), noise(320, 40, t + 9))
      await vi.advanceTimersByTimeAsync(20)
    }
    const last = events.at(-1)!
    expect(last.suggestedOutputId).toBe(MOCK_IDS.RAZER_OUT)
    expect(last.suggestedMicId).toBe(MOCK_IDS.RAZER_MIC)
    const laptopOut = last.devices.find((d) => d.id === MOCK_IDS.LAPTOP_OUT)!
    expect(laptopOut.idleChunks).toBeGreaterThan(0)
    expect(laptopOut.passed).toBe(false)
    expect(scanner.passedFor(MOCK_IDS.RAZER_OUT, MOCK_IDS.RAZER_MIC)).toBe(true)
    expect(scanner.passedFor(MOCK_IDS.LAPTOP_OUT, MOCK_IDS.RAZER_MIC)).toBe(false)
    scanner.stop()
    for (const c of native.startCalls) expect(native.isCapturing(c.stream)).toBe(false)
    // Result survives stop so Save can check it.
    expect(scanner.passedFor(MOCK_IDS.RAZER_OUT, MOCK_IDS.RAZER_MIC)).toBe(true)
  })

  it('reports a device that cannot be opened without failing the rest', () => {
    const { native, scanner } = setup()
    native.endpoints.push({ ...native.endpoints[0], id: 'broken', friendlyName: 'Broken' })
    const orig = native.startCapture.bind(native)
    native.startCapture = (s, id, cb) => (id === 'broken' ? { ok: false, code: 'open_failed', error: 'x' } : orig(s, id, cb))
    const r = scanner.find()
    expect(r.ok).toBe(true)
    expect(r.opened).toBe(4)
    scanner.stop()
  })
})
