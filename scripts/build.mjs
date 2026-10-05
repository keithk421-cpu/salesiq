// Bundles main, preload and renderer into dist/.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'

fs.rmSync('dist', { recursive: true, force: true })
fs.mkdirSync('dist/renderer', { recursive: true })

// Stamped into the app so every log, report and scorecard names the build that produced it.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
let sha = (process.env.GITHUB_SHA ?? '').slice(0, 7)
if (!sha) {
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    sha = 'dev'
  }
}
const buildInfo = { version: pkg.version, build: process.env.GITHUB_RUN_NUMBER ?? 'local', sha, date: new Date().toISOString().slice(0, 10) }
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022', define: { __BUILD_INFO__: JSON.stringify(buildInfo) } }
await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'bufferutil', 'utf-8-validate', '*.node'] })
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] })
await build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' })
fs.copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
fs.copyFileSync('src/renderer/styles.css', 'dist/renderer/styles.css')
console.log('build ok')
