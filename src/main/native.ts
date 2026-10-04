/**
 * Loads the Windows native audio module. On non-Windows (development only) a
 * clearly labelled synthetic DEMO module is used instead; it never ships.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { NativeAudioModule } from '../shared/nativeApi'
import { MockNative } from './mockNative'

export interface LoadedNative {
  module: NativeAudioModule
  demo: boolean
  source: string
}

export function loadNative(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): LoadedNative {
  if (process.platform !== 'win32') {
    // Dev only: SALES_COPILOT_DEMO_PCM=<16 kHz mono s16le file> plays real speech as the remote stream.
    let demoRemotePcm: Buffer | undefined
    try {
      if (process.env.SALES_COPILOT_DEMO_PCM) demoRemotePcm = fs.readFileSync(process.env.SALES_COPILOT_DEMO_PCM)
    } catch {
      demoRemotePcm = undefined
    }
    return { module: new MockNative({ autoGenerate: true, demoRemotePcm }), demo: true, source: 'demo (not Windows)' }
  }
  const candidates = opts.isPackaged
    ? [path.join(opts.resourcesPath, 'sales-copilot-audio.node')]
    : [path.join(opts.appPath, 'native', 'windows-audio', 'sales-copilot-audio.win32-x64-msvc.node')]
  const errors: string[] = []
  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(p) as NativeAudioModule
      return { module: mod, demo: false, source: p }
    } catch (err) {
      errors.push(`${p}: ${(err as Error).message}`)
    }
  }
  throw new Error(`Windows audio module failed to load. ${errors.join(' | ')}`)
}
