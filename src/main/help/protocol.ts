/**
 * Streaming parser + validator for the HELP line protocol (see prompt.ts).
 *
 * "Usable" is strict: the primary ASK/SAY line counts only once its line is complete
 * (newline or end of stream), the MOVE line came first and is valid, and the text is a
 * real sentence (>= 3 words, not a heading/placeholder). A partial line never counts.
 */
import { SALES_MOVES, type HelpCardContent, type SalesMove } from '../../shared/help'

export interface CardLimits {
  primary_max_words: number
  happening_max_words: number
  follow_up_max_words: number
}

const KEYS = ['MOVE', 'ASK', 'SAY', 'HAPPENING', 'FOLLOW', 'SOURCES', 'NOTE'] as const
type Key = (typeof KEYS)[number]

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const dash = (s: string | undefined) => !s || /^[-–—\s]*$/.test(s) || /^(none|n\/a)\.?$/i.test(s.trim())

export function isUsableLine(text: string): boolean {
  const t = text.trim().replace(/^["“]|["”]$/g, '')
  if (words(t) < 3) return false
  if (/^[#*_\-–—]/.test(t)) return false
  if (/^(ask|say|move|happening)\s*:/i.test(t)) return false
  if (/\.\.\.$|…$/.test(t)) return false
  return true
}

export class LineProtocolParser {
  private buf = ''
  private fields = new Map<Key, string>()
  private order: Key[] = []
  /** Set once a complete, valid primary line has been parsed (after a valid MOVE). */
  firstUsableAt: number | null = null

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Feed streamed text. Returns true when a new complete line was parsed. */
  feed(chunk: string): boolean {
    this.buf += chunk
    let changed = false
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      changed = this.takeLine(line) || changed
    }
    return changed
  }

  end(): void {
    if (this.buf.trim()) this.takeLine(this.buf)
    this.buf = ''
  }

  private takeLine(raw: string): boolean {
    const m = /^\s*\**\s*(MOVE|ASK|SAY|HAPPENING|FOLLOW|SOURCES|NOTE)\s*\**\s*:\s*(.*)$/i.exec(raw)
    if (!m) return false
    const key = m[1].toUpperCase() as Key
    if (this.fields.has(key)) return false
    this.fields.set(key, m[2].trim())
    this.order.push(key)
    if (this.firstUsableAt === null && (key === 'ASK' || key === 'SAY')) {
      const move = this.fields.get('MOVE')
      if (move && (SALES_MOVES as readonly string[]).includes(move.trim()) && isUsableLine(m[2])) this.firstUsableAt = this.now()
    }
    return true
  }

  /** Content so far (display only complete lines). */
  partial(): Partial<HelpCardContent> {
    const f = this.fields
    const out: Partial<HelpCardContent> = {}
    const move = f.get('MOVE')?.trim()
    if (move && (SALES_MOVES as readonly string[]).includes(move)) out.move = move as SalesMove
    const ask = f.get('ASK')
    const say = f.get('SAY')
    if (ask !== undefined && !dash(ask)) {
      out.primary_kind = 'ask'
      out.primary = clean(ask)
    } else if (say !== undefined && !dash(say)) {
      out.primary_kind = 'say'
      out.primary = clean(say)
    }
    if (f.has('HAPPENING')) out.happening = dash(f.get('HAPPENING')) ? null : clean(f.get('HAPPENING')!)
    if (f.has('FOLLOW')) out.follow_up = dash(f.get('FOLLOW')) ? null : clean(f.get('FOLLOW')!)
    if (f.has('SOURCES')) out.source_ids = dash(f.get('SOURCES')) ? [] : f.get('SOURCES')!.split(/[,\s]+/).map((x) => x.replace(/[[\]]/g, '')).filter(Boolean)
    if (f.has('NOTE')) out.note = dash(f.get('NOTE')) ? null : clean(f.get('NOTE')!)
    return out
  }

  get fieldOrder(): string[] {
    return [...this.order]
  }
}

function clean(s: string): string {
  return s.trim().replace(/^["“]+|["”]+$/g, '').replace(/\s+/g, ' ')
}

function capWords(s: string, max: number): { text: string; cut: boolean } {
  const w = s.trim().split(/\s+/)
  if (w.length <= max) return { text: s.trim(), cut: false }
  return { text: `${w.slice(0, max).join(' ')}…`, cut: true }
}

export interface ValidationResult {
  ok: boolean
  card: HelpCardContent | null
  issues: string[]
}

/**
 * Level 1 checks that can run live, in code:
 * - valid MOVE, chosen before the wording (MOVE line came first)
 * - exactly one usable ASK/SAY
 * - sources only from ids that were actually in the context
 * - numbers in the visible lines must appear in the context (no invented figures)
 * - visible text within the short-card limits
 */
export function validateCard(
  partial: Partial<HelpCardContent>,
  fieldOrder: string[],
  opts: { knownSourceIds: Set<string>; contextText: string; limits: CardLimits },
): ValidationResult {
  const issues: string[] = []
  if (!partial.move) return { ok: false, card: null, issues: ['missing or invalid MOVE'] }
  if (fieldOrder[0] !== 'MOVE') issues.push('MOVE was not selected first')
  if (!partial.primary || !partial.primary_kind || !isUsableLine(partial.primary)) {
    return { ok: false, card: null, issues: [...issues, 'no usable ASK/SAY line'] }
  }
  if (fieldOrder.includes('ASK') && fieldOrder.includes('SAY')) issues.push('both ASK and SAY given; kept the first')
  const unknown = (partial.source_ids ?? []).filter((id) => !opts.knownSourceIds.has(id))
  if (unknown.length) issues.push(`unknown source ids removed: ${unknown.join(', ')}`)
  const sources = (partial.source_ids ?? []).filter((id) => opts.knownSourceIds.has(id))

  const L = opts.limits
  const p = capWords(partial.primary, Math.ceil(L.primary_max_words * 1.2))
  const h = partial.happening ? capWords(partial.happening, Math.ceil(L.happening_max_words * 1.2)) : null
  const f = partial.follow_up ? capWords(partial.follow_up, Math.ceil(L.follow_up_max_words * 1.2)) : null
  if (p.cut || h?.cut || f?.cut) issues.push('trimmed to card limits')

  const visible = [p.text, h?.text ?? '', f?.text ?? ''].join(' ')
  const ctx = opts.contextText
  for (const n of visible.match(/\$?\d[\d,.]*%?/g) ?? []) {
    const bare = n.replace(/[$%,]/g, '').replace(/\.$/, '')
    if (bare && !ctx.includes(bare)) issues.push(`number not found in context: ${n}`)
  }
  return {
    ok: true,
    issues,
    card: {
      move: partial.move,
      primary_kind: partial.primary_kind,
      primary: p.text,
      happening: h?.text ?? null,
      follow_up: f?.text ?? null,
      source_ids: sources,
      note: partial.note ?? null,
    },
  }
}
