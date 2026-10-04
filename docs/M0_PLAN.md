# M0 Plan: Prove the Ears

Scope: M0 only. No HELP, Deeper, Coach, tracker, WeSpeaker, connectors or buyer room.
Status: **implemented; provisionally accepted by Keith on his hardware (2026-10-04). The 60-minute run is deferred** (see `m0_test_report.md`).

## Pipeline (as built)
```
Razer output endpoint (saved ID) ──WASAPI loopback──┐
Razer mic endpoint (saved ID) ──WASAPI capture──────┤  native/windows-audio (Rust/NAPI, shared mode, read-only)
                                                    ▼  bounded event queue (512/stream), QPC timestamps, 16 kHz mono
                                     src/main/validate.ts (every native event checked)
                                                    ▼
                         src/main/session.ts  ── start gate · pause/resume · loss/recovery · gaps
                           │  system_remote ──────────────┐
                           │  local_mic ─ echoGate.ts ────┤  (two separate logical streams, never mixed)
                                                    ▼
                         src/main/deepgram.ts  ── one socket per stream per epoch; diarize=true on system only;
                                                  no replay buffer; upstream bounded (3 s)
                                                    ▼  DiarizedWord (cluster = "e<epoch>:s<n>")
                         src/main/duplicateGate.ts (drop mic text that repeats system text)
                                                    ▼
                         src/main/turnBuilder.ts ── Turn (keith | unknown; never "buyer")
                                                    ▼
                         renderer (diagnostic view) + sessions/<id>/{transcript,diagnostics}.jsonl
```
Diarization ≠ identity: clusters are Deepgram's "which voice group", scoped to one connection epoch. WeSpeaker is not in M0.

## Module structure
| Path | Role |
|---|---|
| `src/shared/contracts.ts` | AudioFrame, DiarizedWord, Turn, GapRecord, AudioEndpointConfig, EndpointStatus (CONTRACTS.md) |
| `src/shared/nativeApi.ts` | TS contract for the native module (incl. probe streams for setup) |
| `native/windows-audio/src/{lib,wasapi,dsp,devices,com,clock,codes}.rs` | Rust/NAPI WASAPI capture, enumeration, format/resample/timing |
| `src/main/validate.ts` | NAPI event + IPC argument validation |
| `src/main/session.ts` | Session state machine, start gate, loss/recovery, gaps, pause/resume/stop/exit |
| `src/main/deepgram.ts`, `sampleClock.ts` | Streaming STT client; provider time → session clock |
| `src/main/echoGate.ts`, `duplicateGate.ts` | Audio-level and transcript-level leak suppression |
| `src/main/turnBuilder.ts` | Final words → turns; overlap and gaps preserved |
| `src/main/endpoints.ts`, `storage.ts`, `deviceTest.ts` | ID-only resolution, local persistence, setup device scan |
| `src/main/index.ts`, `src/preload/preload.ts` | Electron main + narrow IPC bridge (no secrets cross it outward) |
| `src/renderer/*` | Diagnostic UI |
| `src/main/mockNative.ts` | Test/demo stand-in. **Not** evidence of Windows behaviour. |
| `tests/*` | Vitest suites (logic against the mock + one real-provider replay fixture) |
| `.github/workflows/m0.yml` | Linux tests; Windows native build + smoke + installer artifact |

## Dependencies (pinned in lockfiles)
Node 22, Electron 44.5.1, electron-builder 26.15.3, esbuild 0.28.2, TypeScript 5.9.3 (strict), Vitest 3.2.7, ws 8.22.0.
Rust stable + MSVC (windows-latest runner): napi 2.16.17, napi-derive 2.16.13, napi-build 2.6.0, windows 0.52.0, rubato 0.14.1.
Windows: WASAPI (MMDevice API, IAudioClient/IAudioClient2, IAudioCaptureClient), QPC. No virtual audio drivers, no GStreamer, no AEC3 binaries.

## Contradictions / blockers found (evidence in RAVEN_IMPLEMENTATION_NOTES.md)
1. **Spec says Raven's Windows path uses WebRTC AEC3. It does not ship on Windows.** M0 adapts what Raven actually runs on Windows (residual correlation gate), plus a transcript duplicate gate. Headset use makes acoustic echo unlikely. *For review:* if the leakage check on Keith's PC fails, a Windows AEC3 port is the escalation. Not a blocker now.
2. **Raven captures default endpoints and ignores mic selection on Windows.** This conflicts with the locked device requirement. Replaced with ID-bound capture. This is a required adaptation, not an architecture change.
3. **Raven replays buffered audio after STT reconnect** (violates criteria 10/11) and **silently degrades to mic-only**. Neither is adopted.
4. **Raven's unbounded native queue** violates "bounded buffers". Bounded here.
5. **Wireless headset off with the dongle still present** may leave the endpoint "active" with digital silence. That is surfaced as a mic warning plus a stall loss if packets stop. It needs confirmation on the real Razer.
6. **USB port change can mint a new endpoint ID.** That is treated as missing; Keith confirms the new one.
7. **Secrets and the renderer:** the Deepgram key is typed into a password field in the renderer and sent once to main (encrypted with DPAPI via safeStorage). Main never sends it back, logs it, or exposes it over IPC. Interpretation for review: user input transits the renderer once; no renderer code ever receives the key from main.
8. **UI scope tension:** Keith asked for a less ugly UI. It remains a diagnostic view (endpoints, IDs, meters, capture/provider state, controls, transcript with channel/cluster/epoch/timestamps, gaps, errors) with no sales features or dashboards.

9. **Echo gate deviates from Raven's thresholds, with evidence.** Raven's rule muted up to a third of Keith's speech during double-talk on real recordings. It was replaced by a stable-lag, pre-emphasised rule (see RAVEN_IMPLEMENTATION_NOTES.md row 7 and `tests/echoRealSpeech.test.ts`). This is a tuning change inside the locked architecture, not an architecture change.
10. **Keith's headset (Razer BlackShark V2 Pro) noise-gates the mic** to exact digital zeros between words (seen in his first session). Short digital silence is therefore normal; a note appears only after 60 s.

## Latency (from Keith's first call + live measurements)
- Deepgram finals arrive ~0.5 s after speech ends when the stream goes truly quiet (measured live). During continuous speech or noisy lines they arrive at natural pauses, typically 2-4 s after the words.
- Removed app-side delay: Keith's words are no longer held 1.5 s when the remote side was silent; turns stay open while the speaker is still talking, so late finals extend the bubble instead of fragmenting it.
- Provisional (interim) text is shown live, marked "live, not final"; turns and all stored data still use finals only.
- Every 10 s, `diagnostics.jsonl` logs `timing` per stream: native capture lag and speech-service delay (avg/max). The UI shows the speech-service delay.

## Acceptance traceability
Legend: **T** = covered by automated test against the mock/fake provider · **CI** = verified on the Windows CI runner (no audio hardware) · **L** = verified against the live Deepgram API · **HW** = requires Keith's PC (not yet done).

| # | Criterion | Where | Evidence |
|---|---|---|---|
| 1 | Normal Razer headset | endpoint selection by ID; device scan | **HW** |
| 2–4 | No Windows/Zoom setting changes; app modifies none | shared mode only, no config-writing APIs (grep-verified), `NOPERSIST`, `AudioCategory_Other`; before/after snapshots | code review + **HW** snapshots |
| 5 | Separate logical streams | two captures, two sockets, `stream` on every frame/word/turn | T |
| 6 | Word-level remote diarization | `diarize=true` on system socket; cluster per word | L (replay fixture) + **HW** multi-speaker |
| 7 | Sane timestamped turns | `turnBuilder.ts`, `sampleClock.ts` | T, L |
| 8 | Mic leakage not duplicated | `echoGate.ts`, `duplicateGate.ts` | T (synthetic leakage) + **HW** |
| 9 | Pause stops both streams + upstream | `session.pause()` joins both native threads; sockets finalize/close | T + **HW** |
| 10 | No pre-pause audio after Resume | capture generations, closing sockets aborted on resume, mic hold flushed at pause | T |
| 11 | Resume from current audio | providers connect first, then fresh captures; discontinuity marked | T |
| 12 | Stop ends capture + upstream | `session.stop()`; `teardown_verified` log | T + **HW** |
| 13 | Exit leaves nothing capturing | `shutdownNow()` on before-quit / window-all-closed / process exit; native `stopAll` joins threads | T (logic) + **HW** |
| 14 | Disconnect/change visible | invalidation events, 500 ms state poll, stall + digital-silence detection, 5 s default/device-list notices | T + **HW** |
| 15 | Never silently switch | ID-only resolution; recovery only on the same ID or Keith's explicit pick | T (asserts no other endpoint is ever opened) |
| 16 | Every discontinuity is a gap | pause, device loss/stall, capture error, provider disconnect/backpressure, WASAPI discontinuity, queue overflow | T |
| 17 | Real 60-minute Zoom test | `KEITH_TEST_GUIDE.md` | **HW: not done** |
| 18 | Reconnects recovered, timed, marked | provider retry with backoff; gap with timing; new epoch | T + **HW** |
| 19 | Failure log fields | `gap_open`/`gap_close` in `diagnostics.jsonl`: stream, start, duration, cause, device_state, provider_state, recovery | T |
| 20 | No raw audio persisted | no audio writes anywhere; `mip_opt_out=true` | code review |
| 21 | Secrets kept out of renderer/source/logs | DPAPI storage; key never logged or sent to renderer; repo grep in CI checklist | code review (see note 7) |

## Remaining M0 work
1. Keith installs the CI artifact and runs `KEITH_TEST_GUIDE.md`.
2. Fix whatever the hardware run shows. Do not proceed to M1 before review.
3. Fill in `m0_test_report.md` from the real sessions.
