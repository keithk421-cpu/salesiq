// Windows CI smoke test for the native module: loads it, enumerates (read-only), and checks
// that opening an unknown endpoint ID fails cleanly instead of falling back to a default device.
const path = require('node:path')
const mod = require(path.resolve('native/windows-audio/sales-copilot-audio.win32-x64-msvc.node'))
const fns = ['listEndpoints', 'getEndpointState', 'startCapture', 'stopCapture', 'stopAll', 'isCapturing', 'monotonicNowMs']
for (const f of fns) if (typeof mod[f] !== 'function') throw new Error(`missing export ${f}`)
const eps = mod.listEndpoints()
console.log(`endpoints: ${eps.length}`)
for (const e of eps) console.log(`  [${e.flow}] ${e.state} ${e.friendlyName} default=${e.isDefaultConsole}`)
const bogus = '{0.0.1.00000000}.{00000000-0000-0000-0000-000000000000}'
const st = mod.getEndpointState(bogus)
if (st !== 'missing') throw new Error(`expected missing, got ${st}`)
const r = mod.startCapture('local_mic', bogus, () => {})
console.log('start on unknown id:', JSON.stringify(r))
if (r.ok || r.code !== 'device_not_found') throw new Error('unknown endpoint must fail with device_not_found and never fall back')
if (mod.isCapturing('local_mic') || mod.isCapturing('system_remote')) throw new Error('nothing should be capturing')
const t1 = mod.monotonicNowMs()
if (!(t1 > 0)) throw new Error('monotonic clock')
mod.stopAll()
console.log('native smoke OK')
