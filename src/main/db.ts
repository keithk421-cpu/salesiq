/**
 * Local SQLite (node:sqlite, built into Electron's Node) - the M1 source of truth for
 * call memory, speaker labels, HELP requests/outputs and feedback, plus FTS5 indexes.
 *
 * Lives in the app's userData folder (never in Git, never a cloud-sync folder by default).
 * Transcript and card text are kept here, not in diagnostics logs.
 */
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, setup_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL, stream TEXT NOT NULL, cluster TEXT,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, available_ms INTEGER NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  text, session_id UNINDEXED, turn_id UNINDEXED, tokenize = 'porter unicode61'
);
CREATE TABLE IF NOT EXISTS speaker_labels (
  session_id TEXT NOT NULL, cluster TEXT NOT NULL, role TEXT NOT NULL, name TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, cluster)
);
CREATE TABLE IF NOT EXISTS help_requests (
  id TEXT PRIMARY KEY, session_id TEXT, origin TEXT NOT NULL, created_at TEXT NOT NULL,
  at_session_ms INTEGER, status TEXT NOT NULL, model_json TEXT NOT NULL, context_refs_json TEXT,
  request_text TEXT, output_raw TEXT, card_json TEXT, timing_json TEXT, usage_json TEXT, error TEXT,
  prefetch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, origin TEXT NOT NULL, type TEXT NOT NULL,
  bad_reason TEXT, note TEXT, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  doc_id TEXT PRIMARY KEY, file TEXT NOT NULL, mtime_ms INTEGER NOT NULL, meta_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, title TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  text, title, heading, chunk_id UNINDEXED, doc_id UNINDEXED, tokenize = 'porter unicode61'
);
`

export class Db {
  readonly sql: DatabaseSync

  constructor(path: string) {
    this.sql = new DatabaseSync(path)
    this.sql.exec(SCHEMA)
    // Databases created before chunks kept their "Source:" reference separately.
    const cols = this.sql.prepare('PRAGMA table_info(knowledge_chunks)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'source_ref')) this.sql.exec("ALTER TABLE knowledge_chunks ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''")
    // Builds before Oct 5 kept the text of background requests Keith never saw. Drop it, and compact
    // the file so the removed text doesn't linger in free pages.
    const unseen = this.sql.prepare(
      `UPDATE help_requests SET request_text = NULL, output_raw = NULL, card_json = NULL
       WHERE prefetch = 1 AND COALESCE(json_extract(timing_json, '$.served_from_prefetch'), 0) = 0
         AND (request_text IS NOT NULL OR output_raw IS NOT NULL OR card_json IS NOT NULL)`,
    ).run()
    if (Number(unseen.changes) > 0 && path !== ':memory:') this.sql.exec('VACUUM')
    this.sql.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
  }

  close(): void {
    this.sql.close()
  }

  tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN')
    try {
      const r = fn()
      this.sql.exec('COMMIT')
      return r
    } catch (err) {
      this.sql.exec('ROLLBACK')
      throw err
    }
  }
}

/**
 * Build an FTS5 MATCH expression from free text: alphanumeric tokens (>= 3 chars, not stopwords),
 * each quoted, OR-ed, plus alias expansions. Never passes raw user/transcript text as FTS syntax.
 */
export function ftsQuery(text: string, aliases: Map<string, string[]> = new Map(), maxTerms = 24): string | null {
  const list = ftsTerms(text, aliases, maxTerms)
  return list.length ? ftsAny(list) : null
}

/** Synonyms of the newest few things said get their own room, outside the cap on spoken words. */
const ALIAS_NEWEST = 4
const ALIAS_EXTRA = 12

/**
 * What was said, as concepts: each spoken content word with its aliases, newest first. Words from the
 * same synonym group ("pricing" and "budget") are one concept, and a multi-word synonym said as a
 * phrase ("proof of concept") counts as that phrase, not as its words. The words actually said fill
 * the cap before any alias, so the cap never drops the buyer's latest question in favour of earlier
 * talk or synonyms; the newest few concepts still get their synonyms from a small separate allowance.
 */
export function ftsConcepts(text: string, aliases: Map<string, string[]> = new Map(), maxTerms = 24): string[][] {
  if (maxTerms <= 0) return []
  const lower = text.toLowerCase()
  const phrases: Array<{ at: number; end: number; term: string }> = []
  for (const [key] of aliases) {
    if (!key.includes(' ')) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu')
    for (const m of lower.matchAll(re)) phrases.push({ at: m.index ?? 0, end: (m.index ?? 0) + key.length, term: key })
  }
  const said: Array<{ at: number; term: string }> = phrases.map(({ at, term }) => ({ at, term }))
  for (const m of lower.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
    const at = m.index ?? 0
    const t = m[0].replace(/'s$/, '').replace(/[^\p{L}\p{N}-]/gu, '')
    if (t.length < 3 || STOPWORDS.has(t) || phrases.some((p) => at >= p.at && at < p.end)) continue
    said.push({ at, term: t })
  }
  said.sort((a, b) => b.at - a.at)
  const group = (t: string) => [t, ...(aliases.get(t) ?? [])].sort()[0]
  const concepts: string[][] = []
  const byGroup = new Map<string, string[]>()
  const used = new Set<string>()
  for (const { term } of said) {
    if (used.size >= maxTerms) break
    if (used.has(term)) continue
    used.add(term)
    const g = group(term)
    const c = byGroup.get(g)
    if (c) c.push(term)
    else {
      byGroup.set(g, [term])
      concepts.push(byGroup.get(g)!)
    }
  }
  let room = maxTerms - used.size
  let extra = ALIAS_EXTRA
  concepts.forEach((c, i) => {
    for (const a of new Set(c.flatMap((t) => aliases.get(t) ?? []))) {
      if (used.has(a)) continue
      if (i < ALIAS_NEWEST && extra > 0) extra--
      else if (room > 0) room--
      else break
      used.add(a)
      c.push(a)
    }
  })
  return concepts
}

/** The search terms ftsQuery uses: every concept's words, flattened. */
export function ftsTerms(text: string, aliases: Map<string, string[]> = new Map(), maxTerms = 24): string[] {
  return ftsConcepts(text, aliases, maxTerms).flat()
}

/** One FTS5 OR-group for a list of terms, each quoted so user text is never FTS syntax. */
export function ftsAny(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
}

const STOPWORDS = new Set(
  ('the and that this with have for you your are was were what when where which who how why not but just like yeah yes ' +
    'okay right really think know mean kind sort thing things there their they them then than its it\'s our out about ' +
    'would could should will can get got going gonna want wanna from into some any all also very much more most been ' +
    'being had has did does doing done one two make made let lets well sure maybe actually basically probably um uh ' +
    // Filler nouns in buyer speech ("an on-prem version"); "versioning" is still searchable.
    'version versions').split(/\s+/),
)
