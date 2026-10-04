/**
 * Stand-in for the Windows native module, used by tests and by `npm run dev`
 * on non-Windows machines. Same contract as native/windows-audio. Never used
 * on Windows builds (see native.ts).
 */
import type {
  CaptureStream,
  EndpointInfo,
  EndpointState,
  NativeAudioModule,
  NativeCaptureEvent,
  StartCaptureResult,
} from '../shared/nativeApi'

const RAZER_OUT = '{0.0.0.00000000}.{a1b2c3d4-0000-4000-8000-00000000r001}'
const RAZER_MIC = '{0.0.1.00000000}.{a1b2c3d4-0000-4000-8000-00000000r002}'
const LAPTOP_OUT = '{0.0.0.00000000}.{a1b2c3d4-0000-4000-8000-00000000l001}'
const LAPTOP_MIC = '{0.0.1.00000000}.{a1b2c3d4-0000-4000-8000-00000000l002}'

export const MOCK_IDS = { RAZER_OUT, RAZER_MIC, LAPTOP_OUT, LAPTOP_MIC }

export function defaultMockEndpoints(): EndpointInfo[] {
  const fmt = { sampleRate: 48000, channels: 2, bitsPerSample: 32, isFloat: true }
  return [
    { id: RAZER_OUT, flow: 'render', friendlyName: 'Headset Earphone (Razer Wireless Headset)', deviceDescription: 'Headset Earphone', interfaceName: 'Razer Wireless Headset', formFactor: 'headset', state: 'active', isDefaultConsole: true, isDefaultCommunications: true, mixFormat: fmt },
    { id: RAZER_MIC, flow: 'capture', friendlyName: 'Headset Microphone (Razer Wireless Headset)', deviceDescription: 'Headset Microphone', interfaceName: 'Razer Wireless Headset', formFactor: 'headset', state: 'active', isDefaultConsole: true, isDefaultCommunications: true, mixFormat: { ...fmt, channels: 1 } },
    { id: LAPTOP_OUT, flow: 'render', friendlyName: 'Speakers (Realtek(R) Audio)', deviceDescription: 'Speakers', interfaceName: 'Realtek(R) Audio', formFactor: 'speakers', state: 'active', isDefaultConsole: false, isDefaultCommunications: false, mixFormat: fmt },
    { id: LAPTOP_MIC, flow: 'capture', friendlyName: 'Microphone Array (Realtek(R) Audio)', deviceDescription: 'Microphone Array', interfaceName: 'Realtek(R) Audio', formFactor: 'microphone', state: 'active', isDefaultConsole: false, isDefaultCommunications: false, mixFormat: fmt },
  ]
}

interface Active {
  endpointId: string
  onEvent: (ev: NativeCaptureEvent) => void
  timer: NodeJS.Timeout | null
}

export interface MockOptions {
  /** Generate synthetic audio every 20 ms (dev mode). Tests drive audio manually. */
  autoGenerate?: boolean
  now?: () => number
}

export class MockNative implements NativeAudioModule {
  endpoints: EndpointInfo[] = defaultMockEndpoints()
  active = new Map<CaptureStream, Active>()
  /** Every start call, for assertions (e.g. "never opened another endpoint"). */
  startCalls: Array<{ stream: CaptureStream; endpointId: string }> = []
  failNextStart: Partial<Record<CaptureStream, { code: string; error: string }>> = {}
  private readonly now: () => number
  private phase = 0

  constructor(private readonly opts: MockOptions = {}) {
    this.now = opts.now ?? (() => performance.now())
  }

  listEndpoints(): EndpointInfo[] {
    return this.endpoints.map((e) => ({ ...e }))
  }

  getEndpointState(endpointId: string): EndpointState {
    return this.endpoints.find((e) => e.id === endpointId)?.state ?? 'missing'
  }

  startCapture(stream: CaptureStream, endpointId: string, onEvent: (ev: NativeCaptureEvent) => void): StartCaptureResult {
    this.startCalls.push({ stream, endpointId })
    if (this.active.has(stream)) return { ok: false, code: 'already_capturing', error: 'already capturing' }
    const forced = this.failNextStart[stream]
    if (forced) {
      delete this.failNextStart[stream]
      return { ok: false, ...forced }
    }
    const ep = this.endpoints.find((e) => e.id === endpointId)
    if (!ep) return { ok: false, code: 'device_not_found', error: 'Endpoint ID not found' }
    if (ep.state !== 'active') return { ok: false, code: 'device_not_active', error: `Endpoint is ${ep.state}` }
    const wantFlow = stream === 'system_remote' ? 'render' : 'capture'
    if (ep.flow !== wantFlow) return { ok: false, code: 'wrong_flow', error: `Expected a ${wantFlow} endpoint` }
    const a: Active = { endpointId, onEvent, timer: null }
    if (this.opts.autoGenerate) a.timer = setInterval(() => this.generate(stream), 20)
    this.active.set(stream, a)
    return { ok: true, mixFormat: ep.mixFormat }
  }

  stopCapture(stream: CaptureStream): boolean {
    const a = this.active.get(stream)
    if (!a) return false
    if (a.timer) clearInterval(a.timer)
    this.active.delete(stream)
    a.onEvent({ kind: 'stopped', reason: 'requested' })
    return true
  }

  stopAll(): void {
    for (const s of [...this.active.keys()]) this.stopCapture(s)
  }

  isCapturing(stream: CaptureStream): boolean {
    return this.active.has(stream)
  }

  monotonicNowMs(): number {
    return this.now()
  }

  // ---- test helpers ----

  emitAudio(stream: CaptureStream, pcm: Buffer, opts: { discontinuity?: boolean; syntheticSilence?: boolean } = {}): void {
    const a = this.active.get(stream)
    if (!a) return
    a.onEvent({
      kind: 'audio',
      data: pcm,
      samples: pcm.length / 2,
      monotonicMs: this.now(),
      discontinuity: !!opts.discontinuity,
      syntheticSilence: !!opts.syntheticSilence,
    })
  }

  /** Simulate the headset powering off: endpoint goes away and the stream is invalidated. */
  unplug(endpointId: string, newState: EndpointState = 'notpresent'): void {
    const ep = this.endpoints.find((e) => e.id === endpointId)
    if (ep) ep.state = newState
    for (const [stream, a] of this.active) {
      if (a.endpointId !== endpointId) continue
      if (a.timer) clearInterval(a.timer)
      this.active.delete(stream)
      a.onEvent({ kind: 'error', code: 'device_invalidated', message: 'AUDCLNT_E_DEVICE_INVALIDATED', hresult: '0x88890004' })
      a.onEvent({ kind: 'stopped', reason: 'error' })
    }
  }

  replug(endpointId: string): void {
    const ep = this.endpoints.find((e) => e.id === endpointId)
    if (ep) ep.state = 'active'
  }

  /** Simulate a Windows default-device change (must have no effect on capture). */
  setDefault(flow: 'render' | 'capture', endpointId: string): void {
    for (const e of this.endpoints) {
      if (e.flow !== flow) continue
      e.isDefaultConsole = e.id === endpointId
      e.isDefaultCommunications = e.id === endpointId
    }
  }

  private generate(stream: CaptureStream): void {
    const samples = 320
    const buf = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) {
      this.phase++
      const t = this.phase / 16000
      const env = Math.sin(t * Math.PI * 0.5) > 0 ? 1 : 0.05
      const v =
        stream === 'system_remote'
          ? Math.sin(2 * Math.PI * 440 * t) * 4000 * env
          : (Math.random() - 0.5) * 1200 * (Math.sin(t * Math.PI * 0.7) > 0.3 ? 1 : 0.1)
      buf.writeInt16LE(Math.round(v), i * 2)
    }
    this.emitAudio(stream, buf)
  }
}
