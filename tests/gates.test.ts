import { describe, expect, it } from 'vitest'
import type { DiarizedWord } from '../src/shared/contracts'
import { DuplicateGate, lcs } from '../src/main/duplicateGate'
import { ResidualEchoGate } from '../src/main/echoGate'
import { noise, tone } from './helpers/audio'

let n = 0
function words(stream: DiarizedWord['stream'], text: string, start: number): DiarizedWord[] {
  return text.split(' ').map((t, i) => ({ word_id: `w${n++}`, session_id: 's', stream, word: t, start_ms: start + i * 300, end_ms: start + i * 300 + 250, confidence: 0.9, speaker_cluster: null, is_final: true, provider_segment_id: 'p', connection_epoch: 1 }))
}

describe('DuplicateGate (transcript-level leakage)', () => {
  it('suppresses mic text that repeats system text at the same time', () => {
    const g = new DuplicateGate()
    g.addSystemWords(words('system_remote', 'we are evaluating three vendors right now', 1000))
    g.addMicWords(words('local_mic', 'evaluating three vendors right', 1350), 0)
    const r = g.poll(10000)
    expect(r.release).toHaveLength(0)
    expect(r.suppressed).toHaveLength(1)
  })

  it('keeps Keith when he says different words', () => {
    const g = new DuplicateGate()
    g.addSystemWords(words('system_remote', 'we are evaluating three vendors right now', 1000))
    g.addMicWords(words('local_mic', 'which one is ahead today', 1400), 0)
    expect(g.poll(10000).release).toHaveLength(1)
  })

  it('keeps short mic acknowledgements', () => {
    const g = new DuplicateGate()
    g.addSystemWords(words('system_remote', 'yeah', 1000))
    g.addMicWords(words('local_mic', 'yeah', 1000), 0)
    expect(g.poll(10000).release).toHaveLength(1)
  })

  it('does not match system words far away in time', () => {
    const g = new DuplicateGate()
    g.addSystemWords(words('system_remote', 'pricing is the main concern', 1000))
    g.addMicWords(words('local_mic', 'pricing is the main concern', 20000), 0)
    expect(g.poll(10000).release).toHaveLength(1)
  })

  it('holds mic segments until the hold time passes', () => {
    const g = new DuplicateGate({ holdMs: 1500 })
    g.addMicWords(words('local_mic', 'hello there friend', 0), 1000)
    expect(g.poll(2000).release).toHaveLength(0)
    expect(g.poll(2600).release).toHaveLength(1)
  })

  it('lcs', () => {
    expect(lcs(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(2)
  })
})

describe('ResidualEchoGate (audio-level leakage test)', () => {
  it('zeroes mic windows that are a delayed copy of system audio', () => {
    const g = new ResidualEchoGate()
    const sys = noise(16000, 6000, 7)
    let echoWindows = 0
    // Feed system audio ahead, mic is the same signal 40 ms later at -12 dB.
    for (let off = 0; off + 1600 <= 16000; off += 1600) {
      g.pushSystemPcm(sys.subarray(off * 2, (off + 1600) * 2))
      const micStart = Math.max(0, off - 640)
      const mic = Buffer.from(sys.subarray(micStart * 2, (micStart + 1600) * 2))
      for (let i = 0; i < mic.length; i += 2) mic.writeInt16LE(Math.round(mic.readInt16LE(i) / 4), i)
      for (const wnd of g.pushMicPcm(mic)) {
        if (wnd.decision === 'echo') {
          echoWindows++
          expect(wnd.pcm.every((b) => b === 0)).toBe(true)
        }
      }
    }
    expect(echoWindows).toBeGreaterThanOrEqual(8)
  })

  it('passes near-end speech unrelated to system audio', () => {
    const g = new ResidualEchoGate()
    let sent = 0
    for (let i = 0; i < 10; i++) {
      g.pushSystemPcm(noise(1600, 6000, 100 + i))
      for (const wnd of g.pushMicPcm(tone(1600, 8000, 220, i * 1600))) if (wnd.decision === 'send') sent++
    }
    expect(sent).toBe(10)
  })

  it('keeps sample count constant (timeline continuity)', () => {
    const g = new ResidualEchoGate()
    let out = 0
    for (let i = 0; i < 7; i++) for (const wnd of g.pushMicPcm(noise(700, 2000, i))) out += wnd.pcm.length / 2
    expect(out).toBe(Math.floor((7 * 700) / 1600) * 1600)
  })
})
