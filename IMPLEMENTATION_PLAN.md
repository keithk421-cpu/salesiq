# Implementation Plan

## Tomorrow: M0 only — Prove the ears
Do not build sales intelligence tomorrow.

1. Scaffold Electron/TypeScript + Rust/NAPI workspace; minimal renderer; provider interfaces; redacted diagnostics; scripts doctor/dev/test/typecheck/lint/package:win.
2. Adapt Raven-derived WASAPI system loopback + separate mic, in shared mode, bound to explicitly selected endpoint IDs. Add endpoint enumeration, select-test-confirm flow, AudioEndpointConfig persistence, session-start gate, and device-loss handling per AUDIO_DEVICE_REQUIREMENT.md. Add meters and explicit state.
3. Implement echo/duplicate suppression and repeatable leakage test.
4. Deepgram streaming: remote diarization enabled; interim diagnostic only; final word events keep timestamps + speaker cluster.
5. Turn builder consumes final words, preserves overlap/gaps, never infers buyer identity.
6. Bare debug screen: selected output + mic device names/IDs, endpoint status, meters, Start/Pause/Resume/Stop, elapsed time, timestamped Keith/REMOTE_n/UNKNOWN turns, GAP markers, connection state.
7. Real Zoom smoke test on Keith's Razer USB wireless headset, device-loss tests (headset off / dongle out / back on), then 60-minute reliability run.

M0 hard checks: Pause kills both streams immediately; Resume leaks no buffered pre-pause speech; exit kills capture; no meaningful duplicate remote transcript; clusters usable; every gap/reconnect explicit; Windows/Zoom audio settings untouched and no virtual audio devices; endpoint IDs persisted; never auto-switch endpoints.

M0 deliverables: working Windows build; `docs/raven_capture_map.md`; `docs/m0_test_report.md`; saved approved/synthetic replay fixture. No M1 work before review.

## M1 — Replay + HELP
Replay harness; per-call tap-to-name roles; Hot/Warm/Cold context; FTS5 retrieval; call type/goal/outcomes; move selector; unrestricted HELP hotkey; short card/source; latency/stale handling; Useful/Should've-stayed-quiet/Bad.
Exit: Keith gets stuck, presses HELP, receives something usable while the moment is live.

## M2 — Discovery intelligence
Prep threads; tracker; hidden ladder; semantic team-inquiry detection; buyer-answer completion; Deeper fixed slot; neutral-friction rule; state deltas/manual corrections.

## M3 — Proactive Coach
Explicit objections and competitor comparisons first; later high-confidence technical/discovery/decision moments; NO_MOVE; interruption/staleness rules; silence-feedback precision tuning.

## M4 — Speaker identity
WeSpeaker benchmark/enrollment; SA/buyer profiles; conservative thresholds; Unknown fallback; automatic Coach role classification. Verify exact checkpoint license separately from Apache-2.0 repo license.

## M5 — Post-call deal brain
Final transcript reconciliation; evidence timeline; what changed; commitments; next actions; follow-up; pre-call briefing.

## M6 — Connectors
Selected Notion then Gmail; Gong only with supported access. Never live-path dependencies.

## M7 — Buyer workspace
Reviewed Google Doc + external-only Drive folder; explicit publish approval and revision safety.

## M8 — Mac/Gong/optional enhancements
Mac capture; Gong automation; HELP WITH SCREEN; embeddings only if benchmark earns them; other measured needs.
