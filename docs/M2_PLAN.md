# M2: nothing slips between calls

Keith's picks from the strategy review: wrap-up after Stop with a follow-up draft, account memory,
"before you hang up", shorter lines, and a compact window, plus the two fixes they depend on (the
closing notes pass at Stop and showing card checks while the line streams). No CRM, talk timer or
qualification scorecard.

Locked decisions still hold: nothing is sent or published automatically (the follow-up is a draft
Keith copies); no proactive pop-up cards; HELP stays manual and immediate; asked is not answered and
proposed is not agreed; only approved knowledge is stated as Arize fact. Keith approved these UI
changes (the live UI was otherwise frozen).

Shared contracts (already in the code): `WrapupItem`, `CallWrapup`, `FollowupDraft`, `WRAPUP_SECTIONS`,
`AccountMemory`, `accountKey()` in `src/shared/help.ts`; the `call_wrapups` table in `src/main/db.ts`
(deleted with the call in `src/main/retention.ts`); `HelpOrigin` `'wrap_requested'`; the notes status
`'finishing'`; the optional playbook `card_limits.technical_max_words`.

## 1. Closing notes pass at Stop (fix)

Today Stop cancels a notes update in flight and saves with no final pass, and updates are spaced
3 minutes apart, so the last minutes of a call (when next steps and promises are made) are the part
the notes most often miss.

- `CallNotesKeeper`: Stop no longer cancels an update in flight. At `stopping` the keeper stops
  scheduling new regular updates (`beginFinish()`); at `stopped` (after the transcript's last finals
  have arrived) `finish(): Promise<void>` sets status `finishing`, waits for any update in flight,
  then runs closing updates over ALL queued lines, ignoring the minimum-speech threshold and the
  spacing, until nothing is queued (at most 3 passes, 90 s in all). Then `stopped`, persist, emit.
- Not run when notes are off, blocked (key/credit/model access) or the call is deleted meanwhile
  (`dispose()` aborts). Pause behaves as today.
- Stats gain `closing` (closing passes run). Logs: counts, timings, codes only, never note text.

## 2. Wrap-up after Stop + follow-up draft (feature 1)

After the closing notes pass, one background request builds the wrap-up for the call that just ended.

- `src/main/help/wrapup.ts`: `WRAPUP_SCHEMA` (structured output), a stable cached system prompt
  (over 512 tokens so Sonnet caches it), `wrapupUserMessage()` and `validateWrapup()`.
  - Input: call setup, the final call notes, and the finished transcript with line ids `[L1]...`
    (oldest first; if over 60,000 characters, the last 60,000 characters, with the notes covering the
    earlier part), speaker names as HELP shows them.
  - Sections: `we_owe` (things Keith or an Arize teammate said they would do or send), `they_owe`
    (things the buyer's side said they would do), `agreed` (next steps the buyer's side accepted, with
    who/when only if said), `proposed` (suggested but not accepted), `open_questions` (buyer
    questions not answered on the call). Never invented: an item citing no line that was sent is
    dropped; at most 6 per section; text at most 160 characters.
  - The quote shown is taken from the transcript itself (first cited turn, trimmed to about 120
    characters at a word), never from the model.
  - Sent through `HelpModel.notes()` (the structured-output path, no fallbacks), max_tokens 3000,
    timeout 45 s. Practice mode (MOCK model) builds a deterministic wrap-up from the final notes.
- Stored in `call_wrapups` (`CallWrapup` JSON, numbers-only `stats_json`); deleting the call deletes it.
- Setting "Wrap-up after each call" (Setup step 3, on by default). Works with call notes off (the
  transcript alone).
- Keith's view: a "Wrap-up" window opens by itself after Stop ("Finishing notes and wrap-up…" while
  it builds). Five short sections; each item has a tick (confirm), editable text, the quote with its
  call time, and remove. "+ Add" per section. Buttons: "Draft follow-up email", "Review cards" (the
  existing review), "Done". A "Wrap-up" button stays in the call controls after Stop to reopen it.
- `src/main/help/followup.ts`: the follow-up draft, made only when Keith clicks "Draft follow-up email".
  - Input: confirmed items (or every item not removed, when none is confirmed), call setup, buyer
    names from speaker labels, up to 3 of "what they want" from the notes, and approved knowledge:
    each open question and promise is searched in the approved, current, in-scope knowledge; up to 5
    sections, labelled K1..K5 with whose product they describe.
  - Rules: under about 180 words; plain and human; thanks in one line; what Keith heard in their
    words (2-3 bullets); the agreed next step with who/when; what Keith will send; answers to their
    questions ONLY from a K section (keeping its qualifiers), otherwise "I'll come back to you on X";
    what they said they'd do, gently; no pricing, discount, contract or roadmap promises; sign-off
    "Keith". Output `{subject, body, sources}`.
  - Checks: numbers not in the inputs, and Arize capability claims with no K source, become plain
    "check before sending" warnings (reuse `numbersIn` and `findCapabilityClaim` from protocol.ts).
  - Shown in an editable box with "Copy". Nothing is sent.
- The per-call scorecard counts wrap-up items per section, confirmed/removed/added counts, and the
  wrap-up and draft cost (never text).

## 3. Account memory (feature 2)

- `src/main/help/accountMemory.ts`:
  - `listAccounts(db)`: the accounts of saved calls (from `sessions.setup_json`), grouped by
    `accountKey`, shown as last typed, newest first, with call count and last call date.
  - `accountMemory(db, account, excludeSessionId?)`: from the last 3 calls with that account, newest
    first: wrap-up items not removed (`we_owe` -> promised, `they_owe`, `agreed`, `open_questions` and
    `proposed` -> still open) and from the notes "what they want" (up to 3) and facts about their
    tooling, team, timeline and decision process (up to 4). Deduplicated, dated, at most 12 items.
- Call screen, setup strip: the account box suggests earlier accounts. When the account matches one,
  a "Last time with <Account> · <date> (<n> calls)" box shows: You promised / They owe / Agreed next
  step / Still open / They want / What they told us. "Reuse last setup" copies the last call's goal,
  outcomes and deployment, with call type Follow-up. Open before Start; collapsed to a one-line chip
  during the call.
- HELP: an `<earlier_calls>` block (at most about 700 characters, dated items, newest call first)
  when the call's account has memory, computed once at call start (excluding this call). Prompt rule:
  these are past statements; Keith can refer to them ("Last time you mentioned X, is that still the
  priority?") but they are never stated as current fact. Call notes don't read it.

## 4. Before you hang up (feature 3)

- A WRAP button next to HELP, and the hotkey Ctrl+Alt+W. It asks for a wrap card: one SAY/ASK line
  that locks a concrete next step (what, who attends, a date or time), building on anything already
  agreed (the notes' next steps); FOLLOW lists what Keith still owes them, if anything; MOVE is
  `confirm_next_step` (`call_control` only if they are mid-thought). Origin `wrap_requested`, always a
  fresh request (never a background candidate). The card is labelled "Wrapping up".
- A HELP press while the last 30 s contain closing language ("we're out of time", "hard stop",
  "I have to jump", "let you go", "top of the hour", "before we wrap", "next steps") gets the wrap
  instruction too (and skips the background candidate). No pop-up; nothing appears without a press.

## 5. Shorter lines (feature 4)

- Built-in playbook `m1-draft-2`: ASK/SAY at most 15 words, HAPPENING 12, FOLLOW 15, and
  `technical_max_words` 30 for a technical answer from approved knowledge.
- `validateCard` uses `technical_max_words` (when set) for a `technical_answer` card.
- A copy of the playbook in the data folder that Keith never edited (identical to an earlier built-in
  version) moves to the new version by itself; an edited one is offered the switch as today.

## 6. Compact window (feature 5)

- A "Compact" button in the call controls (and back with "Expand"): the window shrinks to a small
  strip (about 460 x 240), stays on top during the call, and shows only HELP and WRAP, a status dot,
  the card's line with its checks, and the approved note's first line. Position and size are
  remembered per mode. Content protection is unchanged (same window).

## 7. Checks while the line streams (fix)

Today the yellow "check before saying" note appears only when the whole card is finished, after
Keith may already have read the line. As soon as the ASK/SAY line is complete, the checks that are
already certain are shown: a number not in the call or knowledge, and, when no approved knowledge
was given for this press, an Arize capability claim or a technical answer. The finished card's full
checks replace them.
