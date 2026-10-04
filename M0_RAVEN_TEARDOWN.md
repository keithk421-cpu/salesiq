# M0 Reference Teardown: Project Raven
Primary reference: https://github.com/Laxcorp-Research/project-raven
Observed repo license during research: MIT. Verify current commit and every reused dependency/file.

## Why Raven
A shipped Electron meeting copilot with Windows installers. Documented Windows path uses Rust/NAPI + WASAPI for system/mic capture, local WebRTC AEC3 and residual echo suppression, then STT. This is the primary implementation reference.

## Before capture code
Create `docs/raven_capture_map.md` with exact current Raven file paths, commit SHA, licenses and notes for:
1. WASAPI loopback init.
2. Mic capture init.
3. Rust <-> Node/Electron NAPI boundary.
4. PCM/frame format + resampling.
5. Sequencing/shared monotonic timing.
6. AEC3 integration.
7. Residual echo/duplicate gate.
8. Device enumeration/change.
9. Pause/resume.
10. Start/stop/app-exit teardown.
11. Error propagation.
12. Windows native-module build/package.
13. Relevant Windows tests/diagnostics.

Adapt the minimum proven pattern. Do not fork Raven wholesale.

## M0 pipeline
Zoom + headphones -> WASAPI system loopback + mic -> echo/duplicate suppression -> normalized bounded frames -> Deepgram -> final word timestamps + remote speaker clusters -> turn builder -> bare debug transcript.

## Non-goals
No WeSpeaker, HELP, Deeper, Coach, connectors, buyer room or polished UI.

## Hard gates
- Actual Keith Windows PC + Zoom desktop + headphones.
- Separate mic/system meters.
- Correct local vs remote routing.
- No meaningful duplicate remote transcript from echo.
- Remote final words preserve speaker cluster tags.
- Turn builder preserves timestamps, overlap and gaps without assuming buyer identity.
- Pause stops BOTH streams immediately. No pre-pause buffered speech appears after Resume.
- Resume uses current audio and marks discontinuity where appropriate.
- Stop/app exit leaves nothing capturing.
- 60-minute Zoom run. No reconnect preferred. Any reconnect/gap is explicitly marked.
- For each gap log stream, timestamp, duration, device state, provider state and recovery result.
- System audio remains honestly labeled; unrelated playback is a documented limitation.

## Fallback
Do not start with desktopCapturer. Consider it only if Raven-derived WASAPI/Rust fails on Keith's machine or creates a measured packaging/reliability blocker. Record evidence before changing architecture.
