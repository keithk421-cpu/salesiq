/**
 * Approved knowledge pack (M1): local Markdown/text files in the user's knowledge folder,
 * indexed with SQLite FTS5 + aliases + tags. No embeddings.
 *
 * Importing is NOT approval. A document counts as approved only if Keith approved it in the app,
 * and the approval is bound to the exact content he reviewed: a hash of the body plus the material
 * front matter (title, category, source, version, review_by, applies_to, tags). Any edit, including
 * one that keeps the same readable version, needs approval again. `approved: true` written in a file
 * does not approve it, so no tool or import can approve on Keith's behalf; revoking in the app always wins.
 *
 * Only approved, non-stale chunks in scope for the call's deployment are offered to HELP as facts.
 * Stale ones are surfaced by title only ("exists but is past its review date"), and ones scoped to
 * another deployment are named so HELP offers to check instead of asserting.
 *
 * Each "## " section is one or more chunks of claim text (at most KNOWLEDGE_TEXT_MAX characters,
 * all of which the model receives) plus the section's "Source:" paragraph, kept whole and separate.
 *
 * Front matter (optional, between --- lines at the top):
 *   title, category (product|deployment_security|competitive|objection_handling|other), source,
 *   version, review_by (YYYY-MM-DD), applies_to (saas | self_hosted | all), tags (comma list)
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Deployment, KnowledgeCategory, KnowledgeChunk, KnowledgeDocMeta } from '../shared/help'
import { Db, ftsQuery, ftsTerms } from './db'

const CATEGORIES: KnowledgeCategory[] = ['product', 'deployment_security', 'competitive', 'objection_handling', 'other']
/** The model receives every character of a chunk's text, so the chunker and the prompt share this limit. */
export const KNOWLEDGE_TEXT_MAX = 700
/** Ranking boost per query term that matches one of the document's tags (max two counted). */
const TAG_BOOST = 0.05
const SOURCE_PARA = /^source\s*:/i

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

type Material = Pick<KnowledgeDocMeta, 'title' | 'category' | 'source' | 'version' | 'review_by' | 'applies_to' | 'tags'>

/** Identity of the reviewed content: body plus everything in the front matter that changes meaning or scope. */
export function contentHash(m: Material, body: string): string {
  const material = { title: m.title, category: m.category, source: m.source, version: m.version, review_by: m.review_by, applies_to: m.applies_to, tags: m.tags }
  return createHash('sha256').update(JSON.stringify(material)).update('\n').update(body.replace(/\r\n/g, '\n')).digest('hex')
}

export function docMetaFrom(file: string, meta: Record<string, string>, body: string): KnowledgeDocMeta {
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1]
  const category = (CATEGORIES as string[]).includes(meta.category ?? '') ? (meta.category as KnowledgeCategory) : 'other'
  const material: Material = {
    title: meta.title || firstHeading || path.basename(file),
    category,
    source: meta.source || path.basename(file),
    version: meta.version || createHash('sha1').update(body).digest('hex').slice(0, 10),
    review_by: meta.review_by || null,
    applies_to: list(meta.applies_to).map((x) => x.toLowerCase()),
    tags: list(meta.tags),
  }
  return {
    doc_id: path.basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    ...material,
    content_hash: contentHash(material, body),
    // Approval lives in the app only (see the header); whatever the file says is ignored.
    approved: false,
    needs_reapproval: false,
    approved_by: null,
    approved_at: null,
    file,
  }
}

/** Split one paragraph that is longer than the limit at sentence ends, then at spaces. */
function splitLong(p: string, max: number): string[] {
  if (p.length <= max) return [p]
  const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p]
  const out: string[] = []
  let cur = ''
  for (let s of sentences) {
    while (s.length > max) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      const cut = s.lastIndexOf(' ', max)
      const at = cut > max / 2 ? cut : max
      out.push(s.slice(0, at).trim())
      s = s.slice(at)
    }
    if ((cur + s).trim().length > max) {
      out.push(cur.trim())
      cur = s
    } else cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * Split by headings into sections. Each section's "Source:" paragraph becomes its source_ref; the rest
 * is packed into chunks of whole paragraphs, none longer than KNOWLEDGE_TEXT_MAX.
 */
export function chunkBody(body: string, max = KNOWLEDGE_TEXT_MAX): Array<{ heading: string; text: string; source_ref: string }> {
  const out: Array<{ heading: string; text: string; source_ref: string }> = []
  let heading = ''
  let paras: string[] = []
  const flushSection = () => {
    const source_ref = paras.filter((p) => SOURCE_PARA.test(p)).join(' ')
    let buf = ''
    for (const p of paras.filter((x) => !SOURCE_PARA.test(x)).flatMap((x) => splitLong(x, max))) {
      if (buf && buf.length + 2 + p.length > max) {
        out.push({ heading, text: buf, source_ref })
        buf = ''
      }
      buf = buf ? `${buf}\n\n${p}` : p
    }
    if (buf) out.push({ heading, text: buf, source_ref })
    paras = []
  }
  for (const raw of body.split(/\n\s*\n/)) {
    const para = raw.trim()
    if (!para) continue
    if (/^#{1,6}\s+\S/.test(para)) {
      flushSection()
      const lines = para.split('\n')
      heading = lines[0].replace(/^#{1,6}\s+/, '').trim()
      const rest = lines.slice(1).join('\n').trim()
      if (rest) paras.push(rest)
      continue
    }
    paras.push(para)
  }
  flushSection()
  return out
}

export function isStale(meta: KnowledgeDocMeta, today = new Date()): boolean {
  if (!meta.review_by) return false
  const d = new Date(meta.review_by)
  return !Number.isNaN(d.getTime()) && d.getTime() < today.getTime()
}

/** A document with no scope, or scope "all", applies everywhere; otherwise it must name the deployment. */
export function inScope(meta: KnowledgeDocMeta, deployment: Deployment): boolean {
  if (deployment === 'unknown' || meta.applies_to.length === 0 || meta.applies_to.includes('all')) return true
  return meta.applies_to.includes(deployment)
}

type Row = { chunk_id: string; doc_id: string; title: string; heading: string; text: string; source_ref: string; score: number }

export interface KnowledgeSearch {
  /** Approved, current, in-scope chunks: the only material HELP may state as fact. */
  usable: KnowledgeChunk[]
  /** Approved documents that matched but are past their review date. */
  staleTitles: string[]
  /** Approved documents that matched but cover another deployment than this call's. */
  scopedOut: Array<{ title: string; applies_to: string[] }>
}

export class KnowledgeBase {
  private aliases: Map<string, string[]>

  constructor(private readonly db: Db, aliasesFile: string | null) {
    this.aliases = aliasesFile ? loadAliases(aliasesFile) : new Map()
    // One row per (document, exact content) Keith decided on. The pre-hash table (keyed by the readable
    // version) is no longer read, so earlier approvals do not carry over to unreviewed content.
    db.sql.exec(`CREATE TABLE IF NOT EXISTS knowledge_decisions (
      doc_id TEXT NOT NULL, content_hash TEXT NOT NULL, approved INTEGER NOT NULL, decided_at TEXT NOT NULL,
      PRIMARY KEY (doc_id, content_hash))`)
  }

  get aliasMap(): Map<string, string[]> {
    return this.aliases
  }

  /** (Re)index every .md/.txt file in the folder (not subfolders). Returns doc metadata for display. */
  indexFolder(folder: string): KnowledgeDocMeta[] {
    fs.mkdirSync(folder, { recursive: true })
    const files = fs.readdirSync(folder).filter((f) => /\.(md|txt)$/i.test(f) && !f.startsWith('_') && f.toLowerCase() !== 'readme.md')
    this.db.tx(() => {
      this.db.sql.exec('DELETE FROM knowledge_chunks; DELETE FROM knowledge_fts; DELETE FROM knowledge_docs;')
      for (const f of files) {
        const full = path.join(folder, f)
        if (!fs.statSync(full).isFile()) continue
        const { meta, body } = parseFrontMatter(fs.readFileSync(full, 'utf8'))
        this.addDoc(docMetaFrom(full, meta, body), body, fs.statSync(full).mtimeMs)
      }
    })
    return this.listDocs()
  }

  /** Index one document (used by indexFolder, replay and tests). The content hash is always recomputed here. */
  addDoc(doc: KnowledgeDocMeta, body: string, mtimeMs = 0): void {
    const stored: KnowledgeDocMeta = { ...doc, content_hash: contentHash(doc, body), approved: false, needs_reapproval: false, approved_by: null, approved_at: null }
    this.db.sql.prepare('INSERT OR REPLACE INTO knowledge_docs (doc_id, file, mtime_ms, meta_json) VALUES (?, ?, ?, ?)')
      .run(doc.doc_id, doc.file, Math.round(mtimeMs), JSON.stringify(stored))
    const ins = this.db.sql.prepare('INSERT INTO knowledge_chunks (chunk_id, doc_id, title, heading, text, source_ref) VALUES (?, ?, ?, ?, ?, ?)')
    const fts = this.db.sql.prepare('INSERT INTO knowledge_fts (text, title, heading, chunk_id, doc_id) VALUES (?, ?, ?, ?, ?)')
    chunkBody(body).forEach((c, i) => {
      const id = `k:${doc.doc_id}#${i + 1}`
      ins.run(id, doc.doc_id, doc.title, c.heading, c.text, c.source_ref)
      fts.run(c.text, doc.title, c.heading, id, doc.doc_id)
    })
  }

  /** Keith approves or revokes the document's current content in the app. Any later edit needs approval again. */
  approve(docId: string, approved: boolean): void {
    const doc = this.getDoc(docId)
    if (!doc) return
    this.db.sql.prepare('INSERT OR REPLACE INTO knowledge_decisions (doc_id, content_hash, approved, decided_at) VALUES (?, ?, ?, ?)')
      .run(docId, doc.content_hash, approved ? 1 : 0, new Date().toISOString())
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
    const decisions = this.db.sql.prepare('SELECT content_hash, approved, decided_at FROM knowledge_decisions WHERE doc_id = ?').all(d.doc_id) as Array<{
      content_hash: string
      approved: number
      decided_at: string
    }>
    const current = decisions.find((x) => x.content_hash === d.content_hash)
    const approved = current?.approved === 1
    return {
      ...d,
      approved,
      approved_by: approved ? 'Keith (in app)' : null,
      approved_at: approved ? current!.decided_at : null,
      needs_reapproval: !current && decisions.some((x) => x.approved === 1),
    }
  }

  /**
   * Search for chunks relevant to `text`. Only approved documents are searched at all (so unapproved
   * matches can never crowd out an approved answer). Returns approved, current, in-scope chunks
   * (usable as facts), plus the titles of approved documents that matched but are stale or scoped to
   * another deployment (to prompt a follow-up, never a claim).
   */
  search(text: string, limit = 4, today = new Date(), deployment: Deployment = 'unknown'): KnowledgeSearch {
    const none: KnowledgeSearch = { usable: [], staleTitles: [], scopedOut: [] }
    const terms = ftsTerms(text, this.aliases)
    const q = ftsQuery(text, this.aliases)
    if (!q) return none
    const approved = this.listDocs().filter((d) => d.approved)
    if (!approved.length) return none
    const byId = new Map(approved.map((d) => [d.doc_id, d]))
    const query = (ids: string[], max: number): Row[] => {
      if (!ids.length) return []
      try {
        // Tags are not indexed per chunk: repeating them in every chunk of a doc would make the most
        // telling words (a competitor's name, "HIPAA") look common and rank worse. They re-rank instead.
        return this.db.sql.prepare(
          `SELECT c.chunk_id, c.doc_id, c.title, c.heading, c.text, c.source_ref, bm25(knowledge_fts, 1.0, 0.5, 2.5) AS score FROM knowledge_fts f
           JOIN knowledge_chunks c ON c.chunk_id = f.chunk_id
           WHERE knowledge_fts MATCH ? AND f.doc_id IN (SELECT value FROM json_each(?)) ORDER BY score LIMIT ?`,
        ).all(q, JSON.stringify(ids), max) as Row[]
      } catch {
        return []
      }
    }
    const tagHits = (meta: KnowledgeDocMeta) => Math.min(2, terms.filter((t) => meta.tags.some((tag) => tag.toLowerCase() === t)).length)
    // bm25 is negative (lower is better), so a boost multiplies it.
    const rows = query(approved.filter((d) => inScope(d, deployment)).map((d) => d.doc_id), 30)
      .map((r) => ({ ...r, score: r.score * (1 + TAG_BOOST * tagHits(byId.get(r.doc_id)!)) }))
      .sort((a, b) => a.score - b.score)
    const usable: KnowledgeChunk[] = []
    const staleTitles = new Set<string>()
    for (const { score: _score, ...r } of rows) {
      const meta = byId.get(r.doc_id)!
      if (isStale(meta, today)) {
        staleTitles.add(meta.title)
        continue
      }
      if (usable.length < limit) usable.push({ ...r, meta, stale: false })
    }
    const scopedOut = new Map<string, string[]>()
    for (const r of query(approved.filter((d) => !inScope(d, deployment)).map((d) => d.doc_id), 3)) {
      const meta = byId.get(r.doc_id)!
      scopedOut.set(meta.title, meta.applies_to)
    }
    return { usable, staleTitles: [...staleTitles], scopedOut: [...scopedOut].map(([title, applies_to]) => ({ title, applies_to })) }
  }
}
