# Raven Capture Map

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

## The 14 mapped concerns

| # | Concern | Raven (file:line @692cd17) | Ours | Notes |
|---|---|---|---|---|
| 1 | WASAPI loopback init | `src/native/windows/src/wasapi.rs:101-145` (`capture_loop`: `GetDefaultAudioEndpoint(eRender)`, `Initialize(SHARED, LOOPBACK, 1 s)`) | `native/windows-audio/src/wasapi.rs` | Adapted: open by ID, validate render flow, shared mode, `NOPERSIST`, `AudioCategory_Other` via `IAudioClient2::SetClientProperties`. |
| 2 | Mic capture init | `wasapi.rs:231-260` (`mic_capture_loop`, default `eCapture`) | same file | Adapted: open by ID, validate capture flow, shared mode only. |
| 3 | Rust ↔ Node NAPI boundary | `src/native/windows/src/lib.rs:47-150` (napi v2 `ThreadsafeFunction`, one thread per stream, stop flag) | `native/windows-audio/src/lib.rs` | Same pattern. Added JoinHandle join on stop, a 3 s startup handshake that returns real open errors, and error/stopped events. |
| 4 | PCM format + resampling | `wasapi.rs:16-90` (rubato `SincFixedIn` to 16 kHz mono i16, 20 ms polling) | `native/windows-audio/src/dsp.rs` | Same crate and settings. Format parsing fixed (see 6 above). |
| 5 | Sequencing / shared monotonic timing | `wasapi.rs:93` wall-clock only | `dsp.rs`, `clock.rs`; `src/main/sampleClock.ts` | QPC-based `monotonicMs`; re-anchors on discontinuity or drift above 30 ms; per-epoch sample-offset → session-ms map for word timestamps. |
| 6 | AEC3 integration | `src/native/aec/*`, `systemAudioNative.ts:138-260` (GStreamer webrtcdsp, macOS only in practice) | Not adopted (see finding 2) | Deferred and evidence-gated. |
| 7 | Residual echo / duplicate gate | `src/main/residualEchoGate.ts` (Pearson correlation of mic vs recent system PCM); used at `systemAudioNative.ts:532-560` | `src/main/echoGate.ts` (port, MIT credit); `src/main/duplicateGate.ts` (new, transcript-level) | Port zero-fills echo windows instead of withholding them, so the mic timeline stays continuous. The duplicate gate drops mic text repeating the same words the system stream said within ±1.5 s. |
| 8 | Device enumeration / change | None on Windows (defaults only); `windowsCaptureDeathPoll` in `systemAudioNative.ts` | `native/windows-audio/src/devices.rs`; `src/main/session.ts` (500 ms state poll, stall detection, digital-silence warning) | New. Read-only enumeration; default flags are informational only. |
| 9 | Pause / resume | None (Raven has start/stop only) | `src/main/session.ts` `pause()`/`resume()` | Pause joins both capture threads; resume opens fresh captures and fresh STT epochs and drops late pre-pause results. |
| 10 | Start/stop/app-exit teardown | `lib.rs` stop flags (no join); `audioManager.ts:805-815` shutdown | `lib.rs` stop and join; `session.ts stop()/shutdownNow()`; `src/main/index.ts` before-quit / window-all-closed / process exit | Teardown verified (`teardown_verified` log). |
| 11 | Error propagation | `eprintln!` only; thread exits silently, Node polls for death | `{kind:'error', code, hresult}` + `{kind:'stopped'}` events; JS handlers wrapped in try/catch | `AUDCLNT_E_DEVICE_INVALIDATED` maps to `device_invalidated`, which becomes a device-loss gap. |
| 12 | Windows native build / package | `scripts/release-windows.ps1:200-212` (`cargo build --release`, copy dll → `.node`, hard-fail if missing); `electron-builder.json5:99-100` extraResources | `scripts/build-native.mjs`; `package.json` `build.extraResources`; `.github/workflows/m0.yml` | Kept Raven's lesson: fail the build if the `.node` is missing, then verify it is inside the packaged installer. |
| 13 | Windows tests / diagnostics | `src/main/__tests__/windowsAudioModule.test.ts`, `windowsCaptureStart.test.ts`; `docs/_evidence/W04_audio.md` | `scripts/native-smoke.cjs` (CI on windows-latest); `tests/*.test.ts`; per-session `diagnostics.jsonl` | The smoke test asserts that an unknown ID fails with `device_not_found` (no fallback). |
| 14 | Endpoint IDs, shared vs exclusive mode, ducking, notifications | Default endpoint (`eConsole`); shared mode; no stream category; no notification client | By ID; shared only; `AudioCategory_Other`; polling instead of IMMNotificationClient | Ducking is still to be verified on Keith's PC (an M0 check). Polling at 500 ms was chosen over IMMNotificationClient for simplicity; `AUDCLNT_E_DEVICE_INVALIDATED` gives immediate notice anyway. |

## Dependencies and licenses (verify on update)
- Raven source adapted: MIT (above).
- `napi` / `napi-derive` / `napi-build` 2.x: MIT.
- `windows` 0.52: MIT OR Apache-2.0.
- `rubato` 0.14: MIT.
- `ws`: MIT. Electron: MIT. electron-builder: MIT.
