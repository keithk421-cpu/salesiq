# M1: Replay + HELP

Status: **built and tested offline; live model testing waits for Keith's key (entered locally in the app).** Not accepted until HELP is used on real calls (build-order step 5).

Exit criterion (IMPLEMENTATION_PLAN): Keith gets stuck, presses HELP, and gets something usable while the moment is live. The winning model is the one that consistently does this: the buyer gives a complicated answer, HELP understands the actual point, suggests a neutral, useful continuation, and gets it on screen in time.

## What Keith sees
Ctrl+Alt+H (registered only if free; otherwise the UI says so) or the **HELP** button:
- *What's happening*: one short sentence, only when useful.
- **Ask** or **Say**: the one useful next line.
- An optional follow-up, only when it adds something.
- Sources, collapsed. A small warning if part of the call wasn't heard (gap) or the last seconds are still being transcribed.
- **Useful / Should've stayed quiet / Bad** (+ optional reason). Each tap records feedback. Nothing trains or rewrites itself.

The sales move is chosen internally (logged and stored), never shown as a section.

## Build order (as requested)
1. **Replay and context assembly**: `src/main/help/{callMemory,context,replay}.ts`. As-of-time queries; a finished line is available ~1 s after it ends, and in-progress speech is only provisional interim text. No later transcript or post-call corrections leak into a test (tests mutation-checked).
2. **Manual per-call speaker labels**: tap a remote speaker (buyer / teammate-SA / unknown, optional name). Scoped to the connection epoch. Unknown speakers never block HELP.
3. **HELP end to end**: `src/main/help/{prompt,protocol,models,engine}.ts`, `src/main/helpService.ts`, UI.
4. **Feedback and scenario evaluation**: SQLite feedback (origin `help_requested`, distinct from future proactive Coach `coach_proactive`), 25 draft scenarios, Level 1 checks, benchmark, promptfoo.
5. **Real-call latency and usefulness testing**: Keith's step (below).

## Context HELP uses (all speakers, never gated by role)
- **Last 30 s verbatim**, plus provisional words still being transcribed (labelled).
- **Call setup**: type, goal, desired outcomes, account. **Participants**: manual labels; unlabeled is normal.
- **Recent thread**: the few minutes before that, compact.
- **Earlier in the call**: SQLite FTS5 search of older turns relevant to what's being discussed.
- **Approved knowledge**: FTS5 + aliases + tags; no embeddings. Only approved, in-scope documents are searched. Search reads the newest words first (so the buyer's latest question is never cut by the term cap) and ranks by concepts: each spoken word counts once with its synonyms, rarer words count more, heading matches count extra, blended with bm25. Each section is indexed under its heading and file title; a file's tags only break ties between files (repeating them in every section made the most telling words, such as a competitor's name, rank worse).
- **Transcript status**: gaps and lag, so HELP never pretends it heard something.

## Knowledge rules
- Local folder (`%APPDATA%/Sales Copilot M0/knowledge`), never in Git. Only files directly in it are read; material still under review stays outside it.
- Each document keeps source, version, review-by date and applies-to (one scope per file: `saas`, `self_hosted` or `all`; split mixed files).
- **Approval happens in the app only and is bound to the exact content reviewed**: a sha256 of the body plus the material front matter (title, category, source, version, review_by, applies_to, tags). Any edit, even with the same readable version, needs approval again (the list shows "Changed: approve again"). `approved: true` written in a file approves nothing, so no tool or import can approve for Keith. Revoking always wins. Restoring exactly the approved content restores its approval.
- Approval is per document, so a document should only contain sections that are ready for the same use. "Verify before stating" text inside an approved file is not an enforced block.
- Only approved, current, in-scope material can be stated as fact. Unapproved documents are not searched at all (they cannot crowd out an approved answer). Stale documents are named only. Documents scoped to another deployment than the call's are named only ("covers SaaS only: offer to check").
- The call's deployment is set in the setup strip (not sure / SaaS / self-hosted). With "not sure", HELP sees each item's scope and must state it or ask.
- Each `## ` section is claim text (at most 700 characters, all of which the model receives) plus one `Source:` paragraph kept whole and sent with it; the card's sources show both in full.
- A buyer's claim about Arize or a competitor is labelled as a speaker statement, not verified fact. "Possible reason" notes in objection material are hypotheses about buyers in general; HAPPENING describes only what was said on the call.
- Source authority depends on the claim: product docs for product behavior, the current plan source for entitlements, Security/Legal-approved answers for promises, permission for customer references, current competitor docs for competitor features. When equally relevant sources disagree, the claim is held for its owner.
- With no docs, HELP still gives questions and follow-ups.
- Scale note: each search reads every document's approval state (one small query per document). Fine for a few dozen files; add a cache before growing the pack to hundreds.

## Model and latency design
- **Default: Claude Sonnet 5.5**, thinking off (`between_tools`), effort `low`. **Opus 5.5** is selectable (adaptive thinking, effort `low`; Opus can't turn thinking off). The production default is chosen by the benchmark, not by general rankings.
- **One bounded request.** The output is short labelled lines with `MOVE:` first, then `ASK:`/`SAY:`. So the move is selected before any wording, without a second sequential call. Plain lines instead of JSON avoid structured-output grammar warm-up and JSON overhead, and they let the first complete line show while the rest streams.
- **"Usable" is strict.** A complete Ask/Say line (newline-terminated) after a valid MOVE, at least 3 words, and not a heading, fragment or placeholder. Spinners and half sentences don't count.
- **Prefetch (on by default, toggle in Setup).** After the other side finishes speaking, HELP prepares a candidate in the background (Keith's own words only cancel a pending one; at most 4 a minute). It's shown only if Keith presses and nothing new was said since; otherwise a fresh request runs. This costs extra background requests (recorded with `prefetch=1`, totalled in the per-call scorecard) and buys a near-zero wait for the common case. A key, credit or model-access error stops background work until a request succeeds again.
- **Resilience.** One quick SDK retry for a busy or dropped request inside the 8 s deadline; errors shown in plain words (logs keep a short code). A line that streamed in but whose answer then failed is shown struck through as "Don't use this line". A finished card with a number not found in the call or approved knowledge, or an Arize capability claim without a cited K# source, carries a yellow "check before saying" note.
- **HELP-ready light** under the HELP button: a free key check (model lookup, no tokens) at app start, call start and key save; states ready / practice (no key) / key not working / out of credit / offline.
- **After-call review.** "Review this call's cards" after Stop: every card shown, with rating (last tap wins), "I used this line" and a note per card (stored as feedback rows; the scorecard counts them, never the text).
- **Practice moments from real calls.** "Save as practice moment" on a card in the after-call review writes `practice/<id>.json` (data folder only) in the scenario format, `category: real_call`, `synthetic: false`, never approved: the call as it stood at that press (turns available by then, a line still being spoken cut at the press, the call setup and labels the request was built with via the new `call_setup` and `labels` refs (older rows: the call's latest setup and labels set by the press, noted), the approved knowledge sections the request used copied in via `knowledge_chunk_ids` + the new `knowledge_hashes` ref; sections edited, removed or no longer approved since are left out and noted). The card HELP gave and Keith's rating/used/note are kept as `observed` and notes; expected moves only from his feedback (Useful or used → acceptable; Bad: wrong move → `unacceptable_moves`; otherwise none, other moves not judged). One moment per card, never a second file; saving it again (the review does this when Keith changes a saved card's rating, tick or note) rewrites only the feedback-derived parts (`observed`, the derived move, its wrong-move behavior, the feedback lines of the notes) and keeps his edits. The speed test includes them when "Include my saved moments (N)" is ticked, reports them in their own section (never in the summaries, baselines or anything that gates; a moment that can't be replayed is reported as failed, never stopping the run) and writes that report to `reports/mine/` as `-mine`, which Save support files leaves out.
- **Export HELP feedback.** Diagnostics, period Last 7 days / Last 30 days / Everything: one Markdown file to Downloads (`SalesCopilot-feedback-<date>.md`, never overwriting an earlier one) with a summary (calls, cards, ratings, bad reasons, lines used, notes, median time to first usable line, total cost) and every card Keith saw per call with his feedback. Builder in `src/main/help/feedbackExport.ts`; logs keep counts only.
- **Saved calls.** Kept by default. Optional auto-delete after 7/14/30/90 days (first deletion previewed and confirmed) and "Delete all saved calls" in Diagnostics; a call's DB rows and session folder go, then VACUUM + WAL truncate.
- **Playbook.** Keith's edited copy wins while valid; a broken edit is shown in Setup and the built-in one is used meanwhile; a different built-in version is offered (switch keeps a dated backup, or keep his). Reloaded at each call start.
- **Scorecard.** At Stop, `reports/help-scorecard-<session>.json`: numbers only (presses, outcomes, speed, prefetch used/unused and cost, tokens, feedback per card, error codes). Included in Save support files.
- **Warm start.** The system prompt (rules + playbook, about 1.5K tokens) is cached. At go-live a `max_tokens: 0` pre-warm opens the connection and writes the cache, and a keep-warm runs every few minutes while idle.
- **Safety nets.** Server-side fallback (`fallbacks: "default"`), an 8 s timeout, and refusal handling.
- **Request rules.** A new press supersedes a pending one, and an older response can't overwrite a newer one. A finished card is never rewritten. Pause/Stop cancel pending work and drop late results.

## Measurements (per request, stored locally; summarized by the benchmark)
- Hotkey → first complete, usable line (`first_usable_ms`).
- Hotkey → fully validated card (`complete_ms`). Median and p95 for both.
- Timeouts and failures.
- Input, output (including billed thinking), cache-read and cache-write tokens, and USD cost (`PRICES` in `models.ts`).
- Targets to test, not promises: usable line ~1–2 s, p95 ≤ 3 s.

## Evaluation
- **Level 1 (hard gate, code)**:
  - valid card with the move chosen first
  - sources only from the context
  - no figures that aren't in the context
  - no technical answer without approved knowledge
  - no Arize capability claim ("we support", "Arize has", "Arize covers", "our platform supports", "is supported"...) unless the card cites an approved knowledge source (K#); approved knowledge merely being in context is not enough. Questions, a hedge earlier in the sentence ("let me confirm we support that"), negations ("Arize can't confirm") and "we have" without a product object ("we have a call next week") are not claims
  - no invented pain in any category: pain words (problem, frustrating, headache...) the transcript never voiced; idioms such as "no problem" or "broken down by team" are not pain
  - per-scenario forbidden patterns
- **Level 2 (quality)**: promptfoo `llm-rubric` (understood the point, neutral, useful, concise, supported, not repetitive).
- **Level 3 (Keith's Golden Set)**: move agreement on scenarios Keith approved. All drafts start `golden_approved: false`; only Keith changes that. Drafts are reported separately and never gate.
- **Regression check**: `npm run eval:help -- --save-baseline <file>` keeps per-scenario move, Level 1 and first-usable time plus per-model summaries; `--compare <file>` (read before the run starts, and compared before any `--save-baseline` write, so both flags can name the same file) works only on the scenarios both runs share: it lists scenarios that passed Level 1 before and fail now, move-agreement drops with the scenarios that flipped (flips that cancel out are not a drop), and p95 latency across the shared scenarios up more than 20% (live runs only), and exits 1 if any.
- **Scenarios**: `evals/scenarios/help/` (43 synthetic drafts: 25 originals plus 8 from the knowledge review: cheaper option, build with nothing built, no budget without a deadline, MLflow local evals, Phoenix in production, a customer reference awaiting clearance, a SaaS-only feature for a self-hosted buyer and for an unknown deployment; plus 10 practice moments: a pilot proposed but not agreed, a half-answered question, the buyer correcting Keith's premise, what a POC looks like with no approved POC material, a pricing ask with no pricing material, a reference request with none approved, the acquisition question with only the public announcement, SOC 2 for a self-hosted buyer when the report covers SaaS only, a question answered before Keith asked it, and "nobody reviews them" as a complete answer). They cover neutral discovery (including a long rambling answer with a buried point), objections, competitors (including a neutral mention and an incorrect buyer claim), technical confusion, approved vs missing vs stale sources, fully answered questions, the SA leading, older context, unknown speakers and transcript gaps.

## Data handling
- Everything is in local SQLite (`copilot.db` in userData): calls' turns, labels, HELP requests (mode, request text, context references, output, model and config, timing, usage) and feedback.
- Diagnostics logs carry ids, timings, statuses and token counts only, never transcript or card text (tested).
- Background (prefetch) requests that were never shown keep only timings, cost, source ids, the call setup and speaker labels in use then (every request's refs record them) and issue kinds; their request and output text is not stored (rows from older builds are cleaned when the database opens). Logs keep fingerprints of knowledge file names, not the names. **Save support files** (Diagnostics) copies only logs, per-call diagnostics/counters, speed-test reports and settings without secrets; never `copilot.db`, transcripts, practice moments or speed-test reports that replayed them (`reports/mine/`) (tested). What leaves the PC: docs/DATA_FLOW.md.
- Keys are stored with DPAPI. Nothing is in Git.
- Retention purge is not implemented yet (the pilot policy proposes 30 days).

## Running call notes (`src/main/help/callNotes.ts`, `callNotesKeeper.ts`)
- A small structured summary kept up to date in the background so a long call doesn't lose early facts: topic, what they want, their open questions (asked is not answered), concerns, facts by kind (tools, team, timeline, budget, decision process, success criteria), next steps proposed vs agreed, and "not covered yet" from a fixed neutral list (timeline, decision process, current tooling, success criteria). Same model and settings as HELP, a cached ~960-token system prompt, JSON via `output_config.format`, checked again in code: every item must cite a line that was sent, an unclear step counts as proposed, a broken answer keeps the previous notes. Delta-only (previous notes + finished lines since + call setup), one at a time, only while live, after ~60 s or 150 words of new talk from the other side, never while a pressed HELP is being answered, at most 20 an hour, a minute's wait after a failure, cancelled by Pause/Stop, stopped by a key/credit/model error until a request succeeds. Latest notes and counts per call in the `call_notes` table (deleted with the call); the scorecard's `call_notes` section and the logs keep counts, cost and codes only. Panel on the call screen, kept after Stop; Setup step 3 "Keep running call notes" (on by default). Estimate (not yet measured live): ~$0.005 an update, about $0.10 an hour at the cap (Sonnet, cached system prompt).
- HELP gets one compact `<call_notes>` block in the user message (≤ 800 characters, after the participants, never in the cached system prompt, used only if built from lines available by the press time; "may lag; the transcript wins"). Items cite their turns as `T#`, so the card's sources show the real early line. Without notes (practice moments, scenarios, the speed test) the context is exactly as before; a saved practice moment doesn't carry the notes.

## Commands
```
npm test                                   # all offline tests (no key needed)
npm run eval:help -- --replay evals/scenarios/help/<id>.json        # exactly what HELP sees at that moment
npm run eval:help -- --session <userData>/sessions/<id>/transcript.jsonl --at 754   # a real call at 12:34
npm run eval:help -- --mock                # offline run, labelled MOCK
SALES_COPILOT_ANTHROPIC_KEY=... npm run eval:help -- --models sonnet,opus --repeats 2
SALES_COPILOT_ANTHROPIC_KEY=... npm run eval:promptfoo                  # Level 1 + Level 2 via promptfoo
```
Normally Keith runs the live comparison from the app: **Diagnostics → Run HELP speed test**.

## Open for Keith
- Review the playbook draft (`config/playbook.json`; Setup → Edit sales playbook).
- Review the 25 scenario drafts in plain English (`docs/SCENARIO_REVIEW.md`) and say which match his judgment; those get `golden_approved: true`.
- Add the knowledge pack: product/evaluation overview, deployment/security answers, current competitive material, objection notes.
