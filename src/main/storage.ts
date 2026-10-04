/** Local-only persistence: device config, Deepgram key (OS-encrypted), session records. */
import fs from 'node:fs'
import path from 'node:path'
import type { AudioEndpointConfig } from '../shared/contracts'

export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export class Storage {
  constructor(private readonly dir: string, private readonly box: SecretBox) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private p(name: string): string {
    return path.join(this.dir, name)
  }

  loadConfig(): AudioEndpointConfig | null {
    try {
      return JSON.parse(fs.readFileSync(this.p('audio-endpoints.json'), 'utf8')) as AudioEndpointConfig
    } catch {
      return null
    }
  }

  saveConfig(c: AudioEndpointConfig): void {
    const tmp = this.p('audio-endpoints.json.tmp')
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2))
    fs.renameSync(tmp, this.p('audio-endpoints.json'))
  }

  /**
   * Secrets are stored encrypted with the OS (Windows DPAPI via safeStorage) in userData.
   * Env vars are for development only. Secrets never go to the renderer, logs or Git.
   */
  loadSecret(name: 'deepgram' | 'anthropic'): string {
    const env = name === 'deepgram' ? process.env.DEEPGRAM_API_KEY : process.env.SALES_COPILOT_ANTHROPIC_KEY
    if (env) return env
    try {
      const raw = fs.readFileSync(this.p(`${name}-key.bin`))
      return this.box.isEncryptionAvailable() ? this.box.decryptString(raw) : ''
    } catch {
      return ''
    }
  }

  saveSecret(name: 'deepgram' | 'anthropic', key: string): void {
    if (!this.box.isEncryptionAvailable()) throw new Error('OS encryption unavailable; key not saved')
    fs.writeFileSync(this.p(`${name}-key.bin`), this.box.encryptString(key.trim()))
  }

  loadApiKey(): string {
    return this.loadSecret('deepgram')
  }

  saveApiKey(key: string): void {
    this.saveSecret('deepgram', key)
  }

  readJson<T>(name: string, fallback: T): T {
    try {
      return { ...fallback, ...(JSON.parse(fs.readFileSync(this.p(name), 'utf8')) as T) }
    } catch {
      return fallback
    }
  }

  writeJson(name: string, value: unknown): void {
    fs.writeFileSync(this.p(name), JSON.stringify(value, null, 2))
  }

  get root(): string {
    return this.dir
  }

  sessionDir(sessionId: string): string {
    const d = path.join(this.dir, 'sessions', sessionId)
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  logsDir(): string {
    const d = path.join(this.dir, 'logs')
    fs.mkdirSync(d, { recursive: true })
    return d
  }
}

/** Append-only JSONL writer. */
export class JsonlWriter {
  private fd: number
  constructor(file: string) {
    this.fd = fs.openSync(file, 'a')
  }
  write(obj: Record<string, unknown>): void {
    try {
      fs.writeSync(this.fd, `${JSON.stringify({ at: new Date().toISOString(), ...obj })}\n`)
    } catch {
      /* never let logging break capture */
    }
  }
  close(): void {
    try { fs.closeSync(this.fd) } catch { /* ignore */ }
  }
}
