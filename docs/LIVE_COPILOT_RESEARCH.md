# Making the Sales Copilot Faster, Smarter and More Useful on Calls

*Combined research report: Round 1 (web + 22 sources, 25 claims checked three ways) and Round 2 (GitHub mega-sweep: 869 repos found, 223 judged relevant, 48 read in depth, claims re-checked by two skeptics each). Researched 2026-10-05.*

---

## 1. The short version

Your app is already ahead of almost every open-source project we found. Most of them only have a button and a single AI call. None of the 48 repos we read deeply beat you on prompt caching, pre-warming or preparing a card early. So the gains left are **not** "a smarter AI". They are in five places:

1. **Show the approved answer first, let Claude polish second.** When a buyer asks a common question (security, SOC 2, self-hosted vs SaaS, "how are you different from Langfuse"), show your approved passage in about half a second. Claude's line streams in underneath. If Claude is slow or down, the rep still sees the passage. *(Round 1 and Round 2 both landed here independently.)*
2. **Build the planned Coach the quiet way.** Several repos show the recipe: a free rule-based check decides if anything is worth saying, then a cooldown (about 2 minutes between nudges), and the model may answer "SKIP". Concrete numbers are in section 4.
3. **Keep a running "call notes" card** (what the buyer wants, open questions, objections raised) updated in the background. It feeds the Deeper panel and the topic tracker without slowing HELP.
4. **Start the card earlier** by using Deepgram Flux's "buyer probably finished" signal, and throw the card away if they keep talking.
5. **Cheap search upgrades** for the approved-docs lookup. One repo measured plain keyword search finding the right passage for 55 of 71 questions, against 14 of 71 for meaning-based search alone. So your keyword-first design is right. Small add-ons beat a big rebuild.

**What I would do first:** #1, then the free pre-filter and quiet rules from #2 (needed before any Coach), then #3.

---

## 2. How much to trust this

- **Round 1 (web):** 22 sources, 65 claims pulled out, 25 checked three ways. 19 held up, 6 were thrown out. Several vendor sites (arxiv, deepgram.com, assemblyai.com) were blocked, so some quotes came through search snippets.
- **Round 2 (GitHub):** 869 unique repos found across 38 search angles (26 first round, 12 second round hunting for what was missed). Every repo got a quick check. The best 48 were read in depth (README, source files, open issues), then two separate skeptic agents tried to disprove each repo's claims.
  - **Result of the double-check:** 236 of 241 technique claims survived. 5 could not be matched to a skeptic's answer, so treat those as "unchecked". None were disproved.
  - **Important limits:** "survived" means a skeptic opened the cited file and found it does what was claimed. **Nobody ran any of this code.** Star counts were often missing because GitHub's own pages were blocked from the research sandbox, so those show "n/a". GitHub issue pages were also mostly blocked, so the complaint list is thin.
  - **Two deep-reads failed** (a formatting error, not a content finding): `Vinix24/OnCue` and the `OpenGranola` alias of OpenOats. OnCue appears in the catalog in section 11, and OpenOats was read in full under its current name.
  - **A repo count note:** two different projects are both called "NexQ" (`naxhq/NexQ` and `VahidAlizadeh/NexQ`). Both are listed.
- **Headline numbers inside repos are mostly their authors' own** (for example "sub-500 ms" or "14x faster"). None were independently measured. Treat them as claims.

---

## 3. What you already do (so this is not old news)

Checked against your code and `docs/M1_PLAN.md`. These ideas came up in the research, and you already have them:

| Idea from the research | Where you stand |
|---|---|
| Prompt caching with a stable first part | Done (system prompt cached, live transcript last) |
| Warm the connection and cache before the first press | Done (pre-warm + keep-warm every 4 minutes) |
| Prepare a card early, throw it away if the buyer said more | Done (prefetch with a "nothing new was said" check) |
| Include the half-finished buyer sentence when HELP is pressed | Done (provisional words are included and labelled) |
| New press cancels the old one, late answers can't overwrite | Done |
| Echo defence against the buyer leaking into your mic | Done (audio gate + duplicate-text gate) |
| Product-name hints for the speech engine | Done (keyterm list) |
| Replay tests of real calls and a scorecard | Done (replay, 43 scenarios, promptfoo, baseline compare) |
| Refuse to invent product claims, cite sources | Done (Level 1 checks, "check before saying" note) |

So a few of the repos' "top ideas" are already in your app. Those are not in the ranked list below.

---

## 4. The ranked ideas (merged from both rounds)

*Impact and effort are for you as the rep: how much it changes a live call vs how much building it takes. "Round 1" = web research, "Round 2" = GitHub repos.*

| # | Idea | What it does for you on a call | Impact | Effort | Confidence |
|---|---|---|---|---|---|
| 1 | **Source-first card**: show the approved passage (file named) at once, then stream Claude's line; if Claude fails, keep the passage and say why | Rep sees something usable in about half a second, never a blank card | High | Medium | Medium. Design confirmed in code (akou, Parrot). Their latency numbers are unmeasured |
| 2 | **Instant answers for common questions**: detect the question, and if it matches a pre-approved answer, show it with no AI step | Fastest and safest path for security, compliance, packaging, competitor questions | High | Medium | Medium. Vendor paper reports under 2s (Round 1) |
| 3 | **Quiet Coach rules** (see below) | Coach speaks rarely, never nags, never shows stale advice | High | Low to medium | High that the pattern works. The numbers are each author's own, untested on Arize calls |
| 4 | **Free pre-filter before any AI call**: objection/question/competitor/pricing triggers, check objections before buying signals, skip repeats, let the model answer "SKIP" | Decides in under 100 ms whether a buyer turn matters, at zero cost | Medium | Low | High. The keyword lists must be rewritten for Arize (LangSmith, Datadog, in-house, security review, evals) |
| 5 | **Rolling call-notes card**: small background model keeps a short note of current topic, buyer goals, open questions, objections, plus the pinned opening | Feeds Deeper and the topic tracker. Early facts do not get forgotten in a long call. Turns missing items (budget, timeline, owner) into a sayable question | High | Medium | Medium. Design confirmed (OpenOats, Raven). Output quality not shown in any repo |
| 6 | **Earlier start with Deepgram Flux** "eager end of turn", cancel if they keep talking | Card starts sooner than a silence timer allows | Medium to high | Medium | High that it works on voice bots. **Unknown on calls with several buyers talking.** Can add 50 to 70% more AI calls |
| 7 | **Search upgrades for your docs**: search the question alone *and* question plus recent words, keep the best score, drop weak hits, include neighbouring chunks | Fewer wrong or missing citations | High | Low to medium | High for the keyword-first finding (Parrot measured 55/71 vs 14/71). Embeddings add install size and delay |
| 8 | **Delivery coach from local signals**: talking over the buyer, dead air (both quiet), long monologue, talk share, rushing | Live nudges with no AI cost, using your own pace as the baseline | Medium | Medium | Medium. Thresholds are theirs: monologue over 90s, 3+ interruptions in 5 minutes, 1.4x your normal pace |
| 9 | **Transcript stall watchdog**: if the speech connection is open but produces no words while real audio is arriving for about 30s, reconnect, replay the last ~5s, remove duplicate words | HELP never runs on a frozen transcript | High | Medium | Medium. Confirmed in code (anarlog, Parley), not run |
| 10 | **Capture-health banner** that tells "buyer is quiet" from "capture is dead" | You find out *before* you press HELP, not after a bad card | High | Low to medium | Medium. Respects your locked rule: show, don't auto-switch |
| 11 | **Stricter evidence check on cards**: card quotes the buyer line that triggered it, and code drops any card that cites nothing, a missing source, or a line with no shared content words | Cards you can verify at a glance | Medium to high | Low | High for the check (akou, Parley, Parrot). You already do part of this |
| 12 | **Fix common speech-to-text junk**: drop stray "Thank you." lines on silence, and a very conservative product-name correction | Fewer misheard Arize/Phoenix/competitor names reaching the card | Medium | Low | Medium. Not measured |
| 13 | **Time each stage in replay**: hear the question → detect → search → first word of card | Proves a change really sped things up | High (enabler) | Low | High that it is the right way to test |
| 14 | **Longer-lived cache** for the system prompt (1 hour instead of 5 minutes) | Small gain; your keep-warm already refreshes it | Low | Low | High |
| 15 | **Trace your own HELP presses in Phoenix** (Arize's own open-source tool) | Dogfooding: a real "we run on our own product" story for demos | Low for the call, nice for credibility | Low | Medium. Phoenix is Elastic-licensed: use it as a tool, do not copy its code |

### The quiet Coach recipe (idea 3 in plain words)

Put these together so the Coach stays quiet by default:

- **Needs new finished buyer speech** before it considers speaking (Parley: at least 2 seconds of new speech, 15 second cooldown).
- **One request at a time**; stale cards are dropped, not queued (OpenOats drops anything older than 8 seconds).
- **A nudge budget**: Parrot allows one nudge every 2 minutes, one per type every 5 minutes, a 2-minute warm-up at the start, and shows only the top-ranked one.
- **Adapt to the call**: OpenOats shortens the gap when questions are flying and lengthens it in quiet stretches.
- **Let the model veto**: reply exactly `SKIP` and the screen shows nothing.
- **Never react to your own questions**, only to the buyer's side.
- **Two-step design (Round 1, LlamaPIE research):** a small cheap check decides *whether* to speak, and a bigger model writes the line only when it says yes.

### Where the evidence says "be careful"

- **Round 1 could not find solid proof** of which live features help reps versus distract them. Round 2's issue pages were thin too. Everything on glanceable cards, staying silent and nudges is design reasoning from many projects, not a study. Use your own Useful / Should've stayed quiet / Bad buttons as the real evidence.
- Distraction warning signs seen in the repos: a stream of cards (one repo's own comment mentions eight cards about one worry), cards that arrive after the moment has passed, popups triggered by the rep's own questions, and scores shown with no evidence.

---

## 5. Ideas to skip for now

- **Switching to AssemblyAI for speech-to-text.** Its speed advantage disappears when speaker separation is on, and you need speaker separation. *(Round 1)*
- **Whole knowledge pack stuffed into the prompt.** The claim that Anthropic recommends this under ~200K tokens was knocked down in checking (1 of 3 votes held). *(Round 1)*
- **Embeddings and a reranker as a rebuild.** The "49% to 67% fewer retrieval failures" claim was knocked down (0 of 3 held). Test on your own documents first. If you do try it, `sqlite-vec` (MIT/Apache) and `model2vec` (MIT, tiny and local) are the cheap routes; keep any reranker off the hot path.
- **Haiku for a fast first line.** Haiku 4.5 will not cache a prompt as short as yours (needs about 4,096 tokens), so it may not end up faster. Measure before switching. *(Round 1)*
- **Big local speech models** (WhisperLiveKit and similar). Python/GPU heavy, not a fit for a Windows laptop app that already uses Deepgram.
- **Pre-loading likely next topics** (Salesforce's VoiceAgentRAG). Your local search is already a few milliseconds; the real wait is Claude. It also has a non-commercial licence. *(Round 1)*
- **Anything copied from copyleft or no-licence repos** (see section 6).

---

## 6. Two warnings

**A. Locked decisions.** Some repo ideas collide with `DECISIONS.md` / `AUDIO_DEVICE_REQUIREMENT.md`. These need your explicit call, not a quiet build:

- Repos "follow the headset when it switches" (Parley, anarlog). Your rule says **never silently switch endpoints; reconnect only to a confirmed one.** Keep showing a banner and asking.
- **Capture only Zoom's audio** (`WerdoxDev/application-loopback`, per-process loopback, needs Windows 10 build 19041+). It would change the "system audio, labelled honestly" design and could miss Zoom if it is pinned to a non-default output. Only worth it if measured evidence shows other sounds polluting the transcript.

**B. Licences.** Roughly half the interesting repos cannot have their code copied into a commercial app.

- **Safe to reuse code (MIT / Apache / BSD):** Project Raven, OpenOats, NexQ, anarlog (outside its enterprise folder), Parley, Unseen, Smart Turn, Deepgram JS SDK, sqlite-vec, qmd, promptfoo.
- **Ideas only:** AGPL (Pika, Amurex, OnCue), GPL (Parrot, akou), non-commercial (Natively, interview-assistant), proprietary or source-hidden (HuddleOwl, Cue), no licence (several small repos).
- **Phoenix** is Elastic License 2.0: fine to use as a tool, get legal review before copying code.

---

## 7. What the repos taught us about the problems

**How the best ones keep latency low**
- Stream the answer and show the source passage before the model finishes.
- A fast lane for questions: wait 0.3s after a question, one request at a time, one queued re-run, and a 15s cap so nothing is starved.
- Retrieve early on a timer and cache by a fingerprint of the last ~50 words (OpenOats).
- Cheap pattern matching before any model call (under 1 ms).
- Run summaries and state-tracking in the background, never on the HELP path.
- Honest reality check: the "sub-500 ms", "2.8 s" and "14x faster" claims are unmeasured or self-reported.

**When they speak or stay silent**
- Most only speak when you press a button. Silence is the default.
- The few that speak on their own gate on fresh finished speech, a cooldown and "nothing already running".

**How they track the call**
- Microphone = you, system audio = buyer. Only buyer finals trigger cards.
- A rolling note (topic, open questions, tensions, goals), a pinned opening, a pointer so the same question never fires twice, and a cutoff so advice cannot use words said later (important for replay tests).

**How they keep answers grounded**
- Quote the line that triggered the card; discard cards that cannot point at a real sentence.
- Drop bullets whose citation is missing, invented, or from later in the call.
- An exact refusal sentence when the answer is not in the docs so code can detect it.
- Mark half-finished speech "(still speaking)". Treat transcript text as data, not instructions.
- Check every number against the source.

**Complaints seen in issues (thin evidence)**
- The buyer side not being captured is the most common complaint, by far (OpenOats #625, #667, #654, #54, #288; Parrot #100 and #96; Raven #11, empty recordings with a wireless headset on Windows).
- Wrong speaker labels and merged buyers (OpenOats #279, Raven #21).
- Slow responses (NexQ #4, fixed by skipping search when nothing is indexed and keeping the local model loaded).
- Windows treated as second-class (builds missing, unsigned installers, a CRLF bug that hung one app).
- Cut-off or incomplete suggestions (OpenOats #624).
- Caveat: most trackers have 0 to 12 issues, so absence of complaints about "hallucination" or "distraction" is **not** proof they do not happen.

**Hype or abandoned, so do not rely on them**
- HuddleOwl (source private, every claim is README-only), Pika's "sub-500 ms" (unmeasured, licence conflict), Natively (sponsored README, non-commercial licence), jev-sales-radar, UltimateCallCenterAgent, Salesforce's enterprise-sales-copilot (research demo, 4 stars, insurance prompts), dealpulse (archived), call-copilot (live audio wiring unfinished), ghost-overlay-app (0 stars).
- Very young but active, treat as unproven: Parley (about 1 week old), Parrot (about 9 days of history, Mac only), akou, ColdCoach, Meetwit.

---

## 8. Open questions worth a quick test

1. **Does Flux eager end-of-turn hold up on your real calls** (several buyers mixed into one Zoom channel)? A one-week test logging false cut-offs and time saved on recorded calls would answer it before switching. Also confirm whether Flux supports speaker separation.
2. **What do you actually use on calls?** Log which HELP cards are read, used or dismissed. That is better evidence than any vendor blog.
3. **Is a fast first-line model really faster than Sonnet 5.5 with a warm cache?** Test with your replay harness.
4. **Is hybrid search better on your own pack?** Run a small test on real buyer questions.

---

## 9. Round 1 sources (web and code)

- Anthropic: [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations), [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Citations](https://platform.claude.com/docs/en/build-with-claude/citations)
- LiveKit: [agent_activity.py](https://github.com/livekit/agents/blob/main/livekit-agents/livekit/agents/voice/agent_activity.py), [turn.py](https://github.com/livekit/agents/blob/main/livekit-agents/livekit/agents/voice/turn.py), [Deepgram Flux plugin](https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-deepgram/livekit/plugins/deepgram/stt_v2.py), [eot-bench](https://github.com/livekit/eot-bench)
- Pipecat: [Anthropic adapter](https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/adapters/services/anthropic_adapter.py), [Smart Turn](https://github.com/pipecat-ai/smart-turn)
- Research: [Beyond-RAG (arXiv 2410.10136)](https://arxiv.org/abs/2410.10136), [LlamaPIE (arXiv 2505.04066)](https://arxiv.org/abs/2505.04066v1) with [code](https://github.com/chentuochao/LlamaPIE), [VoiceAgentRAG](https://github.com/SalesforceAIResearch/VoiceAgentRAG), [Don't Break the Cache (arXiv 2601.06007)](https://arxiv.org/abs/2601.06007)
- [AssemblyAI turn detection docs](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection)

---

## 10. The 48 repos we read in depth

Each card: link, what it is in plain English, stars, licence (and whether code can be reused or only the idea), and what is worth borrowing with the file where it lives.
✔ = a skeptic opened the file and could not refute it · ~ = one skeptic disagreed · ? = unchecked. *Nobody ran this code.*

### 1. [pathorsAI/parley](https://github.com/pathorsAI/parley)
**Stars:** 20 · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** 2026-10-05

Parley is a desktop app (Mac and Windows) that records both sides of a call, shows a live transcript split into "me" and "them", and runs a side panel of AI coaching alerts (for example negotiation risk, unasked qualification questions, red flags) against checklists the rep writes. Each alert has a "how should I reply" button that gives 2-3 ready-to-say lines.

**Verdict:** Adopt ideas, borrow a little code (Apache-2.0), do not adopt the architecture. Parley is a post-call-first note taker and library with a live coach bolted on; it has no hotkey help card, no knowledge pack, no retrieval, no prompt caching, and its live suggestion loop is slower and simpler than yours.

**Worth borrowing:**
- ✔ Windows WASAPI loopback supervisor: reopen on device invalidation, follow default-output switches, pad silence while nothing renders (`src-tauri/src/audio/system_windows.rs (helpers in…`)
- ✔ Stall-tolerant two-stream mixer plus bounded backlog, and a reconnect ladder that never gives up (`src-tauri/src/audio/mixer.rs;…`)
- ✔ Fresh-speech + cooldown + in-flight gating for background LLM checks, run on a cheap fast lane (`src/lib/analysis/engine.ts`)

### 2. [royisme/pikabaka](https://github.com/royisme/pikabaka)
**Stars:** 22 · **Licence:** AGPL-3.0 (copyleft) → *idea only* · **Last activity:** 2026-07-14

Pika is a free desktop app (Windows and Mac) that listens to a meeting or call, writes a live transcript of both the other side and you, and when you press a button suggests what to say next. It was built mainly as an interview copilot, with a pitch to sales and support calls too. You bring your own AI key. Summaries, past-meeting search and screenshot questions are included.

**Verdict:** Adopt ideas selectively. Do not borrow code (AGPL), and do not expect a sales-ready design. The repo is small (22 stars, one open issue, 43 commits), interview-focused (the prompt says "You ARE the candidate") and almost entirely manual-trigger.

**Worth borrowing:**
- ✔ Late-flush, reopenable transcript turns, with a different delay depending on whether the speaker finished a sentence. (`electron/lib/transcript-assembler.ts`)
- ✔ Inject the in-progress interim transcript into the prompt when the rep presses help, unless it duplicates the last final turn (same text, or timestamp within 1 s). (`electron/core/IntelligenceEngine.ts`)
- ✔ Generation-id cancellation of streaming LLM calls. Every new request increments currentGenerationId and aborts the previous AbortController. (`electron/core/IntelligenceEngine.ts`)

### 3. [Laxcorp-Research/project-raven](https://github.com/Laxcorp-Research/project-raven)
**Stars:** 420 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-09-23

Raven is a free desktop app (Windows and Mac) that listens to your call on your own computer. It transcribes what you say ("You") and what the other side says ("Them") live, and shows a small overlay, hidden from screen share, that suggests what to say when you press a hotkey. After the call it writes notes, action items, a follow-up email draft and a talk ratio.

**Verdict:** Borrow selectively. This is a real, MIT-licensed, shipping v2.5.0 app, so the capture design (WASAPI loopback and mic into two Deepgram streams labelled You/Them) is a good match for yours. It is a general meeting copilot, not a sales coach, and it is weaker than your stack on the things you care most about.

**Worth borrowing:**
- ✔ Residual echo gate: a cross-correlation check of raw mic against the last 400 ms of system audio, run after AEC and before STT (`src/main/residualEchoGate.ts`)
- ✔ Tiered session memory: a running summary written by a cheap background model, plus a verbatim pinned opening, pinned rep questions, the last 8 turns and the live… (`src/main/services/ai/sessionMemory.ts (prompt rules in…`)
- ✔ Delta-only transcript to the model: send the tail plus only the new text since the last Assist, not the full transcript and the delta twice (`src/main/services/ai/sessionMemory.ts and src/main/constants.ts`)

### 4. [turantekin/Parrot](https://github.com/turantekin/Parrot)
**Stars:** n/a · **Licence:** GPL-3.0 (copyleft) → *idea only* · **Last activity:** 2026-10-01

Parrot is a Mac-only meeting recorder with a live assistant. No bot joins the call. It records both sides and transcribes on the Mac. While the call runs it puts cards on screen: an answer quoted from your own documents (file named, Copy button), pinned objections and open questions, promises you made, a 0-100 call score with a one-line coach, and a talk-share gauge.

**Verdict:** Adopt the ideas; skip the code. It cannot be reused directly (macOS/Swift, and GPL-3.0 copyleft would infect a commercial app). It is the most relevant repo for the planned Coach and rep-UX work: the nudge rules, the question fast-lane timings, the excerpt-first path and the eval numbers are concrete and re-implementable.

**Worth borrowing:**
- ✔ Replayable, pure nudge engine with adaptive per-call thresholds and a global rate limiter (`Parrot/Services/NudgeDetector.swift`)
- ✔ Question fast-lane with single in-flight request, per-pace floors and a staleness cap (`Parrot/Services/CallAnalysisEngine.swift`)
- ✔ Two-stage answer: instant retrieved excerpt from the rep's docs while the LLM is still writing, gated by a relevance probability (`Parrot/Services/JevDocMatcher.swift (plus…`)

### 5. [yazinsai/OpenOats](https://github.com/yazinsai/OpenOats)
**Stars:** ~2.6k · **Licence:** MIT → *code reusable* · **Last activity:** recent (date not confirmed)

A Mac-only note-taker that listens to both sides of a call, transcribes them on your own computer, and as the conversation moves it looks through a folder of your notes (prep docs, battlecards, briefs) and pops up a short, scannable talking point (a bold one-line takeaway plus 2-4 bullets with the names and numbers from your notes). It fires on its own when it hears a question or a claim; there is no hotkey.

**Verdict:** Adopt the ideas, do not port the code. Swift/macOS code means almost nothing is directly reusable, but the licence is MIT so there is no legal obstacle.

**Worth borrowing:**
- ✔ Zero-LLM local gate for 'speak vs stay silent': regex-style trigger detection, KB-score threshold, and Jaccard duplicate suppression, all run before any LLM call (`OpenOats/Sources/OpenOats/Intelligence/RealtimeGate.swift`)
- ✔ Burst/decay throttle with drop-or-replace and no queue: spacing between cards shrinks when the conversation is hot (high question density plus KB relevance) and grows… (`OpenOats/Sources/OpenOats/Intelligence/BurstDecayThrottle.swift (and…`)
- ✔ Speculative KB prefetch on a timer plus a fingerprint cache, so retrieval is already done when the trigger utterance finalises (`OpenOats/Sources/OpenOats/Intelligence/PreFetchCache.swift and…`)

### 6. [naxhq/NexQ](https://github.com/naxhq/NexQ)
**Stars:** 48 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-09-28

NexQ is a free Windows desktop helper that sits as a small see-through window on top of your meeting. It listens to your microphone (labelled "You") and to the other people on the call (labelled "Them"), shows a live transcript, and lets you click a button to get an AI-written answer or suggestion. You can load your own documents (PDF, Word, text) so the AI can use them.

**Verdict:** Adopt a few small ideas, skip the codebase. Do not borrow code wholesale (different stack, Tauri/Rust vs Electron). It is a generic interview/lecture copilot with 48 stars and 1 open issue, and does not do what your app already does better.

**Worth borrowing:**
- ✔ Skip retrieval when the index is empty and keep the local model hot (`src-tauri/src/commands/intelligence_commands.rs;…`)
- ✔ Dual retrieval query: question alone, then question plus recent transcript, merged by best score (`src-tauri/src/commands/intelligence_commands.rs`)
- ✔ Hybrid search with Reciprocal Rank Fusion plus relative-score cutoff (`src-tauri/src/rag/search.rs; src-tauri/src/rag/prompt_builder.rs`)

### 7. [IshanVats-6/huddleowl](https://github.com/IshanVats-6/huddleowl)
**Stars:** 4 · **Licence:** Proprietary → *idea only* · **Last activity:** 2026-09-10

HuddleOwl is a free-for-individuals meeting coach app for Mac and Windows. It listens to your mic and the other side's audio on your own computer (no bot joins the call). While you talk, it pops up short cards quoting the exact line that triggered them, such as an objection you talked past, a question you skipped or a buying signal you missed.

**Verdict:** Skip the code, because there is none and the licence forbids reverse engineering. Adopt a few ideas only: evidence-gated cues, a narrow named trigger taxonomy for the proactive Coach, null scores for untested rubric dimensions, and turn-boundary chunking.

**Worth borrowing:**
- ✔ Evidence-gated cues: every card and every score must point at the transcript sentence that earned it; a cue with no quotable trigger line is discarded before display (`README.md`)
- ✔ Unanswered-objection / skipped-question / missed-buying-signal as the three named card triggers, i.e. cards keyed to conversational events rather than only on-demand (`README.md`)
- ✔ Unscored dimensions: a rubric dimension the call never tested is left unscored rather than given a zero (`README.md`)

### 8. [tiXor-code/coldcoach](https://github.com/tiXor-code/coldcoach)
**Stars:** 0 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-07-22

ColdCoach is a free Mac app that listens to a sales call, turns speech into text on your own computer, and pops up a small coaching card when the prospect raises an objection, asks a question, or shows buying interest. The card gives a headline, one line to say next, and a short reason. You describe your offer in one sentence and an AI writes a playbook of openers, discovery questions and objection answers.

**Verdict:** Adopt the ideas only; do not borrow code. ColdCoach is a small (about 3.7k lines of Swift), very early, Mac-only project with 0 stars and no real user feedback.

**Worth borrowing:**
- ✔ Zero-LLM-cost intent gate that decides whether a card is warranted at all, with objection-first ordering so brush-offs like 'send me an email' are not read as interest. (`Sources/ColdCoachCore/Coaching/IntentClassifier.swift`)
- ✔ Deterministic debounce on the transcript timeline, not wall-clock time, plus a pure decide() function that returns a ready request or nil, so trigger behaviour is… (`Sources/ColdCoachCore/Coaching/CoachingEngine.swift`)
- ✔ Observable call-state and capture health: an explicit status enum plus an audio-level meter and a 'no audio detected after 6s' warning, so a wrong device or silent… (`Sources/ColdCoachApp/Session/CallSession.swift`)

### 9. [SalesforceAIResearch/enterprise-sales-copilot](https://github.com/SalesforceAIResearch/enterprise-sales-copilot)
**Stars:** 4 · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** 2026-06-02

A research demo from Salesforce AI Research. It listens to a sales call through the browser microphone, turns speech into text live (Deepgram), and asks an AI whether the customer just asked a product question. If so, it looks the answer up in a product database (matching FAQs plus an AI-written database query) and puts a 2-4 sentence answer on the rep's screen.

**Verdict:** Adopt the idea only; skip the code. This is a small, clean, research-grade pipeline (about 2,000 lines, 8 commits, 4 stars, 0 issues) that is behind what you already have.

**Worth borrowing:**
- ✔ Cheap, narrow trigger gate before any expensive work: fire detection only on new, final, non-duplicate transcript segments (`backend/conversation.py`)
- ✔ Question-detector pre-classifier returning structured JSON with a category and confidence, used as a router (`backend/question_detector.py`)
- ✔ Defence-in-depth guard on LLM-generated SQL: SELECT-only prefix check plus keyword denylist before execution (`backend/retriever.py`)

### 10. [repowise-dev/unseen](https://github.com/repowise-dev/unseen)
**Stars:** n/a · **Licence:** MIT → *code reusable* · **Last activity:** 2026-06-24

Unseen is a free desktop app that listens to your meetings through your microphone, turns speech into text live, and shows a small floating window that stays on top of your screen. When someone asks a question or you press a hotkey, an AI of your choice (Claude, OpenAI, Gemini or a local model) writes a short suggested answer in that window.

**Verdict:** ADOPT IDEAS ONLY, do not borrow wholesale. Unseen is a general meeting/dictation tool with a sales profile that is mostly a prompt, not a sales engine. It is a decent reference for (a) the answeredUpTo pointer, (b) cancel/queue/debounce rules, (c) the SKIP veto, (d) YAML-configurable triggers.

**Worth borrowing:**
- ✔ Anti-repeat pointer: only the text since the last answer is judged and sent as the 'new segment', and the pointer is advanced before the LLM call returns (`src/renderer/overlay/controller.ts,…`)
- ✔ In-flight and debounce state machine for auto and forced answers, with a watchdog (`src/renderer/overlay/controller.ts,…`)
- ✔ Model-side silence via an exact 'SKIP' token, which the UI drops silently (`src/main/services/prompt-builder.ts,…`)

### 11. [WerdoxDev/application-loopback](https://github.com/WerdoxDev/application-loopback)
**Stars:** 12 · **Licence:** MIT → *code reusable* · **Last activity:** recent (date not confirmed)

A small plug-in for Node/Electron apps that lets the app "listen" to what a Windows PC is playing out of its speakers (or just one program, like Zoom) and hands the sound over as raw audio data, without needing a virtual cable or Stereo Mix. It does nothing else: no transcription, no AI, no suggestions. It is only the capture layer. Windows 10 (2004+) and Linux/PipeWire; x64 only.

**Verdict:** Adopt the idea, and use the package or its Windows C++ as the buyer-side capture layer if you do not already have equivalent. The main takeaway for your app is per-process (Zoom + child tree) loopback instead of whole-system loopback, in MIT-licensed code.

**Worth borrowing:**
- ✔ Per-process loopback of Zoom only (include process tree), instead of whole-system loopback. (`src/platform/windows/LoopbackCapture.cpp`)
- ✔ Event-driven, low-latency capture loop: shared-mode AudioClient with EVENTCALLBACK, an MMCSS work queue, and a drain-all-packets loop on every wake-up. (`src/platform/windows/LoopbackCapture.cpp`)
- ✔ Ask Windows to convert to exactly the format Deepgram wants (16-bit PCM, 48 kHz, stereo) using AUTOCONVERTPCM, so no resampling code is needed in JS. (`src/platform/windows/LoopbackCapture.cpp`)

### 12. [stenolabs/stenoai](https://github.com/stenolabs/stenoai)
**Stars:** ~1.3k · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-03

StenographAI ("Steno") is a private note-taker for meetings. It listens to both sides of a call on your computer, turns speech into text on-device, and then writes a summary with a local AI (or optionally your own cloud AI key). It shows a live "You vs Others" transcript, lets you ask questions about the meeting (including during a recording), and saves notes as plain Markdown files.

**Verdict:** Skip as a coaching reference, and adopt a few ideas. This is a post-meeting notetaker with live transcription and chat. It has no hotkey-triggered coaching, no suggestion card and no logic for when to speak vs stay silent, so it adds nothing on smarter suggestions.

**Worth borrowing:**
- ✔ Keep the speech model hot: warm it on launch and re-warm on window focus, throttled to once per 5 min and skipped while recording (`app/main.js (lines ~1745-1873)`)
- ✔ Silero VAD on 16 kHz mono, run per channel, to cut live utterances; each finished utterance is transcribed and emitted with [You]/[Others] and [MM:SS] timestamps (`src/silero_vad.py, simple_recorder.py (transcribe-stream),…`)
- ✔ Windows loopback via Electron's native loopback path, with a custom handler that avoids screen capture; renderer captures mic and system audio via Web Audio/MediaRecorder (`app/main.js, app/ipc-contract.test.js`)

### 13. [GeiserX/akou](https://github.com/GeiserX/akou)
**Stars:** 3 · **Licence:** GPL-3.0 (copyleft) → *idea only* · **Last activity:** 2026-10-05

akou is a Mac-only app that quietly records your own calls on your own computer, with no bot joining the meeting. It writes a live transcript as people talk, then runs a more accurate pass with speaker names after the call. During the call you can ask it questions ("catch me up", "decisions so far") and it answers from the transcript using your own Claude Code, Codex, a local model or an API key.

**Verdict:** Adopt the ideas selectively; do not take the code (GPL-3, macOS/Bun/Rust stack, and it has no proactive coaching). It is a call recorder with an on-demand Q&A, not a live sales assistant. It never decides when to speak, and it has no sales-specific logic.

**Worth borrowing:**
- ✔ Instant evidence-first answer: show retrieved excerpts with no model call, then stream the LLM answer; (`src/main/query/ask.ts`)
- ✔ Regex intent classifier before any model call, which sets the context budget and filters (now / time-window / summary / follow-up / recall / naming) (`src/main/query/classify.ts`)
- ✔ Context pack layout built for prompt-cache stability and bounded size: stable prefix first, volatile tail (roster, vocab hits, memo, now) last; (`src/main/query/context.ts`)

### 14. [emretheus/meetwit](https://github.com/emretheus/meetwit)
**Stars:** 4 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-05-31

Meetwit is a private meeting note-taker that runs entirely on your own laptop (Mac or Windows). It listens to your microphone and the other people on the call, types out a live transcript, and lets you type a question mid-call ("what did they say about budget?") and get a short answer with line citations.

**Verdict:** Adopt the idea, skip the code. Meetwit is the closest in shape (local-first, Windows, live transcript, documents with citations), but it is a younger, simpler product than ours: 4 stars, about 11 days of commit history in what I could see, no issues, no users to learn from.

**Worth borrowing:**
- ✔ Post-ASR hallucination and prompt-echo filter. Drop known junk lines and any output of 4 or more words that is contained inside the priming vocabulary prompt. (`desktop/src-tauri/src/asr/streamer.rs (around lines 460-513)`)
- ✔ Hybrid retrieval: vector search plus BM25 keyword search, merged with Reciprocal Rank Fusion (RRF), over-fetching 3x top_k from each side. (`backend/src/meetwit/retrieval/hybrid.py`)
- ✔ Conservative conflict check against the approved docs. A structured JSON output with a numeric confidence, a hard threshold of 0.8 and an explicit 'empty list if no… (`backend/src/meetwit/services/conflicts.py`)

### 15. [fastrepl/anarlog](https://github.com/fastrepl/anarlog)
**Stars:** ~9.4k · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-05

Anarlog (formerly Hyprnote) is a free, open-source meeting notepad in the Granola mould. It listens to the computer's own audio and the mic, so no bot joins the call. It shows a live transcript, then turns the transcript plus the rep's own notes into a summary, and has a chat box for asking questions about the meeting. Data sits in a local SQLite database and local files.

**Verdict:** ADOPT IDEAS, skip the code as a whole. It is a notetaker, so it does not address our core problems (HELP-card latency, grounding, proactive coaching). It has no prompt caching, prefetch or proactive trigger logic to learn from. It does have mature, well-commented audio and transcript plumbing for Windows.

**Worth borrowing:**
- ✔ Hang-over smoothing on the VAD plus an amplitude floor, applied to the REP's mic before it goes to STT. (`crates/vad-masking/src/streaming.rs (used in…`)
- ✔ Windows WASAPI loopback that follows the meeting app's output device. (`crates/audio-actual/src/speaker/windows.rs`)
- ✔ Stream watchdog that detects 'connected but not transcribing' with energy-aware rules, then reconnects with a replay of recent audio. (`crates/listener-core/src/actors/listener/stream.rs;…`)

### 16. [VahidAlizadeh/NexQ](https://github.com/VahidAlizadeh/NexQ)
**Stars:** n/a · **Licence:** MIT → *code reusable* · **Last activity:** 2026-09-28

NexQ is a free Windows app that sits as a see-through window on top of your meeting. It listens to your mic (labelled "You") and to whatever your computer is playing (labelled "Them"), transcribes both live, and lets you click a button to get an AI answer or suggested wording, optionally drawing on documents you loaded. It also saves transcripts, bookmarks, action items, recordings and summaries after the call.

**Verdict:** ADOPT IDEAS ONLY (small), do not borrow wholesale; skip for core suggestion quality.

**Worth borrowing:**
- ✔ Skip the retrieval step when the index is empty, and keep the local model warm. (`src-tauri/src/commands/intelligence_commands.rs ;…`)
- ✔ Dual-query retrieval merged by best score, using hybrid semantic + keyword search combined with reciprocal rank fusion (RRF). (`src-tauri/src/commands/intelligence_commands.rs ;…`)
- ✔ Segment accumulator that sits between STT output and the UI/LLM. (`src-tauri/src/stt/segment_accumulator.rs`)

### 17. [electron/electron](https://github.com/electron/electron)
**Stars:** n/a · **Licence:** MIT → *code reusable* · **Last activity:** recent (date not confirmed)

Electron is the toolkit used to build desktop apps like VS Code and Slack using web technology. It is the platform your Windows app already runs on, not a competing product. It supplies the pieces the app is built from: screen and audio capture, global hotkeys, and background worker processes. It contains no call-coaching or AI logic.

**Verdict:** Adopt the idea, skip the code. Electron is your runtime, so there is no code to borrow. Its docs give three practical takeaways: add a silent-capture guard, check the hotkey registration result, and keep heavy retrieval off the UI process. It has no logic for deciding when to suggest versus stay silent.

**Worth borrowing:**
- ✔ Use setDisplayMediaRequestHandler with audio:'loopback' for the buyer side, and guard against silent failure (`/tmp/claude-0/-home-user-salesiq/6aedc294-3065-5d60-a916-6ca503a152bc/…`)
- ✔ Check the globalShortcut.register return value and handle the silent failure for the HELP hotkey (`/tmp/claude-0/-home-user-salesiq/6aedc294-3065-5d60-a916-6ca503a152bc/…`)
- ✔ Move heavy work (FTS5 search, LLM streaming, Deepgram socket) off the UI process into a utilityProcess, and stagger or defer startup work (`/tmp/claude-0/-home-user-salesiq/6aedc294-3065-5d60-a916-6ca503a152bc/…`)

### 18. [video-db/call.md](https://github.com/video-db/call.md)
**Stars:** ~1.5k · **Licence:** MIT → *code reusable* · **Last activity:** recent (date not confirmed)

Call.md is a desktop app that sits beside your video call, records it, and writes out a live transcript of what you said versus what they said. Every 20 seconds an AI glances at the last bit of conversation and may pop up a line to say or a question to ask. It also keeps score (how much you talk, how fast, how many questions) and occasionally nudges you ("you are talking a lot").

**Verdict:** Adopt the ideas only, do not borrow code. Call.md is a simpler, cloud-dependent product that is behind your design in most areas. Live Assist is a fixed 20-second poll with one generic prompt.

**Worth borrowing:**
- ✔ Hard rate limit on coaching nudges (global cooldown, priority-ordered rules, per-type suppression) (`src/main/services/copilot/nudge-engine.service.ts`)
- ✔ Cheap, deterministic conversation metrics computed locally from final transcript segments (talk ratio, WPM with clamping, question count, monologue flag) (`src/main/services/copilot/conversation-metrics.service.ts`)
- ✔ Regex fast-path intent detection with per-intent cooldown, backed by a slower LLM detector (`src/main/services/mcp/intent-detector.service.ts`)

### 19. [jessecu2024/MeetU](https://github.com/jessecu2024/MeetU)
**Stars:** n/a · **Licence:** Non-commercial (no commercial use) → *idea only* · **Last activity:** 2026-06-13

MeetU is a desktop app that sits next to a meeting window and listens. It shows a live transcript with who is speaking, translates English and Chinese, and pops an alert when someone says your name or asks you a question. It then offers three possible replies: cautious, assertive and diplomatic. It also writes periodic summaries and meeting minutes. It uses your own speech and AI keys, and stores everything locally.

**Verdict:** Skip as a source of code. Adopt a few ideas lightly. MeetU is a thin general-meeting assistant with a prompt-and-parse design: no streaming, no caching, no retrieval, no grounding or citations, no evals, and no user reports to learn from. Your app already does more on latency and grounding.

**Worth borrowing:**
- ✔ Two-stage mention gate: free string and '?' pre-filter, then a tiny LLM classifier that returns a structured trigger plus extracted question and urgency (`src/services/mention-detector.ts`)
- ✔ Pre-extracted 'trigger question' passed into the suggestion prompt separately from the raw trigger line (`src/services/speech-advisor.ts`)
- ✔ Silence-hallucination filter for STT output (`src/services/stt-engine/whisper-hallucinations.ts`)

### 20. [OpenWhispr/openwhispr](https://github.com/OpenWhispr/openwhispr)
**Stars:** n/a · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-05

OpenWhispr is a free desktop app (Windows, Mac, Linux) where you press a hotkey, talk, and your words are typed wherever your cursor is. It also records meetings (Zoom, Teams), labels who said what, writes AI notes afterwards, and lets you search old notes by meaning. You can run speech-to-text fully on your own computer or send it to a cloud service.

**Verdict:** Borrow ideas, plus small pieces of MIT code where convenient. Do not look here for live-coaching logic: there is none. Evidence: no proactive suggestion or when-to-speak decision engine exists, and a repo-wide search for cache_control/prompt caching found it only in modelManagerBridge.js, not as a live-call technique.

**Worth borrowing:**
- ✔ Windows WASAPI process-loopback helper for the buyer side, with a silence-vs-speakers check and automatic fallback (`src/helpers/windowsLoopbackAudioManager.js; CHANGELOG.md`)
- ✔ Pre-warmed Deepgram websocket with silence-frame keepalive, cold-start audio buffer, liveness timeout and replay on reconnect (`src/helpers/deepgramStreaming.js`)
- ✔ Two-layer echo handling: hold back risky mic finals, then drop only on a text match, with late retraction (`src/helpers/meetingMicHoldback.js; src/helpers/meetingAecManager.js;`)

### 21. [QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)
**Stars:** ~11.1k · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** 2026-08-30

A free program you run on your own computer or server that turns live speech into text as people talk, with only a fraction of a second of delay. It can label who is speaking, translate, and serve many users at once. It is a speech-to-text engine only. It does not give advice, suggest sales moves or decide when to speak up.

**Verdict:** Adopt idea, do not borrow code, and do not swap our ASR for it. It is a real, active (last commit 2026-08-30), Apache-2.0, well-tested project, but it is a Python/PyTorch (GPU-oriented) streaming transcriber and does nothing for suggestions, grounding or when-to-speak.

**Worth borrowing:**
- ✔ Hold back the unstable tail of the transcript and commit only stable words; show the tail as a separate grey 'buffer' (`whisperlivekit/simul_whisper/align_att_base.py;…`)
- ✔ Per-session terminology/context string injected as decoder context (max 1000 chars) (`docs/API.md; whisperlivekit/session_asr_proxy.py;…`)
- ✔ Bounded backpressure queue per pipeline stage with sample-based capacity, timeout and overload callback (`whisperlivekit/processing_queue.py; whisperlivekit/audio_processor.py`)

### 22. [Abdrehman2002/closer-copilot](https://github.com/Abdrehman2002/closer-copilot)
**Stars:** 0 · **Licence:** No licence (all rights reserved) → *idea only* · **Last activity:** 2026-09-24

Closer Copilot is a private assistant that listens to your Google Meet call (their voice from the shared browser tab, yours from the mic) and shows a live two-speaker transcript. After each thing the prospect says, it flashes one short line to say next, with acting directions built in: where to pause, where your voice drops or lifts, which word to stress, plus a one-word tone.

**Verdict:** Adopt the ideas, do not copy the code (no license = all rights reserved; also it is OpenAI/Google-Meet/browser-specific, a 3,200-line single server.js). Stars 0 and no issues, so no external validation; claims like cache hit rates and 230ms savings are the author's own code comments and were not verified by me.

**Worth borrowing:**
- ✔ Generation-counter cancellation: every new Deepgram final segment starts a new coach() run and aborts the in-flight LLM request, so only the run that saw the complete… (`server.js (coach(), ~line 1269)`)
- ✔ Stop reading the stream the moment the LINE field completes; generate WHY/TECH/CONF after LINE, drain them in the background and patch them onto the card later. (`server.js (coach(), LINE_COMPLETE ~line 1267; FORMAT_RULES line 86)`)
- ✔ Deterministic number/claim fact-guard on the finished line, with one corrective retry then withhold, plus a safe-prefix streamer that never shows the part of a line from… (`server.js (validateLine ~1177, safePartial ~1215, retry in coach())`)

### 23. [Eslsamu/callside](https://github.com/Eslsamu/callside)
**Stars:** n/a · **Licence:** GPL-3.0 (copyleft) → *idea only* · **Last activity:** 2026-10-04

Callside is a free, open-source desktop assistant that listens to a meeting (your mic plus the other side's audio), shows a live transcript, and writes suggestions for what to say next. You press F8 (Ctrl+Shift+Space on Windows, Cmd+Shift+Space on Mac) or click Help now, and it answers from the recent conversation plus notes you pasted in.

**Verdict:** Adopt a few ideas, do not borrow code, and do not treat it as a competitor to learn latency tricks from. The repo is a young, generic, OpenAI-only copilot. Its stack is ordinary: a plain streaming Responses call with no prefetch or pre-warm, and a transcript window without retrieval.

**Worth borrowing:**
- ✔ WAIT sentinel plus streaming gate: let the model return nothing, without delaying real answers (`server/provider.ts (AutoGate, AUTO_INSTRUCTIONS); server/index.ts…`)
- ✔ Turn-keyed auto trigger with cooldown, busy lock and manual-preempts-auto (`src/App.tsx lines ~234-260 and ~337-375`)
- ✔ Feed the last few suggestions back and tell the model not to repeat (`server/provider.ts (buildAnswerInput); src/App.tsx`)

### 24. [video-db/sales-copilot](https://github.com/video-db/sales-copilot)
**Stars:** 16 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-02-25

A Mac desktop app that listens to your sales call, separating your voice (mic) from the customer's (system audio). While you talk it shows live helper cards: when the customer raises an objection like price, timing, competitor or security, it pops up suggested talk tracks and follow-up questions.

**Verdict:** Adopt the ideas, skip the code. It is architecturally close (Electron, dual channel, SQLite, cue cards, nudges), but it is a small, young project (16 stars, 6 commits, last commit 2026-02-25) with no latency work, no grounding or knowledge-pack retrieval, no citations, and no hotkey-on-demand flow.

**Worth borrowing:**
- ✔ Cheap regex gate before any LLM call, with per-type cooldown, scoped to customer speech only (`src/main/services/copilot/cue-card-engine.service.ts`)
- ✔ Rule-based, priority-ordered nudge engine with a single global cooldown and suppressible types (`src/main/services/copilot/nudge-engine.service.ts`)
- ✔ Channel-based speaker identity feeding metrics (talk ratio, monologue, questions, pace) (`src/main/services/copilot/conversation-metrics.service.ts`)

### 25. [nicolelu/live-call-coaching](https://github.com/nicolelu/live-call-coaching)
**Stars:** n/a · **Licence:** MIT → *code reusable* · **Last activity:** 2026-07-12

A Mac-only helper that listens to your sales call transcript and shows a small floating card only you can see (hidden from screen share). It can nudge you with sales-methodology tips (Rob Snyder's PULL framework), answer quick questions like "what did I miss" or "what should I say next", search all your past calls, and auto-draft follow-up emails, summaries and pre-call prep briefs.

**Verdict:** Adopt the ideas selectively, do not borrow code, skip as a reference for latency.

**Worth borrowing:**
- ✔ Single-flight brain lock keyed on PID liveness plus a health-status file written on every exit path (`brain_tick.sh`)
- ✔ Proactive pass rate-limited and gated by live-call state, with a 'say nothing' default and max one nudge (`brain_tick.sh`)
- ✔ Three-tier coaching feed (miss / suggest / status) with distinct visual weight, plus dim always-on call-state line (`coach.py`)

### 26. [fluxomate/sales-coach](https://github.com/fluxomate/sales-coach)
**Stars:** n/a · **Licence:** No licence (all rights reserved) → *idea only* · **Last activity:** 2026-09-03

A small always-on-top window for Windows that listens to both you and the buyer on a call. It turns the conversation into text as you talk, then every few seconds an AI reads the last ~90 seconds and either stays quiet or flashes a one-line nudge, such as "She said 33% churn, ask what is driving it" or "Price pushback incoming, lead with ROI".

**Verdict:** Adopt ideas only, do not borrow code (UNLICENSED, and our architecture is already ahead). It is a small, 1.9k-line, 3-commit prototype.

**Worth borrowing:**
- ✔ Single forced-tool JSON per tick that bundles verdict + nudge + facts + next move (`src/coach/prompt.js`)
- ✔ Regex fast-path to fire a coaching call immediately on high-signal buyer lines (`src/coach/coach.js`)
- ✔ Instant scripted card on section jump, then LLM refines (`src/coach/coach.js`)

### 27. [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
**Stars:** ~1.6k · **Licence:** BSD → *code reusable* · **Last activity:** 2026-01-29

Smart Turn is a tiny AI model that listens to raw audio and decides whether the person has actually finished their sentence, or is just pausing to think ("I can't seem to, um..."). Ordinary voice software only checks "is there sound or silence?", so it cuts people off or waits too long.

**Verdict:** Adopt the idea, optionally borrow the model later. It solves one narrow thing (has the buyer's current turn ended) and is not a suggestion engine, so it will not make the cards smarter on its own.

**Worth borrowing:**
- ✔ Run the expensive judgment only during silence, gated by a cheap VAD (`record_and_predict.py`)
- ✔ Segment buffer with a pre-speech ring buffer and hard duration cap (`record_and_predict.py`)
- ✔ Fixed-size, end-aligned audio window (last 8 s, zero-pad at the front) and re-run on the whole turn if new speech arrives (`audio_utils.py`)

### 28. [deepgram/deepgram-js-sdk](https://github.com/deepgram/deepgram-js-sdk)
**Stars:** 274 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-02

This is Deepgram's official toolkit for programmers to plug the Deepgram speech-to-text service (the same transcription engine the app already uses) into their own software. It does not transcribe anything itself and has no AI coaching. It is a connection helper. It opens a live line to Deepgram, sends call audio up, and hands back the words as they are spoken.

**Verdict:** Adopt idea, and use the package itself if the app does not already. It is only a transcription transport library, so it adds nothing to the suggestion logic. No tool in it decides when to suggest or stay silent.

**Worth borrowing:**
- ✔ Flux v2 end-of-turn events: EagerEndOfTurn / TurnResumed / EndOfTurn. Start building the AI answer on the eager signal and discard it if the speaker resumes. (`src/api/resources/listen/resources/v2/types/ListenV2TurnInfo.ts;`)
- ✔ ForceEndTurn / sendFinalize: a manual 'close this turn now' message tied to the rep pressing a button (`src/api/resources/listen/resources/v1/client/Socket.ts;…`)
- ✔ Bounded audio buffer plus app-owned reconnect during drops (exponential backoff with full jitter, drop oldest audio beyond 30 s, re-send original options on reconnect,… (`examples/41-transcription-live-reconnect.ts`)

### 29. [decibri/decibri-aec](https://github.com/decibri/decibri-aec)
**Stars:** 13 · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** 2026-07-30

A small, brand-new software component that cleans up your microphone recording when the other person's voice from your speakers leaks back into your mic. It does not transcribe, suggest or coach anything. It only removes the "echo" so the rep's mic track contains just the rep's voice.

**Verdict:** Adopt the ideas, skip the code for now. It is a competent-looking, well-documented Apache-2.0 Rust echo canceller, but it is only about 2 days old (17 commits, 13 stars, 0 issues) and unproven in the field, and its own benchmark shows only moderate gains (far-end echo 2.12 to 3.24 out of 5) and a speech-quality cost during…

**Worth borrowing:**
- ✔ Self-calibrating double-talk detector based on correlation against the filter's own predicted echo, with a learned baseline and margin, instead of a fixed threshold. (`src/tau.rs`)
- ✔ Cheap cross-correlation delay finder (GCC-PHAT) with a confidence gate, used to align the loopback and mic streams. (`src/delay.rs`)
- ✔ Host declares capture glitches (declare_capture_continuity) so the engine re-anchors instead of guessing, and degrades gracefully with a fade to raw audio while… (`src/engine.rs (CaptureContinuity), src/config.rs…`)

### 30. [yuxino/Mimi](https://github.com/yuxino/Mimi)
**Stars:** 528 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-05

Mimi is a free app that listens to whatever is playing on your computer (a video call, a film, a stream) and puts live subtitles and a translation on screen as a floating strip. You plug in your own cloud speech and translation account (Alibaba Cloud recommended, Gemini also works) and it can also use the mic. It has no sales coaching, no suggestions and no knowledge of the conversation.

**Verdict:** Adopt the ideas, borrow small pieces, skip the product. Mimi is a well-engineered subtitle and translation tool with real CI and tests, but it is not a sales assistant. It has no suggestion logic, no grounding, no retrieval, no call-state tracking and no coaching.

**Worth borrowing:**
- ✔ Windows audio census: enumerate output devices and per-app audio sessions on demand, with live peak levels, and tell "no PCM / silent PCM / valid audio" apart (`src-tauri/src/audio/census.rs;…`)
- ✔ Bounded newest-drop audio queue with a pending-work RAII guard and a single fell-behind error (`src-tauri/src/audio/send_pipeline.rs;…`)
- ✔ Budgeted pacing of replaceable draft requests (fingerprint to skip unchanged text, spacing scaled by input size, rate-limit pause) (`src-tauri/src/core/preview_pacing.rs`)

### 31. [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)
**Stars:** ~8.2k · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** 2026-05-17

A tiny add-on for SQLite (the small database file apps embed) that lets the app search by meaning instead of exact words. Text is turned into lists of numbers (embeddings) and stored in a special table; you ask "what is closest in meaning to this?" and it returns the nearest rows.

**Verdict:** Adopt idea, not code. Pure-C, dual MIT/Apache, loads as a SQLite extension, so if the app wants semantic retrieval beside FTS5 the extension itself is a reasonable drop-in (npm sqlite-vec), but test Windows loading first given the load-failure issues. Nothing to copy: it is a retrieval library.

**Worth borrowing:**
- ✔ Add semantic (embedding) retrieval to the existing SQLite store via a vec0 virtual table, alongside FTS5, instead of a separate vector DB (`/sqlite-vec.c (README.md)`)
- ✔ Quantize vectors (int8 or binary) to shrink storage and speed the scan (`/sqlite-vec.c`)
- ✔ Two-stage 'rescore' index: cheap quantized coarse scan, then re-rank top candidates with full floats (`/sqlite-vec-rescore.c`)

### 32. [anush008/fastembed-rs](https://github.com/anush008/fastembed-rs)
**Stars:** ~1.0k · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** 2026-09-22

A Rust code library that turns text (and images) into numbers that capture meaning, and can re-score a short list of search results so the most relevant come first. It runs on the user's own machine, so no cloud call is needed after a one-time model download. For the rep's app, think of it as a local second-opinion that checks which knowledge-pack snippets actually answer what the buyer just said.

**Verdict:** Adopt the idea, do not borrow code. It is a general embedding/reranking toolkit in Rust, not a call-assistant; it has nothing on audio, when-to-speak, or prompting. The reranker pattern (FTS5 top-N then cross-encoder top-3) is the one actionable takeaway for grounding quality and prompt size;

**Worth borrowing:**
- ✔ Rerank retrieval candidates with a local cross-encoder before they reach Claude (`src/reranking/impl.rs`)
- ✔ Choose the small/fast reranker for English live use (`src/models/reranking.rs`)
- ✔ Truncate and batch-pad to the longest item only (`src/common.rs`)

### 33. [Vbj1808/Dokis](https://github.com/Vbj1808/Dokis)
**Stars:** n/a · **Licence:** MIT → *code reusable* · **Last activity:** 2026-04-28

Dokis is a small checker for AI answers. After an AI writes an answer from a set of source documents, Dokis pulls out each factual statement, looks for the source passage that backs it up, and reports the percentage of statements that are backed. It lists the unsupported ones, shows which source each statement came from, and flags support that is too old.

**Verdict:** Adopt the idea, skip the code. Dokis is a tidy, MIT-licensed, very fast (about 1 ms) post-hoc answer auditor for RAG pipelines. Its most useful transferable pieces are the claim-to-chunk BM25 grounding check with an absolute raw-score floor and the fresh/stale source verdict;

**Worth borrowing:**
- ✔ Post-generation grounding gate: split the answer into claims, BM25-match each to the best chunk, and show claim-to-source plus a compliance rate (`dokis/core/matcher.py, dokis/core/scorer.py`)
- ✔ Absolute raw-score floor before normalising, so stopword-only overlap is never treated as support (`dokis/core/matcher.py`)
- ✔ Deterministic verifiable-claim filter: only score sentences that assert a checkable fact (`dokis/core/extractor.py (line 762),…`)

### 34. [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)
**Stars:** ~25.7k · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-05

Promptfoo is a developer testing tool, not a live-call product. An engineer writes a list of test questions and expected qualities, runs them against one or more AI models and prompts, and gets a side-by-side scorecard showing which prompt or model gave better, safer or cheaper answers. It also runs automated attack tests (red teaming) to see if an AI app can be tricked.

**Verdict:** Adopt the idea, skip the code. It is a well-maintained, MIT-licensed (about 25.7k stars) offline eval harness, not a live-call assistant, so it gives nothing for capture, speaker identity, when-to-speak or call-state.

**Worth borrowing:**
- ✔ Adaptive concurrency with halve-on-429 and slow recovery. When a provider rate-limits, in-flight parallelism is halved immediately. (`src/scheduler/adaptiveConcurrency.ts`)
- ✔ Retry policy that honours the server's Retry-After, adds jitter, and refuses to retry hard quota errors. (`src/scheduler/retryPolicy.ts`)
- ✔ Latency as a first-class assertion. Every call records latencyMs, and a test can assert a threshold in ms. (`src/assertions/latency.ts`)

### 35. [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix)
**Stars:** ~11.7k · **Licence:** Elastic 2.0 (restricted) → *idea only* · **Last activity:** recent (date not confirmed)

Phoenix is Arize's free, self-hostable tool that records what an AI app does step by step (every prompt, answer, and tool call), then lets teams score the quality of those answers, compare prompt/model changes on saved test sets, and debug problems. It is the open-source sibling of the paid Arize AX product, so it is the product the rep is selling.

**Verdict:** Adopt the ideas, skip the code. Phoenix is an observability/eval platform, not a live sales assistant, and ELv2 plus the patent notice argue against copying code.

**Worth borrowing:**
- ✔ AIMD adaptive concurrency controller: ramp up parallel LLM calls slowly, halve on any error or timeout, and collapse to 1 after 2 errors within 15s (`packages/phoenix-evals/src/phoenix/evals/executors.py (and…`)
- ✔ Anthropic prompt-cache capability: explicitly mark tools, instructions and conversation for caching only when the model is Anthropic (`src/phoenix/server/agents/capabilities/anthropic_prompt_cache.py;`)
- ✔ Structured conversation checkpoint (compaction) instead of free-text summary, forced via a tool schema (`src/phoenix/server/agents/summarization.py`)

### 36. [batsearchlight/ai-interview-assistant](https://github.com/batsearchlight/ai-interview-assistant)
**Stars:** 0 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-08-20

A free desktop app that listens to your call (your mic and the other side's audio as two separate streams), types out what everyone says live, and when the interviewer asks something it puts 2-3 short bullet-point hints on screen. It can show them in a small overlay on a chosen monitor, analyse a selected screen region with a vision model, and works with whichever AI models you pick through one Replicate API key.

**Verdict:** Adopt the idea, skip the code. The repo is brand new (v0.1.0, 0 stars, 0 issues, so there is zero field evidence) and aimed at interview practice. Its STT path (Replicate upload plus polling) is slower than your Deepgram streaming, and it has no caching, prefetch, local retrieval, grounding or evals that I saw.

**Worth borrowing:**
- ? LLM control-line gating with streaming: the first output line is [TOPIC:x] / [FOLLOW_UP] / [NO_ACTION]. (`/renderer/app.js (onAnswerDelta/onAnswerDone); main.js…`)
- ? Topic threading with follow-up deltas: track currentTopic and the last ~3-6 suggestions per topic, pass them back into the prompt, and force [FOLLOW_UP] output to… (`/main.js buildUserPrompt ~L462-496; /renderer/app.js ~L205-209 and…`)
- ? Wait-for-finished-thought in proactive mode: debounce non-question speech, always wait 2 s in companion mode, drop fragments under 12 characters, and tell the model to… (`/renderer/app.js queueAutoTrigger/fireAutoTrigger ~L213-245; /main.js…`)

### 37. [FungousLand1941/ghost-overlay-app](https://github.com/FungousLand1941/ghost-overlay-app)
**Stars:** 0 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-05

Ghost is a small always-on-top window that nobody on a Zoom/Teams call can see, even when you share your screen. It listens to both sides of the call (system audio plus your mic), shows a live You/Them transcript, and when you press Ctrl+Enter it sends the transcript (and optionally a screenshot) to Claude or Gemini using your own API key. A short answer streams back, led by a "say this" block you can read aloud.

**Verdict:** Adopt the ideas; do not take the code wholesale. It is two weeks old, 0 stars, 0 issues, with MIT declared only in package.json.

**Worth borrowing:**
- ✔ Cheap question-detector plus guard rails for auto-answer: regex on THEM lines only, 350 ms debounce, no overlap with a streaming reply, 6 s cooldown, no screenshot,… (`src/renderer/app.js (lines ~477-495)`)
- ✔ Request governor: one chokepoint that always allows user-initiated asks but throttles background calls (memory, digest, transcribe) with a per-minute budget, a 90 s… (`src/governor.js`)
- ✔ Echo canceller plus echo gate for the mic: subtract a prediction of the call audio from the mic over about 384 ms of echo path, then silence mic frames that are only… (`src/renderer/dsp.js, src/renderer/audio.js,…`)

### 38. [thepersonalaicompany/amurex](https://github.com/thepersonalaicompany/amurex)
**Stars:** ~2.9k · **Licence:** AGPL-3.0 (copyleft) → *idea only* · **Last activity:** recent (date not confirmed)

Amurex is a Chrome extension that sits inside Google Meet or Teams in the browser. It reads the meeting's built-in captions (it does not capture audio itself), sends them to a separate server, and shows suggested questions and answers, a running summary, a catch-up recap if you join late, and a follow-up email draft. It automatically suggests on a timer, not when the rep asks.

**Verdict:** Skip the code, adopt at most a couple of ideas. The repo is only a thin Chrome extension that scrapes Google Meet captions; all the AI logic (prompting, retrieval, when-to-suggest decisions) is in a separate backend repo I did not read, so there is nothing here for grounding, evals, or prompt caching.

**Worth borrowing:**
- ✔ Per-speaker caption buffers with a flush on length or silence, so the transcript is cut into speaker turns. (`/extension/content.js (transcriber, processSpeakerTranscript)`)
- ✔ Timer-driven 'check_suggestion' pushed to the server every 5 seconds, with a gate on the server side deciding whether to answer. (`/extension/content.js (debouncedDoStuff, ws.onmessage)`)
- ✔ One persistent WebSocket for transcript updates and suggestion checks, with a fixed 5s auto-reconnect. (`/extension/content.js (setupWebSocket)`)

### 39. [sam-willi/cue](https://github.com/sam-willi/cue)
**Stars:** 0 · **Licence:** Proprietary → *idea only* · **Last activity:** 2026-10-04

Cue is an early prototype of a speech coach. It listens to you through the mic and, when you fall into a habit like repeated "um"s, "like"s or rushing, it gives a private buzz (on a planned ear cuff; on-screen in this web version) so you can pause and correct yourself. It buzzes only on patterns, not single slips, and it checks afterwards whether the buzz helped. It does not coach a seller on what to say.

**Verdict:** Adopt the ideas only; do not copy code. The repo is licensed proprietary (all rights reserved, source visible for reference only), so reuse of code in a personal or commercial app is not permitted without the author's permission.

**Worth borrowing:**
- ✔ Interim-result early firing with a stability rule: act on streaming words before the turn is final, but only when confident or when enough following words make them… (`src/lib/cue/session.ts`)
- ✔ Measure end-to-end delay and pick the ASR model by measurement; show per-cue delay in the UI and save it in session files (`src/lib/deepgram/liveTranscriber.ts`)
- ✔ Decision engine gates: pattern thresholds, global cooldown, wait for a natural break (bounded), and outcome tracking that backs off after a nudge worked (`src/lib/cue/engine.ts`)

### 40. [TylerBuza/Meetily-ActuallyFree](https://github.com/TylerBuza/Meetily-ActuallyFree)
**Stars:** 29 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-01

A free meeting recorder for your PC (a fork of the Meetily app). It records both your microphone and the other people on the call, types out the conversation on-device, and labels who is talking (you are "You"; other voices become Speaker 1, 2, ...). You can rename or merge speakers during or after the call, and optionally teach it a named person's voice for later meetings.

**Verdict:** Adopt the ideas selectively; skip the code except as a reference. This repo is a meeting recorder, not a live sales coach. It has no hotkey help card, no knowledge pack, no FTS retrieval, no prompt caching, no pre-warm and no proactive coaching.

**Worth borrowing:**
- ✔ Online speaker clustering with source-aware thresholds (mic is always 'You'; remote voices matched by running centroids) (`frontend/src-tauri/src/diarization/online.rs`)
- ✔ Opt-in named voice profiles with a strict match margin, so wrong names are rarer than no names (`frontend/src-tauri/src/diarization/voice_profiles.rs`)
- ✔ Per-source VAD with pre-roll and a short-redemption real-time mode. Mic and loopback are segmented separately and never mixed before STT. (`frontend/src-tauri/src/audio/pipeline.rs;…`)

### 41. [Checkzsy/interview-assistant](https://github.com/Checkzsy/interview-assistant)
**Stars:** n/a · **Licence:** CC BY-NC (no commercial use) → *idea only* · **Last activity:** 2026-09-24

A desktop app that listens to the interviewer through the computer's audio, turns speech into text live, spots when a real question was asked, and streams a written answer from one or several AI models. It can also read screenshots (code or exam questions), cite the user's own notes, and has resume tools, mock interviews, post-interview replay and a job tracker. It is built to hide itself from screen sharing.

**Verdict:** Adopt the ideas, skip the code. The licence (CC BY-NC) rules out commercial reuse, and the stack is Python/FastAPI and Chinese-language, so there is little to lift anyway. The most useful pieces are the question-group/grace-window logic for when-to-speak and the stale-turn cancellation.

**Worth borrowing:**
- ✔ Question-group state machine with grace window for late constraints (utterance-level promote/candidate/ignore, then group, then flush on timers) (`backend/api/assist/asr_state.py; backend/services/stt/text_utils.py`)
- ✔ Stale-turn cancellation: a new utterance cancels queued and in-flight answers from older turns (`backend/api/assist/scheduler.py; backend/api/assist/answer_worker.py`)
- ✔ Bounded low-priority lane so background work (note saving, analysis) never competes with the live answer, with drop-on-full (`backend/core/resource_lanes.py`)

### 42. [sigotoyou09231997-design/ai-gijiroku](https://github.com/sigotoyou09231997-design/ai-gijiroku)
**Stars:** 0 · **Licence:** No licence (all rights reserved) → *idea only* · **Last activity:** 2026-09-21

A browser-based live meeting assistant in Japanese. It listens to your microphone (you) and, if you route the call audio through a virtual audio cable such as BlackHole, to the other party as a separate stream.

**Verdict:** Adopt ideas, do not borrow code (no license; and the code is small and Japanese-commented anyway). It is an early, 0-star personal project with no issues, so there is no community evidence of what works.

**Worth borrowing:**
- ✔ Role-specific capture constraints: disable echo cancellation, noise suppression and AGC on the loopback (other-party) stream, leave defaults on the mic stream (`src/lib/speech/audioConstraints.ts`)
- ✔ Speaker label from the audio source, injected into the LLM prompt as ground truth ([自分]/[相手]) so the model does not guess who asked (`src/hooks/useLiveSession.ts; api/analyze.ts`)
- ✔ Device auto-pick with scoring plus reconcile on devicechange (virtual cable detected by name regex; Bluetooth/built-in mics scored down; stale saved IDs reset) (`src/lib/speech/devices.ts; src/hooks/useLiveSession.ts`)

### 43. [Parakeet-Inc/Parapper-ASR](https://github.com/Parakeet-Inc/Parapper-ASR)
**Stars:** 46 · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** recent (date not confirmed)

Parapper is a free Windows (also macOS) app that turns speech into text on your own PC, with no graphics card and no internet once models are downloaded. It can listen to the microphone or to whatever the computer is playing, show live captions that update while people are still talking, and lock them in once the speaker has actually finished. It can also translate (Japanese and English) and read text aloud.

**Verdict:** Adopt the IDEA, skip the code. This is a speech-to-text engine for streamers, not a sales assistant, so it has nothing on coaching, grounding or call state. Its useful contribution is a clean, tested way of deciding when a speaker has finished a turn (grammar boundary, then an AI end-of-utterance check, with a safety timeout).

**Worth borrowing:**
- ✔ Three-level end-of-turn decision: silence timer, then grammar boundary on the re-recognised text, then a small AI end-of-utterance check, with a timeout fallback (`crates/parapper-stt-engine/src/turn/grammar.rs (plus turn/silence.rs,…`)
- ✔ Namo turn-detector: a tiny ONNX text classifier that returns P(end of turn) and is given only the last N tokens of context (`crates/parapper-models/src/td/namo.rs`)
- ✔ Fast interim text plus slow accurate final text, with a pre-speech buffer and an immediate 96 ms partial (`crates/parapper-stt-engine/src/config.rs;…`)

### 44. [vivekuppal/transcribe](https://github.com/vivekuppal/transcribe)
**Stars:** 266 · **Licence:** MIT → *code reusable* · **Last activity:** 2026-08-28

Transcribe is a Windows desktop app that listens to your microphone and to whatever your computer is playing (for example the other person on a call), shows a live transcript, and asks an LLM (OpenAI or an OpenAI-compatible provider) to suggest what you could say next. It can run on a timer, or you can click for a response now or highlight text and ask about just that.

**Verdict:** Skip the code and adopt at most one or two small ideas. This is a generic "casual pal" transcription and reply tool. It has no grounding, no citations, no prompt caching or pre-warm, no topic or call-state tracking, and no model of when to speak. Your app is already well ahead of it on every goal.

**Worth borrowing:**
- ✔ Rolling-window live transcript reconciliation. Overlapping STT windows are merged into one transcript. (`app/transcribe/live_transcription.py`)
- ✔ Bounded audio ingress queue that drops the OLDEST chunk on overflow, plus a bounded provider buffer that reports overflow instead of silently discarding. (`sdk/audio_recorder.py; app/transcribe/parameters.yaml`)
- ✔ Separate persistent STT sessions per audio source (mic = 'You', loopback = 'Speaker'), with a per-source format converter, reconnect with backoff, and a deduplication… (`app/transcribe/openai_realtime_transcriber.py`)

### 45. [chentuochao/LlamaPIE](https://github.com/chentuochao/LlamaPIE)
**Stars:** 24 · **Licence:** MIT → *code reusable* · **Last activity:** recent (date not confirmed)

LlamaPIE is a research project for an earpiece AI that listens to a live conversation and only whispers a 1-3 word reminder (for example a name or fact from the wearer's memory) at the moments it thinks you need help, staying silent the rest of the time. A small, fast model keeps asking "should I speak now?" at each pause. Only when it says yes does a larger model write the whisper.

**Verdict:** Adopt the idea, skip the code. The useful ideas are the cheap always-on gate in front of an expensive generator, evaluating only at pauses, a very short glanceable output with a silence option, and gate-sensitivity evaluation.

**Worth borrowing:**
- ✔ Two-stage gate: a tiny classifier decides whether to speak, and the big LLM runs only when it says yes (`/infer_dual_model.py, /model/CasualTokenClassificationLlama.py`)
- ✔ Evaluate the decision only at pauses (silence tokens), not on every word (`/infer_dual_model.py, /edge/text_demo.py,…`)
- ✔ Incremental KV-cache streaming: keep the system prompt and memory prefilled, append each new word to the cache, and snapshot the cache so a generated whisper does not… (`/edge/text_demo.py`)

### 46. [latishab/turnsense](https://github.com/latishab/turnsense)
**Stars:** n/a · **Licence:** Apache-2.0 → *code reusable* · **Last activity:** 2026-03-20

Turnsense is a tiny add-on "ears" model that reads the live transcript text and guesses whether the speaker has finished their turn or is just pausing mid-thought. Voice bots use it so they do not interrupt people or wait too long. It does not hear audio, does not write answers, and does not know anything about sales.

**Verdict:** Adopt the idea, skip the code and the model for now. Deepgram already provides end-of-utterance signals (endpointing, utterance end, speech_final), so a separate text model adds little for a rep who presses HELP manually. The repo is thin (README, licence, one notebook;

**Worth borrowing:**
- ✔ Classify the end of a turn from transcript text with a small CPU model, to decide when the rep's help should fire (`/README.md`)
- ✔ Confidence threshold on the end-of-turn probability instead of a hard yes/no (`/turnsense_finetuning_example.ipynb`)
- ✔ Fixed prompt format for STT text, with the chat-end token removed so the model judges an unfinished turn (`/README.md`)

### 47. [tobi/qmd](https://github.com/tobi/qmd)
**Stars:** ~30.2k · **Licence:** MIT → *code reusable* · **Last activity:** 2026-10-01

QMD is a search engine that lives on your own laptop and finds things in your notes, meeting transcripts and docs. You can ask in plain English ("what did we agree on pricing?") and it finds the right passages without sending anything to the cloud. Behind the scenes it tries both exact keyword matching and meaning-based matching, merges the two lists, then has a small local AI model re-rank the best candidates.

**Verdict:** Adopt the ideas; do not take the code or the dependency. License is MIT, so borrowing code is legally fine, but qmd is a document-search tool, not a live-call assistant. Its full pipeline needs about 2GB of local models and quotes about 10s per warm query, which is too slow and heavy for a HELP-button card.

**Worth borrowing:**
- ✔ Strong-signal bypass: run a cheap BM25 probe first and skip the LLM expansion step when the top hit is clearly dominant (`src/store.ts (about lines 428-429 and 5595-5606)`)
- ✔ Cache LLM sub-results keyed by content, and evict cached duds (`src/store.ts (about lines 1237, 2694-2722, 4636-4665, 5593-5640)`)
- ✔ Hybrid retrieval via Reciprocal Rank Fusion with a top-rank bonus, then position-aware blending of the reranker score (`README.md (pipeline section) and src/store.ts (about lines 2477-2495,…`)

### 48. [MinishLab/model2vec](https://github.com/MinishLab/model2vec)
**Stars:** n/a · **Licence:** MIT → *code reusable* · **Last activity:** recent (date not confirmed)

Model2Vec turns a big, slow text-understanding model into a tiny lookup table. Each word-piece gets a pre-computed number list, and a sentence is just the average of its pieces. That means it can judge "how similar is this sentence to that note" in well under a millisecond on an ordinary laptop CPU, with no GPU and no heavy AI runtime.

**Verdict:** Adopt the idea, skip the code. Static embeddings are a cheap, offline semantic layer to put beside FTS5 for knowledge-pack and older-turn recall, and possibly for the topic tracker.

**Worth borrowing:**
- ✔ Static-embedding retrieval: embed a text as the mean of per-token vectors. No transformer runs at query time. (`model2vec/model.py`)
- ✔ Quantise the embedding table (float16/int8, plus optional dimensionality cut) when loading, to shrink memory and load time. (`model2vec/quantization.py`)
- ✔ Hard truncation of input by characters before tokenising, using a token-length-based cap, so a long transcript can never blow the latency budget. (`model2vec/model.py`)


---

## 11. 174 more relevant repos from the sweep (not read in depth)

These were found and quickly checked (README and repo page only) and scored 5 or higher out of 10 for fit. Descriptions come from that quick check, so treat them as first impressions. Of the 869 repos found in total, the other ~650 scored below 5 (off-topic, abandoned, or duplicates). Stars show "n/a" where GitHub's page could not be loaded.

| Repo | What it is | Stars | Licence | Fit (0-10) |
|---|---|---|---|---|
| [Vinix24/OnCue](https://github.com/Vinix24/OnCue) | Local-first sales copilot: whisper.cpp transcription with speaker attribution, embedding-based pain-point and objection detection (price, timing, competitor, scope, authority), talk-time… | 1 | AGPL-3.0 (copyleft) | 7 |
| [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Fast, synchronous SQLite3 binding for Node with a simple API, bundled SQLite including FTS5, transactions and user-defined functions. Version 13.0.3. | n/a | MIT | 7 |
| [Etan330/Virgil](https://github.com/Etan330/Virgil) | A real-time conversation copilot for macOS (Apple Silicon), aimed at product and requirements discussions rather than sales. | n/a | MIT | 7 |
| [asuntzu/aimeetingcopilot](https://github.com/asuntzu/aimeetingcopilot) | On-device meeting assistant packaged for the Claude desktop app. | 0 | MIT | 7 |
| [Natively-AI-assistant/natively-cluely-ai-assistant](https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant) | Electron plus Rust Cluely-style meeting/interview copilot. It has dual-channel audio (system and mic), STT choices (local Whisper/Moonshine/Parakeet via ONNX, or Deepgram Nova-3, Google,… | n/a | Non-commercial (no commercial use) | 6 |
| [Artasov/xexamai](https://github.com/Artasov/xexamai) | Actively developed Tauri 2 (Rust + TypeScript) desktop assistant: rolling in-memory audio buffer, mic / system-audio / mixed capture via native WASAPI loopback on Windows, streaming… | n/a | unclear | 6 |
| [vishwjeet27/wishpilot](https://github.com/vishwjeet27/wishpilot) | Electron 44 / React 19 stealth interview copilot with polished packaging (WinGet, CI, CodeQL, Dependabot, wiki, Product Hunt). | n/a | GPL-3.0 (copyleft) | 6 |
| [XiaoChu-1208/interview-assistant-CLI](https://github.com/XiaoChu-1208/interview-assistant-CLI) | CLI that does not generate answers with an LLM. You prepare answers in advance, and it transcribes the question and uses hybrid retrieval (BM25 plus embeddings) to show the stored answer in… | 3 | MIT | 6 |
| [sarthakdev143-lite/wingman](https://github.com/sarthakdev143-lite/wingman) | Electron 41 + Python desktop interview assistant. WASAPI loopback via pyaudiowpatch, local dependency-free VAD (pay for speech not silence), Groq whisper-large-v3-turbo transcription,… | n/a | MIT | 6 |
| [buluoai6-eng/online-meeting-interview-assistant](https://github.com/buluoai6-eng/online-meeting-interview-assistant) | Chinese-language Windows always-on-top meeting/interview assistant (v1.0.0) for Tencent Meeting, Zoom, Teams, Feishu, DingTalk, Webex, Meet. | n/a | unclear | 6 |
| [pyannote/pyannote-audio](https://github.com/pyannote/pyannote-audio) | The standard open-source PyTorch toolkit for speaker diarization, with pretrained pipelines on Hugging Face (current open model is community-1) and speaker embedding models. | n/a | MIT | 6 |
| [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | Python framework for real-time voice and multimodal agents. Composable pipelines of STT, LLM and TTS, with many service integrations (including Deepgram) and WebSocket/WebRTC transports. | n/a | BSD | 6 |
| [vortechron/stealth](https://github.com/vortechron/stealth) | Native macOS Swift/SwiftUI Cluely-style copilot. Transcribes mic ('You') and system audio ('Them') live via OpenAI Realtime API. A hotkey (Option+Space) drafts a spoken reply. | n/a | MIT | 6 |
| [mohdrajab81/live-meeting-copilot](https://github.com/mohdrajab81/live-meeting-copilot) | Windows meeting copilot. Real-time transcription (Azure Speech by default, optional Deepgram Nova-3 path with built-in WASAPI loopback capture), English-to-Arabic translation, AI coaching,… | n/a | unclear | 6 |
| [shengjidaguai-china/xiaoguan](https://github.com/shengjidaguai-china/xiaoguan) | Chinese-language local sales advisor packaged as a Codex skill with Python 3.10+. | n/a | unclear | 6 |
| [AiPersonacademy/jev-sales-radar](https://github.com/AiPersonacademy/jev-sales-radar) | Rust teleprompter that claims sub-25ms deterministic objection anticipation. | 0 | MIT | 6 |
| [attentiontech/gtm-superintelligence](https://github.com/attentiontech/gtm-superintelligence) | Open-source, Claude-native post-call pipeline. A transcript goes through four stages (classify call type and phase, infer desired outcome, score against a YAML rubric, coach). | 93 | Apache-2.0 | 6 |
| [jkipo616-bit/call-copilot](https://github.com/jkipo616-bit/call-copilot) | Windows Electron prototype with dual-channel ME/THEM Deepgram Nova-3 sessions, AudioWorklet 16kHz resampling and a mostly rule-based local copilot (intent classifier, sales state machine,… | n/a | unclear | 6 |
| [matildagylee/kairos-sales-assistant](https://github.com/matildagylee/kairos-sales-assistant) | Chrome side-panel extension for live sales calls. Claude copilot grounded in baked-in Notion battlecards (9 competitors, 9 personas, proof points by vertical). | n/a | unclear | 6 |
| [aiagentwithdhruv/dealpulse](https://github.com/aiagentwithdhruv/dealpulse) | Full-stack real-time sales coaching and pipeline platform. Deepgram Nova-2 streaming with rep vs prospect diarization. | n/a | MIT | 6 |
| [Root1V/aletheia-call-agent](https://github.com/Root1V/aletheia-call-agent) | Self-hosted real-time agent assist for Peruvian bank contact centers: streaming ASR, prosodic emotion detection, card-descriptor resolution, hybrid lexical+dense retrieval with reranking,… | 0 | Apache-2.0 | 6 |
| [livekit/agents](https://github.com/livekit/agents) | Production Python framework for realtime server-side voice/multimodal agents: pluggable STT/LLM/TTS, WebRTC and telephony, semantic turn detection, MCP tools, and a native test framework… | 14 | Apache-2.0 | 6 |
| [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | Widely used pre-trained voice activity detector of about 2MB. It processes audio chunks in under 1ms on one CPU thread and supports 8k and 16k sample rates. | n/a | MIT | 6 |
| [openai/openai-realtime-agents](https://github.com/openai/openai-realtime-agents) | OpenAI's reference demo of two voice-agent patterns built on the Realtime API and Agents SDK: Chat-Supervisor and Sequential Handoff. Next.js app with customer-service examples. | n/a | MIT | 6 |
| [videosdk-live/NAMO-Turn-Detector-v1](https://github.com/videosdk-live/NAMO-Turn-Detector-v1) | ONNX semantic turn-detection models (mmBERT multilingual, DistilBERT per language) that predict whether a speaker has finished, from text. | 46 | Apache-2.0 | 6 |
| [lixuanqun/flux-endpoint](https://github.com/lixuanqun/flux-endpoint) | Open re-implementation of Deepgram Flux-style semantic end-of-turn: Flux-compatible event model (StartOfTurn, Update, EagerEndOfTurn, TurnResumed, EndOfTurn) with pluggable VAD, streaming… | n/a | MIT | 6 |
| [Soul-AILab/SoulX-Duplug](https://github.com/Soul-AILab/SoulX-Duplug) | A 0.6B streaming 'semantic VAD' model for full-duplex voice agents. | n/a | Apache-2.0 | 6 |
| [ricky0123/vad](https://github.com/ricky0123/vad) | A mature, easy browser and Node VAD library. It runs Silero VAD v5/v6 through ONNX Runtime Web or Node, with callbacks such as onSpeechStart and onSpeechEnd plus audio segments. | n/a | unclear | 6 |
| [juanmc2005/diart](https://github.com/juanmc2005/diart) | A Python library for real-time streaming speaker diarization, built on pyannote segmentation and embedding models with online incremental clustering. | n/a | MIT | 6 |
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | A large offline onnxruntime toolkit covering streaming and offline ASR, TTS, speaker diarization, speaker identification and verification, VAD, keyword spotting, punctuation, speech… | n/a | Apache-2.0 | 6 |
| [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine) | Moonshine Voice, an on-device streaming speech-to-text toolkit with models trained from scratch. | n/a | MIT | 6 |
| [HEnquist/wasapi-rs](https://github.com/HEnquist/wasapi-rs) | Safe Rust wrapper over the Windows WASAPI audio API: playback and capture, shared/exclusive modes, event-driven or polled buffering, loopback capture, device-change and volume… | n/a | unclear | 6 |
| [decibri/decibri](https://github.com/decibri/decibri) | Cross-platform audio engine for speech apps with Python, Rust, Node.js and browser bindings. | n/a | Apache-2.0 | 6 |
| [wenet-e2e/wespeaker](https://github.com/wenet-e2e/wespeaker) | Speaker embedding toolkit (ResNet, ECAPA-TDNN, CAM++, ERes2Net etc.) for verification, recognition and diarization, with ONNX and MNN export and pretrained models; production focus. | 1 | Apache-2.0 | 6 |
| [modelscope/3D-Speaker](https://github.com/modelscope/3D-Speaker) | Alibaba toolkit and dataset for speaker verification, recognition and diarization (CAM++, ERes2Net, ECAPA, plus audio-visual diarization) with pretrained ModelScope models and ONNX Runtime… | 3 | Apache-2.0 | 6 |
| [maximus-choi/Utterr](https://github.com/maximus-choi/Utterr) | Real-time speaker diarization demo. Captures mic or Windows loopback with SoundCard, uses Silero VAD, takes ECAPA-TDNN or WeSpeaker ResNet34 embeddings, and assigns speakers by cosine… | n/a | unclear | 6 |
| [resemble-ai/Resemblyzer](https://github.com/resemble-ai/Resemblyzer) | Pretrained 256-dimensional GE2E voice encoder, pip-installable. | n/a | Apache-2.0 | 6 |
| [Gr122lyBr/voicetag](https://github.com/Gr122lyBr/voicetag) | Python library and CLI for named speaker identification. It uses pyannote diarization, then Resemblyzer embeddings matched to enrolled voice profiles that can be saved and loaded. | n/a | MIT | 6 |
| [sqliteai/sqlite-vector](https://github.com/sqliteai/sqlite-vector) | Cross-platform SQLite vector extension with SIMD distance kernels and exact search. | n/a | unclear | 6 |
| [Dicklesworthstone/frankensearch](https://github.com/Dicklesworthstone/frankensearch) | Local two-tier hybrid search library and CLI (fsfs) in Rust. A fast first pass returns results immediately, then a higher-quality model refines and re-ranks them. | n/a | MIT | 6 |
| [aksika/abmind](https://github.com/aksika/abmind) | Persistent memory system for 24/7 multilingual AI agents (v0.2.7, npm package, Apache 2.0, Node 22+). | n/a | Apache-2.0 | 6 |
| [nikitacometa/mnemon-memory-mcp](https://github.com/nikitacometa/mnemon-memory-mcp) | mnemon-mcp: local-first MCP memory server on a single SQLite file, with four memory layers (episodic decays with 30-day half-life, semantic, procedural, resource 90-day decay) and hybrid… | n/a | MIT | 6 |
| [KRLabsOrg/LettuceDetect](https://github.com/KRLabsOrg/LettuceDetect) | Open span-level hallucination detector: given source context and an answer, it returns exact character spans that are unsupported or contradicted. | n/a | MIT | 6 |
| [ggozad/haiku.rag](https://github.com/ggozad/haiku.rag) | Local agentic RAG over your own documents with citations to page numbers and section headings. | n/a | unclear | 6 |
| [explodinggradients/ragas](https://github.com/explodinggradients/ragas) | LLM/RAG evaluation toolkit: faithfulness, context precision/recall, answer relevancy, plus synthetic test-set generation. Repo has moved to vibrantlabsai/ragas per README links. | n/a | Apache-2.0 | 6 |
| [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | Pytest-style LLM evaluation framework with many built-in metrics (G-Eval, faithfulness, hallucination, conversational/multi-turn metrics), tracing and a commercial Confident AI platform. | n/a | Apache-2.0 | 6 |
| [langwatch/scenario](https://github.com/langwatch/scenario) | Agent testing framework simulating users in multi-turn scenarios with judge agents, red teaming, caching for determinism, and first-class voice agent testing (audio injection, noise,… | 981 | Apache-2.0 | 6 |
| [kjayashr/liquid-voice-agent](https://github.com/kjayashr/liquid-voice-agent) | Voice chatbot that listens to a sales conversation, detects the situation by semantic search, scores 80+ persuasion principles (Cialdini, Voss, Kahneman) and speaks coaching back. | 4 | MIT | 6 |
| [colakang/echoai_helper](https://github.com/colakang/echoai_helper) | Python meeting/interview transcriber: separate mic and far-end tracks, local FunASR/SenseVoice, speaker labelling, pause-based segmentation, crash-safe logging, live reply suggestions, LLM… | 17 | MIT | 6 |
| [sohzm/cheating-daddy](https://github.com/sohzm/cheating-daddy) | Electron real-time AI assistant for calls and interviews. Captures screen and audio (Windows loopback, macOS SystemAudioDump), streams to Gemini 2.0 Flash Live, shows answers in an… | n/a | GPL-3.0 (copyleft) | 6 |
| [Zackriya-Solutions/meeting-minutes](https://github.com/Zackriya-Solutions/meeting-minutes) | Local-first AI meeting assistant. Captures mic and system audio, mixes them (with ducking and clipping prevention), transcribes locally with Whisper or Parakeet, and summarizes via Ollama,… | 31 | MIT | 6 |
| [michaelwilhelmsen/humla](https://github.com/michaelwilhelmsen/humla) | Granola-style macOS meeting-notes app: freeform notes during the call, mic and system audio captured as two separate streams, transcription via local Whisper, OpenAI, Deepgram Nova-3 etc.,… | n/a | MIT | 6 |
| [Lab-51/lifedash](https://github.com/Lab-51/lifedash) | Offline-first desktop meeting app (Windows installer, macOS beta). | n/a | unclear | 6 |
| [gmudz/UltimateCallCenterAgent](https://github.com/gmudz/UltimateCallCenterAgent) | A real-time AI sales copilot for financial brokerage call centers, aimed at Arabic and MENA markets. The browser captures speech and streams it over a WebSocket. | n/a | Apache-2.0 | 6 |
| [yzfly/awesome-voice-agents](https://github.com/yzfly/awesome-voice-agents) | A bilingual (EN/ZH) curated index of voice-agent frameworks, VAD, turn detection, STT/TTS, end-to-end speech models, voice MCP and specialised solutions. | n/a | unclear | 6 |
| [gsamat/amanu](https://github.com/gsamat/amanu) | Free open-source bot-free meeting recorder for macOS and Windows. | 202 | MIT | 6 |
| [pixelsmasher13/platypus](https://github.com/pixelsmasher13/platypus) | Open-source desktop notes app (macOS/Windows) that auto-detects Zoom/Teams calls, records mic plus meeting audio without a bot, local Whisper with live drafts or OpenAI, merges rough notes… | n/a | MIT | 6 |
| [estebanstifli/Meet2Notes](https://github.com/estebanstifli/Meet2Notes) | Self-hosted local-first meeting assistant (v0.9.0) for Windows/macOS/Linux: mic plus system audio loopback capture, live or final transcripts, diarization, saved-voice matching, structured… | n/a | MIT | 6 |
| [ooboqoo/interview-coder-cn](https://github.com/ooboqoo/interview-coder-cn) | Most popular of the set: Electron/Vue3 stealth overlay with two modes. Screenshot mode solves on-screen problems with a vision model. | 947 | Non-commercial (no commercial use) | 6 |
| [aihaili/meeting-assistant](https://github.com/aihaili/meeting-assistant) | Local-first Windows real-time meeting assistant: streaming ASR (FunASR GGUF or FireRedASR2S), speaker voice-print separation (CAM++), extraction of action items/leads into 10 categories,… | 0 | AGPL-3.0 (copyleft) | 6 |
| [nikiki-star/salesvoice](https://github.com/nikiki-star/salesvoice) | Post-meeting customer intelligence hub for Chinese business sales. | n/a | MIT | 6 |
| [usernamermh/help-sale](https://github.com/usernamermh/help-sale) | Sales-assist agent platform for car-sales teams (Chinese). Analyses customer chat records, retrieves from a team talk-track library, detects intent and risk, checks standard-script… | n/a | MIT | 6 |
| [heri-j1/diting](https://github.com/heri-j1/diting) | Local Chinese meeting recorder. Records system audio and mic on separate tracks and shows live captions via streaming FSMN-VAD and Paraformer-online (600ms chunks). | n/a | unclear | 6 |
| [aliozkanozdurmus/ZaiqoM-MeetingHelper](https://github.com/aliozkanozdurmus/ZaiqoM-MeetingHelper) | Tauri 2 + Rust + React desktop assistant that gives short, sourced answers during meetings using the selected project's code, docs and past recorded meetings, with lexical or Gemini/Ollama… | 0 | No licence (all rights reserved) | 6 |
| [abbinavv/cue](https://github.com/abbinavv/cue) | Free macOS interview copilot with an overlay hidden from default screen-share. It does live on-device meeting transcription (whisper.cpp with Core ML) and screen OCR (Apple Vision). | n/a | unclear | 6 |
| [ictnlp/LSG](https://github.com/ictnlp/LSG) | AAAI 2025 code: an off-the-shelf LLM acts as the read/write policy for simultaneous generation, deciding when to emit output while input still streams. | n/a | unclear | 6 |
| [kizuna-ai-lab/sokuji](https://github.com/kizuna-ai-lab/sokuji) | Cross-platform desktop app (Windows/macOS/Linux) and Chrome/Edge extension for real-time two-way meeting translation. | n/a | AGPL-3.0 (copyleft) | 6 |
| [anthropics/claude-cookbooks](https://github.com/anthropics/claude-cookbooks) | Anthropic's official notebook collection of copy-able Claude API recipes: classification, RAG, summarization, tool use, customer-service agent, and more. | n/a | MIT | 6 |
| [giulioco/skills](https://github.com/giulioco/skills) | A personal collection of Claude Code skills installed via npx add-skill. Most are unrelated (image prompting, social growth). | n/a | unclear | 6 |
| [bozbuilds/AIngram](https://github.com/bozbuilds/AIngram) | Agent memory in one SQLite file fusing FTS5, vector search and knowledge-graph traversal via RRF. | n/a | Apache-2.0 | 6 |
| [MrSibe/KnowNote](https://github.com/MrSibe/KnowNote) | Electron NotebookLM-style desktop app: imports PDF/Word/PPT/web, parses, chunks, embeds in-process (multilingual-e5-small ONNX) with sqlite-vec, answers with citations to source passages… | 1 | GPL-3.0 (copyleft) | 6 |
| [kolisachint/embeddingsearchtools](https://github.com/kolisachint/embeddingsearchtools) | Rust semantic search built from primitives: hand-written HNSW, BM25 fused with vectors, int8 MiniLM bundled via ONNX Runtime, mmap store; | n/a | MIT | 6 |
| [PrithivirajDamodaran/FlashRank](https://github.com/PrithivirajDamodaran/FlashRank) | Tiny CPU-only Python reranker library using ONNX cross-encoders (default TinyBERT-L-2, ~4MB) plus optional listwise LLM rerankers; no torch or transformers needed. | 1 | Apache-2.0 | 6 |
| [qdrant/fastembed](https://github.com/qdrant/fastembed) | Lightweight Python library by Qdrant generating dense, sparse (SPLADE/BM25), late-interaction (ColBERT), image embeddings and rerankers via ONNX Runtime, no GPU or PyTorch. | 3 | Apache-2.0 | 6 |
| [napi-rs/napi-rs](https://github.com/napi-rs/napi-rs) | Framework for writing Node.js native addons in Rust via N-API, with generated TypeScript types and prebuilt per-platform binaries. | n/a | MIT | 6 |
| [SnosMe/uiohook-napi](https://github.com/SnosMe/uiohook-napi) | N-API (prebuilt) bindings to libuiohook that give Node/Electron global keyboard and mouse hooks, working even when the app is unfocused. Version 1.5.5. | n/a | MIT | 6 |
| [m4heshd/better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers) | Fork of better-sqlite3 (fast synchronous Node SQLite) that bundles SQLite3MultipleCiphers, giving encryption with several ciphers (ChaCha20, SQLCipher-compatible, AES, etc.). | n/a | MIT | 6 |
| [amaanmithani/sales-copilot](https://github.com/amaanmithani/sales-copilot) | A live sales-call copilot that runs on a laptop CPU. Its pipeline is energy VAD with a 450 ms silence endpoint, streaming faster-whisper tiny/base int8, then a cue engine (regex rules,… | n/a | unclear | 6 |
| [FluxAether/oncue](https://github.com/FluxAether/oncue) | Local-first desktop interview copilot (Tauri 2 Rust + React 19) for macOS/Windows. | 1 | MIT | 6 |
| [shubhamshnd/Open-Cluely](https://github.com/shubhamshnd/Open-Cluely) | Electron copilot with AssemblyAI streaming transcription of both system audio and mic, screenshots, and Gemini replies in a small always-on-top window. | n/a | No licence (all rights reserved) | 5 |
| [FarzamHejaziK/AnswerCue](https://github.com/FarzamHejaziK/AnswerCue) | Open-source desktop interview assistant that is a fork of a Pika/Natively-style upstream (same Rust native audio, AGPL-3.0). | n/a | AGPL-3.0 (copyleft) | 5 |
| [iskandaryv/meetingly-ai](https://github.com/iskandaryv/meetingly-ai) | Open-source Cluely alternative: on-device speech recognition separating mic from call audio, instant answers, suggested questions, screen analysis, hidden from screen share, post-meeting… | 5 | Apache-2.0 | 5 |
| [Potestas87/sales-copilot-2.0](https://github.com/Potestas87/sales-copilot-2.0) | Real-time sales call assistant. It captures mic and call audio, detects speech with VAD, streams to a self-hosted GPU server for transcription, then shows an objection classification and a… | 0 | MIT | 5 |
| [PowerInterviewAI/client-app](https://github.com/PowerInterviewAI/client-app) | Electron/React client for a commercial interview-assist product: dual-channel (you + interviewer) ASR over WebSocket to a hosted backend, streaming suggestions from CV/job description,… | n/a | MIT | 5 |
| [Muesli-HQ/muesli](https://github.com/Muesli-HQ/muesli) | A native macOS (Apple Silicon, macOS 14.2+) Swift app combining WisprFlow-style dictation and Granola-style meeting transcription. | n/a | MIT | 5 |
| [Rkcr7/Aura-AI](https://github.com/Rkcr7/Aura-AI) | Windows-first invisible overlay for interviews/exams: Deepgram live STT, fast LLMs (Cerebras, Groq, Gemini) with a health-checked provider fallback, screenshot vision (queue up to 4… | n/a | unclear | 5 |
| [bnovik0v/ghst](https://github.com/bnovik0v/ghst) | Linux-only Electron overlay (v0.1 WIP) that captures system audio plus mic via PipeWire, applies Silero VAD, streams chunks to Groq whisper-large-v3-turbo for You/Them captions, and gives a… | n/a | MIT | 5 |
| [silverstein/minutes](https://github.com/silverstein/minutes) | Local-first conversation memory app and CLI. It records and transcribes meetings, calls, memos and dictation on-device, stores Markdown files in ~/meetings, and exposes an MCP server so… | n/a | MIT | 5 |
| [kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling) | Kyutai's streaming speech-to-text and text-to-speech models with run instructions and servers. STT 1B model has ~0.5s delay (2.6B model ~2.5s), with word timestamps and semantic VAD. | n/a | Apache-2.0 | 5 |
| [Valtora/Nojoin](https://github.com/Valtora/Nojoin) | Self-hosted (Docker, GPU) meeting transcription and notes. It records via a Chromium browser's shared-audio capture, so no bot joins, and processes on your own server with pyannote… | n/a | AGPL-3.0 (copyleft) | 5 |
| [ANTHONY-CHINEDU-ECHEM/SALES_CALL_COPILOT](https://github.com/ANTHONY-CHINEDU-ECHEM/SALES_CALL_COPILOT) | Small Python/FastAPI reference implementation: detects 8 objection categories, retrieves approved enablement material (TF-IDF with rerank), generates Claude coaching, and scores outputs… | 1 | MIT | 5 |
| [zime-ai/zime-gtm-skills](https://github.com/zime-ai/zime-gtm-skills) | 41 markdown Agent Skills that audit call transcripts and CRM exports against GTM frameworks (MEDDICC, BANT, discovery, etc.) with a Covered/Partial/Missed verdict and a quoted-evidence… | 17 | MIT | 5 |
| [silverstein/linecheck](https://github.com/silverstein/linecheck) | Free open-source macOS teleprompter for structured calls. It listens to the rep on-device, follows the script word by word through skips and re-reads, waits while the other person talks,… | n/a | MIT | 5 |
| [issacops/opencloser-v2](https://github.com/issacops/opencloser-v2) | Local-first desktop AI SDR platform (cold calling, lead gen, automation) built as a Tauri 2 + Rust + React 19 app with CI, releases and download badges. | n/a | MIT | 5 |
| [vicens-aniol/shivatto](https://github.com/vicens-aniol/shivatto) | Experimental native macOS real-time sales-call assistant. It transcribes the mic and remote SIP audio, offers optional LLM coaching, and has Airtable contacts and a SIP bridge. | 1 | GPL-3.0 (copyleft) | 5 |
| [rjspence3/demo-gauntlet](https://github.com/rjspence3/demo-gauntlet) | Practice simulator for solution consultants and sales engineers. | n/a | unclear | 5 |
| [TrentIndeed/ghl-call-to-crm](https://github.com/TrentIndeed/ghl-call-to-crm) | Pipeline that transcribes a recorded call and updates GoHighLevel (custom fields, note, task, stage). | n/a | unclear | 5 |
| [divya-sood/ai-sales](https://github.com/divya-sood/ai-sales) | Full-stack GenAI real-time sales call assistant: live transcription via Deepgram and LiveKit, Gemini for sentiment, objection handling, dynamic question generation, summaries, benchmark… | n/a | unclear | 5 |
| [zagolo/Mantis](https://github.com/zagolo/Mantis) | Single-user outbound calling tool. Campaigns from an offering brief, AI strategy plus per-prospect research, Twilio Voice SDK PSTN calls, Deepgram transcribes both sides via Media Streams. | n/a | unclear | 5 |
| [TEN-framework/ten-framework](https://github.com/TEN-framework/ten-framework) | Open-source framework for realtime multimodal conversational agents with graph-based extension system, plus standalone TEN VAD and TEN Turn Detection models; | 11 | Apache-2.0 | 5 |
| [huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech) | Modular voice-agent pipeline of VAD, STT, LLM and TTS, exposed as an OpenAI Realtime-compatible API over WebSocket and WebRTC. Every stage is swappable. | n/a | Apache-2.0 | 5 |
| [TEN-framework/ten-vad](https://github.com/TEN-framework/ten-vad) | Low-latency, small streaming VAD, claimed to beat WebRTC VAD and Silero in precision. | n/a | Apache-2.0 | 5 |
| [justplus/turn-detection](https://github.com/justplus/turn-detection) | Fine-tuned Gemma3-270M classifier with three states (incomplete, complete, interruption request), Chinese and English, claiming 96.2% accuracy and under 100ms on a T4. | 14 | Apache-2.0 | 5 |
| [mohitgoyal161162/turn-gate](https://github.com/mohitgoyal161162/turn-gate) | Zero-dependency Python library that sits after STT endpoints: scores each endpoint with an end-of-turn model, commits immediately if confident, otherwise holds on a cancellable timer… | n/a | MIT | 5 |
| [MaAI-Kyoto/MaAI](https://github.com/MaAI-Kyoto/MaAI) | Real-time, CPU-friendly implementation of Voice Activity Projection. It continuously predicts turn-taking, backchannels and head nods from one- or two-channel audio. | n/a | MIT | 5 |
| [KoljaB/RealtimeSTT](https://github.com/KoljaB/RealtimeSTT) | A Python speech-to-text library with VAD, wake words, faster-whisper transcription and realtime partial text, for assistants and dictation. | n/a | MIT | 5 |
| [deepgram/deepgram-python-sdk](https://github.com/deepgram/deepgram-python-sdk) | Official Deepgram Python SDK, generated with Fern, currently v7. Covers STT, TTS and text intelligence, with sync and async clients. | n/a | MIT | 5 |
| [speechmatics/speechmatics-python-sdk](https://github.com/speechmatics/speechmatics-python-sdk) | Speechmatics Python SDK split into packages: batch, rt (realtime), agent-stt and voice (voice-agent layer). 55+ languages, custom vocabulary, speaker diarization and speaker ID. | n/a | MIT | 5 |
| [thewh1teagle/aec-rs](https://github.com/thewh1teagle/aec-rs) | Acoustic echo cancellation and noise suppression in Rust, wrapping speexdsp. Offers Rust (aec-rs), Python (pyaec) and a C API. | n/a | MIT | 5 |
| [microsoft/Windows-classic-samples](https://github.com/microsoft/Windows-classic-samples) | Microsoft repo of Windows desktop API samples; includes Samples/ApplicationLoopback for per-process audio capture (page did not itself list that sample). | 5 | MIT | 5 |
| [m96-chan/ProcTap](https://github.com/m96-chan/ProcTap) | Python library capturing audio from a single process by PID using WASAPI process loopback (Windows), PipeWire/PulseAudio (Linux), ScreenCaptureKit (macOS). | 19 | MIT | 5 |
| [biaowww/channel_recording](https://github.com/biaowww/channel_recording) | Windows GUI/CLI app that records one chosen program's audio via WASAPI process loopback, optionally mixed with the mic. | n/a | MIT | 5 |
| [almoghamdani/audify](https://github.com/almoghamdani/audify) | Node.js native addon (RtAudio + Opus) for PCM streaming/recording and Opus encode/decode; WASAPI supported on Windows, prebuilt N-API binaries for Node/Electron. | 156 | MIT | 5 |
| [TaoRuijie/ECAPA-TDNN](https://github.com/TaoRuijie/ECAPA-TDNN) | Unofficial ECAPA-TDNN speaker recognition trainer on VoxCeleb2 (EER 0.86 Vox1-O with AS-norm) with a pretrained model; training-focused, needs ~48h on a 3090. | 826 | MIT | 5 |
| [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) | Long-term memory plugin for OpenClaw agents on LanceDB: hybrid vector plus BM25 with cross-encoder rerank, LLM extraction of memories into 6 categories, Weibull decay, scope isolation,… | n/a | MIT | 5 |
| [RustyRAG/RustyRAG](https://github.com/RustyRAG/RustyRAG) | Rust (Actix-web) RAG API. Hybrid dense plus sparse search in Milvus, optional cross-encoder reranking, Jina embeddings, SSE streaming from Cerebras or Groq. | n/a | unclear | 5 |
| [xbmxb/RAG-query-rewriting](https://github.com/xbmxb/RAG-query-rewriting) | Research code for the paper Query Rewriting in Retrieval-Augmented LLMs (Rewrite-Retrieve-Read): an LLM or small RL-trained rewriter turns the user question into a search query before… | n/a | unclear | 5 |
| [allen-li1231/treehop-rag](https://github.com/allen-li1231/treehop-rag) | TreeHop: a lightweight embedding-level query rewriter for multi-hop retrieval. | n/a | MIT | 5 |
| [valpere/session-indexer](https://github.com/valpere/session-indexer) | Per-project semantic search over Claude Code session history. Indexes JSONL transcripts into a per-project SQLite file (.claude/sessions.db), retrieves via bge-m3 embeddings through Ollama… | n/a | unclear | 5 |
| [everest-an/Awareness-Market](https://github.com/everest-an/Awareness-Market) | Awareness Local: a local-first MCP memory daemon for AI coding agents (Cursor, Claude Code, Copilot, Cline). | n/a | MIT | 5 |
| [roomi-fields/rtfm](https://github.com/roomi-fields/rtfm) | Local retrieval layer (MCP server + CLI, pip rtfm-ai) that indexes code, docs, PDFs into one SQLite file and offers FTS5, semantic or hybrid search for coding agents. | n/a | MIT | 5 |
| [amazon-science/RefChecker](https://github.com/amazon-science/RefChecker) | Amazon Science framework that extracts claims as subject-predicate-object triplets and checks each against reference text with an LLM or NLI checker, then aggregates. | 434 | Apache-2.0 | 5 |
| [stanford-oval/WikiChat](https://github.com/stanford-oval/WikiChat) | Stanford OVAL retrieval-augmented chatbot with a 7-stage pipeline that retrieves Wikipedia evidence, drafts, fact-checks its own claims and refines, with inline citations in 25 languages. | 1 | Apache-2.0 | 5 |
| [mbzuai-nlp/fire](https://github.com/mbzuai-nlp/fire) | NAACL 2025 Findings research code from MBZUAI. An agent loop fact-checks atomic claims. | n/a | No licence (all rights reserved) | 5 |
| [lc198707/anti-lie](https://github.com/lc198707/anti-lie) | Apache-2.0 LICENSE file (README badge says MIT, a mismatch). An outbound audit gate for LLM output. | n/a | Apache-2.0 | 5 |
| [vectara/open-rag-eval](https://github.com/vectara/open-rag-eval) | Python RAG evaluation toolkit from Vectara. Its core metrics, UMBRELA (retrieval relevance) and AutoNuggetizer (answer completeness vs key nuggets), need no golden answers. | n/a | Apache-2.0 | 5 |
| [ARTPARK-SAHAI-ORG/calibrate](https://github.com/ARTPARK-SAHAI-ORG/calibrate) | Engine behind Calibrate, a CLI/framework for evaluating voice agents: STT provider benchmarking, TTS benchmarking, text-LLM multi-turn evals, LLM-judge alignment with human labels, and text… | n/a | No licence (all rights reserved) | 5 |
| [onyx-dot-app/EnterpriseRAG-Bench](https://github.com/onyx-dot-app/EnterpriseRAG-Bench) | Benchmark of about 500,000 synthetic internal company documents (Slack, Gmail, docs, etc., fictional company Redwood Inference) with 500 questions, plus code to generate similar corpora for… | n/a | MIT | 5 |
| [latitude-dev/latitude-llm](https://github.com/latitude-dev/latitude-llm) | Open-source observability for AI agents that finds failure modes in production traces and turns them into evals and fixes, branded as self-healing agents. | n/a | MIT | 5 |
| [prometheus-eval/prometheus-eval](https://github.com/prometheus-eval/prometheus-eval) | Open evaluator LLMs (Prometheus 2, M-Prometheus, BiGGen-Bench) and a Python toolkit for LLM-as-a-judge scoring against custom rubrics, with absolute grading and pairwise ranking. | n/a | Apache-2.0 | 5 |
| [benchflow-ai/awesome-evals](https://github.com/benchflow-ai/awesome-evals) | Annotated curated list (CC0) of 443+ links on building and evaluating AI agents, with 143 deep reading notes and a PATTERNS.md playbook with runnable code: LLM-as-judge aligned to humans,… | n/a | unclear | 5 |
| [Dphenomenal101/playcall](https://github.com/Dphenomenal101/playcall) | Open-source Gong alternative: upload calls, get scorecards that grade whether what was said fit the buyer and the team's playbook, with optional buyer enrichment. Post-call, not live. | 16 | MIT | 5 |
| [mdashfaqq/SalesVoice-Eval](https://github.com/mdashfaqq/SalesVoice-Eval) | Configurable voice-agent framework with an eval harness: runs one prompt against 30 scripted personas, LLM-as-judge scores each transcript, compares v1 vs v2 prompts, with Postgres… | 0 | No licence (all rights reserved) | 5 |
| [Arstanley/Awesome-LLM-Conversation-Simulation](https://github.com/Arstanley/Awesome-LLM-Conversation-Simulation) | Curated list of papers and benchmarks accompanying the 2025 survey 'LLMs for Conversational User Simulation' (Adobe-affiliated authors). | n/a | MIT | 5 |
| [armpro24-blip/MeetingBro](https://github.com/armpro24-blip/MeetingBro) | Local-first meeting assistant: local Whisper live transcription, translation, rolling 3-5 minute summary, cumulative Meeting Board (topics, decisions, actions, open questions), Markdown… | 39 | MIT | 5 |
| [meetp06/parakeetai-clone](https://github.com/meetp06/parakeetai-clone) | Self-hosted single-user live interview copilot. Real-time transcription of both sides, streamed Claude answers grounded in uploaded resume and documents, floating always-on-top pop-out,… | n/a | unclear | 5 |
| [innovatorved/realtime-interview-copilot](https://github.com/innovatorved/realtime-interview-copilot) | Desktop app capturing system audio, live transcription, and AI answers from text, voice or screenshots, with PiP overlay and screen-share protection. | 126 | Apache-2.0 | 5 |
| [tigerless-labs/cost-xray](https://github.com/tigerless-labs/cost-xray) | mitmproxy-based tool capturing real Claude Code/Codex API traffic to attribute tokens and cost per call and component (system prompt, tool schemas, MCP, cache reads/writes) with a live TUI. | 3 | MIT | 5 |
| [Nutlope/open-customer-insights](https://github.com/Nutlope/open-customer-insights) | Next.js workspace for grounded chat and hybrid semantic+keyword search across call transcripts (Gong), tickets (Pylon) and Slack, with company timelines, competitor-mention leaderboard and… | n/a | No licence (all rights reserved) | 5 |
| [IgorOdaryuk/call-audit-demo](https://github.com/IgorOdaryuk/call-audit-demo) | Small post-call audit pipeline. It transcribes locally with faster-whisper, then Claude classifies each call into labels, and every label must carry an evidence quote. | 0 | MIT | 5 |
| [charoiteai/Charoite_audio](https://github.com/charoiteai/Charoite_audio) | Fully local meeting assistant for Apple Silicon Macs: local transcription, live speaker labeling with post-meeting refinement, LLM summaries, self-updating knowledge graph of… | 14 | Apache-2.0 | 5 |
| [vonarmen-wq/forward-deployed-selling](https://github.com/vonarmen-wq/forward-deployed-selling) | Open-source Claude skill (SKILL.md plus capabilities, foundations, references, examples) encoding an enterprise AI-era sales methodology from an ex-AWS seller: account research, outreach,… | n/a | Apache-2.0 | 5 |
| [impossibleG/phorminx](https://github.com/impossibleG/phorminx) | Local-first Windows app in Rust for dictation and meeting transcription. | 204 | MIT | 5 |
| [lgy1027/matrix-live-diarizer](https://github.com/lgy1027/matrix-live-diarizer) | Local-first live captioning plus post-meeting diarization tool. | 133 | MIT | 5 |
| [ObscureAintSecure/TalkTrack](https://github.com/ObscureAintSecure/TalkTrack) | Windows desktop app that records Teams, Zoom and Meet calls with dual-channel WASAPI capture, with per-app audio capture on Windows 11. | 60 | MIT | 5 |
| [richlira/MeetingMindAI](https://github.com/richlira/MeetingMindAI) | iOS 26 SwiftUI app: live transcription (Whisper or on-device SpeechAnalyzer), generates probing questions every ~50 words while speaker is talking, summary, chat over transcript. | n/a | MIT | 5 |
| [igarrux/kuali](https://github.com/igarrux/kuali) | Local meeting transcription for Discord and Google Meet with speaker attribution known before transcription (Discord per-user streams, Meet participant context via a browser extension). | n/a | Apache-2.0 | 5 |
| [royabes/sealscribe](https://github.com/royabes/sealscribe) | Self-hosted meeting stack with three services: OpenAI-compatible speech gateway (Whisper STT, batch and streaming diarization, local LLM summaries, Kokoro TTS), a privacy gateway that… | 1 | MIT | 5 |
| [YangHeng66/interview-coder-cn](https://github.com/YangHeng66/interview-coder-cn) | Working Chinese-language Electron AI interview assistant: screenshot solving, streaming chat, real-time voice transcription, auto-answer on sentence end, plus a local per-role knowledge… | 18 | Non-commercial (no commercial use) | 5 |
| [lfss-zxj/ai-interview-tools](https://github.com/lfss-zxj/ai-interview-tools) | Windows desktop overlay that captures system audio via WASAPI loopback, runs local streaming ASR (FunASR Paraformer for Chinese, Faster-Whisper for English) and shows live captions plus… | 23 | MIT | 5 |
| [simpleqt/snanswer](https://github.com/simpleqt/snanswer) | Electron app with a screen-share-invisible, no-focus-steal overlay. | 10 | CC BY-NC (no commercial use) | 5 |
| [Liwj-0106/Meeting](https://github.com/Liwj-0106/Meeting) | Tauri/Rust desktop meeting assistant (Windows portable). Dual-track mic plus system-audio capture aligned on one 48 kHz timeline, pluggable ASR (local Whisper/Parakeet, Deepgram, OpenAI… | n/a | No licence (all rights reserved) | 5 |
| [jasoncheng7115/jt-live-whisper](https://github.com/jasoncheng7115/jt-live-whisper) | Mature fully local AI speech toolbox (v2.26.12): live transcription, live translation subtitles, batch file processing, speaker diarization, LLM meeting summaries, WebUI. | n/a | Apache-2.0 | 5 |
| [Drong-Yang/live-caption-overlay](https://github.com/Drong-Yang/live-caption-overlay) | Windows desktop caption overlay: captures system output with WASAPI loopback and runs offline streaming sherpa-onnx Paraformer (zh/en bilingual) with a floating subtitle window. | n/a | MIT | 5 |
| [skrylkovs/trippi-oss](https://github.com/skrylkovs/trippi-oss) | Trimmed reference build of a commercial product: tabCapture, offscreen AudioWorklet PCM, direct WebSocket to Deepgram STT, DeepL translation, Shadow-DOM caption overlay with per-speaker… | 0 | MIT | 5 |
| [rahprasad/clairly](https://github.com/rahprasad/clairly) | Electron app plus MV3 extension acting as an always-on-top coach window hidden from screenshare (macOS setContentProtection). | 0 | unclear | 5 |
| [Marvinngg/ambient-voice](https://github.com/Marvinngg/ambient-voice) | macOS menu-bar voice input app on Apple SpeechAnalyzer (macOS 26), fully on-device. Hold Right Option to dictate into any app. | n/a | unclear | 5 |
| [thunlp/ProactiveAgent](https://github.com/thunlp/ProactiveAgent) | ICLR 2025 pipeline for agents that sense the environment (via ActivityWatcher), propose tasks and decide when to proactively help. | n/a | Apache-2.0 | 5 |
| [inokoj/VAP-Realtime](https://github.com/inokoj/VAP-Realtime) | Real-time VAP that runs on CPU. It takes stereo audio over TCP and outputs p_now and p_future, plus separate backchannel and nod predictors. | n/a | MIT | 5 |
| [SakanaAI/kame](https://github.com/SakanaAI/kame) | Inference server and browser UI for KAME, a tandem speech-to-speech system built on Kyutai Moshi. | n/a | MIT | 5 |
| [FireRedTeam/FireRedChat](https://github.com/FireRedTeam/FireRedChat) | Self-hosted real-time voice agent stack with a cascade design (ASR, LLM, TTS) on LiveKit. | n/a | Apache-2.0 | 5 |
| [jeffignacio-growthbook/MEDDICC-agent](https://github.com/jeffignacio-growthbook/MEDDICC-agent) | Fork of a RevOps project. A GitHub Actions job runs nightly at 2am UTC, loads deals and cached calls from Fireflies or Gong, scores each deal on MEDDICC, writes six scores to HubSpot and… | 0 | unclear | 5 |
| [Yz613/Sales-Coach](https://github.com/Yz613/Sales-Coach) | Open-source Gong-style post-call coaching app. It uploads audio or transcripts, transcribes with Whisper, Gemini or Groq, grades against custom rubrics (Sandler pain, budget, decision),… | 0 | MIT | 5 |
| [WebDclassified/OneFind](https://github.com/WebDclassified/OneFind) | Local hybrid retrieval in one SQLite file: FTS5 BM25 plus sqlite-vec cosine KNN, int8/binary quantized ranking, RRF or weighted fusion, optional cosine rerank over a 50-doc pool. | n/a | unclear | 5 |
| [sqliteai/sqlite-rag](https://github.com/sqliteai/sqlite-rag) | Hybrid search engine on SQLite combining vector similarity (SQLite AI and sqlite-vector extensions, EmbeddingGemma GGUF) with FTS5 via RRF. Includes a document chunker, CLI and REPL. | n/a | unclear | 5 |
| [etemigarba/Building-Local-RAG-Pipelines-with-Open-Source-Embeddings](https://github.com/etemigarba/Building-Local-RAG-Pipelines-with-Open-Source-Embeddings) | Offline retrieval-only teaching repo: chunking, dense + BM25 hybrid via reciprocal rank fusion, cross-encoder reranking, recall/MRR/nDCG evaluation, manifest checks against embedding-model… | 0 | MIT | 5 |
| [rupurt/sift](https://github.com/rupurt/sift) | Single-binary Rust CLI/library for local hybrid search: query expansion, BM25 + vector retrieval, fusion, reranking, plus planner-driven agentic multi-turn search and eval/benchmark… | n/a | MIT | 5 |
| [gptguy/silentkeys](https://github.com/gptguy/silentkeys) | Local real-time desktop dictation that types into whatever app has focus. macOS-first beta, Linux/Windows experimental. | n/a | MIT | 5 |
| [RustAudio/cpal](https://github.com/RustAudio/cpal) | Low-level Rust audio input/output library covering WASAPI, CoreAudio, ALSA, JACK and others. | 4 | Apache-2.0 | 5 |
| [microsoft/windows-rs](https://github.com/microsoft/windows-rs) | Microsoft's official Rust crates for Windows APIs, including COM and system services. | 12 | Apache-2.0 | 5 |
| [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) | Complete packaging, code-signing and auto-update (electron-updater) solution for Electron apps; produces NSIS, MSI, portable and others on Windows. | n/a | MIT | 5 |
| [megahertz/electron-log](https://github.com/megahertz/electron-log) | Zero-dependency logging for Electron/Node with file transport in platform-specific directories and renderer-to-main log forwarding. | 1 | MIT | 5 |
| [sewox/EchoMind](https://github.com/sewox/EchoMind) | Tauri v2 (Rust + React/TS) desktop meeting assistant: local whisper.cpp with GPU, sherpa-onnx CAM++ speaker diarization, three model tiers (local, self-hosted Ollama/vLLM, cloud BYOK), DLP… | 0 | MIT | 5 |
| [3aLaee/ClawLine](https://github.com/3aLaee/ClawLine) | Self-hosted terminal (Textual TUI) meeting copilot. A Chrome extension streams tab audio to localhost, Deepgram Nova-3 transcribes, Groq Llama 3.3 70B drafts a suggested reply while the… | 1 | MIT | 5 |

---

*Method note: Round 1 used the deep-research workflow (104 agents). Round 2 was a custom workflow (330 agents): 26 discovery agents, 12 gap-fill agents, 145 quick-check agents, 48 deep-read agents, 96 skeptic agents, 1 synthesis agent. Two deep-read agents failed on a formatting error and were not retried.*
