# Locked Decisions
Do not reopen these unless implementation evidence shows failure.

- Windows-first, local-first personal desktop app for Zoom. New implementation; do not reuse SalesCoach.
- Primary Windows capture: adapt Project Raven's Rust/NAPI + WASAPI system-loopback and separate mic architecture, including echo/duplicate suppression. Pure Electron desktopCapturer is fallback only after measured failure/blocker.
- Headphones required. Label remote source honestly as system audio, not Zoom-only.
- Deepgram initial STT; keep provider adapter replaceable.
- Diarization != identity. Deepgram word-level speaker clusters -> turn builder -> optional identity later.
- Per-call tap-to-name roles through M3. WeSpeaker identity is M4, after Coach.
- Unknown speaker never blocks HELP. Role gating applies only to automatic Coach.
- Live UI frozen: topic tracker + Deeper + Coach + HELP. Discovery ladder hidden.
- HELP is manual, immediate, unrestricted by speaker identity, and can use all recent speakers.
- Deeper quietly refreshes after team inquiry -> buyer answer. Team = Keith or recognized/manually labeled SA. Inquiry detection is semantic, not punctuation-based.
- Deeper surfaces friction; never presumes it. Unsupported pain/urgency/dissatisfaction/ownership/desire-to-change is a failure.
- Coach is rare. NO_MOVE is first-class. One proactive card max; stale cards die.
- Live tracker shows topic Open/Partial/Done only. Asked != answered. Proposed != agreed.
- Context = Hot recent verbatim + Warm structured call state + Cold searchable older evidence.
- Select sales move before wording. Playbooks/rubrics live in inspectable config.
- Call type + desired outcomes influence coaching.
- SQLite FTS5 first. Embeddings ship only after a labeled paraphrase-recall benchmark proves material improvement.
- SQLite local source of truth; never live DB in cloud-sync folder.
- Promptfoo is eval runner.
- Level 1 correctness hard gate; Level 2 quality threshold; Level 3 Keith Golden Set hard sales-quality gate.
- Agent may draft Golden scenarios, but Keith must approve every one.
- Feedback footer: Useful | Should've stayed quiet | Bad. Silence feedback is first-class and tunes Coach firing precision.
- Replay harness mandatory immediately after M0.
- Live transcript optimized for latency; final transcript can be reconciled post-call.
- Notion/Gmail/Gong never live-path dependencies.
- Buyer workspace starts as reviewed Google Doc + external-only Drive folder.
- Nothing sends/publishes automatically.
