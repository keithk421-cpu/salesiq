/**
 * Approved knowledge pack (M1): local Markdown/text files in the user's knowledge folder,
 * indexed with SQLite FTS5 + aliases + tags. No embeddings.
 *
 * Importing is NOT approval. A document counts as approved only if Keith approved it in the app,
 * and the approval is bound to the exact content he reviewed: a hash of the body plus the material
 * front matter (title, category, vendor when given, source, version, review_by, applies_to, tags). Any edit, including
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
 *   title, category (product|deployment_security|competitive|objection_handling|other), vendor (whose
 *   product it describes: arize, a competitor's name, neutral or mixed), source, version,
 *   review_by (YYYY-MM-DD), applies_to (saas | self_hosted | all), tags (comma list)
 *
 * A competitor's own documents are searched for HELP only when that competitor was named in the
 * words searched with (retrieval.ts passes the names said in the last 30 s): otherwise a question
 * about Arize ("Can you evaluate multi-turn conversations?") can bring back a competitor's section
 * worded the same way. Documents without a vendor are always searched.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Deployment, KnowledgeCategory, KnowledgeChunk, KnowledgeDocMeta } from '../shared/help'
import { isPastReview } from '../shared/dates'
import { Db, ftsAny, ftsConcepts, ftsQuery } from './db'

const CATEGORIES: KnowledgeCategory[] = ['product', 'deployment_security', 'competitive', 'objection_handling', 'other']
/** The model receives every character of a chunk's text, so the chunker and the prompt share this limit. */
export const KNOWLEDGE_TEXT_MAX = 700
/** Ranking boost per query term that matches one of the document's tags (max two counted). */
const TAG_BOOST = 0.05
/** Weight of the bm25 match strength next to the concept score (both scaled to 0-1 per search). */
const BM25_BLEND = 0.25
const SOURCE_PARA = /^source\s*:/i
/** Vendor values that are not a competitor: Arize's own products, guidance, or several products. */
const NOT_COMPETITOR = new Set(['arize', 'phoenix', 'neutral', 'mixed', 'unknown'])

/** The front matter's vendor, lower case with single spaces; undefined when the file doesn't say. */
export function normalizeVendor(v: string | undefined): string | undefined {
  const x = (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return x || undefined
}

/** A document about a competitor's product (its vendor is named and is not Arize, guidance or mixed). */
export function isCompetitor(meta: Pick<KnowledgeDocMeta, 'vendor'>): boolean {
  return !!meta.vendor && !NOT_COMPETITOR.has(meta.vendor)
}

/** A vendor's name as a word or phrase in any case and spacing ("langsmith", "new relic" in "NewRelic"). */
export function vendorPattern(name: string): RegExp {
  const words = name.split(/[\s-]+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('[\\s-]*')}(?![\\p{L}\\p{N}])`, 'iu')
}

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

type Material = Pick<KnowledgeDocMeta, 'title' | 'category' | 'vendor' | 'source' | 'version' | 'review_by' | 'applies_to' | 'tags'>

/**
 * Identity of the reviewed content: body plus everything in the front matter that changes meaning or
 * scope. The vendor counts only when the file names one, so documents approved before files had a
 * vendor line keep their approval.
 */
export function contentHash(m: Material, body: string): string {
  const vendor = normalizeVendor(m.vendor)
  const material = { title: m.title, category: m.category, ...(vendor ? { vendor } : {}), source: m.source, version: m.version, review_by: m.review_by, applies_to: m.applies_to, tags: m.tags }
  return createHash('sha256').update(JSON.stringify(material)).update('\n').update(body.replace(/\r\n/g, '\n')).digest('hex')
}

export function docMetaFrom(file: string, meta: Record<string, string>, body: string): KnowledgeDocMeta {
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1]
  const category = (CATEGORIES as string[]).includes(meta.category ?? '') ? (meta.category as KnowledgeCategory) : 'other'
  const material: Material = {
    title: meta.title || firstHeading || path.basename(file),
    category,
    vendor: normalizeVendor(meta.vendor),
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

/** Stale from local midnight after its review_by date (a calendar date on Keith's clock, not UTC). */
export function isStale(meta: KnowledgeDocMeta, today = new Date()): boolean {
  return isPastReview(meta.review_by, today)
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

/** A usable chunk with how it matched (for merging searches and judging a strong match). */
export interface RankedChunk extends KnowledgeChunk {
  /** The order search() uses: concept score scaled to the best candidate, plus the bm25 blend, times the tag boost. */
  rank: number
  /** Indexes into `concepts` of the spoken concepts this chunk mentions (text, title or heading). */
  matched: number[]
  /** The subset of `matched` that its section heading mentions. */
  in_heading: number[]
}

/** search() with the detail behind it: every usable chunk in rank order, and how common each spoken concept is. */
export interface RankedSearch extends Omit<KnowledgeSearch, 'usable'> {
  ranked: RankedChunk[]
  /** The spoken concepts (newest first), each with how many searchable sections mention it. */
  concepts: Array<{ terms: string[]; sections: number }>
  /** Sections (a document's "## " headings) in the documents searched. */
  sections: number
}

/** One section's place in the index: chunk ids "k:<doc>#<n>" sort by n, not as text (#10 comes after #2). */
const chunkNo = (id: string) => Number(/#(\d+)$/.exec(id)?.[1] ?? 0)
const sectionKey = (docId: string, heading: string) => `${docId}\n${heading}`

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
    const stored: KnowledgeDocMeta = { ...doc, vendor: normalizeVendor(doc.vendor), content_hash: contentHash(doc, body), approved: false, needs_reapproval: false, approved_by: null, approved_at: null }
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
   * Per chunk: sum over the concepts it mentions of ln(1 + N/df), x1.5 when the heading mentions it.
   * Also says which concepts each chunk matched (and in its heading), and how many sections mention each.
   */
  private conceptScorer(concepts: string[][], docIds: string[]): {
    score: (chunkId: string) => number
    matched: (chunkId: string) => { all: number[]; heading: number[] }
    sectionsPerConcept: number[]
    sections: number
  } {
    const score = new Map<string, number>()
    const matched = new Map<string, { all: number[]; heading: number[] }>()
    const sectionsPerConcept = concepts.map(() => 0)
    if (!docIds.length || !concepts.length) return { score: () => 0, matched: () => ({ all: [], heading: [] }), sectionsPerConcept, sections: 0 }
    const ids = JSON.stringify(docIds)
    const hits = (match: string): string[] => {
      try {
        return (this.db.sql.prepare('SELECT chunk_id FROM knowledge_fts WHERE knowledge_fts MATCH ? AND doc_id IN (SELECT value FROM json_each(?))').all(match, ids) as Array<{ chunk_id: string }>).map((r) => r.chunk_id)
      } catch {
        return []
      }
    }
    const chunks = this.db.sql.prepare('SELECT chunk_id, doc_id, heading FROM knowledge_chunks WHERE doc_id IN (SELECT value FROM json_each(?))').all(ids) as Array<{ chunk_id: string; doc_id: string; heading: string }>
    const n = chunks.length
    const sectionOf = new Map(chunks.map((c) => [c.chunk_id, sectionKey(c.doc_id, c.heading)]))
    concepts.forEach((c, i) => {
      const any = hits(ftsAny(c))
      if (!any.length) return
      sectionsPerConcept[i] = new Set(any.map((id) => sectionOf.get(id))).size
      const idf = Math.log(1 + n / any.length)
      const inHeading = new Set(hits(`heading : (${ftsAny(c)})`))
      for (const id of any) {
        score.set(id, (score.get(id) ?? 0) + idf * (inHeading.has(id) ? 1.5 : 1))
        const m = matched.get(id) ?? { all: [], heading: [] }
        m.all.push(i)
        if (inHeading.has(id)) m.heading.push(i)
        matched.set(id, m)
      }
    })
    return {
      score: (chunkId) => score.get(chunkId) ?? 0,
      matched: (chunkId) => matched.get(chunkId) ?? { all: [], heading: [] },
      sectionsPerConcept,
      sections: new Set(sectionOf.values()).size,
    }
  }

  /**
   * The competitors (vendor values of approved documents) named in the text, by their vendor name or an
   * alias from aliases.json ("lang smith" for "langsmith").
   */
  competitorsNamed(text: string): string[] {
    const vendors = new Set(this.listDocs().filter((d) => d.approved && isCompetitor(d)).map((d) => d.vendor!))
    return [...vendors].filter((v) => [v, ...(this.aliases.get(v) ?? [])].some((name) => vendorPattern(name).test(text)))
  }

  /** Every chunk of one section (a document's "## " heading), in order; the section's text is these joined. */
  sectionChunks(docId: string, heading: string): Array<{ chunk_id: string; text: string; source_ref: string }> {
    const rows = this.db.sql.prepare('SELECT chunk_id, text, source_ref FROM knowledge_chunks WHERE doc_id = ? AND heading = ?').all(docId, heading) as Array<{ chunk_id: string; text: string; source_ref: string }>
    return rows.sort((a, b) => chunkNo(a.chunk_id) - chunkNo(b.chunk_id))
  }

  /**
   * Search for chunks relevant to `text`. Only approved documents are searched at all (so unapproved
   * matches can never crowd out an approved answer). Returns approved, current, in-scope chunks
   * (usable as facts), plus the titles of approved documents that matched but are stale or scoped to
   * another deployment (to prompt a follow-up, never a claim).
   */
  search(text: string, limit = 4, today = new Date(), deployment: Deployment = 'unknown'): KnowledgeSearch {
    const r = this.searchRanked(text, today, deployment)
    const usable = r.ranked.slice(0, limit).map(({ rank: _rank, matched: _m, in_heading: _h, ...c }) => c)
    return { usable, staleTitles: r.staleTitles, scopedOut: r.scopedOut }
  }

  /**
   * search() with every usable chunk (not just the first few) and how each one matched. With
   * `everyApproved`, every approved document is ranked whatever its scope, and stale chunks stay in
   * the list marked `stale` (to judge whether the best match overall is one HELP may use). With
   * `competitorsNamed`, competitors' documents not in it are left out entirely.
   */
  searchRanked(text: string, today = new Date(), deployment: Deployment = 'unknown', opts: { everyApproved?: boolean; competitorsNamed?: string[] } = {}): RankedSearch {
    const none: RankedSearch = { ranked: [], staleTitles: [], scopedOut: [], concepts: [], sections: 0 }
    const concepts = ftsConcepts(text, this.aliases)
    const terms = concepts.flat()
    const q = ftsQuery(text, this.aliases)
    if (!q) return none
    // With `competitorsNamed`, a competitor's own documents are searched only if it is among them (see the header).
    const named = opts.competitorsNamed ? new Set(opts.competitorsNamed) : null
    const approved = this.listDocs().filter((d) => d.approved && (!named || !isCompetitor(d) || named.has(d.vendor!)))
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
    const inScopeIds = approved.filter((d) => opts.everyApproved || inScope(d, deployment)).map((d) => d.doc_id)
    const scorer = this.conceptScorer(concepts, inScopeIds)
    const conceptScore = scorer.score
    // Rank by what was said: each spoken word counts once with its aliases (so one word with many
    // synonyms can't outweigh a rarer, decisive one like a company name), rarer words count more,
    // a match in a section's heading counts extra; tags nudge; bm25 breaks ties.
    const candidates = query(inScopeIds, 30)
    const maxConcept = Math.max(1e-9, ...candidates.map((r) => conceptScore(r.chunk_id)))
    const maxBm25 = Math.max(1e-9, ...candidates.map((r) => -r.score))
    const rows = candidates
      .map((r) => ({ ...r, rank: (conceptScore(r.chunk_id) / maxConcept + BM25_BLEND * (-r.score / maxBm25)) * (1 + TAG_BOOST * tagHits(byId.get(r.doc_id)!)) }))
      .sort((a, b) => b.rank - a.rank || a.score - b.score)
    const ranked: RankedChunk[] = []
    const staleTitles = new Set<string>()
    for (const { score: _score, ...r } of rows) {
      const meta = byId.get(r.doc_id)!
      const stale = isStale(meta, today)
      if (stale) staleTitles.add(meta.title)
      if (stale && !opts.everyApproved) continue
      const m = scorer.matched(r.chunk_id)
      ranked.push({ ...r, meta, stale, matched: m.all, in_heading: m.heading })
    }
    const scopedOut = new Map<string, string[]>()
    for (const r of query(approved.filter((d) => !opts.everyApproved && !inScope(d, deployment)).map((d) => d.doc_id), 3)) {
      const meta = byId.get(r.doc_id)!
      scopedOut.set(meta.title, meta.applies_to)
    }
    return {
      ranked, staleTitles: [...staleTitles], scopedOut: [...scopedOut].map(([title, applies_to]) => ({ title, applies_to })),
      concepts: concepts.map((terms, i) => ({ terms, sections: scorer.sectionsPerConcept[i] })), sections: scorer.sections,
    }
  }
}

export interface KnowledgeImport {
  added: string[]
  skipped: Array<{ name: string; reason: string }>
}

/**
 * Copy knowledge files into the knowledge folder (Setup -> "Add a folder" / "Add files").
 * From a folder: its .md/.txt files that have front matter (a review pack's `1-live-candidate/`
 * subfolder is used when present, so review sheets and held material are never copied). Picked files
 * are copied as chosen. `_`-prefixed files (held or review material) and README.md are never copied.
 * Copying is not approval: every copied file arrives unapproved.
 */
export function importKnowledgeFiles(knowledgeDir: string, picked: string[], fromFolder: boolean): KnowledgeImport {
  const out: KnowledgeImport = { added: [], skipped: [] }
  let candidates = picked
  if (fromFolder) {
    let dir = picked[0]
    const pack = path.join(dir, '1-live-candidate')
    if (fs.existsSync(pack) && fs.statSync(pack).isDirectory()) dir = pack
    candidates = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())
  }
  fs.mkdirSync(knowledgeDir, { recursive: true })
  for (const src of candidates) {
    const name = path.basename(src)
    if (!/\.(md|txt)$/i.test(name)) {
      if (!fromFolder) out.skipped.push({ name, reason: 'not a .md or .txt file' })
      continue
    }
    if (name.startsWith('_')) {
      out.skipped.push({ name, reason: 'held or review file (name starts with _)' })
      continue
    }
    if (name.toLowerCase() === 'readme.md') continue
    if (fromFolder && !parseFrontMatter(fs.readFileSync(src, 'utf8')).meta.title) {
      out.skipped.push({ name, reason: 'not a knowledge file (no front matter)' })
      continue
    }
    const dest = path.join(knowledgeDir, name)
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest)
    out.added.push(name)
  }
  return out
}

/** Take a document out of use: it moves to the knowledge folder's `_removed/` subfolder (never indexed), so it can be restored. */
export function removeKnowledgeFile(knowledgeDir: string, file: string, now = new Date()): boolean {
  if (path.resolve(path.dirname(file)) !== path.resolve(knowledgeDir) || !fs.existsSync(file)) return false
  const bin = path.join(knowledgeDir, '_removed')
  fs.mkdirSync(bin, { recursive: true })
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  fs.renameSync(file, path.join(bin, `${stamp}-${path.basename(file)}`))
  return true
}
