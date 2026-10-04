# M0 Test Report

Status: **Provisionally accepted by Keith (2026-10-04); 60-minute run outstanding.** Everything below except the 60-minute run has been exercised on Keith's real Windows + Zoom + Razer setup. Keith chose to defer the 60-minute run. It closes on the next real call left running end to end (no extra effort), after which `diagnostics.jsonl` from that session is reviewed.

## Progress log
| Date | Who | What was checked | Result |
|---|---|---|---|
| 2026-10-04 | Keith | Pause/Resume and headset off/on during a Zoom test call; Windows/Zoom settings check | Keith reports: Pause/Resume works (nothing said while paused appeared); headset off/on works (disconnect shown, reconnected to the Razer); Zoom settings unchanged and no volume drop noticed. Verbal report; logs for these runs not reviewed. |
| 2026-10-04 | Keith | 62 s two-person Zoom conversation on build 064b12a (Razer BlackShark V2 Pro; second participant on a phone in the same room) | Pass for routing/turns/latency on hardware. 7 final turns, correct KEITH vs REMOTE alternation, accurate text on laptop-quality speech. Speech-service delay 0.5-1.3 s (was 3-6 s); native capture lag 1-2 ms (system) / ~16 ms (mic). 0 gaps, 0 reconnects, 0 echo-muted windows, no false mic-silence warnings, `teardown_verified` with nothing capturing. 3 duplicate segments suppressed: the second participant was in the same room, so their voice reached Keith's mic through the air (and once Keith's voice reached their phone). In-room testing is inherently ambiguous; real remote participants don't create this. Session `s-2026-10-04T21-49-43-133Z-44d674`. |
| 2026-10-04 | Keith | ~30 s test call: Keith on the Razer + his cell phone dialed in as the remote | Worked end to end: correct Razer output auto-found, both streams transcribed, clean stop (`teardown_verified`), no gaps. Issues: remote phone audio transcribed poorly (narrowband PSTN); finals 3-6 s late; false "mic digital silence" warnings from the BlackShark V2 Pro noise gate. Fixes in the next build: echo-gate double-talk fix, no mic hold when remote is silent, live interim text, turn fragmentation fix, 60 s silence note, Arize keyterms, timing diagnostics. |
| 2026-10-04 | Keith | Installed CI build (commit 22ee9fc) on his Windows PC with the Razer headset; device setup; Zoom Settings → Audio speaker/mic test (no meeting) | Meeting-audio loopback and mic both captured and transcribed. Earlier build had a flat meeting-audio meter; fixed by keeping late-stamped loopback audio (see commit bcf34f3). |

## Environment
| Item | Value |
|---|---|
| Windows edition / build | |
| Zoom desktop version | |
| Razer headset model / firmware / dongle USB port | Razer BlackShark V2 Pro (firmware not recorded); mic is noise-gated (exact zeros between words) |
| App version / commit | |
| Meeting-audio endpoint (name, ID) | Speakers (Razer BlackShark V2 Pro), `{0.0.0.00000000}.{0442a787-0b16-4499-9dd5-e1aa1eca6a1c}`, 48 kHz 2 ch float |
| Mic endpoint (name, ID) | Microphone (Razer BlackShark V2 Pro), `{0.0.1.00000000}.{09996d1a-1883-4d2f-aca1-4c8fbd1b50e2}`, 48 kHz 1 ch float |
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
| 2 | Zoom speaker/mic selections unchanged (screenshots) | Pass (Keith verbal) | no screenshots |
| 3 | No virtual audio device present / installed | | |
| 4 | Zoom audio not ducked when capture starts | Pass (Keith verbal) | |
| 5 | Razer endpoints enumerated, tested, saved by ID | Pass | Device scan found `Speakers (Razer BlackShark V2 Pro)` among 5 outputs (other 4: "nothing playing") and the Razer mic among 2 mics; saved by IMMDevice ID |
| 6 | After app restart, saved IDs resolve; start gate passes without re-selection | | |
| 7 | Start blocked (clear reason) with headset off | | |
| 8 | Start blocked when mic or meeting audio silent during the check | | |
| 9 | Separate mic / system meters work | Pass | Keith, sessions 21:28 and 21:49 |
| 10 | Correct local vs remote routing (KEITH vs REMOTE_n) | Pass (1 short call) | session 21:49 transcript |
| 11 | No meaningful duplicate remote transcript from echo (echo/duplicate counters) | | |
| 12 | Remote final words carry speaker clusters | | |
| 13 | Pause stops both streams immediately; nothing said while paused appears | Pass (Keith verbal) | logs not reviewed |
| 14 | Resume uses current audio; discontinuity/GAP marked | Pass (Keith verbal) | logs not reviewed |
| 15 | Mid-call headset off: failure shown ≤ ~2 s, gap marked, no endpoint switch | Pass (Keith verbal) | detection time not measured |
| 16 | Headset on: reconnect to the confirmed endpoint only; no stale audio | Pass (Keith verbal) | |
| 17 | Dongle moved to another USB port (if the ID changes): treated as missing; Keith confirms | | |
| 18 | Stop / app exit leaves nothing capturing (`teardown_verified`) | Stop: pass | `teardown_verified stillCapturing: []` (21:24, 21:51). App-exit check still to do |
| 19 | 60-minute Zoom run completed | **Deferred by Keith** | close on next real call |

## Gap log (from sessions/*/diagnostics.jsonl `gap_open`/`gap_close`)
| Stream | Cause | Start | Duration | Device state | Provider state | Recovery |
|---|---|---|---|---|---|---|

## Known limitations
- System audio is everything played to the selected output endpoint, not "Zoom only". Unrelated playback on that device will be transcribed as REMOTE.
- Wireless headsets that keep the dongle's endpoint present while the headset is off show up as "pure digital silence" (a warning), not as a lost device.
- The installer is unsigned (SmartScreen warning).
