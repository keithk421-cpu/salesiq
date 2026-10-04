/** Runtime validation for payloads crossing the NAPI and IPC boundaries. */
import type { NativeCaptureEvent } from '../shared/nativeApi'

/** Returns null when the native event is well-formed, otherwise the reason. */
export function invalidNativeEvent(ev: unknown): string | null {
  if (!ev || typeof ev !== 'object') return 'not an object'
  const e = ev as Record<string, unknown>
  if (e.kind === 'audio') {
    if (!Buffer.isBuffer(e.data)) return 'audio.data is not a Buffer'
    if (e.data.length % 2 !== 0) return 'audio.data has odd byte length'
    if (typeof e.samples !== 'number' || e.samples !== e.data.length / 2) return 'audio.samples does not match data'
    if (typeof e.monotonicMs !== 'number' || !Number.isFinite(e.monotonicMs)) return 'audio.monotonicMs invalid'
    if (typeof e.discontinuity !== 'boolean' || typeof e.syntheticSilence !== 'boolean') return 'audio flags invalid'
    if (e.droppedChunks !== undefined && (typeof e.droppedChunks !== 'number' || e.droppedChunks < 0)) return 'audio.droppedChunks invalid'
    return null
  }
  if (e.kind === 'error') return typeof e.code === 'string' && typeof e.message === 'string' ? null : 'error event fields invalid'
  if (e.kind === 'stopped') return e.reason === 'requested' || e.reason === 'error' ? null : 'stopped.reason invalid'
  return `unknown kind ${String(e.kind)}`
}

export function asNativeEvent(ev: unknown): NativeCaptureEvent | null {
  return invalidNativeEvent(ev) === null ? (ev as NativeCaptureEvent) : null
}

// ---- IPC argument guards (renderer is untrusted input) ----
const ENDPOINT_ID = /^[\x20-\x7e]{1,512}$/

export function isEndpointId(x: unknown): x is string {
  return typeof x === 'string' && ENDPOINT_ID.test(x)
}

export function isStream(x: unknown): x is 'local_mic' | 'system_remote' {
  return x === 'local_mic' || x === 'system_remote'
}

export function cleanLabel(x: unknown): string {
  return typeof x === 'string' ? x.replace(/[^a-z0-9 _-]/gi, '').slice(0, 40) || 'manual' : 'manual'
}

export function isApiKeyInput(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length >= 20 && x.trim().length <= 200 && /^[\x21-\x7e]+$/.test(x.trim())
}
