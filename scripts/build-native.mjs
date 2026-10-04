// Builds the Rust/NAPI Windows audio module and places the .node where the app and installer expect it.
// Fails loudly if the output is missing (Raven shipped a Windows build without its audio module once).
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dir = 'native/windows-audio'
if (process.platform !== 'win32') {
  console.log('build-native: not Windows; running cargo check for the msvc target only.')
  execSync('cargo check --target x86_64-pc-windows-msvc', { cwd: dir, stdio: 'inherit' })
  process.exit(0)
}
execSync('cargo build --release', { cwd: dir, stdio: 'inherit' })
const dll = path.join(dir, 'target', 'release', 'sales_copilot_audio.dll')
const out = path.join(dir, 'sales-copilot-audio.win32-x64-msvc.node')
if (!fs.existsSync(dll)) {
  console.error(`build-native: expected ${dll} after cargo build`)
  process.exit(1)
}
fs.copyFileSync(dll, out)
console.log(`build-native: wrote ${out} (${fs.statSync(out).size} bytes)`)
