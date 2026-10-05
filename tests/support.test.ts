import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveSupportFiles } from '../src/main/support'

describe('Save support files', () => {
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
})
