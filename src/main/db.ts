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
  if (list.length === 0) return null
  return list.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
}

/** The search terms ftsQuery uses: content words of `text` (no stopwords) plus their aliases. */
export function ftsTerms(text: string, aliases: Map<string, string[]> = new Map(), maxTerms = 24): string[] {
  const terms = new Set<string>()
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    const t = raw.replace(/'s$/, '').replace(/[^\p{L}\p{N}-]/gu, '')
    if (t.length < 3 || STOPWORDS.has(t)) continue
    terms.add(t)
    for (const a of aliases.get(t) ?? []) terms.add(a.toLowerCase())
  }
  // Multi-word aliases (e.g. "weights & biases") are matched on the whole lowercased text.
  const lower = text.toLowerCase()
  for (const [key, group] of aliases) if (key.includes(' ') && lower.includes(key)) for (const a of group) terms.add(a.toLowerCase())
  return [...terms].slice(0, maxTerms)
}

const STOPWORDS = new Set(
  ('the and that this with have for you your are was were what when where which who how why not but just like yeah yes ' +
    'okay right really think know mean kind sort thing things there their they them then than its it\'s our out about ' +
    'would could should will can get got going gonna want wanna from into some any all also very much more most been ' +
    'being had has did does doing done one two make made let lets well sure maybe actually basically probably um uh').split(/\s+/),
)
