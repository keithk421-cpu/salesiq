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
  /** A technical answer stated from approved knowledge may run longer than other ASK/SAY lines. */
  technical_max_words?: number
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

/** A number written with digits: "40", "$1,500", "2.5", "30%" (the "$" or "%" doesn't change which number it is). */
const FIGURE = /\$?\d[\d,]*(?:\.\d+)?%?/g
/**
 * Digits in the context that are not figures anyone said: tags (<last_30_seconds>), ids ([T3], [K1]),
 * line clock stamps "(0:41)", the press and gap times, knowledge version labels, and the call dates
 * that start each <earlier_calls> line ("2026-09-28 · "), which would otherwise let a made-up 28% through.
 */
const NOT_FIGURES = /<[^>\n]*>|\[[TK]\d+\]|\(\d{1,3}:\d{2}\)|pressed HELP at \d{1,3}:\d{2}|\bgap \d{1,3}:\d{2}–(?:\d{1,3}:\d{2}|now)|\bversion [^\s):;]+|\b\d{4}-\d{2}-\d{2}(?= · )/g
/** One figure's value as text: "1,500" and "1500" are the same, "05" is "5". */
const figure = (n: string) => String(Number(n.replace(/[$,%]/g, '')))
const SMALL: Record<string, number> = Object.fromEntries(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((w, i) => [w, i]),
)
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 }

/**
 * Every figure in the text, as numbers written with digits or spelled out ("three teams" -> 3,
 * "twenty-five" -> 25, "a hundred" -> 100), so a card's "3" matches a buyer's "three" but its "15"
 * doesn't match "150".
 */
export function numbersIn(text: string): Set<string> {
  const out = new Set((text.match(FIGURE) ?? []).map(figure))
  // Words in a row make one number ("two hundred and fifty"); "two, three" is two numbers.
  let total = 0
  let current = 0
  let last: 'none' | 'small' | 'tens' | 'scale' = 'none'
  const flush = () => {
    if (last !== 'none') out.add(String(total + current))
    total = current = 0
    last = 'none'
  }
  for (const [, w, gap] of text.toLowerCase().matchAll(/([a-z]+)([^a-z]*)/g)) {
    if (w in SMALL) {
      if (last === 'small') flush()
      current += SMALL[w]
      last = 'small'
    } else if (w in TENS) {
      if (last === 'small' || last === 'tens') flush()
      current += TENS[w]
      last = 'tens'
    } else if (w === 'hundred') {
      current = (current || 1) * 100
      last = 'scale'
    } else if (w in SCALES && (last !== 'none' || w === 'thousand')) {
      total += (current || 1) * SCALES[w]
      current = 0
      last = 'scale'
    } else if (!(w === 'and' && last === 'scale')) flush()
    // A comma or full stop ends the number ("two, three"); a hyphen or space doesn't ("twenty-five").
    if (/[^\s-]/.test(gap)) flush()
  }
  flush()
  return out
}

/** Figures in the card's text that nobody said and no context item holds (ids, clock stamps and tags don't count as said). */
export function unbackedNumbers(visible: string, contextText: string): string[] {
  const said = numbersIn(contextText.replace(NOT_FIGURES, ' '))
  return (visible.match(FIGURE) ?? []).filter((n) => !said.has(figure(n)))
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
  // A technical answer has to carry the facts it states, so it gets the longer limit when the playbook sets one.
  const primaryMax = partial.move === 'technical_answer' && L.technical_max_words ? L.technical_max_words : L.primary_max_words
  // Keith has already seen the ASK/SAY line while it streamed and may be reading it aloud, so a line a
  // little over its limit is kept whole (and noted); only a runaway line is cut.
  const p = capWords(partial.primary, primaryMax * 2)
  if (!p.cut && words(p.text) > Math.ceil(primaryMax * 1.2)) issues.push('over card limits')
  const h = partial.happening ? capWords(partial.happening, Math.ceil(L.happening_max_words * 1.2)) : null
  const f = partial.follow_up ? capWords(partial.follow_up, Math.ceil(L.follow_up_max_words * 1.2)) : null
  if (p.cut || h?.cut || f?.cut) issues.push('trimmed to card limits')

  const visible = [p.text, h?.text ?? '', f?.text ?? ''].join(' ')
  for (const n of unbackedNumbers(visible, opts.contextText)) issues.push(`number not found in context: ${n}`)
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

/** The kind of a validation issue without its details (details can quote the model's output). */
export function issueKind(issue: string): string {
  return issue.split(':')[0]
}

/**
 * Wording that states what Arize can do. It must be tied to a cited approved source (a K# id).
 * "We have" / "we've got" only count with a product object ("we have an OpenTelemetry-based
 * tracer"), so "we have a call next week" or "we have two options" are not claims.
 */
const CAPABILITY_CLAIM_SOURCE =
  String.raw`\b(?:` +
  [
    String.raw`we (?:do |can |also |already |fully |natively )?(?:support|offer|provide)`,
    String.raw`we(?: have|'ve got) (?:a |an |the )?(?:[\w-]+ ){0,2}?(?:integrations?|connectors?|support|features?|sdks?|exports?|apis?|plugins?|tracers?|tracing|instrumentation|capabilit(?:y|ies)|dashboards?|modules?|sso|saml|scim|rbac|otlp|soc ?2|certifications?)`,
    String.raw`(?:arize(?: ax)?|ax|phoenix) (?:also |already |fully |natively )?(?:supports|has|offers|provides|includes|covers|handles|works with|integrates with|can(?!'?t| ?not\b))`,
    String.raw`(?:our|arize'?s|arize’s) (?:[\w-]+ ){0,2}?(?:platform|product|tracing|tracer|sdk|evals?|monitoring|instrumentation|integration|tool)s? (?:supports|includes|covers|handles|works with|integrates with|has)`,
    String.raw`(?:it|the platform|the product|phoenix) (?:also |already |fully |natively )?(?:supports|includes)`,
    String.raw`(?:is|are) (?:fully |natively |officially )?supported`,
  ].join('|') +
  String.raw`)\b`
/** A subordinate lead right before the claim ("if that is supported", "which languages are supported"). */
const CLAIM_LEAD = /\b(?:if|what|which|once|when|until|before|after|suggest|propose|maybe|perhaps)\s+(?:[\w-]+\s+)?$/i
/**
 * A question: the clause, or its part after the last comma, opens with the helper verb, before any
 * subject ("can we provide", "got it, can we offer", "which of these teams would we support").
 * "You can see we support SSO" is not a question.
 */
const CLAIM_QUESTION = /^\W*(?:(?:and|but|so|or|then|also|now|okay|ok|well|yes|no|great|sure)\W+)*(?:(?:how|what|which|where|why|who)(?:\s+[\w-]+){0,3}\s+)?(?:do|does|did|can|could|should|would|will|shall)\s+(?:[\w-]+\s+)?$/i
/** A hedge earlier in the same clause: the line is checking, not claiming ("let me confirm we support that"). */
const CLAIM_HEDGE = /\b(?:confirm|check|verify|whether|not sure|unsure|not certain|find out|look into|double-check|ask)\b/i
/** Where a new clause starts: a sentence end, ';', ':', a dash between words, or ", but". */
const CLAUSE_BREAK = /[.!?;:—]|\s[-–]\s|,\s*but\b/gi

/** The clause the match sits in, up to the match ("let me check, but we support" -> " we support"). */
function clauseBefore(text: string, at: number): string {
  const before = text.slice(0, at)
  let start = 0
  for (const b of before.matchAll(CLAUSE_BREAK)) start = b.index + b[0].length
  return before.slice(start)
}

/**
 * First unhedged Arize capability claim in the text, or null. A hedge or question only counts in the
 * claim's own clause, before it: "Let me check the details, but we support SAML" is still a claim.
 */
export function findCapabilityClaim(text: string): string | null {
  for (const m of text.matchAll(new RegExp(CAPABILITY_CLAIM_SOURCE, 'gi'))) {
    const clause = clauseBefore(text, m.index)
    // A comma opener ("On self-hosted, do we support SAML?") doesn't stop it being a question.
    const question = CLAIM_QUESTION.test(clause) || CLAIM_QUESTION.test(clause.slice(clause.lastIndexOf(',') + 1))
    if (CLAIM_LEAD.test(clause) || question || CLAIM_HEDGE.test(clause)) continue
    // "Which languages are supported in your stack?" is about the buyer's side.
    if (/^(?:is|are)\b/i.test(m[0]) && /^\s+(?:in|on|by|across|within)\s+(?:your|their)\b/i.test(text.slice(m.index + m[0].length))) continue
    return m[0]
  }
  return null
}

/** The card's check notes. The same words while the line streams and on the finished card, so the swap doesn't flicker. */
export const CHECK_NUMBER = "Has a number that isn't in the call or approved knowledge. Check it before saying it."
export const CHECK_CLAIM = 'Says what Arize can do without an approved source. Check it before saying it.'
export const CHECK_TECHNICAL = 'Technical answer without an approved source. Check it before saying it.'

/** Each field on its own, so a hedge in one field never excuses a claim in another. */
function hasCapabilityClaim(card: Partial<HelpCardContent>): boolean {
  return [card.primary ?? '', card.happening ?? '', card.follow_up ?? ''].some((x) => findCapabilityClaim(x) !== null)
}

/** A technical answer that states something (not a question, not "let me check"). */
function statesTechnicalAnswer(card: Partial<HelpCardContent>): boolean {
  const p = card.primary ?? ''
  return card.move === 'technical_answer' && card.primary_kind === 'say' && !!p && !p.trim().endsWith('?') && !CLAIM_HEDGE.test(p)
}

/** Plain-language warnings shown on a finished card: things Keith should check before saying. */
export function cardChecks(card: HelpCardContent, issues: string[], sourceKinds: Map<string, 'turn' | 'knowledge'>): string[] {
  const out: string[] = []
  if (issues.some((i) => issueKind(i) === 'number not found in context')) out.push(CHECK_NUMBER)
  const citesKnowledge = card.source_ids.some((id) => sourceKinds.get(id) === 'knowledge')
  if (hasCapabilityClaim(card) && !citesKnowledge) out.push(CHECK_CLAIM)
  else if (statesTechnicalAnswer(card) && !citesKnowledge) out.push(CHECK_TECHNICAL)
  return out
}

/**
 * The checks that are already certain while the card is still streaming, from the moment its ASK/SAY
 * line is complete (Keith may read it before the card finishes): a number nobody said, and, when this
 * press had no approved knowledge to cite, an Arize capability claim or a technical answer. With
 * knowledge in the context the finished card may still cite it, so those two wait for the end. The
 * finished card's checks replace these.
 */
export function streamingChecks(partial: Partial<HelpCardContent>, opts: { contextText: string; knowledgeInContext: boolean }): string[] {
  if (!partial.primary || !partial.move) return []
  const out: string[] = []
  const visible = [partial.primary, partial.happening ?? '', partial.follow_up ?? ''].join(' ')
  if (unbackedNumbers(visible, opts.contextText).length) out.push(CHECK_NUMBER)
  if (opts.knowledgeInContext) return out
  if (hasCapabilityClaim(partial)) out.push(CHECK_CLAIM)
  else if (statesTechnicalAnswer(partial)) out.push(CHECK_TECHNICAL)
  return out
}
