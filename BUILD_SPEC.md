# Keith Sales Copilot — Canonical Build Specification
Updated 2026-10-04. This supersedes all prior build specs.

## Product
A Windows-first personal AI deal copilot for Zoom. It helps during calls without clutter, then preserves evidence-backed deal memory afterward.

### Frozen live panel
- CALL GOAL
- TOPICS: Open / Partial / Done only
- NEXT STEP: None / Proposed / Agreed / Completed
- DEEPER: quiet fixed slot, refreshes after team inquiry -> buyer answer
- COACH: rare proactive card
- HELP: unrestricted hotkey
- Feedback: Useful | Should've stayed quiet | Bad

The hidden discovery ladder, evidence, detailed qualification and diagnostics never become a live scoreboard.

### Three live modes
DEEPER: passive next-question support. Neutral. Surfaces friction, never assumes it. Uses tracker gaps and prepared 3–5 pre-call deep-dive threads first; generates only when conversation moves elsewhere.

COACH: proactive only when intervention is worth the interruption. Start with explicit objections and direct competitor comparisons. Add technical/discovery/decision triggers only after replay/Golden-set evidence. NO_MOVE is first-class.

HELP: Keith invokes at any time. No speaker-role gate. Uses recent dialogue from all speakers + Warm call state + permitted knowledge. It may explain what was said, recommend the move, give a supported answer, or provide the best next question.

## Sales rules
- Asked != answered.
- Proposed != agreed.
- Deeper may not assume unverified pain, urgency, dissatisfaction, ownership or desire to change.
- Team inquiry includes Keith or SA.
- Neutral competitor mention is not dissatisfaction.
- Unsupported technical answer becomes clarification/follow-up, not invention.
- One proactive card at a time. Never silently rewrite a card being read.
- Manual corrections win over model proposals.

## Architecture
Windows capture: Project Raven pattern, Rust/NAPI + WASAPI loopback + separate mic + echo/duplicate suppression. Headphones required.

Audio devices (LOCKED): see AUDIO_DEVICE_REQUIREMENT.md. Keith's primary setup is a Razer USB wireless headset + Zoom desktop. The app captures explicitly selected, ID-persisted endpoints in shared mode and never changes Windows defaults, Zoom device selections, or installs virtual audio devices. Session start is blocked unless both saved endpoints resolve and show real audio activity. Device loss is surfaced immediately, gap-marked, and recovered only onto a confirmed endpoint without replaying stale audio.

Speech: Deepgram initial provider. Remote stream uses word-level diarization. Model raw words as DiarizedWord, then build Turn objects. Diarization answers which cluster; identity answers who the person is.

Identity: manual per-call labels through M3. M4 uses WeSpeaker locally with conservative thresholds. Weak match remains Unknown. Exact pretrained model license/terms must be recorded.

Storage: local SQLite. FTS5 + aliases/tags first. Embeddings are deferred until a labeled paraphrase-recall test proves FTS materially insufficient.

Context: HOT (~30 sec verbatim), WARM (structured call state/current thread), COLD (older searchable evidence).

Sales brain: first choose a typed SalesMove, then render reviewed wording or bounded contextualization. Rubrics/playbooks are editable config. Call type and desired outcomes influence move selection.

Live transcript is speed-oriented. Final transcript can be reconciled after the call.

## Reference implementations
- Project Raven: https://github.com/Laxcorp-Research/project-raven — Windows capture/echo/session reference; observed MIT.
- WeSpeaker: https://github.com/wenet-e2e/wespeaker — local speaker embeddings/verification; repo Apache-2.0.
- Deepgram live diarizer example: https://github.com/Jibril14/Deepgram_live_audio_transcriber_diarizer — inspect streaming speaker-label shape; implementation quality must be reviewed.
- Promptfoo: https://github.com/promptfoo/promptfoo — eval runner; observed MIT.
- GTM Superintelligence: https://github.com/attentiontech/gtm-superintelligence — evidence-bound/config-driven post-call sales logic reference.
- Jev Sales Copilot: https://github.com/moritzkremb/jev-sales-copilot — move selection, gating, replay and nonblocking personalization reference.

Do not assume a repo license covers every bundled model, dataset or dependency. Pin and record exact licenses before reuse.

## Milestones
M0 Prove ears -> M1 Replay + HELP -> M2 Discovery/Deeper/tracker -> M3 Coach -> M4 WeSpeaker identity -> M5 Deal brain -> M6 Notion/Gmail -> M7 Google Docs/Drive -> M8 Mac/Gong/optional enhancements.

See IMPLEMENTATION_PLAN.md for gates.

## M0 definition of done
On Keith's actual Windows PC using Zoom desktop and his Razer USB wireless headset with his normal Zoom configuration:
- separate mic/system streams and meters
- stable Deepgram streaming
- remote word-level speaker tags
- sane turn builder
- no meaningful duplicate buyer transcript from echo
- Pause immediately kills both streams
- Resume never emits buffered pre-pause speech
- Stop/exit fully tears down capture
- 60-minute session passes; reconnect/gaps are explicitly marked and diagnosed
- every AUDIO_DEVICE_REQUIREMENT.md acceptance check passes (Windows/Zoom device settings untouched, no virtual devices, ID-persisted endpoints, start gate, device-loss handling)

Nothing about a mock UI satisfies M0.

## Evaluation
Promptfoo runs three levels.
Level 1 correctness is a hard gate. Level 2 quality must meet threshold. Level 3 Keith Golden Set is the final sales-quality hard gate. Agents may draft scenarios; Keith approves every Golden case.

`Should've stayed quiet` is the most important live signal for Coach precision and must be one-tap feedback, separate from Bad.

## Integrations and deal room
Notion/Gmail/Gong never block live operation. Post-call deal state is evidence-backed, chronological and reviewable. Google Doc + dedicated external-only Drive folder is the first buyer workspace. Private strategy/transcripts never enter the shared folder. Publish only after explicit review.

## Explicitly deferred
Custom buyer portal; team admin; Salesforce; autonomous sending/publishing; broad web research during calls; embeddings without benchmark; WeSpeaker before Coach; Mac before Windows proves value; hidden/undetectable-capture promises.

## Canonical companion docs
- DECISIONS.md
- AUDIO_DEVICE_REQUIREMENT.md
- CONTRACTS.md
- M0_RAVEN_TEARDOWN.md
- IMPLEMENTATION_PLAN.md
- EVALS.md
