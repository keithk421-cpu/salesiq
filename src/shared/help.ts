/** M1 contracts: HELP, call setup, speaker labels, knowledge, feedback. Mirrors CONTRACTS.md where defined there. */
import type { Stream } from './contracts'

export const SALES_MOVES = [
  'no_move', 'clarify_current_state', 'explore_process', 'test_for_friction', 'quantify_impact', 'clarify_scale',
  'identify_owner', 'clarify_desired_state', 'clarify_requirement', 'clarify_decision', 'handle_objection',
  'handle_competitor', 'technical_clarification', 'technical_answer', 'confirm_next_step', 'call_control',
] as const
export type SalesMove = (typeof SALES_MOVES)[number]

export const CALL_TYPES = ['discovery', 'demo', 'technical_deep_dive', 'follow_up', 'negotiation', 'other'] as const
export type CallType = (typeof CALL_TYPES)[number]

/** The buyer's deployment for this call. Knowledge scoped to another deployment is not offered as fact. */
export const DEPLOYMENTS = ['unknown', 'saas', 'self_hosted'] as const
export type Deployment = (typeof DEPLOYMENTS)[number]

export interface CallSetup {
  call_type: CallType
  call_goal: string
  desired_outcomes: string[]
  account: string
  deployment: Deployment
}

export type SpeakerRole = 'keith' | 'buyer' | 'teammate' | 'unknown'

/** Per-call, manual (tap-to-name). Scoped to a Deepgram cluster in one connection epoch. Never gates HELP. */
export interface SpeakerLabel {
  cluster: string
  role: Exclude<SpeakerRole, 'keith'>
  name: string | null
}

/** A transcript utterance as the context builder sees it, with when it became available. */
export interface MemoryTurn {
  id: string
  stream: Stream
  cluster: string | null
  start_ms: number
  end_ms: number
  text: string
  /** Session ms when this text was available to the app (final arrival). Replay uses it to avoid leaking the future. */
  available_ms: number
}

export interface MemoryGap {
  id: string
  stream: Stream
  cause: string
  start_ms: number
  end_ms: number | null
}

// ---------------- knowledge ----------------

export type KnowledgeCategory = 'product' | 'deployment_security' | 'competitive' | 'objection_handling' | 'other'

export interface KnowledgeDocMeta {
  doc_id: string
  title: string
  category: KnowledgeCategory
  /**
   * Whose product the document describes (front matter `vendor`, lower case): "arize", a competitor's
   * name ("langsmith"), "neutral" (guidance) or "mixed". Absent when the file doesn't say.
   */
  vendor?: string
  source: string
  /** Readable label only. Approval is bound to content_hash, never to this string. */
  version: string
  /** sha256 of the body plus the material front matter (everything except approval fields). */
  content_hash: string
  /** Importing is not approval. True only if Keith approved this exact content in the app. */
  approved: boolean
  /** Keith approved an earlier content of this document; the current content needs review again. */
  needs_reapproval: boolean
  approved_by: string | null
  approved_at: string | null
  /** ISO date; past => stale (not stated as current fact). */
  review_by: string | null
  applies_to: string[]
  tags: string[]
  file: string
}

export interface KnowledgeChunk {
  chunk_id: string
  doc_id: string
  title: string
  heading: string
  /** Claim text, at most KNOWLEDGE_TEXT_MAX characters; the model receives all of it. */
  text: string
  /** The section's full "Source:" reference, kept separately so it is never cut off. */
  source_ref: string
  meta: KnowledgeDocMeta
  stale: boolean
}

// ---------------- HELP card ----------------

export type PrimaryKind = 'ask' | 'say'

/** What the model returns (one bounded structured request; move chosen before wording). */
export interface HelpCardContent {
  /** Internal/debug only. Not shown as a section. */
  move: SalesMove
  primary_kind: PrimaryKind
  primary: string
  happening: string | null
  follow_up: string | null
  source_ids: string[]
  /** e.g. "No approved current source for SSO details - offer to follow up". Debug + optional small note. */
  note: string | null
}

/** help_requested: the HELP button; wrap_requested: the WRAP button (lock a dated next step before hanging up). */
export type HelpOrigin = 'help_requested' | 'wrap_requested' | 'coach_proactive'

export type HelpStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'timeout' | 'cancelled' | 'superseded'

export interface HelpTiming {
  pressed_at_wall: number
  /** Hotkey -> first complete, usable guidance (primary line complete and valid). */
  first_usable_ms: number | null
  /** Hotkey -> fully validated card. */
  complete_ms: number | null
  /** Hotkey -> first byte from the model. */
  first_token_ms: number | null
  served_from_prefetch: boolean
  /** Hotkey -> the approved passage on screen (it rides on the press's first card event); null when none was shown. Absent on older rows. */
  passage_ms?: number | null
  /** How long building this request's context took, and the knowledge search inside it (ms). Absent on older rows. */
  context_ms?: number
  knowledge_ms?: number
}

/**
 * The approved knowledge section shown the moment Keith presses HELP, before Claude answers: only
 * from an approved, current, in-scope document, and only when it clearly matches what the other side
 * just said (see help/passage.ts).
 */
export interface ApprovedPassage {
  doc_id: string
  /** The knowledge file's title. */
  title: string
  heading: string
  /** Every chunk of the section ("k:<doc>#<n>"): a card citing any of them used this section. */
  chunk_ids: string[]
  /** The first sentence or two (about 200 characters), shown straight away; "Possible reason" lines are left out. */
  snippet: string
  /** The whole section, shown when Keith opens the box. */
  text: string
  /** The section's "Source:" paragraph, in full. */
  source_ref: string
  /** The document's deployment scope ([] or "all" = every deployment). */
  applies_to: string[]
  /** The finished card cites this section (only ever true on a complete card). */
  used_by_card: boolean
}

export interface HelpUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /** USD, computed from the configured price table (output includes billed thinking tokens). */
  cost_usd: number
}

export interface HelpModelConfig {
  /** 'mock' is a clearly-labelled offline stand-in. */
  provider: 'anthropic' | 'mock'
  model: string
  effort: 'low' | 'medium' | 'high'
  /** Sonnet 5.5 only: 'between_tools' turns thinking off. Opus 5.5 cannot disable thinking. */
  thinking: 'adaptive' | 'off'
  timeout_ms: number
  max_tokens: number
}

/** Context references kept with the request so it can be audited/replayed later. */
export interface HelpContextRefs {
  at_session_ms: number
  hot_turn_ids: string[]
  thread_turn_ids: string[]
  earlier_turn_ids: string[]
  knowledge_chunk_ids: string[]
  /** Content hash of each knowledge chunk's document then (same order), so a saved practice moment can tell if it changed since. Absent on older rows. */
  knowledge_hashes?: string[]
  /** The call setup the request was built with (it can be edited mid-call). Absent on older rows. */
  call_setup?: CallSetup
  /** Speaker labels the request was built with (they can be renamed later). Absent on older rows. */
  labels?: SpeakerLabel[]
  /** The <earlier_calls> items the request showed (account memory, dated). Absent when there were none, and on older rows. */
  earlier_calls?: Array<{ kind: AccountMemoryKind; text: string; date: string }>
  gaps_noted: string[]
  provisional_text: boolean
  transcript_lag_ms: number | null
}

export interface HelpCardEvent {
  request_id: string
  seq: number
  origin: HelpOrigin
  status: HelpStatus
  content: Partial<HelpCardContent>
  /** Shown as a small warning on the card, e.g. transcript gap or lag. */
  warnings: string[]
  timing: HelpTiming
  model_label: string
  mock: boolean
  error: string | null
  /** Plain-language warnings about a finished card (an unbacked number or capability claim). */
  checks: string[]
  /** Who the call is with, as set when this request was built (so a wrong setup is visible). */
  setup: { account: string; deployment: Deployment }
  /** Sources resolved for display (collapsed by default). */
  sources: Array<{ id: string; kind: 'turn' | 'knowledge'; label: string; detail: string }>
  /** The approved passage found at the press, carried on every event for this request (null or absent: none). */
  passage?: ApprovedPassage | null
}

// ---------------- feedback ----------------

/** A rating (the last one per card counts), whether Keith used the line (last of used/unused counts), or a note. */
export type FeedbackType = 'useful' | 'should_have_stayed_quiet' | 'bad' | 'used' | 'unused' | 'note'
export const RATINGS = ['useful', 'should_have_stayed_quiet', 'bad'] as const

/** One card from a finished call, for the after-call review (local only). */
export interface CallCard {
  id: string
  at_session_ms: number | null
  status: string
  primary_kind: 'ask' | 'say' | null
  primary: string | null
  follow_up: string | null
  rating: (typeof RATINGS)[number] | null
  bad_reason: BadReason | null
  used: boolean
  note: string | null
}
export type BadReason = 'wrong_move' | 'assumed_too_much' | 'already_known' | 'too_generic' | 'too_late' | 'bad_wording' | 'unsupported' | 'other'

export interface FeedbackEvent {
  card_id: string
  /** HELP-requested feedback is a different signal from future proactive Coach feedback. */
  origin: HelpOrigin
  type: FeedbackType
  bad_reason: BadReason | null
  optional_note: string | null
  timestamp: string
}

// ---------------- call notes ----------------

/** What a stated fact is about. The first four are also the neutral "not covered yet" topics. */
export const NOTE_FACT_KINDS = ['timeline', 'decision_process', 'current_tooling', 'success_criteria', 'team', 'budget', 'other'] as const
export type NoteFactKind = (typeof NOTE_FACT_KINDS)[number]
/** The fixed, neutral list "not covered yet" comes from (never a pain or a problem). */
export const NOT_COVERED_TOPICS = ['timeline', 'decision_process', 'current_tooling', 'success_criteria'] as const
export type NotCoveredTopic = (typeof NOT_COVERED_TOPICS)[number]

/** One line of the notes, with the transcript turn(s) it came from. */
export interface CallNoteItem {
  text: string
  turn_ids: string[]
}

/** Running notes of a live call, only from what was actually said. Each update replaces the whole set. */
export interface CallNotes {
  /** What they are talking about now. */
  topic: CallNoteItem | null
  buyer_wants: CallNoteItem[]
  /** Questions the buyer's side asked that haven't been answered on the call yet (asked is not answered). */
  open_questions: CallNoteItem[]
  concerns: CallNoteItem[]
  facts: Array<CallNoteItem & { kind: NoteFactKind }>
  /** Proposed is not agreed: "agreed" only when the other side accepted it. */
  next_steps: Array<CallNoteItem & { status: 'proposed' | 'agreed' }>
  not_covered: NotCoveredTopic[]
}

/** What the call screen's notes panel shows. "finishing": the closing pass after Stop (the last minutes). */
export interface CallNotesState {
  status: 'off' | 'waiting' | 'updating' | 'paused' | 'finishing' | 'stopped' | 'blocked'
  notes: CallNotes | null
  /** Wall clock (epoch ms) of the last successful update, for "updated 40 s ago". */
  updated_at: number | null
  /** Session time the notes cover up to. */
  as_of_ms: number | null
  updates: number
  mock: boolean
  /** Plain words when updates stopped because of the Claude key, credit or model access. */
  problem: string | null
}

// ---------------- wrap-up after Stop ----------------

/**
 * The wrap-up Keith confirms after a call: what Arize owes them, what they owe, the agreed next step,
 * what was only proposed, and their questions still unanswered. Built once after the closing notes
 * pass, only from what was said (each item cites the transcript lines it came from); Keith ticks,
 * edits, removes or adds items. Nothing is sent anywhere: the follow-up is a draft he copies.
 */
export const WRAPUP_SECTIONS = ['we_owe', 'they_owe', 'agreed', 'proposed', 'open_questions'] as const
export type WrapupSection = (typeof WRAPUP_SECTIONS)[number]

export interface WrapupItem {
  /** Stable within the call's wrap-up ("w1", "w2", ...; Keith's own items "k1", ...). */
  id: string
  section: WrapupSection
  /** Keith can edit it. */
  text: string
  /** Who will do it / who was asked, and when, only as said on the call (null when not said). */
  who: string | null
  when: string | null
  /** The transcript turns it came from (empty for an item Keith added). */
  turn_ids: string[]
  /** A short word-for-word quote from the first of those turns ('' for an item Keith added). */
  quote: string
  /** Keith's decision. Items he adds start confirmed. */
  state: 'pending' | 'confirmed' | 'removed'
  added_by_keith: boolean
}

/** The follow-up email draft (Keith copies it; nothing is sent). */
export interface FollowupDraft {
  subject: string
  body: string
  created_at: string
  /** Plain-language "check before sending" warnings (a number or Arize claim without an approved source). */
  checks: string[]
  /** Approved knowledge sections the draft was allowed to use. */
  knowledge_chunk_ids: string[]
  mock: boolean
}

export interface CallWrapup {
  session_id: string
  /** building: closing notes pass / wrap-up request running; drafting: the email is being written. */
  status: 'building' | 'ready' | 'drafting' | 'failed' | 'off'
  account: string
  started_at: string
  items: WrapupItem[]
  email: FollowupDraft | null
  /** Plain words when building or drafting failed. */
  error: string | null
  mock: boolean
}

// ---------------- account memory ----------------

/** Calls are grouped by account: the name Keith typed, trimmed, lower case, single spaces. */
export function accountKey(account: string): string {
  return account.trim().toLowerCase().replace(/\s+/g, ' ')
}

export type AccountMemoryKind = 'wants' | 'promised' | 'they_owe' | 'agreed' | 'open' | 'fact'

/** "Last time with <account>": what earlier calls with this account left behind, newest first. */
export interface AccountMemory {
  /** As Keith last typed it. */
  account: string
  calls: number
  last_call_at: string | null
  /** The last call's setup, for "Reuse last setup". */
  last_setup: CallSetup | null
  items: Array<{ kind: AccountMemoryKind; text: string; date: string; session_id: string }>
}
