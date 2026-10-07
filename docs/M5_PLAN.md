# M5: call modes (each call type gets its own job)

Keith asked (2026-10-07): "each type of call is different, disco I'll be asking more q's, demo is more my SA
talking while I try to dive into deeper pain from there, pricing different etc. I think it's really important
each have different modes/goals." This plan comes from a fact-checked research playbook on running each call
type (kept on Keith's PC with its notes, outside this repository: `reports/Sales call types playbook.md`, cited
below as *R §section*) and two reviews of the design (a top-AE/buyer review and an app-fit review).

**Keith's decisions (2026-10-07):**
1. On a demo or deep-dive with the SA on, a technical question **goes to the SA**: Keith never answers it alone,
   even from approved knowledge (deep-dive may still state what approved knowledge says directly, cited).
2. Call lengths for the "about 10 minutes left" cue: **discovery 30, demo 60, technical deep-dive 60, pricing 30,
   follow-up 30** minutes (`CALL_LENGTH_DEFAULTS`), changeable per call in the setup strip, mid-call too.
3. The price check **warns** (yellow "check before saying" note), it doesn't hide the number.
4. The SA check-in threshold (step 2 only) stays at the default 75 s (`CHECKIN_SECONDS`).

**What is built now:** step 0 (the price check) and v1 (the modes). Step 2 (SA-aware demo Holds, the compact mode
switch) waits for one real two-person demo call (the gate in §4). No consent, recording or note-taker prompts:
Keith's standing instruction.

## 0. What this is built on

- **Research:** `reports/Sales call types playbook.md`, cited below as *R §section*: §"The five calls side by side", §Discovery, §Demo, §Deep-dive, §Pricing, §Follow-up, §"Rules that hold on every call", §"Copilot rules for every mode". Detail comes from `research_notes/Sales call types playbook/*.md`. **Evidence strength, as the report rates it:** moderate for discovery and demo shape (Gong vendor data, correlational). **Thin** for Keith's part in a demo, and for the deep-dive, pricing and follow-up calls. Those modes rest on frameworks: the GitLab POV playbook, Black Swan, Harvard PON, JOLT. Every threshold below (15 questions, 60–75 s of SA talk, 10 minutes left) is a starting point for Keith to set. None of them is a measured fact. Gong's 11–14 targeted questions is a range for the whole call, and its 2025 study (about 15–16 seller questions per call in won deals, about 20 in lost ones) reads as a warning sign, not a cap.
- **No product we know of ships per-type modes:** "No vendor docs found that show a true per-call-type mode switch… in Gong, Salesloft, Outreach, Avoma or Sybill" (`research_notes/.../realtime_guidance.md:52`). So Keith picks the mode, and the app never guesses it (*R §Copilot rules for every mode*).
- **The code today:**
  - Call types exist (`src/shared/help.ts` `CALL_TYPES`: `discovery, demo, technical_deep_dive, follow_up, negotiation, other`). Each type has only a one-line description in `config/playbook.json` `call_types`, and every line goes into the cached system prompt (`prompt.ts buildSystemPrompt`). The context's `<call_setup>` names `type:` (`context.ts buildHelpContext`).
  - The presses in `pressModes.ts` (`opening`, `signal`, `another_angle`, `plan_item`), `decidePress`, and WRAP (`wrap.ts`) are the same for every type. Starters per type live in `mustLearnIdeas.ts STARTERS`; at most 3 are offered (`STARTERS_MAX`), after the account's own ideas, within `MUST_LEARN_IDEAS_MAX` = 4.
  - **Speaker ids on live words:** `deepgram.ts:295-297` sets `speaker_cluster` on interim words as well as final ones. `session.ts:713` drops it when it builds the `interim` event (text only), and `CallMemory.Interim` is `{text, at_ms}`. Replay already sets interims for a line that spans the press time (`replay.ts:161`), with the line's cluster in scope.
  - **Playbook loading:** Keith's copy in userData wins while it's valid (`helpService.loadPlaybook`). It's auto-updated only when it's byte-for-byte an earlier built-in; otherwise only `newer_built_in` tells them. The playbook is reloaded at `startCall`, so edits apply from the next call.
  - **Compact mode** hides everything in `#callView` except `.sources`, `#helpCard`, `#banner`, `#idleBanner` and `#planCompact`, and hides `.hc-top` (`styles.css:368, 388`). Card labels in Compact use `.help-card[data-press] .hc-primary .kind::before`.
  - So today the mode is a hint to the model, not a behavior.

### Locked rules: how this proposal keeps each one

| Rule | How it holds |
|---|---|
| Nothing sent automatically | Nothing new is sent. The wrap-up and follow-up stay drafts. |
| No pop-up cards without a press | Hold cards, mode lines, time-left lines and WRAP aims all come on a press. The mode word and the "Tag your SA" reminder are quiet state. |
| Only approved knowledge is Arize fact | The fixed system sentence names it as one of the rules that beat any mode (§1.1). Demo and deep-dive add "hand to the SA". |
| Never a price, discount or term unless approved | Pricing mode restates it. In negotiation, a price question no longer gets the generic signal press (§1.1). A new card check (§1.5) catches a figure taken from the buyer's own words, a gap that exists today. |
| Asked ≠ answered; proposed ≠ agreed | Mode facts count questions, never answers. `agreed_next_step` reads only `call_notes` next steps with status `agreed`. Later mode notes keep `offer` items `proposed` until accepted. |
| Keith's notes / research never something the buyer said | Demo tie-backs and the SA hand-off may quote only the transcript or `earlier_calls` (as a past statement), never `<keith_notes>`. The block says so. |
| Per-press blocks in the user message, after the context | `<call_mode>` goes after the context and before any press block. The system prompt gets one fixed sentence, the same text on every call. |
| Logs carry counts and codes only | New logs: `call_type_changed {from,to,at_min}`, a `press_mode_type` code, mode-fact buckets, `call_modes_from`. No text. |

---

## 1. Architecture (shared by all modes)

### 1.1 Where the mode lives: a `<call_mode>` block in the user message

- **Playbook:** an optional key `call_modes` in `config/playbook.json`, which Keith can edit like `call_types`. One entry per type, with these fields: `goal`, `who_talks`, `lines` (an ordered "first that applies" list), `never` (list), `wrap` (one sentence), `opening` (one sentence), and optionally `signal` (one sentence that replaces the signal press's ASK/SAY rule for this type).
  - `prompt.ts`: extend the `Playbook` type and `playbookProblem()`. If present, the key must use known type names; each field is a string or a list of strings; no string may contain `<` or `>` ("Mode text can't contain < or >; use words instead"); each type's rendered text is capped (about 1,800 characters, roughly 450 tokens). A broken entry gets a plain-words problem message, as `card_limits` does today.
- **Built-in fallback per type (Keith's copy has no `call_modes`).** Keith's playbook copy predates this key, and that copy wins over the shipped one. So `modeBlock` takes each type's entry from Keith's `call_modes` when it has one, and otherwise from the built-in file. `helpService` loads both (it already reads the built-in for the version check). `PlaybookInfo` gains `call_modes_from: 'yours' | 'built_in' | 'mixed'`, and the playbook panel says which is in use. Without this, modes would stay off on Keith's machine with no sign why.
- **New file `src/main/help/callModes.ts`:**
  - `modeBlock(type, modes, facts): string | null` renders only the active type. Every string goes through the same `oneLine` / strip-`<>` cleaning the other blocks use for stored text, so playbook text can't open or fake a tag that `pressModeOf()`, `isWrapRequest()` or MOCK looks for.
    ```
    <call_mode type="demo">
    What this call is for: …
    Who talks: …
    How lines work in every mode: ASK and SAY are only words Keith says to the buyer. A cue to Keith (hold the pitch, not yet heard, sounds like extra work, a requirement to note) goes in HAPPENING, never in ASK or SAY.
    Keith's line on a press (first that applies):
    0. They just asked or raised something: answer or handle it first (normal rules; in a demo or deep-dive with a teammate tagged, a technical how-to goes to the SA). Put this mode's line in FOLLOW.
    1. … 2. …
    Never: …
    Right now (counted by the app; may lag): about 15 min left; no agreed next step; Keith asked 2 questions in a row.
    </call_mode>
    ```
  - Line 0 and the "How lines work" rule are written once in `modeBlock`, so every mode gets them and Keith's edits can't drop them.
  - Returns `null` for `other`.
- **Wiring:** in `pressModes.ts pressUserMessage()`, insert the block after `contextText` and before the press block, in every branch, including the normal press (`buildUserMessage`). The **wrap branch returns early** through `wrap.ts wrapUserMessage()`, so that function takes a `mode` argument too: the mode's `wrap` sentence is added to `<wrap_card>` as `Aim for this call type: …`.
- **Press choice is type-aware in code, not left to prompt order.** Prompt precedence alone would let the generic presses override the mode exactly when it matters. `decidePress` gets the type:
  - **Negotiation:** a `pricing` signal returns a normal press (`mode: null`), so the pricing mode governs. `pilot`, `rollout` and `send_to_boss` keep the signal press. Otherwise, on almost every press after a price question, `signalBlock` says "If approved knowledge doesn't answer it, offer to follow up", which beats pricing mode's "recap value; Keith gives the number from their approved quote".
  - **Demo and technical_deep_dive:** `isOpening()` returns false once a tagged teammate has spoken 40 words or more. Today `isOpening` counts only non-teammate words, so a press at minute 3 while the SA presents gets `<opening_press>` ("set a short agenda").
  - **`signalBlock(detail, type)`:** its ASK/SAY rule line takes the mode's `signal` sentence when there is one (for example, in negotiation, for non-pricing signals: "never state a figure; Keith gives any number themselves from their approved quote"). FOLLOW per type is as in §2.
  - **`openingBlock(detail, type)`:** adds the mode's `opening` sentence (§2).
  - Unit tests in the `decidePress` suite cover both cases.
- **Order:** context → `<call_mode>` → press block (`<opening_press>`, `<next_step_press>`, `<another_angle>`, `<plan_press>`, `<wrap_card>`) → final instruction. The press blocks are now type-aware, so they agree with the mode by construction. Where a press block is narrower (the opening agenda, the next-step FOLLOW, the must-learn it's aiming at), it says what this press is for. The mode still decides who answers and what's never said.
- **System prompt:** one fixed sentence in `buildSystemPrompt`, after "Call types:". It names exactly which rules beat the mode:
  > "A <call_mode> block, when given, says what this call is for and which lines fit it. These rules always win over it: approved knowledge is the only Arize fact; never a price, discount or contract term unless approved knowledge states it; asked is not answered; nothing they haven't said. Within those, follow <call_mode>, including who answers a technical question."

  This settles the clash with `prompt.ts:92` ("answer directly when they asked a direct question that approved knowledge answers"). The new sentence says the mode decides *who* answers, so a demo hand-off to the SA isn't overridden. The sentence is the same on every call, so the cache is unchanged. The `call_types` one-liners stay.
- **Why the user message and not the system prompt:**
  - Only the active mode is seen, so rules from another mode can't bleed in (for example, discovery questions during a demo).
  - A stored request replays exactly.
  - The cached system prompt stays fixed within and across calls. (Playbook edits apply from the next call, because `startCall` reloads the playbook. Correction: rev 1 said "next press".)
- **Cost:** a unit test renders the demo and negotiation blocks and counts tokens; the cap above keeps each one at or under about 450 tokens. Rev 1's estimate of 250–350 was low. The speed test compares median first-usable time against a pre-M5 baseline taken once with the existing baseline feature, not with a paired A/B that doubles paid requests.
  - **Fallback if the median rises by more than about 100 ms:** move the five mode texts into the system prompt (cached), and send only `<call_mode type="demo">` plus the facts per press.

### 1.2 Mode facts: counted in code, not guessed by the model

`callModes.ts modeFacts(memory, atMs, type)` is a pure function over finished turns, plus one fact about live words. It knows who is who from `memory.fromTheirSide()` and labels with role `teammate`.

**The rule for phasing:** facts that don't depend on the teammate tag ship in v1. Facts that do depend on it are computed and logged in v1 but only drive lines in step 2 (§4), after a real two-person call shows the SA's cluster stays stable and separate from the buyer's.

| Fact | How | Bucketed as | Lines use it from |
|---|---|---|---|
| `minutes_left` | `length_min` (setup, else the type's default) minus elapsed session minutes | 5-minute steps; `>20`, `15`, `10`, `5`, `0` | v1 |
| `agreed_next_step` | Any `call_notes.next_steps` item with `status: 'agreed'` | boolean | v1 |
| `wrap_started` | Since `minutes_left` reached 10: a Keith turn that asks about next steps, timing or what stood out ("next step", "stood out", "from here", "before we run out", "book", "follow-up"), or the time-left card was already shown | boolean | v1 |
| `keith_q_since_playback` | Keith's question turns since the last play-back (below) | `<10` / `10–14` / `15+` | v1 |
| `keith_q_in_row` | Keith's question turns since the other side last spoke ≥ 8 words | 0–3+ | v1 |
| `keith_run` | Keith's talk since the other side's last turn of ≥ 5 words | `<30s` / `30–60s` / `60s–threshold` / `over_threshold` (`CHECKIN_SECONDS`, 75 s) | v1 |
| `keith_number_unanswered` | Keith's latest turn has a currency figure or a %, and the other side hasn't spoken since | boolean | v1 |
| `teammate_tagged` | Any label with role `teammate` | boolean | v1 (hand-off wording) |
| `sa_has_presented` | Teammate talk > 60 s this call | boolean | step 2 (v1 only for `isOpening`) |
| `sa_run` | Teammate talk since the other side's last finished turn of ≥ 5 words | relative to `CHECKIN_SECONDS` (75 s): `none` / `below` / `at_or_over` / `>120s` | step 2 |
| `sa_talking_now` | The live (interim) words on `system_remote` carry a cluster labelled `teammate` | boolean; **exact, not a guess** | step 2 |

- **Buckets follow Keith's settings.** The run buckets are computed in code against `CHECKIN_SECONDS` (75 s, Keith can change it later), and the bucket still changes only when a boundary is crossed (stable for prefetch reuse).
- **What counts as a question:** a Keith mic turn of at least 4 words that contains "?", after removing a trailing tag question ("right?", "make sense?", "you know?", "okay?", "yeah?", "correct?", "does that make sense?"). Deepgram's punctuation on tag questions would otherwise inflate the count.
- **What counts as a play-back (resets `keith_q_since_playback`):** a Keith turn of 30 s or more, **or** one containing "did I get that right", "did I miss anything", "anything I missed" or "is that a fair summary". The length test is the main one; the phrases catch short play-backs.
- **`sa_talking_now` is exact.** `session.ts` adds the cluster of the latest interim word to the `interim` event. `CallMemory.Interim` stores `cluster`, `interimsAsOf` returns it, and `replay.ts:161` passes the line's cluster. Rev 1's heuristic (the last finished turn was the SA's) is dropped: it read a buyer reacting right after the SA as the SA. An untagged or renumbered cluster reads as "not the SA", so the failure is a normal question card, never a Hold over the buyer.
- **`minutes_left` is session time from Start,** not from when the Zoom started. If Keith presses Start early, the cue comes early. The `length_min` override covers that. A 5-minute bucket keeps the facts stable for prefetch reuse.
- **Why buckets and finished turns:** prefetch reuse compares `JSON.stringify(pf.detail) === JSON.stringify(decision.detail)` (engine.ts:180). Raw seconds would differ every second, so the background card would never be served. `sa_talking_now` depends on interims, but a press with live words never uses the prefetch anyway (`liveSpeech`).
- **Stored for replay:** the facts go in `PressDetail.mode_facts` and `timing_json.mode_facts` (numbers and codes only), cleaned in `cleanPressDetail` / `savedPress`. Replay recomputes them with `modeFacts()` from the scenario, including `sa_talking_now` (replay has interims). Stored values are used only for saved practice moments. No SCHEMA change.
- **Facts go to HELP only, never to the screen.** The report is explicit: talk ratio doesn't separate wins from losses in demos, and numbers are "alarms, not targets" (*R §Demo, stays quiet about*; *R §Rules that hold on every call*).

### 1.3 The background card (prefetch)

- **Bug to fix first: `engine.ts snapshotKey()` doesn't include the setup.** After a type change mid-call, a press can be served a card built for the old mode. Add `call_type`, `length_min`, `no_sa`, and a short hash of goal and must-learns to the key. Also call `engine.discardPrefetch()` in `setSetup` when `call_type` or `call_goal` changes, following the existing `planChanged` pattern. (S)
- **Teammate talk burns the cap.** `engine.ts onFinalWords(stream, text)` starts a candidate after any `system_remote` final, including the SA's. In a demo the SA would use up the 4-a-minute cap (`PREFETCH_PER_MINUTE`).
  - Pass the turn's `cluster` from `helpService.ts:480`.
  - In `demo` and `technical_deep_dive`, skip teammate turns: a tagged teammate's final words cancel a pending timer the same way Keith's do. Untagged, it behaves as today. This is safe in v1.
  - `onSpeechEnd` is unchanged.
- The candidate is built through `decidePress` + `pressUserMessage`, so it carries the mode block and its facts automatically.

### 1.4 Hold cards (wait, with a question ready)

- **Today `no_move` has no rendering of its own.** The protocol still requires an ASK or SAY line.
- **The card shape (no protocol change):** `planBlock` already does this. A Hold card is:
  - `MOVE: no_move`
  - `ASK:` the question for the pause. This is still something Keith says.
  - `HAPPENING:` the hold reason, at most 12 words. It names the SA only when `sa_talking_now` is true ("Sam's mid-screen: ask at the pause"). Otherwise it says "Still talking: ask at the pause".
  - `FOLLOW:` "-".
- **Holds with nothing to ask yet** ("you've given the number"): ASK is the line for **after they answer or if the silence runs on**, for example "How does that land for you?". HAPPENING says to wait first.
- **Rendering:** the ready question is the one thing on the card Keith doesn't already have, so it stays at full weight.
  - `src/renderer/pressModes.ts` sets `#helpCard[data-move="no_move"]` from the **first partial** event. MOVE is the first protocol line, so the label is there before the ASK streams; the card doesn't restyle after Keith has started reading.
  - `styles.css`, following the `data-press` label pattern: the full card shows a small muted "Hold · at the pause" tag in `.hc-top`, with the ASK at full weight and HAPPENING in its usual place. In Compact, `.help-card[data-move="no_move"] .hc-primary .kind::before { content: "Hold · " }` puts the prefix before the undimmed ASK, so the strip reads "Hold · <ASK>".
  - The after-call review lists the card as "Hold". (S)
- **In v1** Holds come only from facts that don't need the teammate tag: pricing (`keith_number_unanswered`) and follow-up (recap done, question already asked). Demo Holds come in step 2.

### 1.5 Price check (every mode, strongest in pricing)

**This ships first, on its own (step 0).** It closes a gap in a locked rule that exists today, and it doesn't depend on modes.

- **The gap:** `protocol.ts unbackedNumbers()` flags only figures **not in the context**. If the buyer says "we'd need 20% off", a SAY line "We could do 20% if you sign annually" passes today.
- **`priceFigures(card, opts)` flags in ASK, SAY or FOLLOW:**
  - **Every mode:** currency amounts (`$40k`, `€12,000`, "40 thousand dollars", "40k a year" with a currency word); `\d+ ?% off`; `off (the )?(list|price)`; `discount of \d`; a figure within 3 words of `discount`, `price`, `cost`, `per seat`, `per user`.
  - **Not flagged on their own:** unit words like "per month", "a year", "rate", "commit", "off". "10 million traces a month", "90 days of history", "error rate under 2%", "kick off in 2 weeks", "we ship 4 times a year" and "the 3 goals we commit to" all pass.
  - **Negotiation only:** a bare `%`, and an offer shape with a figure: `\b(can|could|would|will) (we|I) (do|offer|give|go)\b[^?]*\d`. Deep-dive goals like "50% fewer regressions" don't trip it.
  - **Allowed:** a figure that appears in an approved knowledge item the card cites in SOURCES; an ASK that quotes **their own** figure back as a question ("What's driving the 20?"): the figure appears in a buyer-side turn in the last 30 s, and the line has no offer shape.
  - Anything else adds the check "Price or discount not from approved pricing: don't say it".
- **Inputs (a signature change, so `engine.ts` changes too):** `cardChecks(card, issues, opts)` gets `ctx.sources` with item text and kind, the buyer-side text of the last 30 s, and `memory.setup.call_type`, passed from `engine.ts:455`.
- **While streaming,** SOURCES hasn't arrived yet. `streamingChecks` runs the same patterns, but it can only use its existing `knowledgeInContext` flag: it warns early when a flagged figure appears and no approved item is in the context at all. The full "cited approved item" test runs in `cardChecks` on the finished card. It is a Level 1 failure in the speed test (`evalRunner.ts`).
- Keith chose **warn**: the card shows the yellow check "Price or discount not from approved pricing: don't say it".
- **Never knowledge:** per-deal quotes, discount floors and walk-away numbers never go in the knowledge folder. They could leak through screen-share or a recording (*R §Pricing, never shows*). The same goes for "What I know": HELP reads it (`<keith_notes>`) and could turn a "give" into a SAY line.

### 1.6 What Keith sees (all modes)

- **Setup strip (before the call):**
  - The type dropdown `#csType`. The label reads "Pricing" (§7); the internal key stays `negotiation`.
  - A goal **placeholder** per type (§2).
  - A small **length** select next to the type: "30 / 45 / 60 min", preset from the type's default. It's saved as `CallSetup.length_min`.
  - For demo and deep-dive, a **"No SA today"** checkbox, saved as `CallSetup.no_sa`. It's also offered on the step-2 reminder.
  - The Ideas row with the new starters (3 per type).
- **Saving the new setup fields:** `saveSetup` in `renderer.ts` sends only the form fields, and `helpService.setSetup` rebuilds the whole `CallSetup` from what it's sent. So `setSetup` **merges** the new optional fields (`length_min`, `no_sa`): a field that isn't sent keeps its current value, as `must_learn` already does. A test checks that a type change keeps the account, goal and `no_sa`.
- **During the call (Compact):**
  - **The SA reminder (step 2):** in a demo or deep-dive with no teammate tagged after 3 minutes of live time, the mode word reads "Demo · tag SA". It sits in the compact strip, because the speaker-labels area is hidden in Compact. Clicking it opens the labels in the expanded view, or offers **"No SA today"**. That sets `no_sa`, hides the reminder, and switches the demo check-in to Keith's own talk (§2.2). The reminder shows again when a new connection epoch starts, because cluster labels reset after a pause or reconnect (`KEITH_TEST_GUIDE.md:92`).
  - **The mode word and switch menu (step 2):** a small mode word next to HELP; click for a 6-item menu (§3).
  - Card labels are unchanged ("Opening", "Next step", "Must learn", "Wrapping up"), plus "Hold".
  - No meters, counters or timers.

---

## 2. The modes

The **ASK : SAY** ratios are rough targets for the mode text, for Keith to tune. The speed-test report counts them per type. In every mode, line 0 (answer or handle what they just asked, mode line in FOLLOW) and the "cues go in HAPPENING" rule come from `modeBlock` (§1.1) and are not repeated below.

### 2.1 Discovery: "suggest the next good question"

**Goal:** find out whether there's a real problem worth solving, what prompted the conversation and who else cares, and leave with the next meeting booked (*R §Discovery, goal in one line*).

**Setup**
- **Goal placeholder:** "Learn if there's a real problem, why now, who else cares; book the next meeting". Outcomes placeholder: "Their top problems in their words; next meeting booked". Default length 30 min.
- **Starters** (`mustLearnIdeas.ts STARTERS.discovery`; at most 3, in priority order; each ≤ 28 characters, neutral; from *R §Discovery, what must be learned on call one*):

| # | Starter | Chars | Topic tag | Replaces |
|---|---|---|---|---|
| 1 | what prompted the call | 22 | – | (kept) |
| 2 | how they check quality today | 28 | `current_tooling` | "how they test answers today" (question-bank wording) |
| 3 | who else has a view | 19 | `decision_process` | "who signs off". Formal sign-off usually comes later (*R §Discovery*). |

"Timeline to decide" is dropped from discovery. Alternatives (build, do nothing, another tool) come up through the ladder's "what they tried".

**HELP:** about 90% ASK, 10% SAY.
- **`lines` (first that applies, after line 0):**
  1. `minutes_left` ≤ 10, no `agreed_next_step`, and not `wrap_started` → SAY a short play-back of their problems in their words, then ASK to book the next meeting. HAPPENING: "~10 min left, no next step yet". Once the wrap has started, this line doesn't repeat: HAPPENING may carry "~N min left, no next step yet" while the lines below choose the ASK. (`agreed_next_step` lags the notes and may never flip on the call.) (*R §Discovery*: "With about 10 minutes left: play back their problems, then book the next step"; Gong 2018: close rates fell 71% when next steps never came up on a first call.)
  2. Keith has been describing the product (`keith_run` > 60 s) before two or three problems are on the table → HAPPENING "Hold the pitch"; ASK "How do you handle that today?" (*R §Discovery: copilot shows*)
  3. They just named a new issue → one layer deeper, in order: example → what happened → what they tried → what it meant → what good looks like. Only for issues **they** raised (the Sandler pain funnel, *R §Discovery evidence*). This beats line 4 even when the question count is high.
  4. `keith_q_since_playback` is `15+`, or `keith_q_in_row` ≥ 3 → SAY a short play-back of what they said, then ASK "Did I miss anything?". HAPPENING gives the reason ("Lots of questions: play it back"). Once Keith has played back, the count resets, so this doesn't repeat.
  5. An issue was mentioned but not explored → ASK for an example.
  6. A lull → Keith's open must-learn (the existing prompt rule).
- **`never`:**
  - feature or pitch lines
  - "teams like yours often find…" unless approved
  - feelings or pressure lines ("Is living with it still an option?")
  - telling them they have a problem
  - re-asking what was answered (*R §Discovery: what to avoid*)
- **SA presenting fallback (step 2):** once `sa_has_presented` and `sa_run` ≥ 60 s, don't fire discovery questions over the SA. Use the demo tie-back (§2.2) and Holds. This covers a discovery that turned into a demo without a switch.
- **Press modes:**
  - `opening`: the agenda line adds their agenda and makes "no fit is fine" explicit, an up-front contract (*R §Discovery flow step 1*).
  - `signal` with `pricing`: answer from approved knowledge or defer. FOLLOW asks how they fund tools like this ("How have you funded tools like this before?") in place of a meeting, because talking budget early goes with winning (*R §Pricing, timing note*; Gong 2020).
  - `signal` with pilot, rollout or send_to_boss: unchanged. `another_angle` and `plan_item`: unchanged.
- **Not in v1:** the executive variant ("fewer question prompts, share a short point of view"). It needs seniority on labels; see §5 L4.

**Notes** (v1 = today's notes; later = §5 L1): `problem` (their words, only what they raised), `impact` (their words and numbers), `why_now`, `alternative`.

**WRAP aim:** "Play back their problems in their words, then book the next meeting: date, who joins, what for. Offer to send the invite now." (*R §Discovery flow steps 6–7*). FOLLOW keeps today's behavior.

**Background card:** as today.

### 2.2 Demo: "dig into what lands, protect the next step"

**Goal:** show that the problems they named get easier, see what lands, go one level deeper on it, and leave with a dated next step (*R §Demo, goal in one line*).

**Roles:** the SA (a teammate-tagged speaker) drives the screen and answers "how". Keith runs the meeting, goes after the pain behind each reaction, and ties screens back to their words, one question per section.

**Setup**
- **Goal placeholder:** "Show their top problems getting easier; learn what lands; book a dated next step". Outcomes: "What landed and for whom; who else should see it; dated next step". Default length 60 min.
- **Starters** (*R §Demo, what must be learned*):

| # | Starter | Chars | Replaces |
|---|---|---|---|
| 1 | what landed for them | 20 | "which use case to show". That's prep, not something to learn on the call. |
| 2 | who else should see it | 22 | (kept) |
| 3 | how they'd judge it next | 24 | "what they need to see". Covers trial, POC or reference. |

**HELP:** ASK about 75%, SAY about 10% (hand-offs and parking), Hold about 15% (step 2).

**Before the SA has presented** (`sa_has_presented` false, or no teammate tagged): many demos open with 5–15 minutes of discovery refresh, which is when Keith wants to dig into pain. HELP uses discovery's one-layer-deeper ladder on what's changed and on their top problem. None of the "let Sam carry on" lines apply.

- **`lines` (first that applies, after line 0). The order follows *R §Demo, "shows the first line that applies"*. The fact each line needs is in brackets:**
  1. `minutes_left` ≤ 10, no `agreed_next_step`, and not `wrap_started` → ASK "Before we run out of time, what stood out most?"; HAPPENING "~10 min left, no next step yet". Fires once: after that, line 4 (their reaction) and the rest choose the ASK, with the time left in HAPPENING. [v1 facts] (*R §Demo* line 1; Gong: winning demos spent about 4 more minutes on next steps)
  2. The other side just raised an objection → ASK "What's behind that?" before the SA answers (Gong 2019: top performers answer objections with a question 54% of the time). [transcript]
  3. A deep technical question:
     - put to Keith, teammate tagged → SAY a hand-off ("Good one for Sam"). If the group is drifting, offer to take it offline with them and the SA (`call_control`).
     - put to the SA, or the SA is already answering → a Hold whose ASK is the business follow-up for after the SA answers ("What would that let your team do?"). In v1, without the Hold styling for demos, this is a normal ASK with HAPPENING "After Sam answers".
     - **Keith never answers it alone while a teammate is tagged, even with approved knowledge** (Keith's decision). [teammate_tagged]
  4. The buyer showed interest or reacted to the screen → go one deeper on the pain or impact behind it, using only words from their reaction: first "How does that compare to how you do it today?"; only after clear interest, "What would change for the team if you had this?" (`clarify_current_state` / `quantify_impact`; *R §Demo: question bank*). **This comes before any Hold:** a buyer reacting right after the SA is exactly the moment to dig. [transcript]
  5. `sa_talking_now` and `sa_run` is `below` → **Hold** (§1.4). ASK is the ready question tied to what's on screen and their words. HAPPENING: "Sam's mid-screen: ask at the pause". [step 2: sa_talking_now]
  6. `sa_run` at or over `CHECKIN_SECONDS` with no buyer turn → ASK a check-in at the next pause: "Is this close to how you do it today?" (Gong: no closed-won demo had more than 76 s of uninterrupted pitch.) With `no_sa`, the same line fires on `keith_run` over the threshold: Keith's own run is the pitch to break. [step 2: sa_run; `no_sa` + keith_run can ship in v1]
  7. A new screen started (SA words like "so here you can see") → tie back: "You mentioned [their words from this call or earlier_calls]: how do you handle that today?" Never from `<keith_notes>`. [transcript]
  8. Once `sa_has_presented`, Keith asked 2+ in a row (`keith_q_in_row` ≥ 2) → Hold. HAPPENING: "One question per section: let Sam carry on". ASK is the one question for the next pause. [step 2]
- **`never`:**
  - product facts or technical answers from Keith while the SA is on
  - assuming a pain they haven't stated ("Where does that bite today?")
  - price numbers
  - "would this make the shortlist?" pressure
  - ROI numbers
  - talk-ratio remarks
  - "open source" for Phoenix without naming its license (*R §Rules on every call*)
  - quoting a teammate's words as the buyer's ("they said" only for buyer-side turns)
- **No teammate tagged:** the block says roles are unknown. Line 3's hand-off becomes "if the transcript shows an Arize teammate presenting, hand technical questions to them", and lines 5, 6 and 8 don't apply. Lines 1, 2, 4 and 7 work from the transcript alone, so v1 is useful without the tag.
- **Press modes:**
  - `opening` (demo): recap discovery in their words in under two minutes, then "Did we get that right? Anything changed?" and "What would make today worth it?" (*R §Demo flow step 1*). When a teammate is tagged and they confirmed the recap, FOLLOW hands over in their words: "Sam, let's start with the eval gap you mentioned". The words come only from the transcript or `earlier_calls`, and the SA should show their top problem first (*R §Demo*). With `earlier_calls`, the recap picks up their words; without them, it asks.
  - The opening press stops once a tagged teammate has spoken 40+ words (§1.1).
  - `signal` with `pricing`: "a short, clear answer" only if approved knowledge has one, else defer. FOLLOW asks who should be in the pricing conversation.
  - `signal` with `pilot`: FOLLOW asks "What would you need to see to judge it?" before proposing a scoping call.
  - `plan_item`: when `sa_talking_now` (step 2), HAPPENING says "Sam's mid-screen: ask at the pause", the same pattern as today's "they're still talking".
  - `another_angle`: unchanged, and may answer with a Hold.

**Notes** (later, §5 L1): `reaction` (who reacted to what, quoted), `parked` (a question parked for the SA or for later, with the owner if said), `wants_to_see`, `eval_path`. The notes never label a reaction positive or negative.

**WRAP aim:** "Ask what stood out most, who else needs to see it, and book a dated next step (trial, POC or reference call) with names. Name any parked questions and who owes the answer." (*R §Demo flow step 5*). The existing `<buying_signal>` still feeds into it.

**Approved passage:** the source-first passage (`passage.ts`) still shows when the buyer's words match an approved section, even when the line is a hand-off. It's approved fact Keith can point the SA to. No change.

**Background card:** only after a buyer-side turn (§1.3). A demo Hold is never prefetched: with `sa_talking_now`, the press has live words and is fresh anyway.

### 2.3 Technical deep-dive / POC scoping: "track the plan"

**Goal:** check that Arize fits their real setup and decide together whether a formal test is worth doing. If yes, write down what pass means, who's involved and when they'll decide (*R §Deep-dive, goal in one line*).

**Roles:** the SA owns technical fit. Keith listens for three things: **needs that are really buying criteria, new names, and dates**.

**Setup**
- **Goal placeholder:** "Check fit; if a test is worth it, agree 1–3 written goals, owners, decision date". Outcomes: "Goals with baseline and target; owners; readout and decision date booked". Default length 60 min.
- **Starters** (*R §Deep-dive: copilot "track the plan"*; GitLab POV playbook). Your must-learns cover the key plan items; the rest is caught by lines 2 and 6 and by WRAP.

| # | Starter | Chars | Topic tag | Replaces |
|---|---|---|---|---|
| 1 | what pass looks like | 20 | `success_criteria` | "what a POC must prove". That presumed a POC; first decide whether one is needed. |
| 2 | who approves, by when | 21 | `decision_process` | – |
| 3 | who runs security review | 24 | – | "where data must stay" and "how they send traces today". Data location already comes up while deployment is "not sure" ("SaaS or self-hosted" idea); trace setup is the SA's to learn. |

**HELP:** ASK about 70%, SAY about 30% (hand-offs, read-backs).
- **`lines` (first that applies, after line 0):**
  1. A technical question with a teammate tagged → SAY a hand-off to the SA. Exception: what approved knowledge states directly (for example deployment options) may be answered with `technical_answer`, cited (§7).
  2. The buyer stated a hard need ("prompts can't leave our network") → HAPPENING "Requirement: note it"; ASK "Got it, a hard requirement. Who on your side reviews that?". Ask about the owner once per requirement: if the thread shows the owner was already asked or named, skip to the next line. This is a soft instruction, judged from the ~3-minute thread; there's no fact behind it.
  3. A new ask once goals are being agreed → ASK "Swap it for one of the goals, or park it for phase 2?"
  4. Something that sounds like Arize building their eval setup for free → HAPPENING "Sounds like extra work: check the goals"; ASK "Should we add that as a goal, or keep it for phase 2?"
  5. A goal was just agreed → ASK to tie it to the problem they named and get a baseline: "How do you measure that today?"
  6. A lull → the most important plan item not yet heard **in the transcript or notes**, asked as a check, not a gap: HAPPENING "Not yet heard: pass criteria"; ASK "At the end, what would you need to see to decide either way?". For a date or owner that may have come up earlier, outside what HELP can see: "Did we land on a readout date?" / "Who did we say owns the test?". Never "We still need X".
- **`never`:**
  - technical claims beyond approved knowledge
  - roadmap
  - dates on the SA's behalf, free work, paid-test terms
  - competitor descriptions from memory
  - "HIPAA certified"; the approved wording is "HIPAA-ready" (*R §Deep-dive: what to avoid*)
  - telling them how to rate their own requirement ("that's a must-have")
- **Press modes:**
  - `opening`: restate the business reason in their words, give the agenda and what we hope to leave with. With a teammate tagged, FOLLOW hands over in their words ("Sam, let's start with how you send traces today"), from the transcript or `earlier_calls` only. It stops after the SA has spoken 40+ words (§1.1).
  - `signal` with `pilot`: FOLLOW asks "What would you want a test to tell you that you don't know yet?" in place of booking.
  - `signal` with `pricing`: defer; FOLLOW asks who runs purchasing and whether to start it alongside the test.

**Notes** (later, §5 L1): `requirement`, `test_goal` (with baseline, target and measure as said), `owner`, `date` (end, midpoint, readout, decision, as said), `out_of_scope`.

**WRAP aim:** "Read back the goals, owners and dates that are in the transcript or notes, as said. For anything not seen, ask it as a check ('Did we land on a readout date?', 'Who did we say owns the test?'), never as 'we still need'. Then book the kickoff and the readout." HELP sees about 30 s word for word, about 3 minutes of thread, 3 search hits and at most 10 note facts, with no note kind for a readout date. A date agreed at minute 15 of 60 may not be in view, so a gap-shaped WRAP would re-ask in front of their engineers. The report's success line ("Today [baseline]. If by [end date] we see [target]…") may be used only with values actually in view.

**Background card:** after buyer-side turns only, as in a demo.

### 2.4 Pricing (`negotiation`): "restraint"

**Goal:** agree a deal both sides think is fair, with value agreed before numbers, trading rather than giving (*R §Pricing, goal in one line*).

**Setup**
- **Goal placeholder:** "Agree a fair deal: value first, trade don't give; path to signature with dates". Outcomes: "Path to signature with dates; nothing unapproved given". Default length 30 min.
- **Starters** (*R §Pricing, what must be learned*):

| # | Starter | Chars | Topic tag | Replaces |
|---|---|---|---|---|
| 1 | steps left to sign | 18 | `decision_process` | (kept) |
| 2 | volumes that drive cost | 23 | – | "who signs and how". That duplicates the first starter's topic. |
| 3 | how they fund tools | 19 | – | "start date they need". That presumed a deadline (*R §Pricing: no fake deadlines*). |

"What they compare against" isn't a starter. Line 4 handles a comparison when one comes up.

**HELP:** ASK about 60%, SAY about 40% (short, straight answers or defers). A price question in this mode gets a normal press under this block, not the generic signal press (§1.1).
- **`lines` (first that applies, after line 0):**
  1. They asked the price and value hasn't been recapped this call → SAY a value recap in their words (from the transcript or earlier_calls), then ASK whether it still holds. The number comes from Keith, from their approved quote, not from HELP. HAPPENING: "Recap first, then your number".
  2. `keith_number_unanswered` → Hold. HAPPENING: "You've given the number: let them answer". ASK, only if the silence runs on: "How does that land for you?" No long, engineered silence (*R §Pricing: what to avoid*).
  3. **Push-back, or a discount or term ask** (one line, in this order):
     - The reason isn't known yet → an honest label plus one question: "It sounds like the price is a sticking point. What's driving the 20?" (budget cap, competing quote, savings target). (Black Swan; labels are honest only.)
     - The reason is known → ASK a trade that names what they'd give, without promising anything: "What could you do on term or timing on your side?"
     - Anything off-standard → SAY "Let me take that to our deal desk." Never signal that a discount is on the table.
  4. A comparison → ASK what's in it: volume, retention, hosting, who runs it.
  5. A labelled speaker whose name includes procurement or purchasing (labels have no role for this; Keith types it in the name) → ASK "How will you judge whether this is a good outcome?" (*R §Pricing*: "works well with purchasing"). Ask early about blockers such as security review and legal.
  6. A lull → path to signature, asked: who reviews, which paper step comes next (security, legal, DPA, vendor setup, PO), and the date, as theirs.
- **`never`:**
  - any price, discount, percentage, unit rate or commitment size unless approved knowledge states it
  - promised terms (payment terms, caps, ramps, exit options, free months)
  - competitor prices
  - legal or security answers
  - urgency or end-of-quarter lines
  - "How am I supposed to do that?" offered unprompted (*R §Pricing: never shows*)
- **Press modes:** `signal` with `pricing` → a normal press (§1.1). Other signals keep the signal press, with the mode's `signal` sentence: "never state a figure; Keith gives any number themselves from their approved quote". `opening`: purpose and time ("walk through options and hear what works"), then the value recap.
- **Check:** the §1.5 price check is a Level 1 failure for all pricing scenarios.

**Notes** (later, §5 L1): `ask`, `offer` (who, and `proposed`/`agreed`, where proposed is not agreed), `paper_step` (with dates as said), `comparison`.

**WRAP aim:** "Confirm who reviews, the next paper step to signature and its date. Never a concession to get the meeting. If something was taken to the deal desk, say when Keith will come back."

**Background card:** as today, plus an early start on `speech_final` when the buyer's words carry a figure or a discount word.

### 2.5 Follow-up: "memory and momentum"

**Goal:** move the deal one clear step forward and leave with a dated next meeting with the right people in it (*R §Follow-up, goal in one line*).

**Setup**
- **Goal placeholder:** "Close owed items, hear what changed, move one thing forward". Outcomes: "Owed items closed or re-dated; dated next step with names". Default length 30 min.
- **Starters** (the account's own ideas, such as "status of …", already come first in `mustLearnIdeas()`):

| # | Starter | Chars | Replaces |
|---|---|---|---|
| 1 | what changed since last call | 28 | (kept) |
| 2 | who else has weighed in | 23 | (kept) |
| 3 | how they'd explain it inside | 28 | "next step and date". WRAP covers that. This is the champion test (*R §Follow-up: testing the champion*). |

**HELP:** ASK about 75%, SAY about 25%.
- **`lines` (first that applies, after line 0):**
  1. After Keith's recap (`keith_run` > 30 s), if the buyer hasn't spoken → ASK "What's changed on your side since we spoke?", HAPPENING "Recap done: ask, then let them talk". If Keith already asked it → Hold, with the same ASK kept for after they answer.
  2. Owed items in `earlier_calls` not yet closed on this call → ASK to close or re-date one ("Last time you were going to… did that happen?"). Asked, never stated as done.
  3. A group call → ASK a named person what they thought, not "Any questions?" (labelled names only).
  4. "We need to think about it" after they liked it → name it gently: "My sense is something still feels uncertain. Is that fair?" Then: too many options → one recommendation; more homework → one specific thing; fear of blame → a smaller first step (JOLT, *R §Follow-up: two kinds of stall*).
  5. "Not a priority right now" → back to their problem: "What would need to happen for this to move up?" Accept "not now". No discount.
  6. Late stage → "Who signs, and what's the path from here?"
- **`never`:**
  - re-pitch lines
  - product facts unless asked
  - any concession (pilot, opt-out, ramp, discount)
  - urgency lines
  - re-asking answered questions; show "already known" in HAPPENING instead
  - claims about what they said unless the notes or earlier_calls have it
- **Press modes:** `opening` already picks up from `earlier_calls` (`openingBlock`, `pickUp`). Add from `call_modes.follow_up.opening`: "Then stop and ask what's changed." `signal` is unchanged.

**Notes** (later, §5 L1): `changed`, `owed_update`.

**WRAP aim:** "Summary in one line, owed items each closed or re-dated, a dated next step with named people. Offer to send the invite now." (*R §Follow-up flow step 6*).

**Background card:** as today.

### 2.6 Other

No mode block. HELP behaves exactly as today (`call_types.other`). The starter stays "what they want from today".

---

## 3. Picking the mode, and a call that changes type

**Before the call:**
- Keith picks the type in `#csType`. M4's auto-fill still proposes `next_call_type`.
- Changing the type refreshes the Ideas row (already wired), the goal/outcomes **placeholders**, and the length preset (unless Keith changed it).
- Placeholder only; a click never fills the goal (§7).

**During the call:**
- **v1:** the strip can already change mid-call, and "the next HELP press uses it" (`docs/KEITH_TEST_GUIDE.md:86`), but only in the expanded view. That stays the v1 route.
- **Step 2:** the mode word in the compact strip; a click opens a 6-item menu. A choice **sets the hidden `#csType` and fires its existing change handler**, which saves the whole setup. It never sends `{call_type}` alone: `setSetup` rebuilds `CallSetup` from what it's sent, so a lone type would blank the goal, outcomes and account, and an account changing to `''` drops HELP's earlier calls.
- **What changes on a switch:**
  1. `snapshotKey` and `discardPrefetch` drop the old background card (§1.3).
  2. The next press and the next notes update use the new type.
  3. Must-learns and their statuses stay; they're Keith's plan.
  4. Notes keep everything. Once mode notes exist (L1), items of every kind are kept across a switch.
  5. HelpService logs `call_type_changed {from, to, at_min}` and appends `{type, at_ms}` to a per-session `type_history`.
- **Without a switch (step 2):** discovery and follow-up don't fire questions over a teammate who has presented for 60 s or more; they use the demo tie-back and Hold. So a discovery that drifts into a demo degrades gracefully.
- **After Stop:** the wrap-up and follow-up draft use the type at Stop, with "Discovery → Demo" in the header when `type_history` has more than one type. `nextCallType()` is unchanged. Practice moments store the type at the press, so they replay in their own mode.
- **Never** switches by itself. A quiet "sounds like a demo now" chip is a later option (§5 L2).

---

## 4. Build order

### Step 0: the price check, on its own (2–3 days)

| # | Item | Files / functions | Effort |
|---|---|---|---|
| 0.1 | `priceFigures` (§1.5) with the narrowed patterns; `cardChecks` and `streamingChecks` get sources with text, recent buyer text and the call type | `protocol.ts`; `engine.ts:455` (call site) | S |
| 0.2 | Level 1 failure in the speed test; must-flag / must-pass unit tests (§6) | `evalRunner.ts`, `tests/` | S |

### v1: the modes (about 2 weeks)

| # | Item | Files / functions | Effort |
|---|---|---|---|
| 1 | `call_modes` defaults for 5 types (§2) + validation (`<>` rejected, size cap) + one fixed system sentence | `config/playbook.json`, `prompt.ts` (`Playbook`, `playbookProblem`, `buildSystemPrompt`) | M |
| 2 | Per-type fallback to the built-in `call_modes`; `call_modes_from` in `PlaybookInfo` and the playbook panel | `helpService.ts loadPlaybook`, playbook panel in renderer | S |
| 3 | `<call_mode>` block (line 0, cues-in-HAPPENING rule, sanitised) on every press, prefetch and WRAP | new `callModes.ts modeBlock`; `pressModes.ts pressUserMessage`; `wrap.ts wrapUserMessage` | M |
| 4 | Type-aware presses: `decidePress` (negotiation pricing → normal; demo/deep-dive `isOpening` stops after 40 SA words), `openingBlock` per type (incl. the SA hand-off), `signalBlock` per type | `pressModes.ts` | S–M |
| 5 | v1 mode facts (`minutes_left`, `agreed_next_step`, `wrap_started`, `keith_q_since_playback`, `keith_q_in_row`, `keith_run`, `keith_number_unanswered`, `teammate_tagged`), stored for replay | `callModes.ts modeFacts`; `PressDetail.mode_facts`, `cleanPressDetail`, `savedPress`; `engine.ts persist` | M |
| 6 | Interim speaker plumbing: cluster on the `interim` event, `Interim.cluster`, `interimsAsOf`, replay. SA facts computed and logged, not yet used by lines | `session.ts:713`, `callMemory.ts`, `helpService.ts:486`, `replay.ts:161` | S |
| 7 | Setup: `length_min` select (+ type defaults), "No SA today" checkbox (`no_sa`), both merged in `setSetup`; placeholders per type | `shared/help.ts CallSetup`, `helpService.setSetup`, `renderer.ts`, `index.html` | S |
| 8 | Prefetch: setup in `snapshotKey`, `discardPrefetch` on type/goal change, tagged-teammate turns don't trigger in demo/deep-dive | `engine.ts snapshotKey`, `onFinalWords(stream, text, cluster)`; `helpService.ts:480` | S |
| 9 | New starters, 3 per type in priority order (§2) | `mustLearnIdeas.ts STARTERS` (and the M4_PLAN list, guide text) | S |
| 10 | Hold card shape and rendering (`data-move` from the first partial, "Hold ·" label, ASK at full weight); used in v1 by pricing and follow-up | `src/renderer/pressModes.ts`, `styles.css`, after-call review label | S |
| 12 | MOCK answers in mode (reads `<call_mode type=…>`: e.g. `ASK: [MOCK · demo] How does that compare to how you do it today?`; a pricing Hold when `keith_number_unanswered`) | `models.ts mockPress` | S |
| 13 | Scenarios (§6) + "By call type" report table | `evals/scenarios/help/mode-*.json`, `evalRunner.ts` | M |
| 14 | Docs | `docs/M5_PLAN.md`, `DECISIONS.md` once Keith approves, `KEITH_TEST_GUIDE.md` section | S |

**Total: about 2 weeks for one engineer after step 0.** Items 1, 3, 4, 5 and 13 are the core; the rest are small and independent.

### Gate: one real two-person demo call (Keith + SA, or a test Zoom)

Check, from the saved call and the speaker labels:
- the SA's cluster stays one cluster and doesn't merge with a buyer's;
- how often a pause or reconnect renumbers clusters (`e<epoch>:s<n>`) mid-demo;
- whether `sa_talking_now` (logged as a code at each press in v1) matched who was really talking.

If the SA's cluster isn't reliable, step 2's Hold and check-in lines stay off, and demo mode keeps its v1 lines, which work from the transcript.

### Step 2: SA-aware demo, and switching in Compact (about 1 week)

| # | Item | Files / functions | Effort |
|---|---|---|---|
| 15 | Demo lines 5, 6, 8 and the deep-dive/discovery SA fallback switched on (`sa_talking_now`, `sa_run`, `sa_has_presented` used in `modeBlock`) | `callModes.ts`, `config/playbook.json` | S |
| 16 | "Demo · tag SA" reminder on the mode word, "No SA today", shown again on each new epoch | `compact.ts`, renderer labels, `helpService.ts` (epoch event) | S |
| 17 | Mode word + switch menu in the compact strip (through `#csType`'s change handler), `call_type_changed` log, `type_history` | `compact.ts`, `helpService.ts`, `db.ts` | S–M |
| 18 | Demo scenarios with a teammate mid-screen promoted to Level 1 | `evals/scenarios/help/` | S |

## 5. Later steps (optional)

| # | Step | What | Effort |
|---|---|---|---|
| L1 | **Mode notes** | One `mode_items: Array<CallNoteItem & {kind, status?}>` field in `CallNotes`. `kind` is a union across all types: `problem, impact, why_now, alternative, reaction, parked, wants_to_see, eval_path, requirement, test_goal, owner, date, out_of_scope, ask, offer, paper_step, comparison, changed, owed_update`. `NOTES_SYSTEM_PROMPT` (cached, so it stays identical across calls) describes the kinds for all types once, and says to add only those for the `call_setup` type. `validateNotes` keeps items of any kind (a switch must not drop discovery problems), caps at 8, requires citations, and keeps `offer` as `proposed` unless accepted. `callNotesBlock` gives them about 200 characters after the plan. The notes panel adds one section per type. Then the deep-dive WRAP can read back owners and dates from the notes rather than asking. | L |
| L2 | **Quiet switch hint** | A teammate spoke over 60% of the last 5 minutes while the type is discovery or follow-up → a grey chip by the mode word: "SA presenting · Demo?" One click switches. Never automatic. Needs step 2. | M |
| L3 | **Better call length** | Read the planned length from the calendar invite, if a calendar is ever connected; start the clock at the first buyer word rather than at Start. | S–M |
| L4 | **Senior people** | A title on labels ("VP", "Head of"). The discovery executive variant. Demo "invite [name] in" once per call, when a labelled senior buyer hasn't spoken for 10+ minutes. A purchasing role, so pricing line 5 doesn't depend on the name. | M |
| L5 | **Per-type "not covered" topics** | Deep-dive: decision date, approving exec, readout booked. Pricing: path to signature. These feed "Learn next time" and Ideas. | M |
| L6 | **After-call mode review** | A per-type scorecard: must-learns left empty, Holds, passes, price-check hits, whether a dated next step was booked (from the wrap-up `agreed`). Counts only (*R §Conclusion*: "rate each call against its mode"). | S–M |
| L7 | **Per-type follow-up draft shapes** | Deep-dive → the test-plan read-back. Demo → parked questions with owners. Pricing → paper steps with dates. | M |

Suggested order: L1, then L6.

---

## 6. Testing offline

**Unit tests (vitest, `tests/`):**
- `modeFacts`:
  - SA 3 turns / 80 s with no buyer, threshold 75 s → `sa_run` `at_or_over`; threshold 90 s → `below`; a buyer "mm-hmm" (< 5 words) doesn't reset it.
  - An unlabelled remote speaker counts as their side, never as the SA.
  - `sa_talking_now`: live words with a teammate cluster → true; a buyer reacting right after an SA turn (buyer cluster on the interim) → false.
  - 16 Keith question turns → `15+`; then a 35 s Keith turn → `<10` (the reset); a short "did I miss anything?" turn also resets.
  - "Right?", "make sense?" and 3-word questions don't count.
  - `minutes_left`: demo default 60, atMs 51 min → `10`; `length_min` 30 overrides.
  - `agreed_next_step`: a `proposed` next step → false; `agreed` → true.
  - `wrap_started`: false at minute 35 of 45; true after a Keith "what stood out most?" turn, so the time-left line doesn't repeat.
  - A Keith number then a buyer reply → `keith_number_unanswered` false.
  - Bucket stability: same turns, any second within the same 5 minutes → same facts.
- `modeBlock`:
  - One block per type; null for `other`.
  - Keith's playbook without `call_modes` still gets the built-in demo block; `call_modes_from` reads `built_in`.
  - A mode string with `<wrap_card>` in it comes out without `<>`; `playbookProblem` rejects it.
  - Line 0 and the cues-in-HAPPENING rule are present in every type's block.
  - Rendered demo and negotiation blocks stay under the token cap.
  - Order inside `pressUserMessage`: context → `<call_mode>` → press block → final line, for all branches **including wrap**.
- `decidePress`:
  - Negotiation + a pricing signal → `mode: null`; negotiation + pilot signal → `signal`.
  - Demo at minute 3, buyer < 40 words, tagged SA 60 words → not `opening`. Untagged → `opening` as today.
- `engine`:
  - A type change makes `snapshotKey` differ and discards the candidate.
  - In demo, a tagged teammate's final words don't start a candidate; a buyer's do.
  - The prefetch built with facts is served when the turns are unchanged.
- `setSetup`: a type change keeps the account, goal, outcomes, `length_min` and `no_sa`.
- `STARTERS`: at most 3 per type; every starter ≤ 28 characters; none matches `/\b(pain|struggl|problem with|issue with|urgent|deadline|asap|frustrat|broken)\b/i`; no duplicate topic tags within a type.
- `priceFigures`:
  - **Must flag:** "We can do 20% if you sign annually" (negotiation, buyer said 20%); "$40k a year"; "about 15% off"; "a discount of 10"; "We could do 20 if you sign today" (negotiation, offer shape).
  - **Must pass:** "What's driving the 20?" (their figure, as a question); a figure from a cited approved item; "So about 10 million traces a month, 90 days of history?"; "error rate under 2%" (deep-dive); "50% fewer regressions" (deep-dive goal); "kick off in 2 weeks"; "we ship 4 times a year"; "the 3 goals we commit to"; "two weeks".
- `playbookProblem`: accepts a good `call_modes`; rejects an unknown type name, a non-string line, `<` or `>`, or an over-long mode.
- `savedPress` / `cleanPressDetail`: round-trip `mode_facts`.

**Practice mode (no key, MOCK):**
1. Start a call with each type and press HELP. The card reads `[MOCK · <type>]`, which proves the block reached the request. With an older playbook copy in userData, it still does (built-in fallback), and the playbook panel says "Call modes: built-in".
2. Change the type in the expanded strip mid-call. The next card's tag follows; the goal and account stay.
3. Check that the Ideas row shows 3 starters per type, the goal placeholder and length preset change with the type.
4. Step 2: switch from the compact mode word; tag a speaker as teammate and play a recorded SA demo through the speakers, pressing while that speaker is mid-sentence → a Hold card with the ready question at full weight. The offline route is the MOCK speed test on `mode-demo-01-sa-mid-screen` (replay sets the interim with its cluster, so the fact is recomputed and deterministic). Optional, S: a dev-only "play scenario as a live call" command.

**Speed test** (Diagnostics → Run HELP speed test): new draft scenarios, `golden_approved: false`, for Keith to review in `docs/SCENARIO_REVIEW.md`. Today's set has demo 5 and negotiation 3, too thin for per-mode results. Each needs `speakers` with role `teammate` where an SA is meant (SCHEMA already supports it). Facts are recomputed from the replayed `CallMemory`; no SCHEMA change.

| id | type | Setup in the transcript | best / acceptable moves | Level 1 extras |
|---|---|---|---|---|
| `mode-disco-01-pitching-early` | discovery | Keith talks 70 s about features; one problem heard | `clarify_current_state` / `explore_process` | unacceptable: pitch line; "Hold the pitch" in ASK |
| `mode-disco-02-fifteen-questions` | discovery | 16 Keith questions since any play-back, 3 problems named, last turn not a new issue | `call_control` (play-back) / `confirm_next_step` | unacceptable: another new question |
| `mode-disco-03-new-issue-after-many` | discovery | 16 questions, then buyer: "releases are slow since we added agents" | `clarify_current_state` (example) / `quantify_impact` | unacceptable: play-back; assumes impact |
| `mode-disco-04-ten-min-left` | discovery | minute 21 of 30, no agreed next step | `confirm_next_step` / `call_control` | unacceptable: another discovery question |
| `mode-disco-05-direct-question` | discovery | buyer: "Do you support OpenTelemetry?" (approved item exists) | `technical_answer` / – | unacceptable: a counter-question |
| `mode-demo-01-sa-mid-screen` | demo | `e1:s1` role `teammate` "Sam (SA)" 50 s and still talking (interim, teammate cluster) | `no_move` / – | step 2 only; unacceptable: a question interrupting Sam |
| `mode-demo-02-reaction-go-deeper` | demo | SA turn, then buyer (interim, buyer cluster): "oh, that trace view is what we've been hacking together" | `clarify_current_state` / `quantify_impact` | unacceptable: Hold; feature list; "where does that bite" |
| `mode-demo-03-tech-question-to-keith` | demo | Buyer asks Keith about span propagation; Sam tagged; approved item exists | `call_control` (hand-off) / `technical_clarification` | unacceptable: Keith answers it alone |
| `mode-demo-04-objection` | demo | "We'd never send prompts to a SaaS" | `handle_objection` (ask what's behind it) | unacceptable: rebuttal before the question |
| `mode-demo-05-refresh-before-sa` | demo | minute 4, Sam tagged but silent, Keith has asked 2 in a row about what changed | `clarify_current_state` / `quantify_impact` | unacceptable: "let Sam carry on" |
| `mode-demo-06-non-tech-question` | demo | buyer: "Can PMs see these dashboards?" | answers or hands off / – | unacceptable: counter-question first |
| `mode-demo-07-wrap-already-started` | demo | minute 38 of 45, Keith asked "what stood out most?", buyer reacting to a screen | `quantify_impact` / `confirm_next_step` | unacceptable: the time-left question again |
| `mode-dive-01-new-ask` | technical_deep_dive | Goals agreed; buyer adds "and cost tracking too" | `clarify_requirement` / `call_control` | unacceptable: accepts scope |
| `mode-dive-02-requirement` | technical_deep_dive | "Prompts can't leave our VPC" | `clarify_requirement` / `identify_owner` | unacceptable: states self-hosted facts unapproved; "that's a must-have" |
| `mode-dive-03-readout-said-earlier` | technical_deep_dive | Readout date agreed 20 min before WRAP; out of the 3-minute thread | WRAP | unacceptable: "we still need a readout date" |
| `mode-dive-04-onboarding-question` | technical_deep_dive | buyer: "What does onboarding look like?" | answers or defers / – | unacceptable: counter-question first |
| `mode-price-01-discount-ask` | negotiation | "We'd need 20% off to get this through" | `handle_objection` / `clarify_decision` | `forbid_regex`: `\b(can|could|would|will) (we|I) (do|offer|give|go)\b[^?]*\d`, `\$\s?\d`, `\bdiscount of\b` |
| `mode-price-02-keith-gave-number` | negotiation | Keith states a number from the approved quote; silence | `no_move` / – | unacceptable: lowers the number |
| `mode-price-03-comparison` | negotiation | "Langfuse is free to self-host" | `handle_competitor` / `clarify_scale` | unacceptable: competitor price from memory |
| `mode-price-04-volume-recap` | negotiation | buyer gives volumes and retention | `clarify_scale` / – | price check must not fire on "10 million traces a month" |
| `mode-follow-01-recap-then-stop` | follow_up | Keith recaps 40 s; buyer silent | `clarify_current_state` (what changed) / `no_move` | unacceptable: re-pitch |
| `mode-follow-02-think-about-it` | follow_up | "We liked it, we need to think about it" | `handle_objection` / `clarify_decision` | unacceptable: urgency, discount |
| `mode-follow-03-direct-question` | follow_up | buyer: "Did you get the security doc over?" | answers / – | unacceptable: "What's changed on your side?" first |

- **Report:** `evalRunner.ts` adds a "By call type" table (Level 1 pass, move agreement on drafts, the ASK/SAY/Hold split, price-check hits, median first-usable line), compared against a pre-M5 baseline taken once. No paired with/without run.
- **Saved practice moments** replay with their stored type and facts, in the same per-type table under "Your moments" (never deciding the model).

---

## 7. Other settings (defaults chosen; change any later)

1. **Starter wording** for each type (§2 tables, 3 per type, at most 28 characters). Replace any you don't like.
2. **Type label:** "Pricing" (default) or "Negotiation". The internal name stays `negotiation`.
3. **Goal templates:** placeholder only (default), or a click that fills an empty goal and outcomes.
4. **Hold cards:** on (default), or always a plain question with "wait for the pause" in HAPPENING.
5. **Deep-dive technical answers with the SA on:** approved-knowledge answers such as deployment options allowed (default yes).
6. **Discovery pacing:** the play-back cue at 15 questions since the last play-back (default), and "Hold the pitch" after 60 s of Keith describing the product.
7. **Approval:** approve the new draft scenarios in `docs/SCENARIO_REVIEW.md`. Only approved ones decide anything.
8. **Later steps:** which of L1–L7 to do, and in what order.

---

## What changed from revision 1

- **Taken from the top-AE review:** exact SA detection from interim speaker ids, replacing the heuristic, and the buyer's reaction now comes before any Hold (§1.2, §2.2). Play-back counted since the last play-back, ignoring tag questions and short turns, at 15, and a new issue beats it (§1.2, §2.1). Cues moved to HAPPENING in every mode, with the examples rewritten (§1.1, §2). Line 0 ("answer what they asked first") in every mode, plus a direct-question scenario per mode (§1.1, §6). Demo lines gated on `sa_has_presented`, and "No SA today" (§2.2, §1.6). A minimal time-left cue in v1 (§1.2, §2.1, §2.2). Deep-dive WRAP and line 6 asked as checks, not gaps (§2.3). Narrowed price check (§1.5). The discount sequence (why, then trade, then deal desk) and the purchasing line (§2.4). The AE-to-SA hand-off in openings, and the business follow-up when the SA answers (§2.2, §2.3). The bank's neutral demo questions, and the Hold card keeping its ASK at full weight (§2.2, §1.4). Three starters per type, and the corrected pricing-signal claim (§2).
- **Taken from the app-fit review:** type-aware `decidePress`, `isOpening` and `signalBlock` in code (§1.1). Per-type built-in fallback for `call_modes` and `call_modes_from` (§1.1). Compact visibility for the Hold label and the SA reminder, and `data-move` set from the first partial (§1.4, §1.6). The diarization gate before the SA-driven lines (§4). An exact list of the rules that win in the system sentence (§1.1). `cardChecks` inputs, and the `mode-price-01` regex (§1.5, §6). The switch through `#csType`'s handler, plus `discardPrefetch` (§3, §1.3). Corrected code facts: interim speaker ids, replay interims, playbook edits applying from the next call (§0, §1.1, §1.2). Measured token cap, and a baseline comparison instead of a paired A/B (§1.1, §6). Sanitising of playbook text (§1.1). Step 0 for the price check, and a smaller v1 (§4).

## Not taken

- **Dimming the ASK on a Hold card in Compact (app-fit).** The ready question is the one thing on the card Keith doesn't already have, so it stays at full weight. The "Hold ·" prefix and the `data-move`-from-first-partial mechanism are taken.
- **Moving every mode fact to v1.5 (app-fit).** Only the facts that depend on the teammate tag wait for the diarization gate. The time-left, play-back, Keith-run and number-unanswered facts don't depend on diarization and carry v1 lines Keith needs: protecting the next step, and pricing restraint.
- **Bringing deep-dive mode notes (L1) into v1 (top-AE option A).** That's the largest item here (a notes schema, a cached-prompt change, a panel section). The checks-not-gaps wording (top-AE option B) removes the re-asking failure at a fraction of the cost. L1 stays first among the later steps.
- **`keith_questions_since_long_turn` alone (app-fit's playback reset).** Taken as the main reset, but combined with top-AE's play-back phrases so a short play-back also counts.
- **Raising `STARTERS_MAX` for deep-dive only (top-AE alternative).** It would push out the account's own ideas within the 4-idea cap. Swapping "where data must stay" for "who runs security review" is enough, because data location already comes up while deployment is "not sure".
- **"Per month / per year / per span / per trace" as price words (app-fit's narrowed list).** Top-AE's narrower list is taken: unit words alone don't flag, so volume recaps pass. A real price with a currency is still caught by the currency pattern.
- **A stored-`mode_facts` SCHEMA field for scenarios (rev 1).** Replay already produces interims, and with the cluster on them the facts are recomputed. Dropped.
- **The playback "warning" read as a hard cap at 12 (rev 1).** Replaced. The report reads Gong's numbers as a warning sign, not a target.
