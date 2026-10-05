# What data leaves the PC (for a security review)

Sales Copilot is a Windows desktop app Keith runs during Zoom sales calls. It captures call audio on the PC, turns it into text, and on request suggests his next line.

**While a call is running (between Start and Stop/Pause):**
- **Deepgram (speech-to-text):** both audio streams stream live over an encrypted websocket (`wss://api.deepgram.com`, model nova-3): Keith's microphone, and the meeting audio playing through his headset (the buyer's voice). The request sets Deepgram's `mip_opt_out=true` (opt out of Deepgram's model improvement program). Deepgram's retention of audio and text is per Deepgram's terms, for Security to confirm.
- **Anthropic (Claude API):** text, not audio. Each request contains: the most recent part of the call transcript (about the last 3 minutes, plus a few relevant earlier lines), the call setup Keith typed (call type, goal, outcomes, account name, deployment), any speaker labels he set, and up to 3 short sections from knowledge files he approved (Arize product, security, competitive and objection material). A request is sent when Keith presses HELP, **and also in the background after most pauses in the conversation** (so a suggestion is ready instantly), **and** a small keep-alive every few minutes that contains no call content. Anthropic's retention is per the account's terms (for example whether zero data retention applies), for Security to confirm.
- Nothing is sent when the call is paused or stopped.

**Stored on the PC** (in the app's data folder):
- Call transcripts (text), speaker labels, the HELP requests and suggestions Keith actually saw, and his feedback taps, in a local database and per-call transcript files. Background requests he never saw keep only timings, cost and which sources were used, not the text.
- API keys, encrypted with Windows DPAPI (tied to Keith's Windows account).
- Logs and diagnostics with timings, device names, counts and error codes, **never** transcript or card text (covered by an automated test). "Save support files" copies only these, for troubleshooting.
- **No audio is ever saved.**
- Automatic deletion after a set number of days is planned (proposed default: 30 days).

**Not sent anywhere else:** no analytics, no telemetry to the app's developer, nothing to GitHub. The app's source code contains no call data, keys or internal Arize documents.
