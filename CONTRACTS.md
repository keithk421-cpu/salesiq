# Core Contracts

## AudioFrame
session_id; stream(local_mic|system_remote); seq; monotonic_start_ms; duration_ms; sample_rate_hz; channels; encoding; payload; discontinuity_before.

## DiarizedWord
session_id; stream; word; start_ms; end_ms; confidence; speaker_cluster nullable; is_final; provider_segment_id.

## Turn
turn_id; session_id; stream; speaker_cluster; speaker_identity_id nullable; speaker_role(keith|teammate|buyer|unknown); start_ms; end_ms; text; final; source_word_ids; gap_before.

Rules: build turns from finalized words; preserve overlap/gaps; never coerce unknown remote speech to buyer.

## SpeakerIdentity
identity_id; display_name; default_role; enrollment_status; confidence_thresholds; model_id/hash; model_license_record; timestamps.

## CallState
session_id; call_type; call_goal; desired_outcomes[]; topics[]; next_step; active_thread; objections[]; competitors[]; accepted_facts[]; last_manual_correction_at; version.

## DiscoveryTopic
id; label; status(open|partial|done); hidden_rung_state; evidence_turn_ids[]; manually_corrected.

## NextStep
action nullable; owner nullable; date nullable; status(none|proposed|agreed|completed); evidence_turn_ids[]; manually_corrected.

## SalesMove
no_move; clarify_current_state; explore_process; test_for_friction; quantify_impact; clarify_scale; identify_owner; clarify_desired_state; clarify_requirement; clarify_decision; handle_objection; handle_competitor; technical_clarification; technical_answer; confirm_next_step; call_control.

## DeeperSuggestion
source_turn_id; move; question; missing_label; evidence_turn_ids[]; generated_at; expires_at; assumes_unverified_pain=false.

## CoachCard
trigger_type; trigger_turn_ids[]; move; say_this nullable; ask_next nullable; source_ids[]; created_at; expires_at; speaker_role_at_trigger; latency_ms.

## FeedbackEvent
card_id; type(useful|should_have_stayed_quiet|bad); bad_reason nullable(wrong_move|assumed_too_much|already_known|too_generic|too_late|bad_wording|unsupported|other); optional_note; timestamp.

## Evidence
evidence_id; source_type(live_turn|final_transcript|email|notion|approved_reference|manual); source_id; exact_locator; text; provenance; accepted; temporal_status(current|superseded|conflicting).

## Context
HOT: ~30 seconds recent dialogue. WARM: compact CallState + current thread. COLD: older transcript/evidence retrieved only when needed.

## Invariants
Asked does not imply answered. Proposed does not imply agreed. Manual corrections are never silently overwritten. Models propose deltas; code validates state transitions. NO_MOVE is valid.
