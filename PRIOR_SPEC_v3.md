# Keith's Sales Copilot: Build Specification v3

Updated: 4 October 2026

Status: Implementation specification. No application has been implemented, installed, connected, or benchmarked by this document. All performance numbers are engineering targets, not measured results. Prices are dated reference inputs. Examples are synthetic unless explicitly stated otherwise.

> **Superseded.** BUILD_SPEC.md and AUDIO_DEVICE_REQUIREMENT.md take precedence. In particular, desktopCapturer is fallback-only and the locked audio-device requirement applies to any capture path.

**This document supersedes v2 and the earlier Deal Workspace Build Plan.** Start clean. No SalesCoach reuse, custom C++ audio helper, process-tree capture, hosted application stack, or workspace-first sequence. The changes below are requirements and recommendations, not implemented functionality.

## 0. The decision

Build a Windows-first, local-first Electron application for Keith's Zoom desktop calls. Headphones are mandatory. Electron/Chromium captures system output; the microphone is a separate stream. Use one coaching hotkey, one short card, and an always-visible call tracker on the second monitor.

The default is **on-demand coaching, continuous transcription**. Pressing Help reads the already-transcribed last 30 seconds. It does not start a 30-second recording or upload a retrospective audio file. Only explicit buyer objections and substantive competitor comparisons may generate proactive cards.

Remote speaker diarization and buyer/team role mapping are required before live coaching. Cross-call voice matching is in the specified release, but requires its own enrollment, calibration, privacy and packaging gate. Manual per-call labels remain a complete fallback. A speaker's name is not a provider speaker number, and a similarity score is not proof of identity.

Private records, approved knowledge, search, speaker profiles and orchestration stay on Keith's PC. Authorized cloud services transcribe live audio and generate selected text. Local-first is not local-only. Google Docs plus an external-only Drive folder remain the buyer publication destination, after live assistance works.

### Decisions on Keith's four revisions

| Revision | Decision | Important boundary |
|---|---|---|
| Replace custom audio capture with Electron system audio; require headphones | Accept | Removes the custom capture implementation, not all device/runtime risk. System audio is broader than Zoom. |
| One hotkey, last 30 seconds, one card; only two proactive triggers | Accept | Continuous STT remains necessary. Both sides provide context; only eligible buyer speech supplies the coaching target. |
| Required diarization, one-time SA enrollment, remembered buyer voices | Accept diarization and per-call mapping as core; include calibrated, opt-in cross-call matching | Do not promise recognition on every call or persist a voice profile from a tiny or mixed segment. Unknown is a valid state. |
| Persistent goal, open discovery questions, next-step tracker | Accept as core | Display immediately, update asynchronously, persist and allow correction. A seller's suggestion is not buyer agreement. |

### Confirmed environment and scope

One seller, primarily a Windows PC, Zoom desktop, multiple screens. Mac capture follows Windows validation. Clean rebuild because the earlier UI was cluttered and unclear. No new website, always-on server, team administration, CRM replacement, or automated buyer outreach.

Initial data: curated approved documents and selected transcripts. Desired optional connectors: Notion and Gmail; Gong when authorized access exists. Google Doc publishing follows local preview/export. These connections are not on the live response path.

Planning allowance remains $40-$100/month for roughly 20-40 call hours, excluding coding tools and hardware. Remote diarization is now budgeted, not optional. See section 13.

### Unknowns

Exact Windows/Electron/Zoom versions, CPU, audio routing, device policies, model/SDK access, connector permissions, and authorization to process company and participant data remain unverified. The local voice-embedding model and its operating thresholds must be selected by a packaging and held-out audio benchmark, not guessed in the specification.

User acknowledgment records a decision; it does not establish external authorization. Use synthetic or explicitly authorized testing until the real-data path is approved.

## 1. Scope boundaries

### First usable live slice

`system audio + mic -> streaming STT + remote diarization -> per-call speaker roles -> Help hotkey -> one short card`, with the persistent tracker visible from the first UI milestone.

Core includes explicit Start/Pause/Stop, headphones preflight, separate meters, visible system-capture scope, source inspection, a selected deal and knowledge pack, one-tap speaker mapping/correction, typed evidence, cost reporting, and replay testing. All five sales jobs are available on demand; only objections and comparisons are proactive.

### Full v3 live release

Add local voice-profile enrollment and cross-call matching with abstention, encryption, deletion and human correction. This is required implementation work, not an unimplemented toggle sold as recognition. An earlier developer slice may use manual labels, but cannot be called the complete v3 release. Individual people may decline enrollment without breaking the app.

### Next

Post-call evidence review, useful follow-up drafts, selected Notion/Gmail sync, and preview/approved Google Docs publication.

### Not in this release

Custom C++ capture code, process filtering, virtual audio drivers, speakerphone support, automatic identification of every remote voice, voice authentication, voice cloning, inferred demographics/emotions, buyer identity from a diarization number, a public portal, automatic sending/publishing, broad inbox scraping, room-open analytics, or a general multi-agent runtime.

Mac capture and cross-device profile/database sync are separate milestones. No Vercel, Supabase, Render, Inngest, Redis, custom gateway or dedicated vector service by default. Do not silently revive superseded architecture to work around a failed test.

## 2. User experience: one answer, persistent orientation

### Before the call

Select the deal, call type and one concrete goal. Select up to three priority discovery questions for the fixed tracker; more can remain in a drawer. Confirm headphones, the tested output route and microphone, meters, cloud destination, knowledge freshness and budget. Press Start explicitly.

Preload approved plays, accepted deal context, relevant source excerpts and this call's permitted speaker profiles. Known buyer identity does not grant access to their other deals. Selecting an attendee does not prove that person is actually speaking.

### Live panel

Approximately 440-560 logical pixels wide. Remember monitor, position and scale; recover when a monitor disappears. A fixed layout prevents coaching-card changes from moving the tracker.

```text
Listening | System audio + mic | Buyer labels: 2 / 3

CALL GOAL
Establish whether an evaluation is worth doing

DISCOVERY
Open     What must improve from the current approach?
Partial  Who owns the evaluation criteria?
Open     What needs to happen before a decision?

NEXT STEP
Proposed, not agreed: technical session
Owner and date not established

-------------------------------------------------
HELP: Ctrl+Shift+Space                [configurable]

ONE RESPONSE OR FOLLOW-UP
What would need to improve for you to consider
another option?

Source   Pin   Dismiss      Pause   Hide
```

The example is synthetic. No progress score, talk ratio, auto-scrolling transcript or pop-up stack. Speaker chips and naming controls open a compact drawer. Unknown-speaker status stays visible without obstructing the goal/questions/next step.

Default coaching shortcut: `Ctrl+Shift+Space`, remappable after collision testing. Register it as a global shortcut, report registration failure, debounce held keys, and keep a clickable Help control. [S31] Pause and Hide retain separate controls/shortcuts; one coaching hotkey does not remove safety controls.

### Card rules

One card, no focus stealing. Maximum 35 words in `say_this`, 20 in `ask_next`, 55 total excluding sources. A good question alone is enough. Sources and context are expandable. Never silently edit a sentence already displayed.

Automatic cards do not replace a pinned card or a card whose source drawer is being used. The Help shortcut is an explicit request for a new answer: it may replace the current card, preserving the old pinned item in history. This avoids a pin making the primary workflow unusable.

One active foreground request. Repeated identical presses reuse the in-flight request; a genuinely newer request supersedes it. No queue of old coaching. Proactive candidates obey a 30-second initial cooldown and 15-second minimum dwell; the hotkey bypasses both. No cooldown bypass merely because a detector repeatedly finds the same objection.

Hotkey errors use a small status message, not a fabricated coaching card: "Label this speaker as buyer or team", "No recent buyer speech", "Transcript catching up", or "No supported response". One card is the display limit, not an obligation to invent advice.

### Persistent tracker

Always show the call goal, the three selected questions in stable order, and next-step status. These remain visible during generation, outages, Pause and Hide/show cycles. Manual corrections render immediately and persist locally.

Automatic updates use finalized, attributed evidence on a separate low-priority worker, initially coalesced around every 12 seconds when new material exists. Goal: within 15 seconds under normal load. If work is delayed, retain the last state and show its age. No tracker update may delay capture or a Help response. A collapsed transcript is not a substitute for this tracker.

Question states: `open`, `asked`, `partial`, `answered`, `deferred`. Asking is not answering. A seller or SA describing a feature does not establish a buyer's process. Do not auto-remove/reorder questions; mark their state in place. New questions are proposed in the drawer, never automatically added to the fixed panel.

Next-step states: `not_discussed`, `proposed`, `agreed`, `unclear`, `withdrawn`. Agreement and scheduling completeness are separate. A buyer can agree to a technical session while date/owner remain unset; show both facts. An ambiguous "sounds good" after several suggestions is `unclear`, not automatic agreement.

Every automatic change has evidence and speaker-binding versions. Manual corrections are locked against silent overwrite. Conflicts become review proposals. Withdrawing/correcting a speaker label re-evaluates affected tracker entries. The call goal is user-controlled, not rewritten by a model.

### After the call

Review evidence, changed statements, commitments, and up to three useful next actions. Generate drafts and an optional buyer-document diff. Neither tracker status nor a voice match publishes or sends anything.

## 3. Latency and request semantics

### Primary on-demand path

On a Help press at session time `t`, snapshot finalized transcript words in `[max(0,t-30s),t]`. Include roles for both channels, the existing call tracker, a compact accepted deal summary, and locally retrieved approved evidence. The recent-conversation window is 30 seconds; persistent deal/tracker evidence is separate, labeled context.

Use word timestamps so a turn extending across the window does not silently import an extra two minutes. Mark truncated turns. Missing beginning, lost negation or ambiguous reference triggers clarification/no-card, not reconstructed speech. The evidence drawer may offer an explicit earlier-turn selection as a separate action; the default hotkey never silently expands its window.

Select a relevant buyer target inside the window. Team speech can show that a question was answered or clarify what the buyer referred to; it cannot itself become buyer evidence. If the SA has spoken for 40 seconds and there is no buyer speech inside the window, return "No recent buyer speech". The user may explicitly select an earlier buyer turn.

Interim text may prefetch references. Wait up to a proposed 400 ms budget for an in-flight final segment when necessary, included in total latency. Do not issue blanket finalization or restart STT on every hotkey. If current speech remains unfinished or materially uncertain, show an appropriate status rather than an affirmative claim. [S4]

### Latency targets, not measured results

| Mode | Clock starts | Target |
|---|---|---|
| Hotkey, prepared response | Keypress received | Median <=0.5s, p95 <=1.0s |
| Hotkey, generated response | Keypress received, including STT catch-up | Median <=2.0s, p95 <=3.0s |
| Proactive response | Actual end of the relevant spoken buyer turn | Median <=2.0s, p95 <=3.0s, including diarization/role readiness |
| Tracker | End of relevant finalized/attributable exchange | Normally within 15s; stale age visible otherwise |

A proposed hard timeout is four seconds for a hotkey request and three seconds for a proactive candidate. Never render a stale result after its deadline. A usable prepared clarification may replace a timed-out generation only when genuinely relevant. No first-token or empty-spinner success metrics.

For proactive timing, do not restart the clock when identity finally resolves. Late identity resolution means a missed proactive opportunity, not a suddenly fresh objection. It may still support a new, explicit Help request.

### Only two proactive triggers

`explicit_objection`: clear resistance to price, fit, urgency, effort, risk or need.

`competitor_comparison`: an actual request or evaluation comparing Arize with a named alternative. A neutral competitor mention, hypothetical quoted objection, negated usage, or team battlecard discussion is insufficient.

Everything else, including technical questions, value mapping, discovery follow-ups and time management, waits for Help. Tracker updates are state maintenance, not proactive coaching cards.

Use local rules to propose eligible candidates; when needed one short model call decides whether to produce a grounded card or abstain. Do not run a hosted classifier on every utterance. Preserve context beyond keywords to avoid "price isn't a concern" causing an objection card.

### Priority and cancellation

Priority: Stop/Pause and capture continuity; then role/segment correctness; then Help; then allowed proactive work; then tracker; then imports and post-call jobs. Voice embedding inference is bounded, off the UI thread, and never awaited on a Help request.

No live Notion/Gmail/Gong lookup, web search, reindexing, or planner/researcher/writer/critic chain. Prepared text and preloaded retrieval reduce work on the path. [S6]

Requests carry IDs and versions for session, connection epoch, target speech, speaker binding, context, tracker and sources. Before display, trusted code revalidates these. A new unrelated utterance does not automatically kill a hotkey answer, but resolved/contradicted premises, role corrections, Pause, expired sources or superseding Help do. Keep no obsolete request queue.

## 4. Architecture

### Stack

| Component | Choice | Responsibility |
|---|---|---|
| Desktop | Electron + TypeScript | Windows shell, shortcuts, capture permissions and lifecycle |
| Interface | React + Vite | Second-screen panel, persistent tracker, drawers and review views |
| System capture | Electron `desktopCapturer` selection plus `setDisplayMediaRequestHandler` and `getDisplayMedia` | Windows `audio: 'loopback'`, not application-process capture |
| Microphone | Separate `getUserMedia` stream | Local speech context; independent of Zoom mute |
| Audio processing | AudioWorklet in a dedicated trusted local capture renderer | Bounded PCM frames, resampling, timebase and meters |
| Speech | Deepgram Nova-3 baseline, separate mono streams | Remote `diarize_model=v1`; microphone diarization off |
| Storage | Local SQLite + FTS5 | Sources, plays, sessions, evidence, speaker bindings, tracker and jobs |
| Voice matching | Local pretrained embedding adapter in a utility process | Enroll/compare; encrypted saved profiles; no cloud identity lookup |
| Inference runtime candidate | Prebuilt `onnxruntime-node` CPU runtime | Pin model/preprocessing and verify Windows packaging before adoption |
| Card generation | Configurable approved text-model adapter | At most one short foreground generation request |
| Tracker | Local state reducer + bounded low-priority extraction | Evidence-backed deltas, persistence and corrections |
| Publication | Google Docs/Drive, later | Approved external content, not private database |

Electron's documented source-selection/display-media route supports the Windows loopback path. Deepgram currently distinguishes versioned streaming diarization from batch diarization. ONNX Runtime publishes prebuilt Node CPU binaries for Windows; that does not prove that an arbitrary embedding model or Electron package works without testing. [S23-S25, S28]

Start the text model with the v2 configurable baseline, not a claim that it is the best available model. Pin a tested model/version after quality and latency measurement. No model can override permissions, profile consent, source validity or role routing.

### Data flow

```text
System output -> Electron display capture -> remote STT + diarization --+
Mic ----------> separate microphone capture -> local STT ---------------+
                                                                      |
                 local voice matcher + user labels -> role bindings ---+
                                                                      |
                       finalized, role-attributed conversation store
                             /                  |                 
                    Help: last 30s    objection/comparison     tracker deltas
                          |                buyer gate          (low priority)
                 local evidence retrieval         |                  |
                          +------ one card path ---+          persistent panel
                                      |
                          claim / role / deadline checks
                                      |
                             one readable response
                                      |
                          post-call review -> approved Docs
```

### Process boundaries

The main process handles lifecycle, scoped permission grants, hotkeys and protected credentials. A trusted capture renderer uses media APIs and AudioWorklet; it never loads external content or receives provider keys. UI content is sanitized and cannot invoke capture except through an explicit validated command. Avoid broad origin grants in `setDisplayMediaRequestHandler`.

A worker/utility process handles STT, text requests, local retrieval and database jobs. Local speaker inference runs in an isolated bounded worker so native inference cannot block audio/UI. This is not a custom C++ capture helper. Verify packaged dependencies; do not assume removing bespoke capture means there are no native dependencies anywhere.

Keep nodeIntegration off, contextIsolation on, renderer sandboxing, restricted IPC and CSP. No public listener, embedded shared API secret, background meeting joiner or Zoom API dependency. [S9]

Store tokens and the key used to encrypt saved voice embeddings with OS-backed protection. That does not defend against every process running as the same OS user. [S10]

## 5. Windows audio engineering

### Supported path

Start on the actual Windows PC, Zoom desktop and headphone/output route. The tested Electron version is pinned after the capture spike. Removing the helper reduces implementation surface but is not a substitute for that hardware test.

1. From an explicit Start gesture in the trusted local UI, select a display source using `desktopCapturer` with thumbnail generation disabled when unnecessary.
2. Approve only that request origin/frame in `setDisplayMediaRequestHandler`, returning the selected video source and Windows `audio: 'loopback'`. Do not use `loopbackWithMute`: Keith must continue hearing the meeting.
3. Call `getDisplayMedia` with audio enabled and a minimal video track. The standard API requires a video track; `video:false` is not an audio-only shortcut. [S23, S24, S26]
4. Extract only audio into the PCM pipeline. Never transmit, persist, render or analyze screen frames. Test whether the unused video track can be stopped without killing audio on the pinned version. If not, keep it unconsumed for the session and disclose that a display track exists locally. Do not claim that no screen capture was requested.
5. Request microphone audio separately with the explicitly selected device. No camera permission.
6. Validate actual audio tracks/activity and the real output route. API success is not evidence that useful audio arrived.

### System scope and headphones

The captured channel is named `system_remote`, not `zoom_only`. It can include other apps on the captured output route. Headphones address the acoustic path; they do not filter digital system audio. Quiet other applications before the call. Do not promise automatic origin detection from the mixed stream. [S24]

Preflight: headphones confirmed, no unrelated playback, Zoom output route tested, microphone meter tested. Device names are not proof that headphones are worn. Acknowledgment plus a short practical audio check is the supported v1 control, not a fake headphone detector.

Known output-device changes, track termination or reconnection invalidate the tested route. Pause capture and re-run preflight before resuming when the route is uncertain. No speakerphone or remote-only workaround is advertised as satisfying the configured two-stream release. A degraded mode must be named as such, not silently accepted.

A deliberate test with unrelated playback must show the scope limitation, not assert exclusion. During demos with audio playback, pause interpretation/capture deliberately. A recorded voice can resemble a saved person; this system is not replay-resistant identity authentication.

### Mute and playback

Zoom mute is not the assistant's mic mute. Both states must be explained in setup; only the assistant's Pause guarantees both of its streams stop. Do not monitor captured audio through the speakers/headphones, which would create feedback. The app emits no sound notifications.

### Timing, transport and buffers

Keep two independent mono streams. Audio frames include channel, session, connection epoch, monotonic sequence, capture timestamp, sample rate and PCM format. Resample correctly and preserve gaps. Word timestamps from STT reconnects are mapped into the common session clock.

Maintain three separate bounded structures:

- Transmission queue: at most 2 seconds per channel. No long catch-up replay to the live engine.
- Recent transcript: session text under retention policy, with indexed 30-second snapshots for Help. This is not a raw-audio recording.
- Speaker matching audio: at most 45 seconds of remote PCM in RAM when local speaker processing is enabled, plus at most 30 seconds of clean candidate speech per actively enrolled/matched speaker, maximum 12 simultaneous collectors. The ring allows diarization/attribution lag and a recent one-tap label; it never grows with call duration.

Raw audio is not written by the application by default. Exclude audio from crash reports and logs. RAM-only application handling is not a claim about OS paging or forensic erasure. No voice embedding enters the text model or the search index.

Pause/Stop clears transmission queues, recent-audio rings and incomplete enrollment collectors, and stops all media tracks and outgoing speech traffic. Completed saved profiles persist only under their explicit retention policy. Cancel outstanding card/identity work; callbacks from an old session may not relabel a new one. Previously transmitted data cannot be recalled by Pause.

Resume requires explicit action after Pause and never retransmits paused audio. A network reconnect while still active creates a new STT connection epoch, visible gap and fresh raw speaker namespace. Close all tracks on app exit or capture-renderer failure. An ordinary temporary UI hide does not pause or suspend capture.

## 6. Speech, identity and buyer-only coaching

### 6.1 Required diarization

Use a separately transcribed mic and system stream. For the Nova-3 remote stream, pin `diarize_model=v1` as the documented current streaming baseline. Do not send both `diarize` and `diarize_model`, and do not select the batch-only v2 diarizer for live streaming. Microphone diarization is off in the one-local-speaker pilot. Verify model compatibility, word speaker labels and resolved diarizer metadata rather than showing "diarization on" from a config flag alone. [S25]

Streaming Deepgram results provide speaker labels but not a `speaker_confidence` field. Word confidence is recognition confidence, not identity confidence. Do not invent a provider speaker-confidence value. Keep any local matching score explicitly separate. [S25]

Raw provider labels are opaque cluster IDs, scoped to `(session_id, channel, connection_epoch, provider_speaker_id)`. They must never be stored as global people. Unknown, short, overlapping or inconsistent speech remains uncertain. Diarization labels do not create isolated clean audio for each speaker; sample selection must respect overlap and quality.

Turn boundaries, word timestamps, interim/final revisions and connection gaps are first-class data. Partial text can prefetch, not establish a buyer commitment or high-impact claim. Default endpointing around 300 ms is an experiment, not a claim of semantic turn completion. Reconnects must not reuse "speaker 0 = SA" from the old connection. [S4, S5]

Require the approved endpoint/region and `mip_opt_out=true` on every speech request. No silent cross-region failover. Verify settings against outgoing requests and provider usage configuration. These data-handling controls do not establish employer or participant authorization. [S12]

### 6.2 Per-call speaker mapping: mandatory before coaching

The local mic is `seller` only under the explicit single-local-speaker assumption. Co-located participants require manual review or unsupported-mode warning. Remote roles are `buyer`, `team`, `unknown`, or `media`.

A compact speaker drawer shows a recent finalized text segment and neutral labels. Tapping a segment lets Keith choose a person and role. A stable current-call binding applies to that provider cluster, with an immediate correction control. A new person can be labeled "Buyer 1" without a saved cross-call identity.

Keep a versioned mapping, not destructive transcript rewriting. If a cluster appears contaminated, splits, merges or is corrected, retain word-level/raw speaker evidence, mark affected portions uncertain, invalidate affected cards and tracker changes, and request remapping. A manual label is an assertion for the call, not proof that diarization will never err afterward.

### 6.3 Voiceprints: a separate, in-scope identity feature

Diarization groups speech; cross-call identification compares voices with saved representations. pyannoteAI explicitly distinguishes those operations and describes clean single-speaker enrollment. It also notes that voiceprints do not improve diarization itself. Its cited identification tutorial is for recorded-audio jobs, not a demonstrated drop-in sub-second live identity API. [S27]

**Selected approach:** local speaker embeddings in a bounded utility process, alongside Deepgram, with encrypted profiles retained on this installation. Prototype a pretrained embedding model with ONNX Runtime's prebuilt Node CPU runtime. Select and pin the model, license, file hash, expected sample rate, feature normalization and inference interface only after a parity/packaging spike. ONNX Runtime is the executor, not a speaker-recognition model. Do not assume a generic ONNX file accepts raw PCM. [S28, S29]

Model qualification must produce `speaker_model.manifest.json` with artifact origin, SHA-256, license, input/output shapes, preprocessing version, runtime version, measured target-machine cost, calibration dataset identifier and operating thresholds. The provided template is deliberately unqualified. No model artifact, calibrated threshold or actual recognition accuracy has been supplied by this pack.

#### SA enrollment

Record roughly 30 seconds of the SA's normal clean speech, ideally through the Zoom/headphone audio path used in real calls, with explicit permission for reusable recognition. Reject silence, poor quality, overlapping voices and a snippet too short to meet the chosen model's tested requirements. Wall-clock duration is not the same as usable speech.

Compute and encrypt the representation locally. Retain model/quality/version metadata, not the enrollment audio by default. Evaluate future utterances as sufficient clean speech arrives. The system may label a strong qualified match automatically, but must abstain on weak/ambiguous matches. A changed microphone or room is part of the held-out test, not a promise of perfect invariance.

#### One-tap buyer labeling and future calls

Tapping a segment immediately creates the current-call name/role mapping. Saving a reusable voice profile is a separate explicit opt-in, with appropriate participant permission, not a hidden side effect of naming someone.

If usable recent audio is available and permitted, create the profile after quality checks. Otherwise show "Named for this call; voice profile pending" and collect sufficient upcoming speech only while consent/enrollment remains active. An old transcript whose audio has expired cannot recreate a voiceprint. A tiny "yes" must not create a durable profile.

Cross-call search uses only explicitly selected relevant profiles for that meeting/account. Do not search a global collection and do not use a voice match to pull private context from a different deal. Cross-device persistence is not included; Mac support does not automatically copy these profiles.

#### Matching and correction policy

States: `unknown`, `candidate`, `accepted`, `conflict`. Accepted bindings record whether the source was manual or a calibrated voice match. Keep identity and call role separate: the same person's role may differ by engagement.

Before auto-acceptance require enough clean voiced material, repeated agreement across independent non-overlapping windows, an absolute calibrated match threshold, and a calibrated margin over the next candidate. Starting experiments can use at least 8 seconds total voiced material across two windows; these are tuning inputs, not published model guarantees. Thresholds remain unset and auto-acceptance disabled until the benchmark qualifies them.

Never display cosine similarity as a percentage certainty. Never choose the nearest stored person when all candidates are poor. Never label every non-SA remote speaker a buyer. Short interruptions and overlap may remain unknown even after enrollment.

A disputed match goes back to unknown/conflict and suppresses dependent coaching. Manual corrections win and are logged. Saved profiles are never automatically trained on their own unconfirmed guesses, which would propagate a wrong match. Offer explicit profile replacement/deletion and require requalification after an embedding-model change; different embedding spaces are not interchangeable.

#### Privacy boundary

Persistent identification templates are treated as sensitive biometric information, not harmless contact metadata. No covert enrollment from Gong, archived calls, or the mic. Reusable enrollment has an explicit purpose, opt-in/permission record, retention expiry and Delete Profile control. Application policy requires this independently of the jurisdiction-specific legal assessment. FTC guidance identifies unexpected biometric collection and unsupported accuracy claims as risks. [S30]

Profiles stay local, encrypted and excluded from prompts, analytics, exported buyer documents and ordinary backups. A deliberate encrypted profile backup/export is separate. Deletion removes active and cached matching material; backup retention and already-published text require their own handling. No voice authentication, cloning, sentiment inference or demographic classification.

### 6.4 Buyer-only gate, enforced in trusted code

Before generation and again before display, resolve the target transcript span to a valid, current accepted buyer-role binding. Valid provenance: manual per-call mapping or a calibrated accepted voice match plus a configured meeting role. The model does not assign permissions or invent role confidence.

| Speech/context | Coaching behavior |
|---|---|
| Named/role-confirmed buyer | Eligible for Help; proactive only for the two allowed triggers |
| Buyer role confirmed, name unknown | Eligible without a persistent voice profile |
| SA or another teammate | Context only; cannot trigger or become buyer validation |
| Keith/local mic | Context only; cannot trigger |
| Unmapped/ambiguous/overlapping remote speech | No buyer-targeted coaching until corrected |
| Known media/demo audio | Excluded from buyer coaching and commitment evidence |

Both sides remain available as context. Example: buyer asks a question, the SA answers, Keith presses Help. Suppress repeating the answered question; suggest a relevant buyer follow-up only when grounded. Dropping all team text would make this check impossible.

An unknown-speaker Help request displays a naming control, not invented advice. Manual search of approved documents remains available without a buyer, but is a distinct tool and must not be reported as buyer-triggered live coaching.

### 6.5 Card generation and validation

The common request contains the 30-second snapshot, known roles, target evidence, compact call/deal state, eligible plays and a few approved excerpts. Begin with <=4,000 input tokens and <=350 output tokens; measure and tune. Trusted code constructs provenance fields, not the model.

Allowed content modes:

- `question_only`: one relevant question, no vendor assertions.
- `approved_verbatim`: model selects a current approved claim ID; trusted code renders exact reviewed text/qualifiers.
- `contextual_move`: short grounded restatement or sales move without new product, competitive, security, commercial or quantitative claims.

A cited ID is not proof that free-form text is true. Validate evidence, audience, role-binding version, source freshness, word limits and deadline immediately before rendering. Unsupported technical questions produce a precise clarification, a saved SA follow-up, or no card. No live browsing or send/publish tools.

### 6.6 Tracker extraction and state reducer

The tracker sees the full sequence of finalized, role-attributed session evidence incrementally, not only the most recent hotkey window. Maintain a bounded extraction cursor and replayable history. Recent context can resolve a pronoun; it cannot turn an earlier unanswered question into an answer without evidence.

Extraction returns candidate deltas with evidence spans, role bindings and state version. Deterministic code checks entity IDs, current attribution, manual locks and allowed transitions before persisting. Next-step agreement needs an attributable buyer acceptance linked to a specific action; seller proposals remain proposed. Owner/date completeness is tracked separately. A buyer's "no date yet" is not silently normalized to a guessed date.

Persist accepted live tracker state locally after each update. It remains provisional for post-call external publication. Late extraction must compare versions and may not overwrite a newer manual correction. Pause freezes new updates; resume catches up only on legitimately captured text. No generated score or dashboard is introduced.

## 7. Knowledge preparation and Notion

### Initial pack

Import a curated set of approved Markdown/TXT documents and timestamped VTT/TXT calls. Richer formats can follow behind a bounded parser. Each source has its original identifier or local filename, version/hash, import time, business owner, audience, approval state, and review-by date.

Prepare approximately 40-60 high-frequency plays before the first serious pilot. This number is a target for coverage, not a reason to generate filler. A smaller high-quality pack is better than a large unreviewed wiki dump.

Separate sales questions from product claims. A claim needs a current supporting source and permitted wording. The first shipped demo pack contains synthetic question-only plays, not purportedly approved Arize feature claims.

A useful play includes positive trigger examples, negated/irrelevant examples, call types, prerequisites, a short response, one optional follow-up, source dependencies, and suppression rules. Review its wording with Keith.

### Notion adapter

Read only selected enablement and product pages into a local snapshot. Do not write back to Notion in v1. Label when each source was last refreshed and whether access has failed.

Current Notion authorization offers internal connections, public OAuth connections, and user-scoped personal access tokens. Workspace controls and user role matter. Internal connection creation is owner-controlled and its pages must be shared; a permitted PAT acts with the user's permissions, not a magical page-limited read-only grant. [S13]

Preferred order: use an authorized page-limited connection if available; otherwise a permitted user token with an application-enforced page allowlist; otherwise import allowed exports. Never scrape browser sessions or extract another application's token to bypass a blocked integration.

Document the distinction between API-granted scope and the narrower operations the app chooses to perform. Keep API version and token type in adapter configuration. Follow pagination for nested page content; inaccessible or partial content is marked incomplete, not treated as the entire source.

Sync before calls. Freeze a coherent session snapshot, but process explicit source revocations/withdrawals immediately. Expired or revoked claims cannot be used even if their text remains cached. Source changes invalidate dependent prepared responses until reviewed.

## 8. Local deal records and post-call workflow

### Minimal data entities

| Entity | Key information |
|---|---|
| deals | Name, account, user-selected current goal and context |
| sessions | Deal, start/stop times, call type, capture and model versions |
| transcript_segments | Channel, connection epoch, raw speaker cluster, timestamps, revisions and exact text |
| speaker_bindings | Session identity/role, manual versus voice-match provenance, version, uncertainty and correction history |
| voice_profiles | Encrypted representation, explicit enrollment record, model/quality/version, expiry; no default saved audio |
| tracker_state | User goal, stable question IDs/states, next-step agreement/completeness, evidence and manual locks |
| source_versions | Origin, version hash, classification, approval, freshness, retention |
| evidence_spans | Exact text location or transcript interval and source version |
| observations | Statement, provenance, evidence IDs, review status, temporal status |
| claims and plays | Approved wording, applicability, triggers, sources, expiry |
| cards | Trigger, output, sources, model, latency, feedback, suppression |
| commitments | Proposed versus agreed owner/date/action, with evidence |
| drafts and publications | Content hashes, source dependencies, approval, destination |
| connector_state | Selected scopes/resources, last successful sync, errors |
| jobs and usage | Retry state, idempotency key, reserved and actual usage |

One user does not eliminate cross-deal privacy errors. Require deal assignment before using imported call/email content. Shared product knowledge is reusable; another account's private details are not.

### Evidence rules

Preserve the difference between buyer statement, seller statement, approved reference, inference, and unknown. Keep review state separate from provenance. Keep current, conflicting, and superseded statements separate.

The system can use tentative live text context for a relevant question only after its buyer-role target passes the gate. It cannot silently promote it to an accepted deal fact or publish it after a call. Unknown speaker attribution must remain unknown until reviewed.

Post-call processing returns a diff: new statements, changed dates, contradictions, unanswered questions, and possible commitments. A buyer saying "maybe next month" is not an agreed date. Keith exporting a draft is not evidence of sending it.

Require user review for accepted deal-state changes used in external materials. All factual buyer-facing content must trace to accepted evidence or approved product wording.

### Follow-up and action quality

Generate at most three next actions. Each includes the observed trigger, why now, the buying decision it could advance, proposed recipient, draft, and evidence. No invented economic buyer, urgency, blocker, budget, competitor dissatisfaction, or customer proof.

Follow Keith's style: short direct paragraphs, contractions, no em dashes, no canned praise, no generic bump, no internal Arize product nicknames, and one concrete purpose when requesting a meeting. Keep research citations in the review UI rather than scattering them through prospect-facing copy. Preserve required compliance wording.

## 9. Gmail: track the actual conversation, not imaginary intent

The initial integration tracks sent and received messages for selected deal threads: last contact, last response, questions asked, explicit dates, promised material, and who has joined the thread.

Do not build an email-pixel service. Mail privacy mechanisms can obscure whether a recipient opened a message. Apple specifically documents this limitation. An open is not a buying decision, and the product should not create urgency from it. [S14]

Treat `read/unread` in Keith's mailbox as Keith's mailbox state, not the prospect's read state.

### Authorization and sync

Use Google OAuth for the new application. ChatGPT's existing connector access does not transfer to this app. Gmail read-only is a restricted scope; broader account policies, verification requirements, and any applicable exceptions must be resolved for this deployment. Sending Gmail-derived content to a cloud model is still a data transfer even though the app is local. [S15]

Start with a manually selected deal-thread allowlist and bounded historical import. A label can help selection, but it does not narrow the underlying OAuth grant. Do not request send or modify permissions merely to show local drafts.

Track stable provider message IDs and local source hashes. Use incremental reconciliation and visible last-success time. Handle edits/deletions or missing messages without silently inventing a complete history. Stop automatic account matching when multiple deals share a domain.

Remote images, tracking pixels, scripts, and attachments in email must not execute or download merely because the app parsed the body. Extract text safely; import attachments only through an explicit bounded flow.

When the app is closed or the PC sleeps, local synchronization stops. On launch, catch up before presenting the record as current. Do not promise 24/7 monitoring or notifications without an always-on component.

If OAuth is blocked, support user-approved pasted text or email exports. Do not ask the coding agent to evade workspace controls.

## 10. Gong: optional, not a dependency

The Gong API supports call data and authorized integrations. Gong's documentation states that manually creating API credentials requires a technical administrator; OAuth is another route. Keith's actual access has not been verified. [S16]

Do not promise one-click Gong access without account checks. Initial fallback: import a permitted transcript export and retain its original call identifier or link. The live assistant creates its own session transcript regardless of whether Gong integration exists, subject to the approved capture policy.

Later, an authorized read-only adapter may ingest selected calls/transcripts. Avoid duplicate evidence when the same meeting is imported from Gong and locally transcribed. Keep both source versions and link them to one session rather than pretending they are two independent confirmations.

Never scrape private Gong UI sessions, borrow admin credentials, or rely on undocumented endpoints to bypass denied API access.

## 11. Buyer workspace: Google Doc plus Drive

### Recommendation

Use a stable Google Doc as the buyer's front page. Use a dedicated external-only Drive folder for resources. This avoids operating a separate website or forcing a new portal account while the assistant is still being developed.

The cloud-hosted Google document is separate from the local application. Buyers can access the shared material without Keith keeping his PC running. New AI updates and local sync still require the application to run.

### Example structure

```text
Arize x Northstar Financial                  [synthetic account]

1. The outcome under evaluation
2. What we heard
3. What the evaluation needs to prove
4. Open questions and answers
5. Next steps, owners, and dates
6. Relevant resources, with one-line explanations

Resources folder
  Evaluation plan
  Approved architecture or deployment material
  Relevant customer proof, when permitted
  Meeting recap or recording link, when permitted
```

Keep the overview short. Add sections when the deal has enough confirmed information, not as empty template filler. A transcript dump is not a room. The goal is something the buyer can use in an internal review.

### Private versus external

Private: qualification gaps, negotiation strategy, internal notes, full transcripts, unapproved claims, draft versions, and confidential material for another audience.

External: deliberately approved outcome, criteria, resources, unanswered questions, and agreed next steps.

Never create a buyer draft in the already shared folder. Folder permissions inherit to newly added files. Stage drafts locally or in a private app-created area and publish only approved content. [S17]

All material inside a shared resource folder must be appropriate for everyone with access to it. Pricing or sensitive security information for a narrower group belongs in a separate permission boundary. Do not rely on a hidden link or collapsed section to restrict access.

### Initial workflow

First ship a local preview and clean copy/export. Keith can use it with an existing Google Doc without any API setup. Do not mark manual export as automatic publication.

Then add an explicitly authorized Google Docs/Drive publisher. Prefer `drive.file` for app-created or explicitly selected files. This is different from requesting broad access to all of Drive. [S18]

The application proposes a diff after a call. Keith edits and approves the exact content, destination, and intended audience. The app writes only on that action. It does not change sharing merely because a new stakeholder was mentioned.

### Updating the stable document safely

Store the Google document ID and last reviewed revision. Read the current document before each write. Use the API's required-revision precondition so a stale update fails rather than overwrites intervening edits. On conflict, fetch current content, show the difference, and request renewed approval. [S19]

Default buyer role recommendation is Commenter; Keith confirms the actual role and recipients before any sharing action. Do not implement two-way task editing or infer that a comment is acceptance. Keep comment-containing sections intact; do not replace the entire document body blindly.

Track each publishing attempt locally with a stable idempotency key, content hash, target ID, and result. If a write times out, read back and reconcile before retrying. Google Drive asset creation and a Docs write are not one atomic transaction; partial failure must be visible.

Show the last successful publication time. Never present an update as published merely because generation finished.

### What this version intentionally does not provide

No branded portal, verified stakeholder analytics, section-level engagement scoring, hidden-stakeholder identification, automatic follow-up from views, or custom guest task workflow.

A forwarded link does not identify its new reader. Access revocation cannot recall previously downloaded or copied material. Keep expectations explicit.

A custom portal is a later decision only if actual usage shows that Docs access, layout, or collaboration is blocking deals.

## 12. Privacy, controls, and resilience

### Avoid Zoom integration, not applicable requirements

Electron system capture does not require designing a Zoom Marketplace integration. It does not remove OS permissions, device controls, participant notice/consent requirements, or employer data-handling rules. The application must not be designed to defeat them.

Do not assume that being meeting host, or having Gong already record, automatically authorizes a second processor. Before real company data, establish the approved data path. Until then, use synthetic content and authorized test sessions.

No hidden auto-start capture. Start is explicit. Show a local capture indicator and processing destination. Pause stops new audio transmission and clears queued audio. Stop terminates the session. No recording continues after application exit.

### Data destinations

| Data | Local default | Optional external destination |
|---|---|---|
| Raw live audio | Bounded transmission buffer; optional 45-second identity ring/limited collectors, not saved | Chosen STT service while active |
| Voice profiles | Encrypted on this installation after explicit enrollment | None in v3; never sent to the text model |
| Transcript | Local under retention policy | Selected excerpts to approved model |
| Notion/Gmail content | Selected local snapshot | Relevant excerpts only when permitted |
| Private deal data | Local database | None by default |
| Buyer-approved content | Local publication record | Selected Google Doc and folder |
| Keys/tokens | OS-protected secret storage | Only the relevant provider |
| Diagnostics | Local metadata, redacted | Export only with explicit review |

Minimizing context is not anonymization. A short excerpt may still contain confidential information. Do not label it anonymous without a separate verified transformation.

OpenAI distinguishes application-state storage from abuse-monitoring retention. `store=false` alone is not a zero-retention guarantee. Configure the selected endpoint and account against the actual approved policy. [S20]

### Local storage and retention

Store the live SQLite database on the local device, not in a Google Drive/OneDrive/Dropbox sync directory. Use a supported backup/snapshot operation and encrypt portable backups separately. SQLite WAL relies on same-host coordination; do not treat a shared/synchronized file as cross-device database replication. [S21]

Require appropriate device encryption and filesystem permissions before sensitive persistent data. Do not claim vanilla SQLite automatically encrypts the database. If application-level database encryption is required by policy, choose and test a supported encryption build as a separate gate.

Proposed configurable defaults: no raw audio retained; transcript/source retention of 30 days for an initial pilot unless policy requires otherwise; accepted notes and publication records retained only for the selected deal-retention period. Deleted source content must be removed from local chunks/caches and dependent drafts flagged. Externally published material and provider retention require separate handling and cannot be magically erased by deleting the local file.

### Sharing your screen

The panel should live on the unshared display. Provide a Hide shortcut. Do not promise it is invisible to all screen-recording mechanisms. Application-window sharing should be tested on the actual Zoom/OS setup. Electron documents limitations to content protection, including some macOS capture paths. Hide is not a substitute for Pause. [S3]

### Security and failure states

Treat all transcripts, documents, and emails as untrusted data. They cannot change system instructions, call external tools, publish content, or reveal credentials. Test prompt-injection strings as source content.

Block a request when its source is expired or outside the selected deal. Sanitize rendered Markdown/HTML. Disable arbitrary remote resource loads. Validate file paths, sizes, types, and parser limits. Keep real data and keys out of the coding-agent repository and test fixtures.

An expired token displays a reconnect requirement. Missing audio displays which channel failed. No approved source results in a clarification or no card. API outages preserve manual local playbook search. A local-only offline mode in v1 means manual search and drafts already stored, not an unimplemented automatic local transcription engine.

## 13. Cost model and controls

Plan $40-$100/month for roughly 20-40 call hours and start with a $100 runtime budget. This is an allowance, not a vendor quote. Coding-agent subscriptions, taxes, hardware/electricity, existing Workspace, signing, enterprise agreements and profile-model licensing are separate.

No mandatory custom hosting. Continuous transcription remains necessary even though answers are on demand. Do not estimate STT cost as "number of hotkey presses". Remote diarization is required; microphone diarization is not.

### Speech reference inputs

On 4 October 2026, Deepgram's pricing page lists regular Nova-3 monolingual streaming at $0.0077/minute, a promotional rate of $0.0048/minute, and streaming diarization at $0.0020/minute. Budget using the regular base rate and diarization on the one remote stream. Confirm effective account, opt-out, feature and regional pricing before spending. [S22]

| Call hours/month | Two-stream base STT | Remote diarization | Speech subtotal |
|---|---:|---:|---:|
| 20 | $18.48 | $2.40 | $20.88 |
| 40 | $36.96 | $4.80 | $41.76 |
| 80 | $73.92 | $9.60 | $83.52 |

Formula: `hours * 60 * (2 * base_rate + 1 * remote_diarization_rate)`.

Voice matching on the local device has no chosen cloud API line item. Runtime/model packaging, storage and compute still have costs. No additional cloud identity vendor is authorized by this plan.

Text-generation planning allowance remains $10-$40/month for live cards, tracker updates, post-call drafting and selected sync work. Track all categories independently. On-demand may reduce coaching requests but automatic tracker extraction also consumes tokens; do not claim guaranteed savings before measurement. COST_MODEL.json supplies an illustrative workload, not observed usage.

### Spend controls

Record active stream minutes, diarized stream minutes, model tokens, retries and job categories. Reserve expected call spend at Start, warn at 80% of the monthly budget, and require explicit changes before new paid work beyond the limit. Do not surprise-cut an admitted call because a low-priority sync job consumed its reservation.

Keep local tracker state, stored plays and manual search usable when paid inference is unavailable. Provider estimates and reporting delays mean app budgets are not guaranteed vendor-enforced caps. Reconcile actual usage and use supported provider limits.

Fully local STT and language generation remain optional measured experiments, not v3 dependencies. Local speaker embedding is the only new local-model requirement. Do not buy a GPU based on this specification.

## 14. Repository and coding-agent contract

```text
apps/desktop/
  main/                     lifecycle, scoped IPC, secrets, global shortcuts
  renderer/                 fixed tracker + one-card UI, naming and evidence drawers
  capture/                  trusted local capture page + AudioWorklet
  preload/                  narrow typed bridges
packages/
  contracts/                schemas and types
  audio/                    frame format, resampling/time mapping and bounded queues
  speakers/                 binding state, enrollment, matching policy and corrections
  speaker-inference/        bounded local pretrained-model adapter; packaged runtime
  tracker/                  delta extraction, deterministic reducer and persistence
  domain/                   evidence, plays, commitments, publication approvals
  storage/                  SQLite migrations, jobs and encrypted profile records
  retrieval/                local sources, search and approval filters
  live/                     hotkey snapshot, two proactive triggers, cancellation
  providers/                STT and text model adapters
  connectors/               optional Notion, Gmail, Drive, Gong
  evals/                    incremental replay, speaker benchmarks and app tests
  telemetry/                redacted timings and categorized spend
config/                     non-secret defaults and qualified model manifest
scripts/                    doctor, build, test, package and verification
```

No `native/windows-audio` project. Pin tested dependencies and model hashes. The local embedding runtime may contain prebuilt native binaries; verify their provenance, licensing and Electron/Windows package behavior without reintroducing a custom capture helper.

Implement `doctor`, `dev`, `test`, `test:replay`, `test:speakers`, `typecheck`, `lint`, `package:win`. These are required future scripts, not claims that application source exists in this pack.

Doctor checks OS/Electron/Zoom, devices and test route status, privacy configuration, local data path, permitted endpoints, model manifest and calibration readiness. It must not record audio or enroll people as a side effect. Secrets and voice embeddings stay out of reports.

Architect owns data contracts, role routing, enrollment and publication boundaries. Engineer owns working slices and target-machine tests. AE reviewer owns usefulness, supported claims and tracker relevance. These are review responsibilities, not a claim of independent agents having completed work.

One integration owner resolves shared contracts. Coding agents do not silently waive a failed speaker gate, substitute a cloud identity processor, remove the tracker, or revive process-tree capture. Every task reports changed files, commands actually run, failures, measured results and next dependency.

## 15. Milestones and acceptance

No calendar delivery guarantee. Capture is simpler than v2, while voice matching is new work. An early manual-label slice is useful; the complete requested v3 release also needs the identity gate.

### M0: Fixed UI and contracts

Clean Electron repository, one card, persistent tracker, speaker drawer, hotkey, Pause/Hide, Windows scaling and synthetic state. Freeze the data contracts and implement local state persistence.

Exit: the goal/questions/next step remain visible through generation and offline demos; no focus theft, auto-scroll or fake connected labels.

### M1: System audio, separate mic and required diarization

Electron capture only. Headphones preflight. AudioWorklet/frame clocks. Explicit capture controls, STT, remote diarization, current-call speaker mapping and strict buyer-role routing. Test known SA, at least two buyers, unknown speakers and reconnect label reuse.

Exit: target-Windows authorized test call produces separate-channel text with demonstrable remote diarization. Team/unknown targets are blocked. Scope includes system audio, honestly shown. Pause/device-change/exit paths work. Manual speaker labels are functional, not deferred.

### M2: On-demand coaching and automatic tracker

Help snapshots the last 30 seconds, retrieves local sources and returns one supported card. Add only the two authorized proactive triggers after replay. Tracker extraction/reducer runs separately and respects manual edits. An on-demand slice may be tested before persistent identity is complete.

Exit: meaningful buyer-targeted responses meet the declared tests, tracker persists, and other scenarios stay silent until Help. This is an early developer slice, not the full cross-call-recognition release.

### M3: Local voice profiles and full live qualification

Package and benchmark one embedding model. Implement permitted SA enrollment, named-buyer profile opt-in, pending enrollment, encryption, matching with unknown/conflict outcomes, correction, deletion and no self-training on guesses. Test future calls and changed devices.

Exit: full voice feature works on the target PC, and auto-acceptance is enabled only at a calibrated operating point meeting the identity test gates. Manual mapping works for unenrolled people. If auto-matching fails, report that the full v3 identity requirement remains unmet; do not hide it behind a working switch.

### M4: Personal pilot and useful post-call work

Repeated authorized calls, evidence/commitment review, drafts and buyer-document preview/export. Review false triggers, missed opportunities, role mistakes and tracker corrections. No unreviewed publication.

### M5: Optional data connections and Docs publication

Selected Notion, Gmail, authorized Gong when available, then approved Docs/Drive updates. Connections never block live operation. Preserve audience, revision, private-staging and retry safeguards from sections 7-12.

### M6: Mac support later

Test the current Electron/macOS permission and system-audio path separately. Windows loopback configuration is not a cross-platform promise. Keep headphones and equivalent scope disclosures. Cross-device profile/database transfer requires a separate explicit design; do not sync an active SQLite file through Drive.

## 16. Evaluation and release gates

Synthetic fixtures define expected behavior; they are not recordings or benchmark results. Use authorized audio, separate enrollment/development/test calls, and held-out devices/sessions for actual validation. No future transcript or future knowledge in incremental replay.

| Area | Release gate |
|---|---|
| Capture | Actual Windows Zoom/headphone route works; system-audio scope disclosed; no transmitted/saved screen video |
| Controls | Pause/Stop terminate media and new upstream work; no replay of paused/offline backlog |
| Diarization | Remote live labels present and parsed; mic separate; connection epochs prevent ID reuse |
| Role routing | Zero team/unknown/media-targeted coaching in labeled release fixtures; measure mistakes and misses on held-out audio |
| UI | Persistent goal/questions/next step plus one card; no focus theft or silent card rewrite |
| Hotkey scope | Recent dialogue is exactly the prior 30 seconds by word timestamps; older state/evidence explicitly separated |
| Hotkey latency | Prepared median <=0.5s / p95 <=1.0s; generated median <=2.0s / p95 <=3.0s, from keypress |
| Proactive scope | Only current eligible buyer objection/comparison; neutral mentions and other job types do not emit |
| Proactive latency | Median <=2.0s / p95 <=3.0s from true turn end, including role readiness |
| Tracker | Visible offline; automatic normal-load updates within 15s; stale age and evidence shown; manual changes cannot be overwritten |
| Agreement | Seller proposals, vague acceptance and calendar placeholders do not become buyer-agreed steps |
| Claims | No unsupported high-impact vendor/security/commercial claims in release fixtures |
| Card quality | >=85% of emitted holdout cards useful; >=80% appropriate responses on eligible labeled hotkey requests and proactive opportunities, reported separately |
| Voice identity | Record accepted-match precision, false accepts on unenrolled speakers, coverage, abstentions, time-to-label and device breakdown; proposed promotion targets below |
| Profile controls | No persistent enrollment without explicit permission; encrypted storage; Delete Profile invalidates matching caches |
| Reliability | At least five 60-minute target-PC calls including reconnect, screen sharing, device change and overlapping speech |
| Publication | No unapproved external write or sharing; stale document revisions fail safely |

Voice auto-acceptance proposal: at least 200 independent held-out assignment opportunities across multiple authorized speakers/sessions, at least 50 involving unenrolled or confusing non-matches; >=99% precision among accepted identities, <=1% false acceptance on unenrolled opportunities, >=80% coverage on eligible clean enrolled-speaker opportunities after enough speech. Report sample sizes and uncertainty; repeated fragments from one utterance do not count as independent tests. If available data are insufficient, keep automatic acceptance off and display suggestions/manual confirmation instead. Do not claim the target is demonstrated.

Evaluate diarization/role accuracy separately from voice identification: good naming cannot repair a bad mixed cluster. A small clean sample benchmark does not establish reliability in overlap. Report time-to-label including speech accumulation, not just embedding runtime.

All latency reports include timeouts, missing identities and missed opportunities. UI controls/status acknowledgments are not counted as useful coaching. Unknown-role failures belong in end-to-end availability reporting, not silently removed from the denominator. Tracker prioritization must not make the hotkey slower under load.

Keep a failure log by severity. Passing the fixtures is not a universal accuracy guarantee or evidence of higher win rate.

## 17. Definition of the first successful product

Keith starts an authorized Zoom call on his Windows PC with headphones. The goal, open questions and next-step status stay visible. He can label a speaker once for the call, press Help, and receive one useful short response to buyer speech within the measured target.

The app stays quiet on routine discussion and teammate speech. Proactive help is limited to explicit buyer objections and actual competitor comparisons. Speaker uncertainty is visible and correctable. Reusable voice profiles recognize qualified matches across calls without assuming every match is certain or saving anyone covertly.

He leaves with a source-backed recap and useful next move. A buyer's Google Doc changes only after approval. No hosted sales platform or custom C++ audio capture is required. A staged demo or a green configuration flag is not completion.

## Official source registry

Official documentation supports the API facts; the architecture, quality thresholds, UX and schedules are proposed requirements. Existing connector/storage reference links are retained from v2. Capture, diarization, identity and speech-pricing references were rechecked for v3. Recheck availability, prices, licensing and deployment permissions during implementation.

```text
S2 | whisper.cpp: Local speech inference implementation
https://github.com/ggml-org/whisper.cpp

S3 | Electron: BrowserWindow and content-protection limits
https://www.electronjs.org/docs/latest/api/browser-window

S4 | Deepgram: Interim results
https://developers.deepgram.com/docs/interim-results

S5 | Deepgram: Endpointing
https://developers.deepgram.com/docs/endpointing

S6 | OpenAI: Latency optimization
https://developers.openai.com/api/docs/guides/latency-optimization

S7 | OpenAI: GPT-4.1 mini model and pricing
https://developers.openai.com/api/docs/models/gpt-4.1-mini

S8 | SQLite: FTS5
https://www.sqlite.org/fts5.html

S9 | Electron: Security
https://www.electronjs.org/docs/latest/tutorial/security

S10 | Electron: safeStorage
https://www.electronjs.org/docs/latest/api/safe-storage

S11 | Deepgram: Flux quickstart
https://developers.deepgram.com/docs/flux/quickstart

S12 | Deepgram: Your data, opt-out, retention and residency
https://developers.deepgram.com/trust-security/your-data

S13 | Notion: Authorization
https://developers.notion.com/guides/get-started/authorization

S14 | Apple: Mail Privacy Protection
https://support.apple.com/guide/iphone/use-mail-privacy-protection-iphf084865c7/ios

S15 | Google: Gmail API scopes
https://developers.google.com/workspace/gmail/api/auth/scopes

S16 | Gong: API introduction and authorization
https://help.gong.io/apidocs/introduction-2

S17 | Google: Share files and folder inheritance
https://support.google.com/drive/answer/7166529?hl=en

S18 | Google: Drive API scopes and drive.file
https://developers.google.com/workspace/drive/api/guides/api-specific-auth

S19 | Google: Docs batchUpdate and revision control
https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate

S20 | OpenAI: Data controls and retention
https://developers.openai.com/api/docs/guides/your-data

S21 | SQLite: Write-ahead logging
https://www.sqlite.org/wal.html

S22 | Deepgram: Pricing
https://deepgram.com/pricing

S23 | Electron: desktopCapturer and macOS requirements
https://www.electronjs.org/docs/latest/api/desktop-capturer

S24 | Electron: session.setDisplayMediaRequestHandler and Windows loopback
https://www.electronjs.org/docs/latest/api/session

S25 | Deepgram: versioned diarization and streaming speaker fields
https://developers.deepgram.com/docs/diarization

S26 | MDN: getDisplayMedia video-track requirement
https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia

S27 | pyannoteAI: identification, voiceprints and recorded-audio enrollment
https://docs.pyannote.ai/tutorials/identification-with-voiceprints

S28 | ONNX Runtime: Node.js prebuilt platform support
https://onnxruntime.ai/docs/get-started/with-javascript/node.html

S29 | sherpa-onnx: speaker-identification reference and model discovery
https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html

S30 | FTC: biometric information risks and accuracy claims
https://www.ftc.gov/news-events/news/press-releases/2023/05/ftc-warns-about-misuses-biometric-information-harm-consumers

S31 | Electron: globalShortcut registration and collisions
https://www.electronjs.org/docs/latest/api/global-shortcut
```
