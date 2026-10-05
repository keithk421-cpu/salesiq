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
- **Approved knowledge**: FTS5 + aliases + tags; no embeddings. Only approved, in-scope documents are searched. Each section is indexed under its heading and file title; a file's tags only break ties between files (repeating them in every section made the most telling words, such as a competitor's name, rank worse).
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
- **Prefetch (on by default, toggle in Setup).** After someone finishes speaking, HELP prepares a candidate in the background. It's shown only if Keith presses and nothing new was said since; otherwise a fresh request runs. This costs extra background requests (recorded with `prefetch=1`) and buys a near-zero wait for the common case.
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
  - no Arize capability claim without knowledge
  - no invented pain on neutral answers
  - per-scenario forbidden patterns
- **Level 2 (quality)**: promptfoo `llm-rubric` (understood the point, neutral, useful, concise, supported, not repetitive).
- **Level 3 (Keith's Golden Set)**: move agreement on scenarios Keith approved. All 25 drafts start `golden_approved: false`; only Keith changes that. Drafts are reported separately and never gate.
- **Scenarios**: `evals/scenarios/help/` (33 synthetic drafts: 25 originals plus 8 from the knowledge review: cheaper option, build with nothing built, no budget without a deadline, MLflow local evals, Phoenix in production, a customer reference awaiting clearance, a SaaS-only feature for a self-hosted buyer and for an unknown deployment). They cover neutral discovery (including a long rambling answer with a buried point), objections, competitors (including a neutral mention and an incorrect buyer claim), technical confusion, approved vs missing vs stale sources, fully answered questions, the SA leading, older context, unknown speakers and transcript gaps.

## Data handling
- Everything is in local SQLite (`copilot.db` in userData): calls' turns, labels, HELP requests (mode, request text, context references, output, model and config, timing, usage) and feedback.
- Diagnostics logs carry ids, timings, statuses and token counts only, never transcript or card text (tested).
- Keys are stored with DPAPI. Nothing is in Git.
- Retention purge is not implemented yet (the pilot policy proposes 30 days).

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
