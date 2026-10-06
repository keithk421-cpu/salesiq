/**
 * One Deepgram live-streaming connection for one stream and one connection epoch.
 *
 * Rules:
 * - Audio is sent only while the socket is open. There is NO reconnect buffer:
 *   audio that arrives while disconnected is dropped and the caller marks a gap.
 *   (Raven buffers and replays after reconnect; that is forbidden here.)
 * - A new connection = a new epoch = a fresh speaker-cluster namespace.
 * - After abort(), late messages are ignored.
 */
import type { DiarizedWord, Stream } from '../shared/contracts'
import { SampleClock } from './sampleClock'

export const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen'

export interface WsLike {
  readyState: number
  /** Bytes queued but not yet sent (ws). Used to keep the upstream buffer bounded. */
  bufferedAmount: number
  send(data: Buffer | string): void
  close(code?: number, reason?: string): void
  on(event: 'open', cb: () => void): void
  on(event: 'message', cb: (data: Buffer | string) => void): void
  on(event: 'close', cb: (code: number, reason: Buffer | string) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): void
}

export type WsFactory = (url: string, headers: Record<string, string>) => WsLike

export type ProviderState = 'connecting' | 'open' | 'closing' | 'closed' | 'failed'

/** Deepgram answered the connect with an HTTP status instead of opening the stream. */
export class DeepgramHttpError extends Error {
  constructor(readonly statusCode: number | undefined, message: string) {
    super(message)
  }
}

/**
 * True when Deepgram turned the connect down in a way that trying again will not fix: the API key
 * was rejected (401/403), or another 4xx such as no credit left. Timeouts (408), rate limits (429),
 * server errors and network blips are worth retrying.
 */
export function isRefusal(err: unknown): boolean {
  const code = err instanceof DeepgramHttpError ? err.statusCode : undefined
  return code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429
}

export interface DeepgramOptions {
  apiKey: string
  sessionId: string
  stream: Stream
  epoch: number
  diarize: boolean
  wsFactory: WsFactory
  onWords: (words: DiarizedWord[], info: { isFinal: boolean; speechFinal: boolean }) => void
  /** Deepgram's UtteranceEnd: no words for utterance_end_ms after the last finished word (the speaker stopped). */
  onUtteranceEnd?: () => void
  /** Called once when an OPEN socket closes without us asking. */
  onUnexpectedClose: (detail: string) => void
  /** Called for every message of any kind (words or not), until abort(). Feeds the stall watchdog. */
  onMessage?: () => void
  log: (event: string, data?: Record<string, unknown>) => void
  keepAliveMs?: number
}

/** Upstream buffer bound: ~3 s of 16 kHz mono Int16. Beyond this, audio is dropped and a gap is marked. */
export const MAX_BUFFERED_BYTES = 16000 * 2 * 3

/**
 * Keyterm prompting (nova-3): vocabulary Keith's calls use that generic STT often mangles.
 * Proper nouns and domain terms only; generic words here can cause false insertions.
 */
export const DEFAULT_KEYTERMS = [
  'Arize', 'Arize AX', 'Phoenix', 'OpenInference', 'OpenTelemetry', 'LLM', 'evals',
  'LangChain', 'LangGraph', 'LlamaIndex', 'Datadog', 'Databricks', 'Snowflake', 'Bedrock', 'Vertex AI',
]

export function buildListenUrl(diarize: boolean, keyterms: readonly string[] = DEFAULT_KEYTERMS): string {
  const p = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    diarize: diarize ? 'true' : 'false',
    mip_opt_out: 'true',
  })
  for (const k of keyterms.slice(0, 100)) p.append('keyterm', k)
  return `${DEEPGRAM_URL}?${p.toString()}`
}

interface DgWord {
  word: string
  punctuated_word?: string
  start: number
  end: number
  confidence: number
  speaker?: number
}

interface DgResults {
  type: 'Results'
  is_final?: boolean
  speech_final?: boolean
  start?: number
  channel?: { alternatives?: Array<{ words?: DgWord[] }> }
  metadata?: { request_id?: string }
}

export class DeepgramStream {
  readonly clock = new SampleClock()
  state: ProviderState = 'connecting'
  private ws: WsLike | null = null
  private dead = false
  private closeRequested = false
  private keepAlive: NodeJS.Timeout | null = null
  private lastSendAt = 0
  private segmentSeq = 0
  requestId: string | null = null
  sentChunks = 0
  private backedUp = false

  constructor(private readonly opts: DeepgramOptions) {}

  get epoch(): number {
    return this.opts.epoch
  }

  connect(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          this.state = 'failed'
          reject(err)
        } else resolve()
      }
      const timer = setTimeout(() => {
        settle(new Error('Deepgram connect timeout'))
        try { this.ws?.close() } catch { /* ignore */ }
      }, timeoutMs)

      const ws = this.opts.wsFactory(buildListenUrl(this.opts.diarize), {
        Authorization: `Token ${this.opts.apiKey}`,
      })
      this.ws = ws
      ws.on('unexpected-response', (_req, res) => {
        const code = res?.statusCode
        const msg = code === 401 || code === 403 ? 'Deepgram rejected the API key' : `Deepgram HTTP ${code}`
        settle(new DeepgramHttpError(code, msg))
      })
      ws.on('open', () => {
        if (this.dead) return
        this.state = 'open'
        this.opts.log('provider_open', { stream: this.opts.stream, epoch: this.opts.epoch })
        this.keepAlive = setInterval(() => {
          if (this.state === 'open' && Date.now() - this.lastSendAt > 3000) {
            try { ws.send(JSON.stringify({ type: 'KeepAlive' })) } catch { /* ignore */ }
          }
        }, this.opts.keepAliveMs ?? 4000)
        settle()
      })
      ws.on('message', (data) => {
        if (this.dead) return
        this.opts.onMessage?.()
        this.handleMessage(typeof data === 'string' ? data : data.toString('utf8'))
      })
      ws.on('error', (err) => {
        this.opts.log('provider_error', { stream: this.opts.stream, epoch: this.opts.epoch, message: err.message })
        settle(err)
      })
      ws.on('close', (code, reason) => {
        const wasOpen = this.state === 'open'
        this.state = 'closed'
        this.clearKeepAlive()
        const r = typeof reason === 'string' ? reason : reason?.toString('utf8')
        this.opts.log('provider_close', { stream: this.opts.stream, epoch: this.opts.epoch, code, reason: r })
        settle(new Error(`Deepgram closed before open (code ${code})`))
        if (wasOpen && !this.closeRequested && !this.dead) {
          this.opts.onUnexpectedClose(`code ${code}${r ? `: ${r}` : ''}`)
        }
      })
    })
  }

  /** Returns false (audio dropped) unless the socket is open and not backed up. */
  send(pcm: Buffer, samples: number, sessionMs: number): boolean {
    if (this.dead || this.state !== 'open' || !this.ws) return false
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (!this.backedUp) this.opts.log('provider_backpressure', { stream: this.opts.stream, epoch: this.opts.epoch, bufferedBytes: this.ws.bufferedAmount })
      this.backedUp = true
      return false
    }
    this.backedUp = false
    try {
      this.ws.send(pcm)
    } catch {
      return false
    }
    this.clock.record(samples, sessionMs)
    this.lastSendAt = Date.now()
    this.sentChunks++
    return true
  }

  /** Ask Deepgram to finalize audio already sent, then close. Resolves on close or after graceMs. */
  finalizeAndClose(graceMs: number): Promise<void> {
    this.closeRequested = true
    return new Promise((resolve) => {
      if (!this.ws || this.state !== 'open') {
        this.abort()
        resolve()
        return
      }
      this.state = 'closing'
      const ws = this.ws
      const timer = setTimeout(() => {
        this.abort()
        resolve()
      }, graceMs)
      ws.on('close', () => {
        clearTimeout(timer)
        this.dead = true
        resolve()
      })
      try {
        ws.send(JSON.stringify({ type: 'Finalize' }))
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        clearTimeout(timer)
        this.abort()
        resolve()
      }
    })
  }

  /** Close immediately and ignore anything that arrives later. */
  abort(): void {
    this.closeRequested = true
    this.dead = true
    this.clearKeepAlive()
    if (this.state !== 'closed') this.state = 'closed'
    try { this.ws?.close() } catch { /* ignore */ }
  }

  private clearKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
  }

  private handleMessage(text: string): void {
    let msg: { type?: string }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg.type === 'Metadata') {
      this.requestId = (msg as { request_id?: string }).request_id ?? this.requestId
      return
    }
    if (msg.type === 'UtteranceEnd') {
      this.opts.onUtteranceEnd?.()
      return
    }
    if (msg.type !== 'Results') return
    const r = msg as DgResults
    const words = r.channel?.alternatives?.[0]?.words ?? []
    if (words.length === 0) return
    const isFinal = !!r.is_final
    const segId = `${this.opts.stream}-e${this.opts.epoch}-${isFinal ? 'f' : 'i'}${this.segmentSeq++}`
    const out: DiarizedWord[] = []
    words.forEach((w, i) => {
      const start = this.clock.toSessionMs(w.start)
      const end = this.clock.toSessionMs(w.end)
      if (start === null || end === null) return
      out.push({
        word_id: `${this.opts.stream}-e${this.opts.epoch}-${Math.round(w.start * 1000)}-${i}`,
        session_id: this.opts.sessionId,
        stream: this.opts.stream,
        word: w.punctuated_word ?? w.word,
        start_ms: Math.round(start),
        end_ms: Math.round(end),
        confidence: w.confidence,
        speaker_cluster:
          this.opts.diarize && typeof w.speaker === 'number' ? `e${this.opts.epoch}:s${w.speaker}` : null,
        is_final: isFinal,
        provider_segment_id: segId,
        connection_epoch: this.opts.epoch,
      })
    })
    if (out.length > 0) this.opts.onWords(out, { isFinal, speechFinal: !!r.speech_final })
  }
}
