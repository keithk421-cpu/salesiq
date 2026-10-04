/**
 * Contract between the Electron main process and the Rust/NAPI Windows audio
 * module (native/windows-audio). The mock in src/main/mockNative.ts implements
 * the same interface for Linux dev/tests.
 *
 * Locked rules (AUDIO_DEVICE_REQUIREMENT.md):
 * - Read-only with respect to Windows audio configuration.
 * - Endpoints are opened by explicit endpoint ID only, never "the default".
 * - WASAPI shared mode only.
 */

export type DataFlow = 'render' | 'capture'
export type CaptureStream = 'local_mic' | 'system_remote'
/**
 * Device-finder probes: the same read-only shared-mode capture, used during setup to
 * listen to several endpoints at once so Keith can see which one carries Zoom.
 */
export type ProbeStream = `probe_render:${string}` | `probe_capture:${string}`
export type AnyStream = CaptureStream | ProbeStream

/** Windows DEVICE_STATE_* mapped to strings; 'missing' = ID not found at all. */
export type EndpointState = 'active' | 'disabled' | 'notpresent' | 'unplugged' | 'missing'

export interface MixFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
  isFloat: boolean
}

export interface EndpointInfo {
  /** Stable Windows IMMDevice ID string. The only lookup key. */
  id: string
  flow: DataFlow
  friendlyName: string
  deviceDescription: string
  interfaceName: string
  /** EndpointFormFactor as a string, e.g. 'headset', 'headphones', 'speakers', 'microphone'. */
  formFactor: string
  state: EndpointState
  /** Informational only. The app never acts on defaults. */
  isDefaultConsole: boolean
  isDefaultCommunications: boolean
  /** Present only for active endpoints. */
  mixFormat?: MixFormat
}

/** 16 kHz mono signed 16-bit little-endian PCM, as delivered by the native module. */
export const TARGET_SAMPLE_RATE = 16000

export interface NativeAudioChunk {
  kind: 'audio'
  /** Int16 LE mono @ 16 kHz. */
  data: Buffer
  /** Monotonic (QPC-based) ms for the first sample of this chunk. */
  monotonicMs: number
  /** Number of 16 kHz samples in data. */
  samples: number
  /** True when WASAPI flagged AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY. */
  discontinuity: boolean
  /** True when the chunk is zeros synthesized for an idle loopback (no packets from Windows). */
  syntheticSilence: boolean
  /** Audio chunks dropped just before this one because the bounded JS queue was full. */
  droppedChunks?: number
}

export interface NativeCaptureError {
  kind: 'error'
  /** e.g. 'device_invalidated', 'device_not_found', 'device_not_active', 'open_failed', 'exclusive_in_use', 'unsupported_format', 'internal' */
  code: string
  message: string
  /** HRESULT as hex string when available. */
  hresult?: string
}

export interface NativeCaptureStopped {
  kind: 'stopped'
  /** 'requested' when stopCapture was called; otherwise an error ended it. */
  reason: 'requested' | 'error'
}

export type NativeCaptureEvent = NativeAudioChunk | NativeCaptureError | NativeCaptureStopped

export interface StartCaptureResult {
  ok: boolean
  error?: string
  code?: string
  mixFormat?: MixFormat
}

export interface NativeAudioModule {
  /** Enumerate render + capture endpoints in all states. Never modifies anything. */
  listEndpoints(): EndpointInfo[]
  /** State of one endpoint by ID; 'missing' if Windows does not know the ID. */
  getEndpointState(endpointId: string): EndpointState
  /**
   * Open the given endpoint in WASAPI shared mode and start delivering 16 kHz
   * mono chunks. stream 'system_remote' must be a render endpoint (loopback);
   * 'local_mic' must be a capture endpoint. Fails rather than falling back to
   * any other endpoint.
   */
  startCapture(stream: AnyStream, endpointId: string, onEvent: (ev: NativeCaptureEvent) => void): StartCaptureResult
  /** Stop that stream and join its thread. When it returns, nothing is capturing for that stream. */
  stopCapture(stream: AnyStream): boolean
  /** Stop everything (app exit). */
  stopAll(): void
  isCapturing(stream: AnyStream): boolean
  /** Same monotonic clock as NativeAudioChunk.monotonicMs. */
  monotonicNowMs(): number
}
