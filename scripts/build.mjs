// Bundles main, preload and renderer into dist/.
import { build } from 'esbuild'
import fs from 'node:fs'

fs.rmSync('dist', { recursive: true, force: true })
fs.mkdirSync('dist/renderer', { recursive: true })

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' }
await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'bufferutil', 'utf-8-validate', '*.node'] })
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] })
await build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' })
fs.copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
fs.copyFileSync('src/renderer/styles.css', 'dist/renderer/styles.css')
console.log('build ok')
