import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveSupportFiles } from '../src/main/support'

describe('Save support files', () => {
  afterEach(() => vi.restoreAllMocks())

  it('copies logs, per-call diagnostics, reports and safe settings; never conversations, call notes or keys', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
    const put = (rel: string, body = 'x') => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), body)
    }
    put('logs/app.jsonl')
    put('logs/device-snapshots/before.json')
    put('sessions/s1/diagnostics.jsonl')
    put('sessions/s1/summary.json')
    put('sessions/s1/transcript.jsonl', 'BUYER SAID SECRET THINGS')
    put('reports/help-benchmark-1.json')
    put('copilot.db', 'FULL CONVERSATIONS')
    put('deepgram-key.bin')
    put('anthropic-key.bin')
    put('call-setup.json', '{"account":"Acme"}')
    put('help-settings.json')
    put('knowledge/core.md')
    const out = saveSupportFiles(root, fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), new Date('2026-10-05T12:00:00Z'))
    expect(out.files.map((f) => f.split(path.sep).join('/')).sort()).toEqual([
      'help-settings.json', 'logs/app.jsonl', 'logs/device-snapshots/before.json', 'reports/help-benchmark-1.json',
      'sessions/s1/diagnostics.jsonl', 'sessions/s1/summary.json',
    ])
    const all = fs.readdirSync(out.dir, { recursive: true }).map(String).join(' ')
    expect(all).not.toMatch(/transcript|copilot\.db|key\.bin|call-setup|knowledge/)
    expect(path.basename(out.dir)).toBe('SalesCopilot-support-2026-10-05-12-00-00')
  })

  it('leaves behind everything holding real call text: practice moments and speed-test reports that replayed them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
    const put = (rel: string, body = 'x') => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), body)
    }
    put('reports/help-benchmark-2026-10-05T12-00-00-000Z.json')
    put('reports/help-benchmark-2026-10-05T12-00-00-000Z.md')
    put('reports/help-scorecard-s-1.json')
    put('reports/help-benchmark-2026-10-05T13-00-00-000Z-mine.json', 'THE BUYER SAID REAL THINGS')
    put('reports/help-benchmark-2026-10-05T13-00-00-000Z-mine.md', 'THE BUYER SAID REAL THINGS')
    put('reports/help-benchmark-2026-10-05T14-00-00-000Z-MOCK-mine.json', 'THE BUYER SAID REAL THINGS')
    put('practice/real-20261005143210-a1b2c3d4.json', 'THE BUYER SAID REAL THINGS')
    put('SalesCopilot-feedback-2026-10-05.md', 'THE BUYER SAID REAL THINGS')
    const out = saveSupportFiles(root, fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')))
    expect(out.files.map((f) => f.split(path.sep).join('/')).sort()).toEqual([
      'reports/help-benchmark-2026-10-05T12-00-00-000Z.json', 'reports/help-benchmark-2026-10-05T12-00-00-000Z.md', 'reports/help-scorecard-s-1.json',
    ])
    const all = fs.readdirSync(out.dir, { recursive: true }).map((f) => path.join(out.dir, String(f))).filter((f) => fs.statSync(f).isFile())
    for (const f of all) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/BUYER/)
  })

  it('a file that cannot be copied (locked log) is skipped and noted, the rest is still saved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'logs', 'app.jsonl'), 'x')
    fs.writeFileSync(path.join(root, 'help-settings.json'), '{}')
    const real = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation((src, dest, mode) => {
      if (String(src).endsWith('app.jsonl')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return real(src, dest, mode)
    })
    const out = saveSupportFiles(root, fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')))
    expect(out.files).toEqual(['help-settings.json'])
    expect(out.skipped.map((f) => f.split(path.sep).join('/'))).toEqual(['logs/app.jsonl'])
    expect(fs.readFileSync(path.join(out.dir, 'README.txt'), 'utf8')).toMatch(/Could not copy: logs.app\.jsonl/)
  })

  it.skipIf(process.platform === 'win32')('never follows a link from an allowed name to a conversation file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
    fs.mkdirSync(path.join(root, 'sessions', 's1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'copilot.db'), 'FULL CONVERSATIONS')
    fs.writeFileSync(path.join(root, 'sessions', 's1', 'transcript.jsonl'), 'BUYER SECRET')
    fs.symlinkSync(path.join(root, 'copilot.db'), path.join(root, 'logs', 'x.jsonl'))
    fs.symlinkSync(path.join(root, 'sessions', 's1', 'transcript.jsonl'), path.join(root, 'sessions', 's1', 'summary.json'))
    const out = saveSupportFiles(root, fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')))
    expect(out.files).toEqual([])
    const all = fs.readdirSync(out.dir, { recursive: true }).map((f) => path.join(out.dir, String(f))).filter((f) => fs.statSync(f).isFile())
    for (const f of all) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/CONVERSATIONS|SECRET/)
  })
})
