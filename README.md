# Sales Copilot: M0 (prove the ears)

Windows-first Electron app that listens to Zoom calls through Keith's existing audio setup and produces a debug transcript. **M0 only**: no HELP/Deeper/Coach yet.

Start with **START_HERE.md** (spec) and **AUDIO_DEVICE_REQUIREMENT.md** (locked). For Keith: **docs/KEITH_TEST_GUIDE.md**. Plan, traceability and status: **docs/M0_PLAN.md**. Raven teardown: **docs/RAVEN_IMPLEMENTATION_NOTES.md**.

## What it does
- WASAPI loopback on the **selected** output endpoint + separate WASAPI mic capture on the **selected** mic, both opened by saved endpoint ID, shared mode, read-only toward Windows/Zoom settings (`native/windows-audio`, Rust/NAPI, adapted from Project Raven).
- Start gate: both saved endpoints present, both opened, real audio on both, and Deepgram connected; otherwise Start is blocked with a reason.
- Echo defence: residual correlation gate (audio) + duplicate-text gate (transcript).
- Deepgram nova-3 streaming per stream (`diarize=true` on meeting audio, `mip_opt_out=true`), word timestamps mapped to one session clock.
- Turn builder: KEITH / REMOTE_n / UNKNOWN; never assumes "buyer".
- Device loss: surfaced, gap-marked, no auto-switch, reconnect only to the confirmed endpoint, never replays stale audio. Same for STT disconnects.
- Pause kills both captures; Resume starts fresh. Stop/exit tears everything down.
- Local-only data in `%APPDATA%/sales-copilot/`: `audio-endpoints.json`, encrypted key, `sessions/<id>/{transcript,diagnostics}.jsonl`, `logs/`.

## Developer commands
```
npm ci
npm run typecheck && npm test      # all logic tests (Linux/macOS/Windows)
npm run build:native               # Windows: cargo build + copy .node (elsewhere: cargo check for msvc)
npm run dev                        # on non-Windows runs a labelled DEMO with synthetic audio
npm run package:win                # Windows installer in release/
npm run doctor                     # read-only environment check
```
CI (`.github/workflows/m0.yml`) builds the Windows installer on every push and uploads it as an artifact.
