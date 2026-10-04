/**
 * Builds Turns from FINAL DiarizedWords.
 * - One open turn per stream; streams are independent, so overlap is preserved.
 * - A new turn starts on speaker-cluster change, a silence longer than maxGapMs,
 *   or a gap marker on that stream.
 * - Never infers buyer identity: local_mic -> 'keith', system_remote -> 'unknown'.
 */
import type { DiarizedWord, GapRecord, Stream, Turn } from '../shared/contracts'

export type TurnEvent = { type: 'turn_update' | 'turn_final'; turn: Turn }

export interface TurnBuilderOptions {
  maxGapMs?: number
}

export class TurnBuilder {
  private open = new Map<Stream, Turn>()
  private pendingGap = new Map<Stream, GapRecord>()
  private seq = 0
  private readonly maxGapMs: number

  constructor(private readonly sessionId: string, opts: TurnBuilderOptions = {}) {
    this.maxGapMs = opts.maxGapMs ?? 1200
  }

  addFinalWords(words: DiarizedWord[]): TurnEvent[] {
    const events: TurnEvent[] = []
    for (const w of words) {
      if (!w.is_final) continue
      const cur = this.open.get(w.stream)
      const sameSpeaker = cur && cur.speaker_cluster === w.speaker_cluster
      const closeEnough = cur && w.start_ms - cur.end_ms <= this.maxGapMs
      if (cur && sameSpeaker && closeEnough && !this.pendingGap.has(w.stream)) {
        cur.text = `${cur.text} ${w.word}`
        cur.end_ms = Math.max(cur.end_ms, w.end_ms)
        cur.source_word_ids.push(w.word_id)
        this.upsert(events, 'turn_update', cur)
      } else {
        if (cur) events.push(this.finalize(w.stream))
        const t: Turn = {
          turn_id: `t${++this.seq}`,
          session_id: this.sessionId,
          stream: w.stream,
          speaker_cluster: w.speaker_cluster,
          speaker_identity_id: null,
          speaker_role: w.stream === 'local_mic' ? 'keith' : 'unknown',
          start_ms: w.start_ms,
          end_ms: w.end_ms,
          text: w.word,
          final: false,
          source_word_ids: [w.word_id],
          gap_before: this.pendingGap.get(w.stream) ?? null,
        }
        this.pendingGap.delete(w.stream)
        this.open.set(w.stream, t)
        this.upsert(events, 'turn_update', t)
      }
    }
    return events
  }

  /** A gap on a stream closes its open turn; the next turn on that stream carries gap_before. */
  markGap(gap: GapRecord): TurnEvent[] {
    const events: TurnEvent[] = []
    if (this.open.has(gap.stream)) events.push(this.finalize(gap.stream))
    this.pendingGap.set(gap.stream, gap)
    return events
  }

  /**
   * Close turns whose last word is older than maxGapMs. Finals can lag the audio by
   * seconds during continuous speech, so the caller may keep a turn open while its stream
   * is still carrying sound (`keepOpen`); the next final then extends it instead of
   * starting a new bubble mid-sentence.
   */
  flushIdle(nowSessionMs: number, keepOpen?: (stream: Stream, turnEndMs: number) => boolean): TurnEvent[] {
    const events: TurnEvent[] = []
    for (const [stream, t] of this.open) {
      if (nowSessionMs - t.end_ms <= this.maxGapMs) continue
      if (keepOpen?.(stream, t.end_ms)) continue
      events.push(this.finalize(stream))
    }
    return events
  }

  flushAll(): TurnEvent[] {
    return [...this.open.keys()].map((s) => this.finalize(s))
  }

  private finalize(stream: Stream): TurnEvent {
    const t = this.open.get(stream)!
    this.open.delete(stream)
    t.final = true
    return { type: 'turn_final', turn: { ...t, source_word_ids: [...t.source_word_ids] } }
  }

  private upsert(events: TurnEvent[], type: 'turn_update', t: Turn): void {
    const i = events.findIndex((e) => e.type === 'turn_update' && e.turn.turn_id === t.turn_id)
    const ev: TurnEvent = { type, turn: { ...t, source_word_ids: [...t.source_word_ids] } }
    if (i >= 0) events[i] = ev
    else events.push(ev)
  }
}

/** Display label for the debug transcript. */
export function speakerLabel(t: Pick<Turn, 'stream' | 'speaker_cluster'>): string {
  if (t.stream === 'local_mic') return 'KEITH'
  if (!t.speaker_cluster) return 'UNKNOWN'
  const m = /^e(\d+):s(\d+)$/.exec(t.speaker_cluster)
  return m ? `REMOTE_${m[2]} (epoch ${m[1]})` : `REMOTE_${t.speaker_cluster}`
}
