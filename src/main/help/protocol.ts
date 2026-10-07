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

/** A unit right after a figure, as the counted facts give it ("10 min", "75 s", "15 questions", "3 in a row"). */
const COUNTED_UNIT = /^\s?(min(?:ute)?s?|s|secs?|seconds?|questions?|in a row)\b/i
const countedUnit = (u: string) => (/^min/i.test(u) ? 'min' : /^s/i.test(u) ? 's' : /^q/i.test(u) ? 'questions' : 'in a row')

/**
 * Figures in the card's text that nobody said and no context item holds (ids, clock stamps and tags
 * don't count as said). `counted` (M5): numbers the app counted, each with its unit ("75 s"); one backs
 * a figure only when the card gives it with the same unit ("over 75 s" yes, "75 engineers" no).
 */
export function unbackedNumbers(visible: string, contextText: string, counted: readonly string[] = []): string[] {
  const said = numbersIn(contextText.replace(NOT_FIGURES, ' '))
  const echoes = new Set(counted.map((c) => { const m = /^(\d+)\s?(.+)$/.exec(c); return m ? `${m[1]} ${countedUnit(m[2])}` : '' }))
  const out: string[] = []
  for (const m of visible.matchAll(FIGURE)) {
    if (said.has(figure(m[0]))) continue
    const unit = COUNTED_UNIT.exec(visible.slice(m.index + m[0].length))
    if (unit && !m[0].startsWith('$') && !m[0].endsWith('%') && echoes.has(`${figure(m[0])} ${countedUnit(unit[1])}`)) continue
    out.push(m[0])
  }
  return out
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
  opts: { knownSourceIds: Set<string>; contextText: string; limits: CardLimits; counted?: readonly string[] },
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
  for (const n of unbackedNumbers(visible, opts.contextText, opts.counted)) issues.push(`number not found in context: ${n}`)
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
export function cardChecks(card: HelpCardContent, issues: string[], sourceKinds: Map<string, 'turn' | 'knowledge'>, price: PriceCheckOpts = {}): string[] {
  const out: string[] = []
  if (issues.some((i) => issueKind(i) === 'number not found in context')) out.push(CHECK_NUMBER)
  if (priceFigures(card, price).length) out.push(CHECK_PRICE)
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
 * finished card's checks replace these. A price figure is the same: SOURCES comes last, so it is
 * certain early only when no approved item came with the press at all.
 */
export function streamingChecks(partial: Partial<HelpCardContent>, opts: { contextText: string; knowledgeInContext: boolean; counted?: readonly string[] } & PriceCheckOpts): string[] {
  if (!partial.primary || !partial.move) return []
  const out: string[] = []
  const visible = [partial.primary, partial.happening ?? '', partial.follow_up ?? ''].join(' ')
  if (unbackedNumbers(visible, opts.contextText, opts.counted).length) out.push(CHECK_NUMBER)
  if (opts.knowledgeInContext) return out
  if (priceFigures(partial, { theirText: opts.theirText, callType: opts.callType }).length) out.push(CHECK_PRICE)
  if (hasCapabilityClaim(partial)) out.push(CHECK_CLAIM)
  else if (statesTechnicalAnswer(partial)) out.push(CHECK_TECHNICAL)
  return out
}

// ------------------------------------------------------------------ price check (M5 step 0)

/**
 * What the price check needs beyond the card. All optional: a caller that passes nothing still gets
 * the check, just without the two ways a figure can be allowed.
 */
export interface PriceCheckOpts {
  /** The context's sources by short id ("K1", "T3"): an approved item's text backs a figure when the card cites it. */
  sources?: Map<string, { kind: 'turn' | 'knowledge'; detail: string }>
  /**
   * The other side's words on this call up to the press (live words still being transcribed included)
   * and what they said on earlier calls: Keith may ask their own figure back.
   */
  theirText?: string
  /** The call type as at the press. Pricing calls (negotiation) also flag a bare %, a large figure and any offer with a figure. */
  callType?: string
}

/** Keith chose a warning: the line stays on screen with this note. */
export const CHECK_PRICE = "Price or discount not from approved pricing: don't say it."

const NUMBER_WORDS = new Set(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion'.split(' '),
)
/** A spelled number with one of these is big enough to be a price ("forty", "a thousand"); "one" or "two" alone is just a word. */
const BIG_NUMBER_WORD = /^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)$/
/** A number written with digits, with a currency sign or code, a k/m size or a % on it ("$40k", "€12,000", "15%"). */
const DIGIT_FIGURE = /^(?:usd|eur|gbp)?[$€£]?\d[\d,]*(?:\.\d+)?(?:k|mm|m|bn)?%?$/
const SCALE_WORD: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, bn: 1e9, billion: 1e9 }
const CURRENCY_BEFORE = /^(?:usd|eur|gbp|[$€£])$/
const CURRENCY_AFTER = /^(?:dollars?|usd|euros?|eur|pounds|gbp|bucks|grand)$/
/** Words that make a nearby figure a price. Unit words ("per month", "a year", "rate", "commit", "off") never do on their own. */
const PRICE_WORD = /^(?:discount(?:s|ed|ing)?|pric(?:e|es|ed|ing)|costs?|costing)$/
const SEAT_WORD = /^(?:seats?|users?)$/
/**
 * A figure right before one of these counts things ("pricing for 200 seats", "the cost of 10 million
 * traces", "2 more sessions", "3 references"); it isn't the price.
 */
const COUNT_NOUN = /^(?:seats?|users?|licen[cs]es?|people|persons?|employees|staff|engineers?|developers?|devs?|reviewers?|stakeholders?|names?|teams?|squads?|traces?|spans?|events?|requests?|calls?|tokens?|models?|agents?|apps?|applications?|projects?|services?|environments?|regions?|datasets?|evals?|prompts?|queries|records?|rows?|gb|tb|pb|references?|examples?|sessions?|pilots?|options?|demos?|workshops?|meetings?|steps?|things?|questions?|items?|tiers?|slots?|use|cases?|companies|customers?)$/
/** "Your token costs", "what does downtime cost you": the buyer's own costs, not an Arize price. */
const THEIR_COST_BEFORE = /^(?:your|their|token|tokens|llm|model|inference|compute|gpu|cloud|infra|infrastructure|storage|hosting|downtime|outage|incident|labeling|labelling)$/
const THEIR_COST_AFTER = /^(?:you|them|us|your|their)$/
/** "Cost drivers", "a cost increase": talk about their costs. */
const THEIR_COST_NOUN = /^(?:drivers?|increases?|reductions?|drops?|cuts?|savings|cent(?:er|re)s?|overruns?|spikes?|growth)$/
/** "The 3 pricing questions", "the 2 price options": the figure counts the topics, not money. */
const PRICE_TOPIC = /^(?:questions?|options?|tiers?|topics?|things?|items?|points?|pages?|models?|levels?|plans?|scenarios?|conversations?|calls?|meetings?)$/
/** A figure followed by one of these is a time or a date ("2 weeks", "3 pm"), not money. Months and years are left in: they can be a term. */
const TIME_UNIT = /^(?:days?|weeks?|hours?|hrs?|minutes?|mins?|seconds?|secs?|ms|milliseconds?|am|pm|o'?clock|business|working|sprints?)$/
const MONTH_NAME = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/
/**
 * A number right after a model family or a standard is part of its name ("Claude 3.5", "GPT 4", "ISO
 * 27001", "SOC 2"); "GPT-4o" never reads as a figure at all.
 */
const MODEL_FAMILY = /^(?:gpt|claude|llama|gemini|mistral|mixtral|qwen|phi|sonnet|opus|haiku|iso|soc|pci|hipaa|rfc|section|article|version|v)$/
/** A % that measures an outcome, not a price: "40% fewer bad answers", "99.9% uptime", "a 15% increase". */
const OUTCOME_AFTER = /^(?:fewer|less|lower|faster|slower|higher|better|worse|more|drop|cut|reduction|decrease|increase|improvement|growth|uptime|accuracy|availability|coverage|recall|precision)$/
/** "Cut debugging time 30%", "costs went up 40%", "cutting cost by 30%": a change in their numbers. */
const CHANGE_VERB = /^(?:cut|cuts|cutting|reduce[ds]?|reducing|lower(?:ed|s|ing)?|drop(?:ped|s|ping)?|improve[ds]?|improving|save[ds]?|saving|grew|grow(?:s|ing)?|increase[ds]?|increasing|rose|rise|fell|fall|went|gone|shrank|sped)$/
/** A change to one of these is Arize's price moving, never an outcome: "cut the price by 10%". */
const PRICE_THING = /^(?:price|prices|pricing|list|quote|fee|fees|bill|invoice|rate|discount|deal|contract|renewal|subscription|licen[cs]e)$/
const OUR_SIDE = /^(?:we|i|we['’](?:ll|d|re)|i['’](?:ll|d|m)|let['’]?s|us)$/
/**
 * An offer: "could we do", "can I give", the same words the other way round ("we could do", "I'll
 * give"), and the concession shapes a pricing line takes ("come down to", "meet you at", "call it",
 * "how about", "what if we", "happy to include"). "Go through / over / live" is not an offer.
 */
const OFFER_VERB = "(?:do|offer|give|get|meet|match|drop|knock|throw|come|bring|land|settle|take|include|waive|lock|cap|cut|sharpen|extend|add|go(?!\\s+(?:through|over|back|ahead|into|live|deeper)\\b))"
const OFFER = new RegExp(
  "\\b(?:(?:(?:can|could|would|will|shall)\\s+(?:we|i)|(?:we|i)(?:\\s+(?:can|could|would|will|might|may)|['’](?:d|ll)|\\s+are\\s+happy\\s+to|['’](?:re|m)\\s+happy\\s+to))(?:\\s+(?:probably|maybe|definitely|also|still|happily|be\\s+able\\s+to))?\\s+" + OFFER_VERB +
  "|what\\s+if\\s+(?:we|i)|how\\s+about|what\\s+about|call\\s+it|meet\\s+you\\s+at|let['’]?s\\s+(?:say|do|call\\s+it|go|meet|land|settle)|happy\\s+to\\s+(?:do|offer|give|include|go|come|meet|throw|waive|cap|knock|drop))\\b",
  'gi',
)
/** The figure just said is accepted: "15% is doable", "40,000 a year works for us". */
const ACCEPT_AFTER = /^[^.?!]{0,30}?\b(?:(?:is|would\s+be|could\s+be|should\s+be)\s+(?:doable|fine|possible|workable|ok|okay|on\s+the\s+table|no\s+problem|achievable)|works?\s+for\s+(?:us|me))\b/i
/**
 * A line that ties a figure to a yes or a signature can't be "just asking their figure back":
 * "Would 20% off work if you signed annually?", "Is 20% off enough to close this month?".
 */
const CONDITION = /\b(?:if\s+(?:you|we)|would\s+you|could\s+you|will\s+you|can\s+you|sign(?:ed|ing|ature)?|close[ds]?|closing|commit(?:ted|ment)?|terms?|agree[ds]?|accept(?:ed|s)?|take|enough|done|lock|approve[ds]?|works?\s+for\s+(?:you|your|them|us))\b|\b(?:would|does|will|could|can)\s+\S+\s+work\b/i
/**
 * Their words recapped: "you mentioned a $150k budget", "the $200k you spend on Datadog", "so you're
 * spending $200k", "your OpenAI bill". Never "your Arize bill" or "your price from us": that is ours.
 */
const ATTRIBUTION = /\byou(?:['’]ve)?\s+(?:mentioned|said|told|shared|noted|raised|flagged|quoted|spend|spent|pay|paid|budget(?:ed)?|asked\s+for|brought\s+up|wanted|were\s+quoted|got\s+quoted)\b|\byou['’]re\s+(?:spending|paying|budgeting)\b|\byour\s+(?:budget|cap|ceiling|target|number|quote|spend)\b|\byour\s+(?!arize\b|our\b)(?:[\w-]+\s+)?(?:spend|costs?|bill)\b/i
/** Wh-words that ask about the figure; "what if", "how about", "what about" and "why not" propose instead. */
const WH_WORD = /\b(?:what|what['’]s|whats|why|where|how|which|who|when)\b/i
const WH_PROPOSES = /\b(?:what\s+if|how\s+about|what\s+about|why\s+not)\b/i
const MODAL = /\b(?:would|could|can|will|might|should)\b/i
/** A question opening with one of these is a yes/no question; the first few may also propose. */
const YES_NO_OPENER = /^(?:would|could|can|will|shall|should|may|might|if|is|are|does|do|did|was|were|has|have)$/
const PROPOSING_OPENER = /^(?:would|could|can|will|shall|should|may|might|if)$/
/**
 * A line that asks for a yes to an amount, or puts it on our side or in a deal: never their spend
 * asked back ("Is $40k a deal?", "Are we aligned at $40k?", "Is $40k the price you want from us?").
 */
const YES_TO_AMOUNT = /(?<![\w-])(?:ok|okay|fine|good|enough|doable|acceptable|reasonable|workable|works?|deal|land|aligned|we|we['’]\w+|us|our|i|i['’]\w+|arize|price|pricing|quote|discount|contract|renewal|platform|all\s+in)(?![\w-])/i
/**
 * Arize's side in a statement that repeats their figure: "You mentioned $40k. That's where we land."
 * "Us" is left out: "you told us the $200k goes to Datadog" is still their words.
 */
const ARIZE_SIDE = /(?<![\w-])(?:we|we['’]\w+|our|arize|price|pricing|quote|discount|contract|renewal|deal)(?![\w-])/i
/** Their cost or bill with Arize ("your cost with us", "your total cost for Arize") is our price, never their figure. */
const WITH_ARIZE = /\b(?:with|from|to|for)\s+(?:us|arize)\b|\barize\b/i
/** Their figure called our price: "that's our price", "my best", "so $40k it is". */
const OUR_PRICE = /\b(?:our|my)\s+(?:price|pricing|quote|number|offer|rate|best)\b|\bit\s+is\b/i

/**
 * A free period with no figure in it: "a free month", "the first month is on us", "free for a month".
 * A term Keith never promises, on any call.
 */
const FREE_PERIOD = /(?<!\b(?:have|has|had|got|find|any)\s+)\b(?:a|one|an\s+extra|an\s+additional|another|the\s+first|first)\s+(?:free\s+(?:month|quarter|year|week)\b|(?:month|quarter|year|week)(?:['’]s)?\s+(?:(?:is|are)\s+)?(?:free|on\s+us|at\s+no\s+(?:cost|charge)|for\s+free)\b)|\bfree\s+for\s+(?:a|one|the\s+first)\s+(?:month|quarter|year|week)\b|(?<=\b(?:we|i|we['’](?:ll|d)|i['’](?:ll|d)|happy\s+to|glad\s+to)\s+(?:can\s+|could\s+|would\s+|will\s+)?)waive\s+(?:the\s+)?(?:first\s+)?(?:month|quarter|year|week|fee|fees|setup\s+fee|onboarding\s+fee)\b/i
/** After "free", these keep it about a period ("free for 30 days", "a free 30-day pilot"); "free text" or "the free tier" is something else. */
/** "Free" as someone's time, not a price: "your team is free", "are you free", "do you have a free week". */
const FREE_AVAILABLE_BEFORE = /^(?:you|you['’]re|they|they['’]re|team|everyone|anyone|someone|people|have|has|had|got|find)$/
const FREE_PERIOD_NEXT = /^(?:|for|of|during|through|until|to|on|and|trial|pilot|poc|period|months?|weeks?|days?|years?|quarters?|\d.*)$/

interface PriceToken { w: string; start: number; end: number }
interface PriceFigure { raw: string; i: number; j: number; start: number; end: number; value: string; digits: boolean; big: boolean }
type PriceUnit = 'percent' | 'currency' | 'plain'

/**
 * Ranges, "2-week", "$40k/year" and "twenty-five" become plain words. Dates ("10/30") and "24/7" are
 * read first, so their slash isn't taken for "per".
 */
function priceText(text: string): string {
  return text
    .replace(/\b24\/7\b/g, '24x7')
    .replace(/(?<![$€£\d.,])\b(?:1[0-2]|0?[1-9])\/(?:3[01]|[12]\d|0?[1-9])(?:\/\d{2,4})?\b(?![\d,.]\d)/g, 'on-date')
    .replace(/(\d)\s?[-–]\s?(?=[$€£]?\d)/g, '$1 to ')
    .replace(/(\d)[-–](?=[a-z])/gi, '$1 ')
    .replace(/\//g, ' per ')
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(?=[a-z])/gi, '$1 ')
    .replace(/\bper cent\b/gi, 'percent')
}

/** Words in lower case without the punctuation around them ("$40k," -> "$40k", "(20%)" -> "20%"), with where each sits. */
function priceTokens(t: string): PriceToken[] {
  const out: PriceToken[] = []
  for (const m of t.matchAll(/\S+/g)) {
    const w = m[0].toLowerCase().replace(/^[^\w$€£]+|[^\w%]+$/g, '')
    if (w) out.push({ w, start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** Every value a text's figures could mean: "40k" is 40 and 40,000; "20%" is 20. */
/**
 * Figures the other side gave as a count of things ("10 million traces a month", "about 40 engineers"):
 * the same figure on a card is their volume asked back or recapped, not a price.
 */
function countValues(text: string): Set<string> {
  const t = priceText(text)
  const toks = priceTokens(t)
  const at = (k: number) => toks[k]?.w ?? ''
  const out = new Set<string>()
  for (const f of priceFiguresIn(toks, t)) {
    if (f.value && (COUNT_NOUN.test(at(f.j + 1)) || (at(f.j + 1) !== 'per' && COUNT_NOUN.test(at(f.j + 2))))) out.add(f.value)
  }
  return out
}

/** Their spend on what they run today ("we spend $40k a month on OpenAI", "Datadog runs us $100k"), not a budget for Arize. */
const SPEND_NEAR = /\b(?:spend(?:s|ing)?|spent|pay(?:s|ing)?|paid|runs?\s+us|costs?\s+us|bill(?:ed)?|invoice[ds]?)\b/i
function spendValues(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    const t = priceText(line)
    const toks = priceTokens(t)
    for (const f of priceFiguresIn(toks, t)) {
      if (f.value && priceUnit(f, toks) === 'currency' && SPEND_NEAR.test(sentenceAt(t, f.start).text)) out.add(f.value)
    }
  }
  return out
}

function figureValues(text: string): Set<string> {
  const out = numbersIn(text)
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|bn|thousand|million|billion)\b/gi)) {
    out.add(String(Number(m[1].replace(/,/g, '')) * SCALE_WORD[m[2].toLowerCase()]))
  }
  return out
}

/** The figures in one line: digits (with any size word after them: "40 thousand") and spelled-out runs ("forty thousand"). */
function priceFiguresIn(toks: PriceToken[], t: string): PriceFigure[] {
  const out: PriceFigure[] = []
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].w
    if (DIGIT_FIGURE.test(w)) {
      if (MODEL_FAMILY.test(toks[i - 1]?.w ?? '')) continue
      let j = i
      let n = Number(w.replace(/^(?:usd|eur|gbp)/, '').replace(/[$€£,%]|(?:k|mm|m|bn)%?$/g, ''))
      const size = /(k|mm|m|bn)%?$/.exec(w)?.[1]
      if (size) n *= SCALE_WORD[size]
      while (toks[j + 1] && /^(?:thousand|million|billion)$/.test(toks[j + 1].w)) n *= SCALE_WORD[toks[++j].w]
      out.push({ raw: t.slice(toks[i].start, toks[j].end), i, j, start: toks[i].start, end: toks[j].end, value: String(n), digits: true, big: true })
      i = j
    } else if (NUMBER_WORDS.has(w) || (w === 'a' && /^(?:hundred|thousand|million)$/.test(toks[i + 1]?.w ?? ''))) {
      let j = i
      while (toks[j + 1] && (NUMBER_WORDS.has(toks[j + 1].w) || (toks[j + 1].w === 'and' && NUMBER_WORDS.has(toks[j + 2]?.w ?? '')))) j++
      const words = toks.slice(i, j + 1).map((x) => x.w)
      const value = [...numbersIn(words.join(' ').replace(/^a /, 'one '))].pop() ?? ''
      out.push({ raw: t.slice(toks[i].start, toks[j].end), i, j, start: toks[i].start, end: toks[j].end, value, digits: false, big: words.some((x) => BIG_NUMBER_WORD.test(x)) })
      i = j
    }
  }
  return out
}

/** The token index of a figure's "%" (on it, or "percent" after it), or -1. */
function percentAt(f: PriceFigure, toks: PriceToken[]): number {
  const at = (k: number) => toks[k]?.w ?? ''
  return at(f.j).endsWith('%') ? f.j : at(f.j + 1) === 'percent' ? f.j + 1 : -1
}

/** What a figure is: a % ("20%", "twenty percent"), money ("$40k", "40 thousand dollars") or a plain number. */
function priceUnit(f: PriceFigure, toks: PriceToken[]): PriceUnit {
  const at = (k: number) => toks[k]?.w ?? ''
  if (/^(?:usd|eur|gbp)?[$€£]/.test(at(f.i)) || CURRENCY_BEFORE.test(at(f.i - 1)) || CURRENCY_AFTER.test(at(f.j + 1))) return 'currency'
  return percentAt(f, toks) >= 0 ? 'percent' : 'plain'
}

/** Why one figure would be heard as a price, discount or term on this call type (a code, for tests); null: it isn't. */
function priceReason(f: PriceFigure, toks: PriceToken[], t: string, negotiation: boolean): string | null {
  const at = (k: number) => toks[k]?.w ?? ''
  const pctAt = percentAt(f, toks)
  const unit = priceUnit(f, toks)
  const last = pctAt >= 0 ? pctAt : f.j
  const scaled = f.digits && pctAt < 0 && (/\d(?:k|mm|m|bn)$/.test(at(f.i)) || f.j > f.i || Number(f.value) >= 1000)
  // "Thursday at 3" is a time of day; "meet you at 30k" isn't.
  const clock = f.digits && unit === 'plain' && !scaled && at(f.i - 1) === 'at' && Number(f.value) <= 12
  const timing = pctAt < 0 && (TIME_UNIT.test(at(f.j + 1)) || /^(?:19|20)\d\d$/.test(at(f.i)) || MONTH_NAME.test(at(f.i - 1)) || clock)
  // "2 security reviewers", "2 more sessions", "5 of your engineers", "1 of the top 3": the figure counts things.
  const counts = unit === 'plain' && (at(f.j + 1) === 'of' || COUNT_NOUN.test(at(f.j + 1)) || (at(f.j + 1) !== 'per' && COUNT_NOUN.test(at(f.j + 2))))
  // A change in their numbers, never in Arize's price: "40% fewer", "cut debugging time 30%", "cutting
  // cost by 30%". "We could drop 10%" is Arize doing the cutting: an offer, not an outcome.
  const outcome = (() => {
    const after = OUTCOME_AFTER.test(at(last + 1)) ? at(last + 1) : at(last + 1) !== 'of' && OUTCOME_AFTER.test(at(last + 2)) ? at(last + 2) : ''
    // "We can come in 15% lower", "we can do it for 15% less": Arize's price moving, an offer.
    if (after) return !(/^(?:lower|less)$/.test(after) && offerBefore(t, f.start))
    for (let k = f.i - 1; k >= Math.max(0, f.i - 4); k--) {
      if (!CHANGE_VERB.test(at(k))) continue
      for (let p = Math.max(0, k - 3); p < f.i; p++) if (PRICE_THING.test(at(p)) || OUR_SIDE.test(at(p))) return false
      return true
    }
    return false
  })()
  if (unit === 'currency') return 'currency'
  if (pctAt >= 0 && at(pctAt + 1) === 'off') return 'percent_off'
  for (let k = f.j + 1; k <= f.j + 3; k++) {
    if (at(k) === 'off' && (/^(?:list|price)$/.test(at(k + 1)) || (at(k + 1) === 'the' && /^(?:list|price)$/.test(at(k + 2))))) return 'off_list'
  }
  for (let k = f.i - 3; k <= f.i - 2; k++) if (at(k).startsWith('discount') && at(k + 1) === 'of') return 'discount_of'
  // "3 months free", "2 free seats": a free term, on any call.
  if (at(f.j + 1) === 'free' || (/^(?:months?|years?|weeks?|days?|seats?|users?|licen[cs]es?)$/.test(at(f.j + 1)) && at(f.j + 2) === 'free')) return 'free'
  // "Net 60", "net 30 terms": payment terms, on any call.
  if (f.digits && at(f.i - 1) === 'net') return 'term'
  // A free period in other words: "free for the first 90 days", "the first 3 months are on us", "30 days
  // at no cost", "waive the first 90 days". Not "free text search across 90 days" (free names a thing).
  if (/^(?:months?|years?|weeks?|days?|quarters?)$/.test(at(f.j + 1))) {
    for (let k = f.i - 5; k <= f.j + 5; k++) {
      const w = at(k)
      // Not their time ("Is your team free for 2 weeks?", "Do you have a free week?"), nor their own
      // process waived ("Could security waive the 90-day review?"): only our side waives.
      const available = w === 'free' && (FREE_AVAILABLE_BEFORE.test(at(k - 1)) || (/^(?:a|any)$/.test(at(k - 1)) && FREE_AVAILABLE_BEFORE.test(at(k - 2))))
      const ourWaive = w.startsWith('waiv') && [1, 2, 3].some((d) => OUR_SIDE.test(at(k - d)) || /^(?:happy|glad)$/.test(at(k - d)))
      if ((w === 'free' && !available && FREE_PERIOD_NEXT.test(at(k + 1))) || ourWaive || (w === 'on' && at(k + 1) === 'us') || ((w === 'no' || w === 'zero') && /^(?:charge|cost)$/.test(at(k + 1)))) return 'free'
    }
  }
  // A figure within 3 words of a price word (a spelled number only when it's big: "the two price tiers" is fine).
  if ((f.digits || f.big) && !timing && !counts) {
    for (let k = f.i - 3; k <= f.j + 3; k++) {
      if (k >= f.i && k <= f.j) continue
      const w = at(k)
      if (PRICE_WORD.test(w) && !PRICE_TOPIC.test(at(k + 1))) {
        const theirs = w.startsWith('cost') && (THEIR_COST_AFTER.test(at(k + 1)) || THEIR_COST_NOUN.test(at(k + 1)) || THEIR_COST_BEFORE.test(at(k - 1)) || THEIR_COST_BEFORE.test(at(k - 2)) || /^(?:your|their)$/.test(at(k - 3)) || outcome)
        if (!theirs) return 'price_word'
      }
      if (w === 'per' && SEAT_WORD.test(at(k + 1))) return 'per_seat'
    }
  }
  // An offer or an acceptance with a figure. On a pricing call any figure counts; on other calls a %,
  // months or years (a term), or a large amount that counts nothing: "we could do 20%", "15% is
  // doable", "we can add 3 months", "I can match their 30k" (their quote offered back, no $ sign).
  const term = /^(?:months?|years?)$/.test(at(f.j + 1)) && at(f.j + 2) !== 'of'
  const offerable = (f.digits || f.big || term || pctAt >= 0) && !timing && !counts && !(pctAt >= 0 && outcome)
  if (offerable && (negotiation || pctAt >= 0 || term || scaled)) {
    if (offerBefore(t, f.start)) return 'offer'
    if (ACCEPT_AFTER.test(t.slice(f.end))) return 'offer'
  }
  if (!negotiation) return null
  if (pctAt >= 0 && !outcome) return 'percent'
  // A large figure on a pricing call is money ("40k", "40,000"), unless it counts things ("How many spans a day, 50 million?").
  if (scaled && !timing && !counts && !/\bhow\s+many\b/i.test(t)) return 'large'
  return null
}

/** An offer shape ends before this position in the same sentence ("we could do" ... "20%"). */
function offerBefore(t: string, pos: number): boolean {
  for (const m of t.matchAll(OFFER)) {
    const end = m.index + m[0].length
    if (end <= pos && !/[?!]|\.\s/.test(t.slice(end, pos))) return true
  }
  return false
}

/** The line offers something with a figure in it (any offer shape above, in the same sentence). */
function hasOfferShape(t: string): boolean {
  for (const m of t.matchAll(OFFER)) if (/^(?:[^?!.]|\.(?!\s))*\d/.test(t.slice(m.index + m[0].length))) return true
  return false
}

/** The sentence holding a position, and where it starts. */
function sentenceAt(t: string, pos: number): { text: string; start: number } {
  let start = 0
  for (const m of t.slice(0, pos).matchAll(/[.?!](?=\s)/g)) start = m.index + 1
  const rest = /[.?!](?=\s|$)/.exec(t.slice(pos))
  return { text: t.slice(start, rest ? pos + rest.index + 1 : t.length), start }
}

/**
 * Their own figure, asked back as a real question about it: a wh-question ("What's driving the 20?",
 * "Where does the 20% come from?"), their words recapped ("Last call you mentioned a $150k budget. Is
 * that still right?"), or a yes/no check of a plain % or cost figure ("Your costs went up 40% last
 * quarter?"). Never a yes/no question about a discount or an amount ("Would 20% off get this signed?").
 */
function asksTheirFigureBack(f: PriceFigure, reason: string, t: string, spend: Set<string>): boolean {
  if (reason === 'offer' || reason === 'free') return false
  const s = sentenceAt(t, f.start)
  const before = t.slice(s.start, f.start)
  if (WH_PROPOSES.test(s.text)) return false
  const opener = /^[\s"“(]*(?:(?:so|and|ok|okay|right|then|but|now)[,\s]+)*([a-z'’]+)/i.exec(s.text)?.[1]?.toLowerCase() ?? ''
  if (!YES_NO_OPENER.test(opener) && WH_WORD.test(before) && !MODAL.test(before)) return true
  // "you mentioned a $150k budget"; "What would 20% off mean for your budget?" proposes, so not with a "would".
  if (ATTRIBUTION.test(s.text) && !MODAL.test(s.text) && !WITH_ARIZE.test(s.text)) return true
  // "Is the $40,000 a month mostly GPT-4o?": what they spend today, checked back. Never a yes to the
  // amount, or the amount on our side ("Is $40k a deal?"), and never a budget they set for Arize.
  if (reason === 'currency' && spend.has(f.value) && !PROPOSING_OPENER.test(opener) && !YES_TO_AMOUNT.test(s.text)) return true
  // "Are you on net 60 with other vendors?": their payment terms asked back, like a plain %.
  return (reason === 'percent' || reason === 'price_word' || reason === 'term') && !PROPOSING_OPENER.test(opener)
}

/**
 * Their figure recapped as theirs in a statement: "You mentioned the $200k a year on Datadog." (pricing
 * line 1's value recap, said not asked). Never when the line makes it the deal: an offer, a yes, "that's
 * our price", "Done.", Arize's side in the line, or the figure said twice ("Your budget is $40k, so $40k
 * it is").
 */
function recapsTheirFigure(f: PriceFigure, reason: string, t: string, all: PriceFigure[]): boolean {
  // Only an amount of their money (their spend, their budget): never a discount or a %, which recapped
  // as a statement reads as agreeing to it ("You mentioned 20% off. Happy to.").
  if (reason !== 'currency' && reason !== 'large') return false
  if (CONDITION.test(t) || hasOfferShape(t) || OUR_PRICE.test(t) || ARIZE_SIDE.test(t)) return false
  if (all.filter((g) => g.value === f.value).length > 1) return false
  const s = sentenceAt(t, f.start)
  if (!ATTRIBUTION.test(s.text) || MODAL.test(s.text) || WITH_ARIZE.test(s.text)) return false
  // Nothing in the recap says it fits or settles anything ("Your budget of $150k covers the platform").
  if (RECAP_JUDGES.test(s.text.slice(f.end - s.start))) return false
  // Any other sentence of the line checks it with them ("...Does that still hold?"): a statement after
  // it ("That works.", "Expect about a tenth of that here.") may accept or price it.
  const rest = (t.slice(0, s.start) + t.slice(s.start + s.text.length)).split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter(Boolean)
  return rest.every((x) => x.endsWith('?'))
}
/** Words after their figure that judge it against Arize: it covers, fits, works, is enough, the same here. */
const RECAP_JUDGES = /\b(?:covers?|covering|fits?|works?|enough|doable|fine|plenty|same|cheaper|less|more\s+than|under|within|gets?\s+you|buys?|pays?\s+for|here)\b/i

/** The figures an approved item states, with what each is: a % only backs a %, money only money. */
function approvedFigures(text: string): Array<{ value: string; unit: PriceUnit; priced: boolean }> {
  const t = priceText(text)
  const toks = priceTokens(t)
  return priceFiguresIn(toks, t).map((f) => ({ value: f.value, unit: priceUnit(f, toks), priced: priceReason(f, toks, t, true) !== null }))
}

/**
 * Figures in the lines Keith says aloud (ASK/SAY and FOLLOW; HAPPENING is only for him) that would be
 * heard as a price, discount or term, and that approved knowledge doesn't back. unbackedNumbers misses
 * these when the buyer said the figure first: "we'd need 20% off" let "We can do 20%" through.
 * Allowed: a figure an approved item the card cites states, as the same kind of figure (its "30 days"
 * never backs "30% off"), and their own figure asked back as a real question that offers nothing and
 * ties it to no yes (asksTheirFigureBack). Returns the figures (for tests); callers show CHECK_PRICE
 * and log counts, never the figures.
 */
export function priceFigures(card: Partial<HelpCardContent>, opts: PriceCheckOpts = {}): string[] {
  const negotiation = opts.callType === 'negotiation'
  const cited = (card.source_ids ?? []).map((id) => opts.sources?.get(id)).filter((s) => s?.kind === 'knowledge')
  const approved = approvedFigures(cited.map((s) => s!.detail).join('\n'))
  const theirs = figureValues(opts.theirText ?? '')
  const theirCounts = countValues(opts.theirText ?? '')
  const theirSpend = spendValues(opts.theirText ?? '')
  // A FOLLOW that is itself a question asks too.
  const lines = [
    { text: card.primary ?? '', question: card.primary_kind === 'ask' },
    { text: card.follow_up ?? '', question: (card.follow_up ?? '').trim().endsWith('?') },
  ]
  const out: string[] = []
  for (const line of lines) {
    if (!line.text) continue
    const t = priceText(line.text)
    const toks = priceTokens(t)
    const mayAskBack = line.question && !hasOfferShape(t) && !CONDITION.test(t)
    // "A free month", "the first month is on us": a free period with no figure, never asked back.
    const free = FREE_PERIOD.exec(t)
    if (free && !FREE_PERIOD.test(cited.map((s) => s!.detail).join('\n'))) out.push(free[0])
    const figs = priceFiguresIn(toks, t)
    for (const f of figs) {
      const reason = priceReason(f, toks, t, negotiation)
      if (!reason) continue
      const unit = priceUnit(f, toks)
      if (f.value && approved.some((a) => a.value === f.value && (unit === 'plain' ? a.unit !== 'plain' || a.priced : a.unit === unit))) continue
      if (mayAskBack && f.value && theirs.has(f.value) && asksTheirFigureBack(f, reason, t, theirSpend)) continue
      // "Are your payment terms net 30 with every vendor?": a question about their terms, not ours.
      if (reason === 'term' && line.question && /\b(?:your|their)\s+(?:standard\s+)?(?:payment\s+)?terms\b/i.test(sentenceAt(t, f.start).text)) continue
      if (f.value && theirs.has(f.value) && recapsTheirFigure(f, reason, t, figs)) continue
      // "Is that 10 million across all three assistants?" after they said "10 million traces": a big
      // figure they gave as a count is their volume, not a price, unless the line offers something.
      if (reason === 'large' && f.value && theirCounts.has(f.value) && !hasOfferShape(t)) continue
      out.push(f.raw)
    }
  }
  return [...new Set(out)]
}
