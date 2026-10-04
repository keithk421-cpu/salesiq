/**
 * Device test for the select -> test -> confirm flow. Opens the two chosen
 * endpoints (shared mode, read-only), shows meters, and reports whether real
 * audio arrived on each. Sends nothing anywhere and saves nothing.
 */
import type { NativeAudioModule, NativeCaptureEvent } from '../shared/nativeApi'
import { MIC_THRESHOLDS, StreamActivity, SYSTEM_THRESHOLDS, type Level } from './activity'

export interface DeviceTestEvent {
  running: boolean
  systemId: string
  micId: string
  system: Level & { passed: boolean; activeMs: number; error?: string }
  mic: Level & { passed: boolean; activeMs: number; error?: string; digitalZero: boolean }
  remainingMs: number
}

export class DeviceTester {
  private sys = new StreamActivity(SYSTEM_THRESHOLDS)
  private mic = new StreamActivity(MIC_THRESHOLDS)
  private timer: NodeJS.Timeout | null = null
  private errors: { system?: string; mic?: string } = {}
  private gen = 0
  running = false
  lastResult: { systemId: string; micId: string; passed: boolean } | null = null
  private ids = { systemId: '', micId: '' }

  constructor(private readonly native: NativeAudioModule, private readonly emit: (e: DeviceTestEvent) => void, private readonly log: (e: string, d?: Record<string, unknown>) => void) {}

  start(systemId: string, micId: string, durationMs = 60000): { ok: boolean; error?: string } {
    this.stop()
    this.sys.reset()
    this.mic.reset()
    this.errors = {}
    this.ids = { systemId, micId }
    this.lastResult = null
    const gen = ++this.gen
    const handler = (which: 'system' | 'mic') => (ev: NativeCaptureEvent) => {
      if (gen !== this.gen) return
      try {
        this.onEvent(which, ev)
      } catch (err) {
        this.log('handler_error', { which, message: (err as Error).message })
      }
    }
    const s = this.native.startCapture('system_remote', systemId, handler('system')) 
    const m = s.ok ? this.native.startCapture('local_mic', micId, handler('mic')) : { ok: false, code: 'skipped', error: 'not attempted' }
    this.log('device_test_start', { systemId, micId, systemOk: s.ok, systemCode: s.code, micOk: m.ok, micCode: m.code })
    if (!s.ok || !m.ok) {
      this.native.stopCapture('system_remote')
      this.native.stopCapture('local_mic')
      return { ok: false, error: !s.ok ? `Meeting audio device: ${s.code} (${s.error})` : `Microphone: ${m.code} (${m.error})` }
    }
    this.running = true
    const started = Date.now()
    this.timer = setInterval(() => {
      const remainingMs = Math.max(0, durationMs - (Date.now() - started))
      const passed = this.sys.passed && this.mic.passed
      this.lastResult = { ...this.ids, passed }
      this.emit({
        running: true, ...this.ids, remainingMs,
        system: { ...this.sys.level, passed: this.sys.passed, activeMs: Math.round(this.sys.activeMs), error: this.errors.system },
        mic: { ...this.mic.level, passed: this.mic.passed, activeMs: Math.round(this.mic.activeMs), error: this.errors.mic, digitalZero: this.mic.digitalZeroRunMs > 2000 },
      })
      if (remainingMs <= 0) this.stop()
    }, 100)
    return { ok: true }
  }

  private onEvent(which: 'system' | 'mic', ev: NativeCaptureEvent): void {
    const now = this.native.monotonicNowMs()
    if (ev.kind === 'audio') (which === 'system' ? this.sys : this.mic).push(ev.data, now, ev.syntheticSilence)
    else if (ev.kind === 'error') this.errors[which] = `${ev.code}: ${ev.message}`
  }

  stop(): void {
    this.gen++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.running) {
      this.native.stopCapture('system_remote')
      this.native.stopCapture('local_mic')
      this.log('device_test_stop', { passed: this.lastResult?.passed ?? false })
      this.emit({
        running: false, ...this.ids, remainingMs: 0,
        system: { ...this.sys.level, passed: this.sys.passed, activeMs: Math.round(this.sys.activeMs) },
        mic: { ...this.mic.level, passed: this.mic.passed, activeMs: Math.round(this.mic.activeMs), digitalZero: false },
      })
    }
    this.running = false
  }

  /** True only if the most recent test of exactly this pair heard audio on both. */
  passedFor(systemId: string, micId: string): boolean {
    const r = this.lastResult
    return !!r && r.passed && r.systemId === systemId && r.micId === micId
  }
}
