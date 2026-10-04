/** Small helpers for 16 kHz mono Int16 LE PCM. */
import { TARGET_SAMPLE_RATE } from '../shared/nativeApi'

export const SAMPLE_RATE = TARGET_SAMPLE_RATE
export const BYTES_PER_SAMPLE = 2

export function toInt16(buf: Buffer): Int16Array {
  // Copy when unaligned; Int16Array views need an even byte offset.
  if (buf.byteOffset % 2 !== 0) {
    const copy = Buffer.from(buf)
    return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2))
  }
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
}

export function samplesIn(buf: Buffer): number {
  return Math.floor(buf.length / BYTES_PER_SAMPLE)
}

export function samplesToMs(samples: number): number {
  return (samples * 1000) / SAMPLE_RATE
}

export function msToSamples(ms: number): number {
  return Math.round((ms * SAMPLE_RATE) / 1000)
}

export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let ss = 0
  for (let i = 0; i < samples.length; i++) ss += samples[i] * samples[i]
  return Math.sqrt(ss / samples.length)
}

export function peak(samples: Int16Array): number {
  let p = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > p) p = a
  }
  return p
}

/** True when every sample is exactly zero (real microphones always have some noise). */
export function isDigitalZero(samples: Int16Array): boolean {
  for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) return false
  return true
}

/** RMS in dBFS, floored at -100. */
export function rmsDbfs(samples: Int16Array): number {
  const r = rms(samples)
  if (r <= 0) return -100
  return Math.max(-100, 20 * Math.log10(r / 32768))
}

export function silence(samples: number): Buffer {
  return Buffer.alloc(samples * BYTES_PER_SAMPLE)
}
