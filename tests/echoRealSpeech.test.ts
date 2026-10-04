import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ResidualEchoGate } from '../src/main/echoGate'
import { rms, toInt16 } from '../src/main/pcm'

// Public-domain NASA speech (spacewalk sample), 16 kHz mono s16le, 16 s.
// Two non-overlapping 7 s segments stand in for "remote" and "Keith" (independent content).
const pcm = fs.readFileSync(new URL('./fixtures/nasa_spacewalk_16k_mono_s16le.raw', import.meta.url))
const seg = (startS: number, lenS: number) => pcm.subarray(startS * 32000, (startS + lenS) * 32000)
const REMOTE = seg(0, 7)
const KEITH = seg(8, 7)

const scale = (b: Buffer, g: number) => { const o = Buffer.alloc(b.length); for (let i = 0; i < b.length; i += 2) o.writeInt16LE(Math.round(b.readInt16LE(i) * g), i); return o }
const add = (a: Buffer, b: Buffer) => { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i += 2) o.writeInt16LE(Math.max(-32768, Math.min(32767, a.readInt16LE(i) + b.readInt16LE(i))), i); return o }
const delay = (b: Buffer, n: number) => Buffer.concat([Buffer.alloc(n * 2), b.subarray(0, b.length - n * 2)])

/** Feed system + mic in 100 ms steps; count muted windows (only where `keith` is really talking, if given). */
function run(sys: Buffer, mic: Buffer, keith: Buffer | null) {
  const g = new ResidualEchoGate()
  let muted = 0, counted = 0
  for (let off = 0; off + 1600 <= sys.length / 2; off += 1600) {
    g.pushSystemPcm(sys.subarray(off * 2, (off + 1600) * 2))
    const talking = keith ? rms(toInt16(keith.subarray(off * 2, (off + 1600) * 2))) > 500 : true
    for (const w of g.pushMicPcm(mic.subarray(off * 2, (off + 1600) * 2))) {
      if (keith ? !talking : w.decision === 'quiet') continue
      counted++
      if (w.decision === 'echo' || w.decision === 'hold') muted++
    }
  }
  return { muted, counted, rate: muted / Math.max(1, counted) }
}

describe('echo gate on real speech', () => {
  it('never mutes Keith during double-talk without leakage', () => {
    const r = run(REMOTE, KEITH, KEITH)
    expect(r.counted).toBeGreaterThan(20)
    expect(r.rate).toBeLessThanOrEqual(0.02)
  })

  it('rarely mutes Keith when he talks over leaked remote audio', () => {
    // Raven's single-window 0.32 rule muted 23-33% of Keith's speech at -12 dB and 7-14% at -18 dB
    // on these segments; the stable-lag + pre-emphasis rule mutes 0-7% and 0%.
    const r12 = run(REMOTE, add(KEITH, scale(delay(REMOTE, 480), 0.25)), KEITH)
    expect(r12.rate).toBeLessThanOrEqual(0.1)
    const r18 = run(REMOTE, add(KEITH, scale(delay(REMOTE, 480), 0.125)), KEITH)
    expect(r18.rate).toBeLessThanOrEqual(0.05)
  })

  it('still catches most pure leakage (the duplicate-text gate backs up the rest)', () => {
    for (const g of [0.25, 0.125, 0.063]) {
      const r = run(REMOTE, scale(delay(REMOTE, 480), g), null)
      expect(r.rate).toBeGreaterThanOrEqual(0.8)
    }
  })
})
