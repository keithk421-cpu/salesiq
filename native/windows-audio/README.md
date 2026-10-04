# sales-copilot-audio (native/windows-audio)

Rust + napi-rs v2 module that implements `NativeAudioModule` from
`src/shared/nativeApi.ts` on Windows using WASAPI.

Rules it enforces (see `AUDIO_DEVICE_REQUIREMENT.md`):

- Endpoints are opened **only by explicit IMMDevice ID** (`IMMDeviceEnumerator::GetDevice`).
  A missing / inactive / wrong-flow endpoint fails with `device_not_found`,
  `device_not_active` or `wrong_flow`. There is no fallback to any other device.
  `GetDefaultAudioEndpoint` is used only by `listEndpoints()` to fill the
  informational `isDefaultConsole` / `isDefaultCommunications` flags.
- **Shared mode only.** `system_remote` = loopback on a render endpoint,
  `local_mic` = a capture endpoint. Streams are tagged `AudioCategory_Other`
  (not communications) and opened with `AUDCLNT_STREAMFLAGS_NOPERSIST`.
- Read-only: no volume/mute/format/default-device/ducking writes, no virtual devices.

Output: 16 kHz mono signed 16-bit LE chunks stamped with QPC milliseconds
(`monotonicMs`, same clock as `monotonicNowMs()`), with WASAPI discontinuity
pass-through and synthetic silence for an idle loopback (`syntheticSilence: true`).

## Build (Windows, x64)

Requires the Rust MSVC toolchain (`x86_64-pc-windows-msvc`) and the Visual
Studio C++ build tools.

```powershell
cd native/windows-audio
cargo build --release
copy target\release\sales_copilot_audio.dll sales-copilot-audio.win32-x64-msvc.node
```

The Electron main process then loads it with
`require('<app>/native/windows-audio/sales-copilot-audio.win32-x64-msvc.node')`.
Build it against the same architecture as Electron (x64). napi-rs uses
Node-API, so the binary is ABI-stable across Node/Electron versions.

## Develop / test on Linux or macOS

```sh
cargo test                                         # pure DSP / mapping tests
cargo check  --target x86_64-pc-windows-msvc       # type-check the Windows code
cargo clippy --target x86_64-pc-windows-msvc --all-targets
```

On non-Windows platforms the module compiles to stubs: `listEndpoints()`
returns `[]`, `getEndpointState()` returns `'missing'`, and `startCapture()`
returns `{ ok: false, code: 'unsupported_platform' }`.

## Layout

- `src/lib.rs` - napi exports, per-stream capture slots (start/stop/join).
- `src/wasapi.rs` - capture thread: open by ID, validate, Initialize (shared), 20 ms poll loop.
- `src/devices.rs` - endpoint enumeration and state (each query on its own MTA thread).
- `src/com.rs` - COM RAII helpers (CoInitializeEx guard, CoTaskMemFree'd mix format / strings).
- `src/dsp.rs` - format parsing, sample decoding, downmix, resampling, timeline (pure, tested).
- `src/codes.rs` - state / form-factor / HRESULT mappings (pure, tested).
- `src/clock.rs` - QPC clock.

## Credits

The capture-thread pattern, napi ThreadsafeFunction callbacks and rubato
resampling are adapted from Project Raven (MIT, Copyright (c) 2026 Laxcorp
Software Design - FZCO), commit `692cd17606e9f2d0063e2c32c9e250eaa5f60ddc`.
