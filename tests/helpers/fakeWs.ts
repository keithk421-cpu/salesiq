import type { WsFactory, WsLike } from '../../src/main/deepgram'

type Handler = (...args: any[]) => void

export class FakeWs implements WsLike {
  readyState = 0
  bufferedAmount = 0
  sent: Array<Buffer | string> = []
  closed = false
  private refused = false
  private handlers = new Map<string, Handler[]>()
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  on(event: string, cb: Handler): void {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
  }
  private fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args)
  }
  send(data: Buffer | string): void {
    if (this.closed) throw new Error('closed')
    this.sent.push(data)
    if (typeof data === 'string' && data.includes('CloseStream')) {
      queueMicrotask(() => this.serverClose(1000, ''))
    }
  }
  close(): void {
    this.serverClose(1000, 'client close')
  }
  // ---- test helpers ----
  open(): void {
    if (this.closed || this.refused) return // a real socket never opens after it has closed or been refused
    this.readyState = 1
    this.fire('open')
  }
  /** Refuse the connect with an HTTP status AND drop the connection (real ws does not drop it; see rejectKeepOpen). */
  reject(status: number): void {
    this.fire('unexpected-response', {}, { statusCode: status })
    this.serverClose(1006, '')
  }
  /**
   * Refuse the connect with an HTTP status the way real ws does when an 'unexpected-response'
   * listener exists: the socket stays connecting (never opens, never closes) until our side closes it.
   */
  rejectKeepOpen(status: number): void {
    this.refused = true
    this.fire('unexpected-response', {}, { statusCode: status })
  }
  message(obj: unknown): void {
    this.fire('message', Buffer.from(JSON.stringify(obj)))
  }
  serverClose(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.fire('close', code, Buffer.from(reason))
  }
  audioChunks(): Buffer[] {
    return this.sent.filter((d): d is Buffer => Buffer.isBuffer(d))
  }
}

export function fakeWsFactory(opts: { autoOpen?: boolean } = { autoOpen: true }) {
  const sockets: FakeWs[] = []
  const factory: WsFactory = (url, headers) => {
    const ws = new FakeWs(url, headers)
    sockets.push(ws)
    if (opts.autoOpen !== false) queueMicrotask(() => ws.open())
    return ws
  }
  return { factory, sockets }
}

/** Build a Deepgram Results message. words: [word, startSec, endSec, speaker?] */
export function dgResults(words: Array<[string, number, number, number?]>, isFinal = true) {
  return {
    type: 'Results',
    is_final: isFinal,
    speech_final: isFinal,
    channel: {
      alternatives: [
        {
          transcript: words.map((w) => w[0]).join(' '),
          words: words.map(([word, start, end, speaker]) => ({
            word: word.toLowerCase(), punctuated_word: word, start, end, confidence: 0.95,
            ...(speaker === undefined ? {} : { speaker }),
          })),
        },
      ],
    },
  }
}
