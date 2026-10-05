/** Core M0 contracts. Mirrors CONTRACTS.md. */
import type { CaptureStream, EndpointState } from './nativeApi'

export type Stream = CaptureStream

export interface AudioFrame {
  session_id: string
  stream: Stream
  seq: number
  /** Session-relative ms (monotonic). */
  monotonic_start_ms: number
  duration_ms: number
  sample_rate_hz: number
  channels: number
  encoding: 'linear16'
  payload: Buffer
  discontinuity_before: boolean
}

export interface DiarizedWord {
  word_id: string
  session_id: string
  stream: Stream
  word: string
  /** Session-relative ms. */
  start_ms: number
  end_ms: number
  confidence: number
  /** Scoped cluster label, e.g. "e2:s1" (epoch 2, provider speaker 1). Null when the provider gave none. */
  speaker_cluster: string | null
  is_final: boolean
  provider_segment_id: string
  connection_epoch: number
}

export type SpeakerRole = 'keith' | 'teammate' | 'buyer' | 'unknown'

export interface Turn {
  turn_id: string
  session_id: string
  stream: Stream
  speaker_cluster: string | null
  speaker_identity_id: string | null
  speaker_role: SpeakerRole
  start_ms: number
  end_ms: number
  text: string
  final: boolean
  source_word_ids: string[]
  /** Set when a gap/discontinuity on this stream precedes this turn. */
  gap_before: GapRecord | null
}

export type GapCause =
  | 'pause'
  | 'device_lost'
  | 'device_stalled'
  | 'capture_error'
  | 'provider_disconnect'
  | 'wasapi_discontinuity'
  | 'capture_overflow'

export interface GapRecord {
  gap_id: string
  stream: Stream
  cause: GapCause
  /** Session-relative ms. */
  start_ms: number
  end_ms: number | null
  duration_ms: number | null
  device_state: EndpointState | 'unknown'
  provider_state: string
  recovery: 'pending' | 'recovered' | 'not_recovered' | 'session_ended'
  detail: string
}

export interface EndpointRef {
  /** Stable Windows IMMDevice ID. The ONLY lookup key. */
  endpoint_id: string
  data_flow: 'render' | 'capture'
  /** Display only. */
  friendly_name: string
  /** Diagnostics / re-confirm suggestion only. Never auto-adopted. */
  fingerprint: {
    device_description: string
    interface_name: string
    form_factor: string
    mix_format: string
  }
}

export interface AudioEndpointConfig {
  config_id: string
  system_output: EndpointRef
  microphone: EndpointRef
  confirmed_at: string
  confirmed_by_test: boolean
  last_verified_at: string | null
}

export type EndpointStatusState =
  | 'active'
  | 'missing'
  | 'disabled'
  | 'unplugged'
  | 'notpresent'
  | 'invalidated'
  | 'silent'
  | 'stalled'
  | 'unopenable'

export interface EndpointStatus {
  stream: Stream
  endpoint_id: string
  state: EndpointStatusState
  detected_at_ms: number
  reason: string
  is_windows_default: boolean
}

/** Stamped at build time (scripts/build.mjs): which build produced a log, report or scorecard. */
export interface BuildInfo {
  version: string
  /** CI run number, or "local". */
  build: string
  sha: string
  date: string
}
