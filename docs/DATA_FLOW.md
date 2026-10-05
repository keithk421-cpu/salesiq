# What data leaves the PC (for a security review)

Sales Copilot is a Windows desktop app Keith runs during Zoom sales calls. It captures call audio on the PC, turns it into text, and on request suggests his next line.

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
- **Nothing is sent while paused or stopped**, except the optional speed test (Diagnostics), which sends the app's built-in practice scenarios and the playbook, plus, when "Include my saved moments" is ticked (the default once Keith has saved any), the practice moments he saved from his calls: each one is the same kind of request as the live HELP press it came from (the transcript up to that press, the call setup including the account name, speaker labels, and the approved knowledge sections that request used). Locking the PC or putting it to sleep pauses a live call automatically. If nothing is heard from the other side for 10 minutes, the app asks "Still on a call?" and stops a minute later if nobody answers.

**Stored on the PC** (in the app's data folder):
- Call transcripts (text), speaker labels, the call setup for each call (including the account name), the HELP requests and suggestions Keith actually saw, and his feedback (ratings, which lines he used, short notes), in a local database and per-call transcript files. Background requests he never saw keep only timings, cost, which sources were used, the call setup and speaker labels in use then (the same account and names the call already stores) and what kind of check failed, not the transcript or card text (older databases are cleaned when the app opens). Every request records the call setup and speaker labels it was built with, so a practice moment saved from it replays the same way even if they were edited later in the call.
- Copies of the knowledge files Keith added, and their text indexed for search.
- API keys, encrypted with Windows DPAPI (tied to Keith's Windows account).
- Logs and diagnostics: timings, counts, error codes, device names, short fingerprints of knowledge file names, and some local file paths (which include the Windows user name). Never transcript or card text: automated tests check the call's diagnostics log and the HELP log, including words still being transcribed.
- Per-call HELP scorecards and speed-test reports: numbers only (counts, timings, cost, feedback taps); speed-test reports also hold the model's answers to the built-in practice scenarios. A speed-test report from a run that included Keith's saved moments (in `reports/mine`, file name ending `-mine`) also holds those moments' titles (account and date) and the model's answers to them.
- Practice moments Keith saves after a call ("Save as practice moment", in the `practice` folder): call text up to that HELP press, speaker labels, the call setup including the account name, the knowledge sections HELP used (only those still approved and unchanged), the card HELP gave and his rating and note (kept up to date when he changes them in the review). Kept until he deletes the files; deleting a call doesn't delete moments saved from it.
- **No audio is ever saved.**
- "Export HELP feedback" (Diagnostics) writes one Markdown file to Keith's Downloads folder, only when he clicks it: the HELP lines he saw on his calls in the chosen period, the account names, his ratings, which lines he used and his notes. Keith decides where it goes from there.
- "Save support files" copies only the logs, per-call diagnostics and counters, scorecards, speed-test reports and the non-secret settings into a new folder; never the database, transcripts, call setup, keys, knowledge files, practice moments, speed-test reports that replayed them (`reports/mine`) or feedback exports.
- Saved calls are kept until Keith deletes them. An optional setting deletes calls older than 7, 14, 30 or 90 days (off by default; the first time it would delete anything, it lists the calls and asks). Deleting removes a call's transcript, speaker labels, HELP requests and cards, feedback and notes, and compacts the database. Numbers-only scorecards are kept.

**On screen:** the app window is hidden from screen sharing, recordings and screenshots by default (Windows 10 version 2004 and later). Keith can turn this off in Diagnostics to take a screenshot.

**Not sent anywhere else:** no analytics, no telemetry to the app's developer, nothing to GitHub. The app's source code contains no call data, keys or internal Arize documents.
