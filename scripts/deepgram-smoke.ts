// Live Deepgram check: streams a WAV through the real DeepgramStream + TurnBuilder at ~2x real time.
// Usage: DEEPGRAM_API_KEY=... node dist-tools/deepgram-smoke.js file.wav [seconds]
import fs from 'node:fs'
import WebSocket from 'ws'
import { DeepgramStream, type WsLike } from '../src/main/deepgram'
import { TurnBuilder, speakerLabel } from '../src/main/turnBuilder'

const [file, secsArg] = process.argv.slice(2)
const key = process.env.DEEPGRAM_API_KEY ?? ''
const buf = fs.readFileSync(file)
const rate = buf.readUInt32LE(24)
const ch = buf.readUInt16LE(22)
let off = 12
while (buf.toString('ascii', off, off + 4) !== 'data') off += 8 + buf.readUInt32LE(off + 4)
const data = buf.subarray(off + 8)
const inSamples = Math.floor(data.length / 2 / ch)
const maxIn = Math.min(inSamples, Math.floor(Number(secsArg ?? 30) * rate))
const outLen = Math.floor((maxIn * 16000) / rate)
const pcm = Buffer.alloc(outLen * 2)
for (let i = 0; i < outLen; i++) {
  const src = Math.min(maxIn - 1, Math.floor((i * rate) / 16000))
  let v = 0
  for (let c = 0; c < ch; c++) v += data.readInt16LE((src * ch + c) * 2)
  pcm.writeInt16LE(Math.round(v / ch), i * 2)
}
const tb = new TurnBuilder('smoke')
const finals: unknown[] = []
const dg = new DeepgramStream({
  apiKey: key, sessionId: 'smoke', stream: 'system_remote', epoch: 1, diarize: true,
  wsFactory: (url, headers) => new WebSocket(url, { headers }) as unknown as WsLike,
  onWords: (w, info) => { if (info.isFinal) finals.push(...w); if (info.isFinal) for (const e of tb.addFinalWords(w)) if (e.type === 'turn_final') print(e.turn) },
  onUnexpectedClose: (d) => console.log('UNEXPECTED CLOSE', d),
  log: (e, d) => console.log(`[${e}]`, JSON.stringify(d)),
})
function print(t: { start_ms: number; end_ms: number; text: string; stream: 'system_remote' | 'local_mic'; speaker_cluster: string | null }) {
  console.log(`${(t.start_ms / 1000).toFixed(2).padStart(6)}-${(t.end_ms / 1000).toFixed(2).padStart(6)}  ${speakerLabel(t)}: ${t.text}`)
}
await dg.connect()
const chunk = 320
// Pretend session time starts at 10 s to prove mapping onto the session clock.
for (let i = 0, t = 10000; i < outLen; i += chunk, t += 20) {
  dg.send(pcm.subarray(i * 2, Math.min(outLen, i + chunk) * 2), Math.min(chunk, outLen - i), t)
  await new Promise((r) => setTimeout(r, 10))
}
await dg.finalizeAndClose(5000)
for (const e of tb.flushAll()) print(e.turn)
if (process.env.SMOKE_OUT) fs.writeFileSync(process.env.SMOKE_OUT, JSON.stringify({ source: 'NASA spacewalk sample (public, https://dpgr.am/spacewalk.wav), first 30 s, streamed live to Deepgram nova-3 with diarize=true; session clock offset 10 s', words: finals }, null, 1))
console.log(`sent ${dg.sentChunks} chunks, request ${dg.requestId}`)
