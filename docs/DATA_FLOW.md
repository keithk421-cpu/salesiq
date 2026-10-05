# What data leaves the PC (for a security review)

Sales Copilot is a Windows desktop app Keith runs during Zoom sales calls. It captures call audio on the PC, turns it into text, and on request suggests his next line.

**Before a call starts:** Start asks who the call is with, their deployment, and whether Keith has told everyone on the call that it's being transcribed. "Not recording today" starts nothing. (The suggested wording is a placeholder until Legal confirms it.)

**While a call is running (between Start and Stop/Pause):**
- **Deepgram (speech-to-text):** both audio streams stream live over an encrypted websocket (`wss://api.deepgram.com`, model nova-3): Keith's microphone, and the meeting audio, meaning everything that plays on the selected headset output (all remote participants, plus any other app's sound on that device). The request sets Deepgram's `mip_opt_out=true` (opt out of Deepgram's model improvement program). Deepgram's retention of audio and text is per Deepgram's terms, for Security to confirm.
- **Anthropic (Claude API):** text, not audio. Each request contains:
  - the last 30 seconds of the transcript word for word (at least the last 3 lines, however old),
  - up to about 1,800 characters of the 3 minutes before that,
  - up to 3 related lines from earlier in the call,
  - words still being transcribed,
  - the call setup Keith typed (call type, goal, outcomes, account name, deployment) and any speaker labels he set,
  - up to 3 sections from knowledge files he approved in the app, and the titles of approved files that are out of date or cover the other deployment.

  A request is sent when Keith presses HELP, **and in the background after the other side finishes speaking** (at most 4 a minute, so a suggestion is ready instantly). A small keep-alive every few minutes and a key check at app start and call start contain no call content.
- **Nothing is sent while paused or stopped**, except the optional speed test (Diagnostics), which sends only the app's built-in practice scenarios and the playbook. Locking the PC or putting it to sleep pauses a live call automatically. If nothing is heard from the other side for 10 minutes, the app asks "Still on a call?" and stops a minute later if nobody answers.

**Stored on the PC** (in the app's data folder):
- Call transcripts (text), speaker labels, the call setup for each call (including the account name), the HELP requests and suggestions Keith actually saw, and his feedback taps, in a local database and per-call transcript files. Background requests he never saw keep only timings, cost, which sources were used and what kind of check failed, not the text (older databases are cleaned when the app opens).
- Copies of the knowledge files Keith added, and their text indexed for search.
- API keys, encrypted with Windows DPAPI (tied to Keith's Windows account).
- Logs and diagnostics: timings, counts, error codes, device names, short fingerprints of knowledge file names, and some local file paths (which include the Windows user name). Never transcript or card text: automated tests check the call's diagnostics log and the HELP log, including words still being transcribed.
- Per-call HELP scorecards and speed-test reports: numbers only (counts, timings, cost, feedback taps); speed-test reports also hold the model's answers to the built-in practice scenarios.
- **No audio is ever saved.**
- "Save support files" copies only the logs, per-call diagnostics and counters, scorecards, speed-test reports and the non-secret settings into a new folder; never the database, transcripts, call setup, keys or knowledge files.
- Automatic deletion after a set number of days is planned (proposed default: 30 days).

**On screen:** the app window is hidden from screen sharing, recordings and screenshots by default (Windows 10 version 2004 and later). Keith can turn this off in Diagnostics to take a screenshot.

**Not sent anywhere else:** no analytics, no telemetry to the app's developer, nothing to GitHub. The app's source code contains no call data, keys or internal Arize documents.
