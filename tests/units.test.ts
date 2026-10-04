import { describe, expect, it } from 'vitest'
import { buildListenUrl, DeepgramStream } from '../src/main/deepgram'
import { resolveConfig, shortId, toEndpointRef } from '../src/main/endpoints'
import { MOCK_IDS, defaultMockEndpoints } from '../src/main/mockNative'
import { SampleClock } from '../src/main/sampleClock'
import { dgResults, fakeWsFactory } from './helpers/fakeWs'

describe('SampleClock', () => {
  it('maps provider seconds across a gap in session time', () => {
    const c = new SampleClock()
    c.record(16000, 0) // first second at session 0
    c.record(16000, 5000) // next second sent after a 4 s gap
    expect(c.toSessionMs(0.5)).toBe(500)
    expect(c.toSessionMs(1.25)).toBe(5250)
  })
})

describe('endpoint resolution', () => {
  const eps = defaultMockEndpoints()
  const config = {
    config_id: 'c', confirmed_at: '', confirmed_by_test: true, last_verified_at: null,
    system_output: toEndpointRef(eps.find((e) => e.id === MOCK_IDS.RAZER_OUT)!),
    microphone: toEndpointRef(eps.find((e) => e.id === MOCK_IDS.RAZER_MIC)!),
  }
  it('ready when both IDs are active', () => {
    expect(resolveConfig(config, eps).ready).toBe(true)
  })
  it('a new ID for the same headset is only a suggestion', () => {
    const moved = eps.map((e) => (e.id === MOCK_IDS.RAZER_MIC ? { ...e, id: '{0.0.1.00000000}.{new-id}' } : e))
    const r = resolveConfig(config, moved)
    expect(r.ready).toBe(false)
    expect(r.mic.state).toBe('missing')
    expect(r.mic.candidates.map((c) => c.id)).toEqual(['{0.0.1.00000000}.{new-id}'])
  })
  it('ignores Windows default changes', () => {
    const changed = eps.map((e) => ({ ...e, isDefaultConsole: e.id === MOCK_IDS.LAPTOP_MIC }))
    expect(resolveConfig(config, changed).ready).toBe(true)
  })
  it('shortId', () => {
    expect(shortId('{0.0.1.00000000}.{a1b2c3d4-0000-4000-8000-0000000000ff}')).toBe('…000000ff')
  })
})

describe('DeepgramStream', () => {
  it('builds the listen URL with diarization only when asked and MIP opt-out always', () => {
    expect(buildListenUrl(true)).toContain('diarize=true')
    expect(buildListenUrl(false)).toContain('diarize=false')
    expect(buildListenUrl(false)).toContain('mip_opt_out=true')
    expect(buildListenUrl(false)).toContain('encoding=linear16')
  })

  it('does not buffer audio while closed and ignores messages after abort', async () => {
    const { factory, sockets } = fakeWsFactory()
    const got: string[] = []
    const dg = new DeepgramStream({
      apiKey: 'k', sessionId: 's', stream: 'system_remote', epoch: 3, diarize: true, wsFactory: factory,
      onWords: (w) => got.push(...w.map((x) => `${x.word}@${x.speaker_cluster}`)),
      onUnexpectedClose: () => undefined, log: () => undefined,
    })
    expect(dg.send(Buffer.alloc(640), 320, 0)).toBe(false)
    await dg.connect()
    expect(sockets[0].headers.Authorization).toBe('Token k')
    expect(dg.send(Buffer.alloc(640), 320, 0)).toBe(true)
    sockets[0].message(dgResults([['Hi', 0, 0.01, 2]]))
    expect(got).toEqual(['Hi@e3:s2'])
    dg.abort()
    sockets[0].message(dgResults([['Late', 0, 0.01, 2]]))
    expect(got).toEqual(['Hi@e3:s2'])
    expect(sockets[0].audioChunks()).toHaveLength(1)
  })
})
