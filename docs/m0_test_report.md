# M0 Test Report

Status: **NOT YET RUN on Keith's PC.** The M0 gate stays open until this document is filled in from the real Windows + Zoom + Razer runs.

## Environment
| Item | Value |
|---|---|
| Windows edition / build | |
| Zoom desktop version | |
| Razer headset model / firmware / dongle USB port | |
| App version / commit | |
| Meeting-audio endpoint (name, ID) | |
| Mic endpoint (name, ID) | |
| Zoom Settings → Audio: Speaker / Microphone (before) | |

## Automated evidence (pre-hardware)
- Unit/integration tests: `npm test` (session gate, device loss, pause/resume, provider reconnect, echo + duplicate gates, replay fixture).
- Rust unit tests: `cargo test` in `native/windows-audio`.
- Windows CI: native module builds; smoke test proves an unknown endpoint ID fails with `device_not_found` (no fallback); installer contains the module.
- Live Deepgram check (`scripts/deepgram-smoke.ts`, public sample): final words with speaker clusters, mapped onto the session clock.

## Hardware acceptance (AUDIO_DEVICE_REQUIREMENT.md + M0 hard gates)
| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Windows defaults (all roles) identical before/after setup, session, exit (device snapshots) | | |
| 2 | Zoom speaker/mic selections unchanged (screenshots) | | |
| 3 | No virtual audio device present / installed | | |
| 4 | Zoom audio not ducked when capture starts | | |
| 5 | Razer endpoints enumerated, tested, saved by ID | | |
| 6 | After app restart, saved IDs resolve; start gate passes without re-selection | | |
| 7 | Start blocked (clear reason) with headset off | | |
| 8 | Start blocked when mic or meeting audio silent during the check | | |
| 9 | Separate mic / system meters work | | |
| 10 | Correct local vs remote routing (KEITH vs REMOTE_n) | | |
| 11 | No meaningful duplicate remote transcript from echo (echo/duplicate counters) | | |
| 12 | Remote final words carry speaker clusters | | |
| 13 | Pause stops both streams immediately; nothing said while paused appears | | |
| 14 | Resume uses current audio; discontinuity/GAP marked | | |
| 15 | Mid-call headset off: failure shown ≤ ~2 s, gap marked, no endpoint switch | | |
| 16 | Headset on: reconnect to the confirmed endpoint only; no stale audio | | |
| 17 | Dongle moved to another USB port (if the ID changes): treated as missing; Keith confirms | | |
| 18 | Stop / app exit leaves nothing capturing (`teardown_verified`) | | |
| 19 | 60-minute Zoom run completed | | |

## Gap log (from sessions/*/diagnostics.jsonl `gap_open`/`gap_close`)
| Stream | Cause | Start | Duration | Device state | Provider state | Recovery |
|---|---|---|---|---|---|---|

## Known limitations
- System audio is everything played to the selected output endpoint, not "Zoom only". Unrelated playback on that device will be transcribed as REMOTE.
- Wireless headsets that keep the dongle's endpoint present while the headset is off show up as "pure digital silence" (a warning), not as a lost device.
- The installer is unsigned (SmartScreen warning).
