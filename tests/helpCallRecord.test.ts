import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HelpService } from '../src/main/helpService'
import { Storage } from '../src/main/storage'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const plainBox = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }

function service(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'))) {
  return { dir, help: new HelpService(new Storage(dir, plainBox), ROOT, () => {}, () => {}) }
}

/** Drive one call through the states the session controller emits. */
function runCall(help: HelpService, id: string, clock: () => number, until: 'live' | 'stopped' = 'stopped') {
  help.onSessionEvent({ type: 'state', state: 'checking', sessionId: id }, id, clock)
  help.onSessionEvent({ type: 'state', state: 'live', sessionId: id }, id, clock)
  if (until === 'live') return
  help.onSessionEvent({ type: 'state', state: 'stopping', sessionId: id }, id, clock)
  help.onSessionEvent({ type: 'state', state: 'stopped', sessionId: id }, id, clock)
}

const setupOf = (help: HelpService, id: string) =>
  JSON.parse((help.db.sql.prepare('SELECT setup_json FROM sessions WHERE id = ?').get(id) as { setup_json: string }).setup_json) as Record<string, unknown>

afterEach(() => vi.restoreAllMocks())

describe("a finished call's record", () => {
  it('keeps its account and deployment when the strip is edited for the next call', () => {
    const { help } = service()
    help.setSetup({ call_type: 'demo', call_goal: 'Show tracing', account: 'Northwind', deployment: 'saas' })
    runCall(help, 's-1', () => 0)
    // After Stop, Keith fills the strip for his next call before pressing Start.
    help.setSetup({ call_type: 'discovery', call_goal: 'Learn their stack', account: 'Fernhollow', deployment: 'self_hosted' })
    expect(setupOf(help, 's-1')).toMatchObject({ account: 'Northwind', deployment: 'saas', call_goal: 'Show tracing' })
    // The finished call is still there for labels and the after-call review.
    expect(help.setLabel({ cluster: 'e1:s0', role: 'buyer', name: 'Dana' }).ok).toBe(true)
    // The next call starts with what he typed.
    runCall(help, 's-2', () => 0, 'live')
    expect(setupOf(help, 's-2')).toMatchObject({ account: 'Fernhollow', deployment: 'self_hosted' })
    help.shutdown()
  })

  it('still takes mid-call edits while the call is paused', () => {
    const { help } = service()
    runCall(help, 's-1', () => 0, 'live')
    help.onSessionEvent({ type: 'state', state: 'paused', sessionId: 's-1' }, 's-1', () => 0)
    help.setSetup({ call_type: 'demo', account: 'Northwind Health', deployment: 'self_hosted' })
    expect(setupOf(help, 's-1')).toMatchObject({ account: 'Northwind Health', deployment: 'self_hosted' })
    help.shutdown()
  })
})

describe('after-call review reaches the scorecard', () => {
  it('rewrites the numbers-only scorecard as Keith rates the finished call, with no note text', () => {
    const { dir, help } = service()
    let t = 0
    runCall(help, 's-7', () => t, 'live')
    const ins = help.db.sql.prepare(
      "INSERT INTO help_requests (id, session_id, origin, created_at, at_session_ms, status, model_json, card_json, timing_json, prefetch) VALUES (?, 's-7', 'help_requested', 't', ?, 'complete', '{}', ?, '{}', 0)",
    )
    ins.run('c1', 30_000, JSON.stringify({ primary_kind: 'ask', primary: 'First line?', follow_up: null }))
    ins.run('c2', 90_000, JSON.stringify({ primary_kind: 'say', primary: 'Second line', follow_up: null }))
    t = 120_000
    help.onSessionEvent({ type: 'state', state: 'stopping', sessionId: 's-7' }, 's-7', () => t)
    help.onSessionEvent({ type: 'state', state: 'stopped', sessionId: 's-7' }, 's-7', () => t)
    const file = path.join(dir, 'reports', 'help-scorecard-s-7.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).feedback).toMatchObject({ useful: 0, bad: 0, used: 0, notes: 0 })
    // The review happens minutes later: the session clock keeps running, the call's length doesn't.
    t = 600_000
    for (const fb of [
      { card_id: 'c1', type: 'useful' }, { card_id: 'c1', type: 'used' }, { card_id: 'c1', type: 'note', note: 'Slower please, Dana talks fast' },
      { card_id: 'c2', type: 'bad', bad_reason: 'too_generic' },
    ]) expect(help.feedback(fb).ok).toBe(true)
    const text = fs.readFileSync(file, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ session_id: 's-7', call_minutes: 2, shown: 2, feedback: { useful: 1, bad: 1, bad_reasons: { too_generic: 1 }, used: 1, notes: 1 } })
    expect(text).not.toMatch(/Slower|Dana|First line|Second line/)
    help.shutdown()
  })

  it("feedback on a deleted call doesn't write a scorecard for it again", () => {
    const { dir, help } = service()
    runCall(help, 's-8', () => 0)
    const file = path.join(dir, 'reports', 'help-scorecard-s-8.json')
    fs.rmSync(file)
    help.forgetCall('s-8')
    help.feedback({ card_id: 'gone', type: 'useful' })
    expect(fs.existsSync(file)).toBe(false)
    help.shutdown()
  })
})

describe('quitting or crashing without Stop', () => {
  it('quitting mid-call writes the scorecard and starts the next launch clean (call type kept)', () => {
    const first = service()
    first.help.setSetup({ call_type: 'demo', call_goal: 'Show tracing', desired_outcomes: ['next step'], account: 'Northwind', deployment: 'saas' })
    runCall(first.help, 's-3', () => 90_000, 'live')
    first.help.shutdown()
    expect(JSON.parse(fs.readFileSync(path.join(first.dir, 'reports', 'help-scorecard-s-3.json'), 'utf8'))).toMatchObject({ session_id: 's-3', call_minutes: 1.5 })
    const next = service(first.dir)
    expect(next.help.info().setup).toEqual({ call_type: 'demo', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' })
    next.help.shutdown()
  })

  it('after a crash, the next launch keeps only the call type from the saved strip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'))
    fs.writeFileSync(path.join(dir, 'call-setup.json'), JSON.stringify({ call_type: 'negotiation', call_goal: 'Close', desired_outcomes: ['signed'], account: 'Northwind', deployment: 'saas' }))
    const { help } = service(dir)
    expect(help.info().setup).toEqual({ call_type: 'negotiation', call_goal: '', desired_outcomes: [], account: '', deployment: 'unknown' })
    help.shutdown()
  })

  it('quitting with no call running writes nothing', () => {
    const { dir, help } = service()
    help.shutdown()
    expect(fs.existsSync(path.join(dir, 'reports'))).toBe(false)
  })
})

describe('switching to the built-in playbook on Windows', () => {
  const stamp = new Date('2026-10-05T12:00:00Z')
  const busy = (code: string) => () => { throw Object.assign(new Error(`${code}: operation not permitted`), { code }) }

  it('falls back to copy + delete when Windows refuses the rename', () => {
    const { dir, help } = service()
    const mine = help.playbookPath()
    vi.spyOn(fs, 'renameSync').mockImplementation(busy('EPERM'))
    expect(help.useBuiltInPlaybook(stamp)).toMatchObject({ using: 'built_in', error: null })
    expect(fs.existsSync(mine)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'playbook-yours-2026-10-05-12-00-00.json'))).toBe(true)
    help.shutdown()
  })

  it("says plainly when the file is held open, and leaves Keith's copy in use with no stray backup", () => {
    const { dir, help } = service()
    const mine = help.playbookPath()
    vi.spyOn(fs, 'renameSync').mockImplementation(busy('EBUSY'))
    const unlink = fs.unlinkSync
    vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => (String(p) === mine ? busy('EBUSY')() : unlink(p)))
    expect(help.useBuiltInPlaybook(stamp)).toMatchObject({ using: 'yours', error: "Couldn't switch: close the playbook file and try again." })
    expect(fs.existsSync(mine)).toBe(true)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('playbook-yours-'))).toEqual([])
    help.shutdown()
  })
})
