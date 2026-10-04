// Read-only environment check. Never records audio, never changes settings, never prints secrets.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ok = (b) => (b ? 'OK ' : 'NO ')
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`)
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
console.log(`App ${pkg.version}; electron ${pkg.devDependencies.electron}`)
console.log(`${ok(fs.existsSync('dist/main.js'))} app bundle built (npm run build)`)
console.log(`${ok(!!process.env.DEEPGRAM_API_KEY)} DEEPGRAM_API_KEY env (optional; the app stores its key itself)`)
const nodeFile = path.resolve('native/windows-audio/sales-copilot-audio.win32-x64-msvc.node')
if (process.platform !== 'win32') {
  console.log('--  not Windows: native audio module is not loadable here (demo mode only)')
  process.exit(0)
}
console.log(`${ok(fs.existsSync(nodeFile))} native module present (npm run build:native)`)
try {
  const mod = require(nodeFile)
  const eps = mod.listEndpoints()
  console.log(`OK  native module loads; ${eps.length} endpoints:`)
  for (const e of eps) {
    const def = [e.isDefaultConsole && 'default', e.isDefaultCommunications && 'default-comms'].filter(Boolean).join(',')
    console.log(`    [${e.flow}] ${e.state.padEnd(10)} ${e.friendlyName}  ${def ? `(${def})` : ''}\n               id=${e.id}`)
  }
} catch (err) {
  console.log(`NO  native module failed to load: ${err.message}`)
  process.exitCode = 1
}
