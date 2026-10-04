# Raven Implementation Notes

Reference: Project Raven, https://github.com/Laxcorp-Research/project-raven
Commit inspected: `692cd17606e9f2d0063e2c32c9e250eaa5f60ddc` (2026-09-23)
License: MIT, "Copyright (c) 2026 Laxcorp Software Design - FZCO" (repo `LICENSE`). See `THIRD_PARTY_NOTICES.md`.

Our adaptation: `native/windows-audio/` (Rust/NAPI) and `src/main/*.ts`. We did not fork Raven. We adapted the minimum proven pattern and changed it where AUDIO_DEVICE_REQUIREMENT.md requires.

## Headline findings (measured from source, not assumed)

1. **Raven captures the Windows *default* devices.** `src/native/windows/src/wasapi.rs:112` calls `GetDefaultAudioEndpoint(eRender, eConsole)`, and the mic loop does the same with `eCapture`. There is no device selection or enumeration on Windows. **That violates the locked requirement**, so our module opens endpoints only by saved ID (`IMMDeviceEnumerator::GetDevice`) and never falls back.
2. **Raven does not ship WebRTC AEC3 on Windows.** AEC is a GStreamer `webrtcdsp` pipeline (`src/native/aec/`, `systemAudioNative.ts:138 loadAecModule`). Raven's own evidence (`docs/_evidence/W04_audio.md`, "What's NOT covered") says the AEC module and GStreamer bundle are not built for Windows, and the app runs without AEC there. The audio-level echo defence that *does* run on Windows is the pure-TypeScript `ResidualEchoGate` (`src/main/residualEchoGate.ts`). The spec's line "Raven Windows path uses … local WebRTC AEC3" is therefore not supported by current Raven source. M0 uses the residual gate plus a transcript-level duplicate gate (see item 7). A Windows AEC3 port is deferred unless the M0 leakage test fails on Keith's headset.
3. **Raven replays buffered audio after an STT reconnect.** `src/main/transcriptionService.ts:356-370` buffers up to 50 chunks while disconnected (`RECONNECT_BUFFER_MAX_CHUNKS`) and flushes them on reconnect. That is forbidden here: we drop the audio and mark a gap.
4. **Raven silently degrades to mic-only** if system capture fails (`systemAudioNative.ts:750-770`, "continuing with microphone only"). That is forbidden by our start gate: both streams must be present and active.
5. **Raven stamps chunks with wall-clock time** (`wasapi.rs:93 timestamp_now`, SystemTime). We use the QPC position from `GetBuffer` instead (a monotonic clock shared by both streams).
6. **Raven treats every 32-bit format as float** (`wasapi.rs convert_to_f32`). We parse WAVEFORMATEXTENSIBLE and support float32, PCM16, PCM24 and PCM32.

7. **Raven's Windows microphone selection is not real.** The settings UI (`src/renderer/src/components/dashboard/settings/AudioTab.tsx:29-37, 67`) stores a Chromium `enumerateDevices()` deviceId as `selectedMicrophone` and passes it to `audio:start-recording` (`audioManager.ts:154`), where it is only logged (`audioManager.ts:266-269`). The native `startMicCapture(callback)` takes no device argument and opens the default endpoint. There is **no endpoint persistence** on Windows, and a Chromium deviceId is not a Windows IMMDevice ID. Ours persists the IMMDevice ID (`AudioEndpointConfig`) and opens exactly that.
8. **Raven has no Pause.** Only start/stop, plus "resume session", which starts a new recording appended to an old session (`services/sessionManager.ts:47-110`). Our Pause/Resume is new code.
9. **Raven's native event queue is unbounded** (`create_threadsafe_function(0, …)`, `lib.rs:57,109`). Ours is bounded at 512 events per stream. Drops are counted and surfaced as a `capture_overflow` gap.
10. **Raven detects capture death by polling `isCapturing()`** (`systemAudioNative.ts:789-817`), and only for the system stream. Errors are `eprintln!` only. Ours delivers typed `error`/`stopped` events with HRESULTs for both streams, plus endpoint-state polling, stall detection and digital-silence detection.

## The 14 mapped concerns

| # | Concern | Raven (file:line @692cd17) | Ours | Notes |
|---|---|---|---|---|
| 1 | WASAPI loopback init | `src/native/windows/src/wasapi.rs:101-145` (`capture_loop`: `GetDefaultAudioEndpoint(eRender)`, `Initialize(SHARED, LOOPBACK, 1 s)`) | `native/windows-audio/src/wasapi.rs` | Adapted: open by ID, validate render flow, shared mode, `NOPERSIST`, `AudioCategory_Other` via `IAudioClient2::SetClientProperties`. |
| 2 | Mic capture init | `wasapi.rs:231-260` (`mic_capture_loop`, default `eCapture`) | same file | Adapted: open by ID, validate capture flow, shared mode only. |
| 3 | Rust ↔ Node NAPI boundary | `src/native/windows/src/lib.rs:47-150` (napi v2 `ThreadsafeFunction`, one thread per stream, stop flag) | `native/windows-audio/src/lib.rs` | Same pattern. Added JoinHandle join on stop, a 3 s startup handshake that returns real open errors, and error/stopped events. |
| 4 | PCM format + resampling | `wasapi.rs:16-90` (rubato `SincFixedIn` to 16 kHz mono i16, 20 ms polling) | `native/windows-audio/src/dsp.rs` | Same crate and settings. Format parsing fixed (see 6 above). |
| 5 | Sequencing / shared monotonic timing | `wasapi.rs:93` wall-clock only | `dsp.rs`, `clock.rs`; `src/main/sampleClock.ts` | QPC-based `monotonicMs`; re-anchors on discontinuity or drift above 30 ms; per-epoch sample-offset → session-ms map for word timestamps. |
| 6 | AEC3 integration | `src/native/aec/*`, `systemAudioNative.ts:138-260` (GStreamer webrtcdsp, macOS only in practice) | Not adopted (see finding 2) | Deferred and evidence-gated. |
| 7 | Residual echo / duplicate gate | `src/main/residualEchoGate.ts` (Pearson correlation of mic vs recent system PCM, single 100 ms window, threshold 0.32); used at `systemAudioNative.ts:532-560` | `src/main/echoGate.ts` (adapted, MIT credit); `src/main/duplicateGate.ts` (new, transcript-level) | **Changed from Raven, with evidence.** On real speech (`tests/echoRealSpeech.test.ts`), Raven's rule muted 23-33% of Keith's own speech when he talked over leaked remote audio at -12 dB (7-14% at -18 dB). Ours requires correlation >= 0.5 at a stable lag in two consecutive windows, on pre-emphasised signals. That mutes 0-7% (0% at -18 dB) and still catches 86-94% of pure leakage; the duplicate-text gate catches the rest. Echo windows are zero-filled, not withheld. |
| 8 | Device enumeration / change | None in the native layer (defaults only); renderer-side Chromium `enumerateDevices` for a mic picker the native capture ignores (finding 7); `windowsDeathPoll` in `systemAudioNative.ts:789` | `native/windows-audio/src/devices.rs`; `src/main/session.ts` (500 ms state poll, stall detection, digital-silence warning, 5 s default/device-list change notices); `src/main/deviceTest.ts` (setup scan of all endpoints) | New. Read-only enumeration; default flags are informational only. |
| 8b | Endpoint persistence | None (finding 7) | `src/main/storage.ts` (`audio-endpoints.json`), `src/main/endpoints.ts` (resolve by ID only; look-alikes are suggestions only) | New. |
| 9 | Pause / resume | None (Raven has start/stop only) | `src/main/session.ts` `pause()`/`resume()` | Pause joins both capture threads; resume opens fresh captures and fresh STT epochs and drops late pre-pause results. |
| 10 | Start/stop/app-exit teardown | `lib.rs` stop flags (no join); `audioManager.ts:805-815` shutdown | `lib.rs` stop and join; `session.ts stop()/shutdownNow()`; `src/main/index.ts` before-quit / window-all-closed / process exit | Teardown verified (`teardown_verified` log). |
| 11 | Error propagation | `eprintln!` only; thread exits silently, Node polls for death | `{kind:'error', code, hresult}` + `{kind:'stopped'}` events (never dropped: sent in blocking mode); every event validated in TS (`src/main/validate.ts`); JS handlers wrapped in try/catch | `AUDCLNT_E_DEVICE_INVALIDATED` maps to `device_invalidated`, which becomes a device-loss gap. |
| 12 | Windows native build / package | `scripts/release-windows.ps1:200-212` (`cargo build --release`, copy dll → `.node`, hard-fail if missing); `electron-builder.json5:99-100` extraResources | `scripts/build-native.mjs`; `package.json` `build.extraResources`; `.github/workflows/m0.yml` | Kept Raven's lesson: fail the build if the `.node` is missing, then verify it is inside the packaged installer. |
| 13 | Windows tests / diagnostics | `src/main/__tests__/windowsAudioModule.test.ts`, `windowsCaptureStart.test.ts`; `docs/_evidence/W04_audio.md` | `scripts/native-smoke.cjs` (CI on windows-latest); `tests/*.test.ts`; per-session `diagnostics.jsonl` | The smoke test asserts that an unknown ID fails with `device_not_found` (no fallback). |
| 14 | Endpoint IDs, shared vs exclusive mode, ducking, notifications | Default endpoint (`eConsole`); shared mode; no stream category; no notification client | By ID; shared only; `AudioCategory_Other`; polling instead of IMMNotificationClient | Ducking is still to be verified on Keith's PC (an M0 check). Polling at 500 ms was chosen over IMMNotificationClient for simplicity; `AUDCLNT_E_DEVICE_INVALIDATED` gives immediate notice anyway. |

## Dependencies and licenses (verify on update)
- Raven source adapted: MIT (above).
- `napi` / `napi-derive` / `napi-build` 2.x: MIT.
- `windows` 0.52: MIT OR Apache-2.0.
- `rubato` 0.14: MIT.
- `ws`: MIT. Electron: MIT. electron-builder: MIT.
