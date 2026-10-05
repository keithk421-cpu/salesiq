/**
 * Approved knowledge pack (M1): local Markdown/text files in the user's knowledge folder,
 * indexed with SQLite FTS5 + aliases + tags. No embeddings.
 *
 * Importing is NOT approval. A document counts as approved only if Keith approved it
 * (front matter `approved: true`, or approval recorded in the app for that exact version).
 * Only approved, non-stale chunks are offered to HELP as facts. Stale ones are surfaced by
 * title only ("exists but is past its review date") so HELP offers to confirm instead of asserting.
 *
 * Front matter (optional, between --- lines at the top):
 *   title, category (product|deployment_security|competitive|objection_handling|other), source,
 *   version, approved (true|false), approved_by, approved_at, review_by (YYYY-MM-DD),
 *   applies_to (comma list), tags (comma list)
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { KnowledgeCategory, KnowledgeChunk, KnowledgeDocMeta } from '../shared/help'
import { Db, ftsQuery, ftsTerms } from './db'

const CATEGORIES: KnowledgeCategory[] = ['product', 'deployment_security', 'competitive', 'objection_handling', 'other']
const MAX_CHUNK_CHARS = 900
/** Ranking boost per query term that matches one of the document's tags (max two counted). */
const TAG_BOOST = 0.05

export function loadAliases(file: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { groups?: string[][] }
    for (const g of raw.groups ?? []) {
      const lower = g.map((x) => x.toLowerCase())
      for (const term of lower) map.set(term, lower.filter((x) => x !== term))
    }
  } catch {
    /* no aliases is fine */
  }
  return map
}

export function parseFrontMatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { meta: {}, body: src }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return { meta, body: src.slice(m[0].length) }
}

const list = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])

export function docMetaFrom(file: string, meta: Record<string, string>, body: string): KnowledgeDocMeta {
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1]
  const category = (CATEGORIES as string[]).includes(meta.category ?? '') ? (meta.category as KnowledgeCategory) : 'other'
  const version = meta.version || createHash('sha1').update(body).digest('hex').slice(0, 10)
  return {
    doc_id: path.basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title: meta.title || firstHeading || path.basename(file),
    category,
    source: meta.source || path.basename(file),
    version,
    approved: meta.approved === 'true',
    approved_by: meta.approved_by || null,
    approved_at: meta.approved_at || null,
    review_by: meta.review_by || null,
    applies_to: list(meta.applies_to),
    tags: list(meta.tags),
    file,
  }
}

/** Split by headings, then paragraphs, keeping chunks under MAX_CHUNK_CHARS. */
export function chunkBody(body: string): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = []
  let heading = ''
  let buf = ''
  const flush = () => {
    const t = buf.trim()
    if (t) out.push({ heading, text: t })
    buf = ''
  }
  for (const para of body.split(/\n\s*\n/)) {
    const h = /^#{1,6}\s+(.+)$/m.exec(para.trim())
    if (h && para.trim().startsWith('#')) {
      flush()
      heading = h[1].trim()
      const rest = para.trim().split('\n').slice(1).join('\n').trim()
      if (rest) buf = rest
      continue
    }
    if (buf.length + para.length > MAX_CHUNK_CHARS) flush()
    buf += (buf ? '\n\n' : '') + para.trim()
    while (buf.length > MAX_CHUNK_CHARS * 1.5) {
      out.push({ heading, text: buf.slice(0, MAX_CHUNK_CHARS) })
      buf = buf.slice(MAX_CHUNK_CHARS)
    }
  }
  flush()
  return out
}

export function isStale(meta: KnowledgeDocMeta, today = new Date()): boolean {
  if (!meta.review_by) return false
  const d = new Date(meta.review_by)
  return !Number.isNaN(d.getTime()) && d.getTime() < today.getTime()
}

export class KnowledgeBase {
  private aliases: Map<string, string[]>

  constructor(private readonly db: Db, aliasesFile: string | null) {
    this.aliases = aliasesFile ? loadAliases(aliasesFile) : new Map()
    db.sql.exec(`CREATE TABLE IF NOT EXISTS knowledge_approvals (
      doc_id TEXT NOT NULL, version TEXT NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY (doc_id, version))`)
  }

  get aliasMap(): Map<string, string[]> {
    return this.aliases
  }

  /** (Re)index every .md/.txt file in the folder. Returns doc metadata for display. */
  indexFolder(folder: string): KnowledgeDocMeta[] {
    fs.mkdirSync(folder, { recursive: true })
    const files = fs.readdirSync(folder).filter((f) => /\.(md|txt)$/i.test(f) && !f.startsWith('_') && f.toLowerCase() !== 'readme.md')
    const docs: KnowledgeDocMeta[] = []
    this.db.tx(() => {
      this.db.sql.exec('DELETE FROM knowledge_chunks; DELETE FROM knowledge_fts; DELETE FROM knowledge_docs;')
      for (const f of files) {
        const full = path.join(folder, f)
        const src = fs.readFileSync(full, 'utf8')
        const { meta, body } = parseFrontMatter(src)
        const doc = docMetaFrom(full, meta, body)
        this.addDoc(doc, body, fs.statSync(full).mtimeMs)
        docs.push(doc)
      }
    })
    return docs.map((d) => this.withApproval(d))
  }

  /** Index one document (used by indexFolder and tests). */
  addDoc(doc: KnowledgeDocMeta, body: string, mtimeMs = 0): void {
    this.db.sql.prepare('INSERT OR REPLACE INTO knowledge_docs (doc_id, file, mtime_ms, meta_json) VALUES (?, ?, ?, ?)')
      .run(doc.doc_id, doc.file, Math.round(mtimeMs), JSON.stringify(doc))
    const ins = this.db.sql.prepare('INSERT INTO knowledge_chunks (chunk_id, doc_id, title, heading, text) VALUES (?, ?, ?, ?, ?)')
    const fts = this.db.sql.prepare('INSERT INTO knowledge_fts (text, title, heading, chunk_id, doc_id) VALUES (?, ?, ?, ?, ?)')
    chunkBody(body).forEach((c, i) => {
      const id = `k:${doc.doc_id}#${i + 1}`
      ins.run(id, doc.doc_id, doc.title, c.heading, c.text)
      fts.run(c.text, doc.title, c.heading, id, doc.doc_id)
    })
  }

  /** Keith approves the current version of a document in the app. A new version needs re-approval. */
  approve(docId: string, approved: boolean): void {
    const doc = this.getDoc(docId)
    if (!doc) return
    if (approved) {
      this.db.sql.prepare('INSERT OR REPLACE INTO knowledge_approvals (doc_id, version, approved_at) VALUES (?, ?, ?)')
        .run(docId, doc.version, new Date().toISOString())
    } else {
      this.db.sql.prepare('DELETE FROM knowledge_approvals WHERE doc_id = ?').run(docId)
    }
  }

  getDoc(docId: string): KnowledgeDocMeta | null {
    const row = this.db.sql.prepare('SELECT meta_json FROM knowledge_docs WHERE doc_id = ?').get(docId) as { meta_json: string } | undefined
    return row ? this.withApproval(JSON.parse(row.meta_json) as KnowledgeDocMeta) : null
  }

  listDocs(): KnowledgeDocMeta[] {
    const rows = this.db.sql.prepare('SELECT meta_json FROM knowledge_docs ORDER BY doc_id').all() as Array<{ meta_json: string }>
    return rows.map((r) => this.withApproval(JSON.parse(r.meta_json) as KnowledgeDocMeta))
  }

  private withApproval(d: KnowledgeDocMeta): KnowledgeDocMeta {
    if (d.approved) return d
    const row = this.db.sql.prepare('SELECT approved_at FROM knowledge_approvals WHERE doc_id = ? AND version = ?').get(d.doc_id, d.version) as
      | { approved_at: string }
      | undefined
    return row ? { ...d, approved: true, approved_by: d.approved_by ?? 'Keith (in app)', approved_at: row.approved_at } : d
  }

  /**
   * Search for chunks relevant to `text`. Returns approved+current chunks (usable as facts)
   * and the titles of approved-but-stale docs that matched (to prompt a follow-up, never a claim).
   * Unapproved documents are never returned.
   */
  search(text: string, limit = 4, today = new Date()): { usable: KnowledgeChunk[]; staleTitles: string[] } {
    const terms = ftsTerms(text, this.aliases)
    const q = ftsQuery(text, this.aliases)
    if (!q) return { usable: [], staleTitles: [] }
    let rows: Array<{ chunk_id: string; doc_id: string; title: string; heading: string; text: string; score: number }>
    try {
      // Tags are not indexed per chunk: repeating them in every chunk of a doc would make the most
      // telling words (a competitor's name, "HIPAA") look common and rank worse. They re-rank instead.
      rows = this.db.sql.prepare(
        `SELECT c.chunk_id, c.doc_id, c.title, c.heading, c.text, bm25(knowledge_fts, 1.0, 0.5, 2.5) AS score FROM knowledge_fts f
         JOIN knowledge_chunks c ON c.chunk_id = f.chunk_id
         WHERE knowledge_fts MATCH ? ORDER BY score LIMIT 30`,
      ).all(q) as typeof rows
    } catch {
      return { usable: [], staleTitles: [] }
    }
    const docs = new Map<string, KnowledgeDocMeta | null>()
    const docOf = (id: string) => {
      if (!docs.has(id)) docs.set(id, this.getDoc(id))
      return docs.get(id) ?? null
    }
    const tagHits = (meta: KnowledgeDocMeta | null) =>
      meta ? Math.min(2, terms.filter((t) => meta.tags.some((tag) => tag.toLowerCase() === t)).length) : 0
    // bm25 is negative (lower is better), so a boost multiplies it.
    rows = rows
      .map((r) => ({ ...r, score: r.score * (1 + TAG_BOOST * tagHits(docOf(r.doc_id))) }))
      .sort((a, b) => a.score - b.score)
    const usable: KnowledgeChunk[] = []
    const staleTitles = new Set<string>()
    for (const { score: _score, ...r } of rows) {
      const meta = docOf(r.doc_id)
      if (!meta || !meta.approved) continue
      const stale = isStale(meta, today)
      if (stale) {
        staleTitles.add(meta.title)
        continue
      }
      if (usable.length < limit) usable.push({ ...r, meta, stale })
    }
    return { usable, staleTitles: [...staleTitles] }
  }
}
