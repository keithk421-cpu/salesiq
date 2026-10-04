import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DiarizedWord } from '../src/shared/contracts'
import { TurnBuilder } from '../src/main/turnBuilder'

// Synthetic/public replay fixture: real Deepgram final words captured by scripts/deepgram-smoke.ts.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/deepgram_spacewalk_words.json', import.meta.url), 'utf8')) as { words: DiarizedWord[] }

describe('replay fixture', () => {
  it('real provider words are final, on the session clock, cluster-tagged, and build ordered turns', () => {
    const w = fixture.words
    expect(w.length).toBeGreaterThan(30)
    expect(w.every((x) => x.is_final && x.start_ms >= 10000 && x.end_ms >= x.start_ms)).toBe(true)
    expect(w.every((x) => /^e1:s\d+$/.test(x.speaker_cluster ?? ''))).toBe(true)
    const tb = new TurnBuilder('replay')
    const turns = [...tb.addFinalWords(w), ...tb.flushAll()].filter((e) => e.type === 'turn_final').map((e) => e.turn)
    expect(turns.length).toBeGreaterThan(0)
    expect(turns.flatMap((t) => t.source_word_ids)).toHaveLength(w.length)
    for (let i = 1; i < turns.length; i++) expect(turns[i].start_ms).toBeGreaterThanOrEqual(turns[i - 1].start_ms)
    expect(turns.every((t) => t.speaker_role === 'unknown')).toBe(true)
  })
})
