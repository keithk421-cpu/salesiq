import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, playbookProblem, type Playbook } from '../src/main/help/prompt'
import { LineProtocolParser, validateCard } from '../src/main/help/protocol'
import { HelpService, playbookFingerprint } from '../src/main/helpService'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const builtText = fs.readFileSync(path.join(ROOT, 'config', 'playbook.json'), 'utf8')
const built = JSON.parse(builtText) as Playbook
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }

/** The built-in playbook before M5: this one without call modes, at its old version. */
function m1Draft2(): Playbook {
  const { call_modes: _modes, ...rest } = built
  return { ...rest, version: 'm1-draft-2' }
}

/** The one before that: m1-draft-2 with only its version and limits as they were. */
function m1Draft1(): Playbook {
  return { ...m1Draft2(), version: 'm1-draft-1', card_limits: { primary_max_words: 30, happening_max_words: 18, follow_up_max_words: 22 } }
}

function card(move: string, kind: 'ASK' | 'SAY', words: number) {
  const p = new LineProtocolParser()
  p.feed(`MOVE: ${move}\n${kind}: ${Array.from({ length: words }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ')}\nHAPPENING: -\nFOLLOW: -\nSOURCES: -\nNOTE: -\n`)
  p.end()
  return validateCard(p.partial(), p.fieldOrder, { knownSourceIds: new Set(), contextText: '', limits: built.card_limits })
}

describe('shorter lines', () => {
  it('the built-in playbook is m1-draft-3 (M5 call modes): 15/12/15 words, 30 for a technical answer', () => {
    expect(built.version).toBe('m1-draft-3')
    expect(built.card_limits).toEqual({ primary_max_words: 15, happening_max_words: 12, follow_up_max_words: 15, technical_max_words: 30 })
    expect(playbookProblem(built)).toBeNull()
    const sys = buildSystemPrompt(built)
    expect(sys).toMatch(/ASK\/SAY at most 15 words \(a technical_answer stated from approved knowledge: at most 30\)/)
    expect(sys).toMatch(/HAPPENING at most 12 words\. FOLLOW at most 15 words\./)
    // Without the optional limit the prompt doesn't mention it.
    expect(buildSystemPrompt(m1Draft1())).toMatch(/ASK\/SAY at most 30 words, natural spoken English/)
  })

  it('a technical answer may run to its own limit; other lines are held to the shorter one', () => {
    // Limits have 20% slack: 15 -> 18 words, 30 -> 36.
    expect(card('clarify_current_state', 'ASK', 18).issues).not.toContain('over card limits')
    // A line Keith already saw while it streamed is kept whole when it runs a little over (noted, not cut)...
    const long = card('clarify_current_state', 'ASK', 25)
    expect(long.issues).toContain('over card limits')
    expect(long.issues).not.toContain('trimmed to card limits')
    expect(long.card!.primary.split(' ')).toHaveLength(25)
    expect(long.card!.primary).not.toMatch(/…/)
    // ...and only a runaway line (over twice the limit) is cut.
    const runaway = card('clarify_current_state', 'ASK', 40)
    expect(runaway.issues).toContain('trimmed to card limits')
    expect(runaway.card!.primary.split(' ')).toHaveLength(30)
    expect(card('technical_answer', 'SAY', 30).issues).toEqual([])
    expect(card('technical_answer', 'SAY', 40).issues).toContain('over card limits')
    expect(card('technical_answer', 'SAY', 70).card!.primary.split(' ')).toHaveLength(60)
  })

  it('a playbook may leave the technical limit out, but not set it to nonsense', () => {
    expect(playbookProblem(m1Draft1())).toBeNull()
    for (const bad of [0, -5, '30', null]) {
      expect(playbookProblem({ ...built, card_limits: { ...built.card_limits, technical_max_words: bad as never } })).toBe('"card_limits" "technical_max_words" must be a word count above zero (or leave it out)')
    }
  })
})

describe('a playbook copy Keith never edited follows the new built-in', () => {
  const setUp = (copy: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb2-'))
    fs.writeFileSync(path.join(dir, 'playbook.json'), copy)
    const logs: Array<{ e: string; d?: Record<string, unknown> }> = []
    const help = new HelpService(new Storage(dir, plainBox), ROOT, () => {}, (e, d) => logs.push({ e, d }))
    return { dir, help, logs }
  }

  it('an unedited m1-draft-1 or m1-draft-2 copy (even re-saved with other spacing) moves to m1-draft-3 by itself, keeping a dated backup', () => {
    for (const copy of [JSON.stringify(m1Draft1(), null, 2), JSON.stringify(m1Draft1(), null, 4).replace(/\n/g, '\r\n'), JSON.stringify(m1Draft2(), null, 2)]) {
      const { dir, help, logs } = setUp(copy)
      expect(help.playbookInfo).toMatchObject({ using: 'built_in', version: 'm1-draft-3', newer_built_in: false, problem: null, call_modes_from: 'built_in' })
      expect(fs.existsSync(path.join(dir, 'playbook.json'))).toBe(false)
      const backups = fs.readdirSync(dir).filter((f) => /^playbook-earlier-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.json$/.test(f))
      expect(backups).toHaveLength(1)
      expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe(copy)
      expect(logs.find((l) => l.e === 'playbook_auto_updated')?.d).toEqual({ from: JSON.parse(copy).version, to: 'm1-draft-3' })
      help.shutdown()
    }
  })

  it('an edited copy stays in use and is offered the new one, as before', () => {
    const edited = { ...m1Draft1(), principles: [...built.principles, 'Keep it short.'] }
    const { dir, help } = setUp(JSON.stringify(edited, null, 2))
    // A copy from before call modes still gets them, from the built-in playbook.
    expect(help.playbookInfo).toMatchObject({ using: 'yours', version: 'm1-draft-1', newer_built_in: true, call_modes_from: 'built_in' })
    expect(fs.existsSync(path.join(dir, 'playbook.json'))).toBe(true)
    help.shutdown()
  })

  it('a copy of the current built-in is left alone', () => {
    const { help } = setUp(builtText)
    expect(help.playbookInfo).toMatchObject({ using: 'yours', version: 'm1-draft-3', newer_built_in: false, call_modes_from: 'yours' })
    help.shutdown()
  })

  it('the earlier built-in fingerprints are the m1-draft-1 and m1-draft-2 files as they shipped', () => {
    expect(playbookFingerprint(JSON.stringify(m1Draft1()))).toBe('242186ec247fd3f77036830782fd5407ece10bdf5cae25c451ed4dd91538135a')
    expect(playbookFingerprint(JSON.stringify(m1Draft2()))).toBe('5497ddaa898a14e17387b30c16ae25aa25356819c3eb5a66a38df78ee34ffcb3')
  })
})
