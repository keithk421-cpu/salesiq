# HELP scenario format (Level 3 Golden candidates)

One JSON file per scenario in `evals/scenarios/help/`. Agents may draft; **every draft has `"golden_approved": false`. Only Keith flips it to true.**

```jsonc
{
  "id": "objection-01-budget-next-year",        // unique, kebab-case, matches file name
  "category": "neutral_discovery | objection | competitor | technical | answered | sa_leading | older_context | sources | call_mode | real_call",
  "tags": ["unknown_speaker", "technical_confusion", "fully_answered", "older_context", "missing_source", "stale_source", "sa_handling", "buyer_claim"],
  "golden_approved": false,
  "synthetic": true,                             // fictional company/people; no real customer data
  "call_type": "discovery | demo | technical_deep_dive | follow_up | negotiation | other",
  "length_min": 45,                              // optional (M5): how long the call is meant to run, for the "about 10 minutes
                                                 // left" cue; absent = the type's default (discovery 30, demo 60, ...)
  "no_sa": false,                                // optional (M5): no Arize SA on this demo or deep-dive
  "call_goal": "one concrete goal for the call",
  "desired_outcomes": ["..."],
  "deployment": "unknown | saas | self_hosted",  // optional, default unknown: the buyer's deployment as set for the call
  "speakers": {                                  // remote speaker clusters as Keith tagged them (tap-to-name).
    "e1:s0": { "role": "buyer | teammate | unknown", "name": "Dana (Dir. ML Platform)" },  // name may be null
    "e1:s1": { "role": "unknown", "name": null }  // unlabeled speakers are normal and must never block HELP
  },
  // Transcript ONLY up to the decision point (when Keith presses HELP). t = seconds from call start.
  // who: "keith" for Keith's mic, otherwise a cluster key from "speakers".
  // "end" (optional) = when the utterance ended; replay assumes the final transcript becomes available
  // ~1 s after "end" (or after t + words/2.5 s when absent). Replay never shows text before it was available.
  // A line that starts before help_at_s and is still going at the press (M5: the SA mid-screen, a buyer
  // mid-reaction) reaches HELP only as live words: its first part, with that speaker's cluster.
  "transcript": [
    { "t": 0, "who": "keith", "text": "..." },
    { "t": 6.5, "end": 14.0, "who": "e1:s0", "text": "..." }
  ],
  // Optional transcript gaps (device/STT) the HELP context must surface rather than pretend it heard.
  "gaps": [ { "start": 40.0, "end": 47.5, "stream": "system_remote", "cause": "provider_disconnect" } ],
  "help_at_s": 92,                               // >= last t
  // Knowledge snippets available in this scenario (test fixtures; may be empty). Importing is not approval:
  // only approved, non-stale material may be stated as fact. Fixture text is illustrative, not verified Arize facts.
  "knowledge": [ {
    "id": "k-otel", "title": "...", "text": "...",
    "category": "product | deployment_security | competitive | objection_handling",
    "source": "e.g. 'Arize security FAQ (fixture)'", "version": "2026-06",
    "approved": true, "review_by": "2027-01-01",   // stands in for Keith's in-app approval (default true); review_by in the past => stale
    "applies_to": ["saas"]                          // optional scope: saas | self_hosted | all. Out-of-scope items are never offered as fact
                                                    // when the call's deployment is known; with unknown deployment HELP sees the scope.
    // "text" may use the pack format: "## heading", claim text, then a "Source:" paragraph (kept whole, sent with the claim).
  } ],
  "best_moves": ["handle_objection"],            // SalesMove values (see below)
  "acceptable_moves": ["clarify_decision"],
  "unacceptable_behaviors": ["Assumes the buyer has budget pain", "Quotes a price"],
  "forbid_regex": ["\\bdiscount"],               // optional machine-checkable Level 1 extras; JavaScript regex, always
                                                 // case-insensitive (no inline "(?i)": it does not compile in JS)
  "silence_preferred": false,                    // HELP is manual, so usually false
  "acceptable_questions": ["optional examples of good next questions"],
                                                 // each must pass Level 1 (tests/scenarios.test.ts); when best_moves
                                                 // include technical_answer or handle_competitor the example cites the
                                                 // approved K# ids in context, otherwise it cites none
  "keith_notes": "",                             // the reviewer's note on this scenario (never sent to HELP)
  "account": "...",                              // optional: the account name, sent in the call setup
  "account_notes": "Who · Sep 2: ...\nTheir setup: ..."
                                                 // optional (M4): Keith's own "What I know" notes on the account, as HELP
                                                 // gets them in <keith_notes> (not said on the call, not Arize fact; "To learn"
                                                 // lines are left out). Not the same as keith_notes above.
}
```

**Call-mode scenarios (M5, `mode-*.json`, `"category": "call_mode"`)** test what each call type's mode should do at one
moment. The mode's facts (time left, questions since the last play-back, who's talking now...) are counted from the
replayed transcript, so a scenario sets them up with its lines, `help_at_s` and `length_min`; there is no field for them.
Which press it replays is stored, as in a saved moment, and must be the one Keith would get live from the same lines
(`decidePress`; tests/scenarios.test.ts checks every scenario): `"wrap": "button"` for a WRAP press, `"wrap": "closing"` for a
HELP press whose last 30 seconds sound like the call ending, and `"press_mode"` with `"press_detail"` for the smarter presses,
for example `"press_mode": "opening", "press_detail": {"earlier_calls": true}` for a press in the first 5 minutes of a return
call while the other side has said little. A `step_2` tag marks a moment judged only once the SA-aware demo cards are on: until
then it counts in Level 1 and the timings, not in move agreement. A `live_words` tag allows the last line of a stream to still be
going at the press (HELP sees only its first words, live); anywhere else every line must be over by then.

SalesMove values: `no_move`, `clarify_current_state`, `explore_process`, `test_for_friction`, `quantify_impact`, `clarify_scale`, `identify_owner`, `clarify_desired_state`, `clarify_requirement`, `clarify_decision`, `handle_objection`, `handle_competitor`, `technical_clarification`, `technical_answer`, `confirm_next_step`, `call_control`.

**Practice moments saved from Keith's real calls** (after-call review → "Save as practice moment") use the same format with
`"category": "real_call"`, `"synthetic": false`, `"source": "real_call"` and `"golden_approved": false`. They live only in the app's data
folder (`practice/`), never in this repo. Extra fields:

```jsonc
{
  "title": "Account · 2026-10-05 14:32",          // account, date and time of the press
  "account": "...",                               // sent in the call setup on replay, like a live request
  "request_id": "...",                            // the HELP request it was saved from (one moment per card)
  "observed": { "move", "primary_kind", "primary", "follow_up", "model", "rating", "bad_reasons", "used", "note" },
  "unacceptable_moves": ["..."]                   // optional: moves Keith rated Bad: wrong move (a move listed here never agrees)
}
```

Only what HELP could see at the press is saved: turns available by then (a line still being spoken is cut at the press), the
labels and call setup the request was built with, and the knowledge sections the request used that are still approved and
unchanged (copied in, review dates left out). Expected moves come only
from Keith's feedback: Useful or "I used this line" makes the call's move acceptable, Bad with "wrong move" puts it in
`unacceptable_moves`; otherwise none. With no `best_moves`, any other move is not judged. The speed test runs them only when
Keith ticks "Include my saved moments", reports them in their own section, and writes that report to `reports/mine/` as `-mine`
(never in support files). A moment that can't be replayed is reported as failed without stopping the run.

Rules every scenario encodes:
- A neutral answer is not an objection or a problem. Never invent pain, urgency, dissatisfaction or ownership.
- Asked is not answered; proposed is not agreed. A question the buyer already answered (even with "no", or before Keith asked it) is not re-asked.
- A buyer's claim about Arize or a competitor is a buyer statement, not verified documentation.
- Without approved, current material, the right output is a useful clarification or follow-up, not an invented answer.
- HELP never depends on speaker roles; unknown speakers are normal.

Grading (EVALS.md): exact wording is never required. Grade the move, the premise, usefulness and prohibited behavior.
