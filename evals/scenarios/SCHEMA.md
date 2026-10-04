# HELP scenario format (Level 3 Golden candidates)

One JSON file per scenario in `evals/scenarios/help/`. Agents may draft; **every draft has `"golden_approved": false`. Only Keith flips it to true.**

```jsonc
{
  "id": "objection-01-budget-next-year",        // unique, kebab-case, matches file name
  "category": "neutral_discovery | objection | competitor | technical",
  "golden_approved": false,
  "synthetic": true,                             // fictional company/people; no real customer data
  "call_type": "discovery | demo | technical_deep_dive | follow_up | negotiation | other",
  "call_goal": "one concrete goal for the call",
  "desired_outcomes": ["..."],
  "speakers": {                                  // remote speaker clusters as Keith tagged them (tap-to-name)
    "e1:s0": { "role": "buyer | teammate | unknown", "name": "Dana (Dir. ML Platform)" }
  },
  // Transcript ONLY up to the decision point (when Keith presses HELP). t = seconds from call start.
  // who: "keith" for Keith's mic, otherwise a cluster key from "speakers".
  "transcript": [
    { "t": 0, "who": "keith", "text": "..." },
    { "t": 6.5, "who": "e1:s0", "text": "..." }
  ],
  "help_at_s": 92,                               // >= last t
  // Approved knowledge snippets available to HELP in this scenario (test fixtures; may be empty).
  "knowledge": [ { "id": "k-otel", "title": "...", "text": "..." } ],
  "best_moves": ["handle_objection"],            // SalesMove values (see below)
  "acceptable_moves": ["clarify_decision"],
  "unacceptable_behaviors": ["Assumes the buyer has budget pain", "Quotes a price"],
  "forbid_regex": ["(?i)discount"],              // optional machine-checkable Level 1 extras
  "silence_preferred": false,                    // HELP is manual, so usually false
  "acceptable_questions": ["optional examples of good next questions"],
  "keith_notes": ""
}
```

SalesMove values: `no_move`, `clarify_current_state`, `explore_process`, `test_for_friction`, `quantify_impact`, `clarify_scale`, `identify_owner`, `clarify_desired_state`, `clarify_requirement`, `clarify_decision`, `handle_objection`, `handle_competitor`, `technical_clarification`, `technical_answer`, `confirm_next_step`, `call_control`.

Grading (EVALS.md): exact wording is never required. Grade the move, the premise, usefulness and prohibited behavior.
