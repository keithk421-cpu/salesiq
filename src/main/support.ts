/**
 * "Save support files": copies only files that never contain conversation text or keys into a new
 * folder Keith can zip and send. Allowlist, not blocklist: anything not named here stays behind
 * (copilot.db, transcript.jsonl, call-setup.json, keys, knowledge files, practice/ moments saved
 * from real calls). Feedback exports go to Downloads, never to the data folder.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Report names marking a speed test run on Keith's saved moments (real call text). */
export const HOLDS_CALL_TEXT = /-mine\b/i

export function saveSupportFiles(root: string, outParent: string, now = new Date()): { dir: string; files: string[]; skipped: string[] } {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const dir = path.join(outParent, `SalesCopilot-support-${stamp}`)
  const files: string[] = []
  const skipped: string[] = []
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'README.txt'),
    'Sales Copilot support files: logs, timings, counts, speed-test reports and scorecards.\r\n' +
      'No conversation text, no call notes, no API keys. Safe to zip and send.\r\n',
  )
  // One file that can't be read (locked, removed mid-copy) is noted and skipped, not fatal.
  const realRoot = (() => {
    try {
      return fs.realpathSync(root)
    } catch {
      return root
    }
  })()
  const copy = (src: string, name: string) => {
    try {
      // A link is never followed: an allowlisted name can't pull in a conversation file.
      if (!fs.existsSync(src) || !fs.lstatSync(src).isFile()) return
      if (!fs.realpathSync(src).startsWith(realRoot + path.sep)) return
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.copyFileSync(src, path.join(dir, name))
      files.push(name)
    } catch {
      skipped.push(name)
    }
  }
  const list = (d: string) => {
    try {
      return fs.existsSync(d) ? fs.readdirSync(d) : []
    } catch {
      return []
    }
  }

  // App log and device snapshots: timings, device names, counts and error codes only (tested to carry no transcript).
  for (const f of list(path.join(root, 'logs'))) if (f.endsWith('.jsonl')) copy(path.join(root, 'logs', f), path.join('logs', f))
  for (const f of list(path.join(root, 'logs', 'device-snapshots'))) if (f.endsWith('.json')) copy(path.join(root, 'logs', 'device-snapshots', f), path.join('logs', 'device-snapshots', f))
  // Per call: diagnostics and counters only, never transcript.jsonl.
  for (const s of list(path.join(root, 'sessions'))) {
    for (const f of ['diagnostics.jsonl', 'summary.json']) copy(path.join(root, 'sessions', s, f), path.join('sessions', s, f))
  }
  // HELP speed-test reports (built-in, made-up scenarios) and numbers-only scorecards. A speed test
  // that included Keith's saved moments replayed real calls: its report ("-mine") stays behind.
  for (const f of list(path.join(root, 'reports'))) {
    if (/\.(json|md)$/.test(f) && !HOLDS_CALL_TEXT.test(f)) copy(path.join(root, 'reports', f), path.join('reports', f))
  }
  // Settings without secrets.
  copy(path.join(root, 'help-settings.json'), 'help-settings.json')
  copy(path.join(root, 'app-settings.json'), 'app-settings.json')
  if (skipped.length) fs.appendFileSync(path.join(dir, 'README.txt'), `Could not copy: ${skipped.join(', ')}\r\n`)
  return { dir, files, skipped }
}
