# M4: ready before the call

Keith's picks from the brainstorm after M3 (judged on how much easier each makes a call, real use and
effort): must-learn ideas, a "What I know" box per account, faster setup, and a click on a must-learn
mid-call. His decision on the box: HELP may use it, **as check questions only**.

Locked rules still hold: no pop-up cards (everything appears on a press or as quiet state on screen);
nothing is sent automatically; only approved knowledge is stated as Arize fact; asked is not answered,
proposed is not agreed; research and Keith's notes are never something the buyer said. Per-press
instruction blocks go in the user message after the call context (as WRAP and the M3 presses do).
Logs, scorecards and support files carry counts, timings, ids and codes only, never note text.

Shared contracts (already in the code): `src/shared/help.ts` `MustLearnIdea`, `MustLearnIdeaSource`,
`MUST_LEARN_IDEAS_MAX` (4), `MUST_LEARN_IDEA_MAX_CHARS` (40) (an idea cut to fit keeps its whole text in `full`, which is what a click adds), `AccountNotes`, `ACCOUNT_NOTES_MAX_CHARS`
(2000), `KEITH_NOTES_BLOCK_MAX_CHARS` (700), `HelpContextRefs.keith_notes`, `PressMode` `'plan_item'`,
`CallWrapup.not_covered`, `AccountMemory.last_deployment` / `next_call_type` / `last_not_covered` (and
`fact_kind` on fact items, for the "Confirm:" ideas).
The notes store: `src/main/help/accountNotes.ts` (table `account_notes` in `db.ts`): `getAccountNotes`,
`setAccountNotes`, `prependAccountNotes`, `noteLines` (labelled lines), `notesToLearn` ("To learn"
items). Screen hooks: `#akBox` (after the Last time box) and `#wuNext` (top of the wrap-up) in
`index.html`; the plan line's items carry `data-item` and `data-status`.

## A. Prep: must-learn ideas, faster setup, "Learn next time"

1. **Must-learn ideas.** Before Start, an "Ideas" row under the Must learn chips: up to 4 grey
   `+ text` chips; one click makes it a must-learn (the limit stays 3; typing still works). Hover
   shows where it came from. No model request: a pure, tested `mustLearnIdeas()` (new file
   `src/main/help/mustLearnIdeas.ts`) from the setup, account memory and the account's notes, in
   this order, skipping anything already a chip (`planKey`) and anything the last call covered:
   1. the last call's still-to-learn items (`to_learn`), dated;
   2. "status of <what they owed>" from the newest `they_owe` items, dated;
   3. topics the last call's final notes listed as not covered (`last_not_covered`), in plain
      words: timeline → "timeline to decide", decision_process → "who signs off and how",
      current_tooling → "what they use today", success_criteria → "what good looks like";
   4. "Confirm: <fact>" for a decision-process or current-tooling fact an earlier call gave (dated,
      so a stale one reads as a check);
   5. the "To learn" lines of What I know (`notesToLearn`);
   6. "SaaS or self-hosted" while Deployment is "not sure";
   7. two or three starters for the call type (a fixed list in code; neutral: no assumed pain,
      urgency or deadline; at most 28 characters so they read in full on the plan line):
      - Discovery: what prompted the call · how they test answers today · who signs off · timeline to decide
      - Demo: which use case to show · what they need to see · who else should see it
      - Technical deep-dive: how they send traces today · where data must stay · what a POC must prove
      - Follow-up: what changed since last call · who else has weighed in · next step and date
      - Negotiation: steps left to sign · who signs and how · start date they need
      - Other: what they want from today
   The row hides once the call starts and when 3 chips are set, and refreshes when the account, call
   type, deployment or must-learns change, after Stop, and when What I know is saved (the notes box
   fires `window` event `copilot:account-notes`). IPC `help:mustLearnIdeas`.
2. **Type the account, the rest fills in.** Before Start, when the typed account has earlier calls
   and the call type and deployment weren't changed by hand since the app opened or the last Stop:
   call type becomes `next_call_type` (from the last call's agreed next step: a demo → Demo; a
   deep-dive, architecture, security review or POC scoping → Technical deep-dive; contract,
   procurement, order form or legal → Negotiation; else Follow-up; a tested `nextCallType()` with
   must-not-match cases like "they'll demo it to their team internally"), deployment becomes
   `last_deployment` (the newest one that isn't "not sure"), and an empty Must learn takes the last
   call's still-open items. Goal and outcomes stay as they are ("Reuse last setup" still copies the
   old goal). One quiet line in the Last time box: "Filled from the Sep 28 call · Undo"; Undo puts
   back what was there. Nothing changes by itself during a call.
3. **"Learn next time" in the wrap-up.** The wrap-up's "Still to learn" section always shows when
   the wrap-up is ready (named "Learn next time"): the open ones with ✕ as today, up to 4 `+` chips
   from this call's not-covered topics (`CallWrapup.not_covered`, set from the final notes), and a
   small "Add one" box; 3 at most. Added items join `plan_open` (WrapupKeeper `addToLearn`, kept
   through the keeper's recomputes, saved with the call; IPC `wrapup:addToLearn`), so account
   memory, the ideas row and the fill above pick them up with no other change. Practice (MOCK)
   wrap-ups still never feed account memory.

## B. "What I know about <account>"

1. **The box** (`#akBox`, new renderer file `src/renderer/accountNotes.ts`): shows whenever the
   account box has a name, first call or not ("What I know about Larkspur Health · updated Oct 6").
   A text box Keith types or pastes into (counter, limit 2000), saved on leaving the box and with a
   Save button; Clear (asks once). Before Start it's open; at Start it folds to one line ("What I know
   · 6 lines") he can open, and folds again when a HELP card comes (as the Last time box does). A
   different account loads its own notes. IPC `notes:get`, `notes:set`, `notes:prepend`.
2. **Copy prep prompt.** A button that copies a ready-made request for Keith to paste into Claude,
   where Sumble, Notion and Drive are connected (pure, tested `prepPrompt()` in new file
   `src/main/help/prepPrompt.ts`; IPC `notes:prepPrompt`): the account, call type, date, goal, the
   Last time items and his must-learns; asks for at most 8 short lines, each starting with one of
   the labels in `NOTE_LABELS` (Who / Their setup / Before the app / They owe / We promised /
   Research (not said by them) / To learn), the source and date in brackets, at most 3 "To learn"
   lines of 28 characters or fewer, neutral, nothing already known, only what the sources show, no
   guessed numbers, unsure marked. He pastes the answer back into the box. The app sends nothing.
3. **HELP reads it, as check questions only.** A `<keith_notes>` block after `<earlier_calls>`:
   "Keith's own notes and research from before this call: not said by anyone on this call, not
   Arize fact, may be out of date", at most `KEITH_NOTES_BLOCK_MAX_CHARS`, "To learn" lines left out
   (they're plan, not facts), research lines last (dropped first when it's too long). Loaded at call
   start, on an account change and when the notes are saved mid-call (`CallMemory.keithNotes`).
   Recorded in `HelpContextRefs.keith_notes`; practice moments, replay and the speed test carry it.
   One system prompt rule next to the earlier_calls rule: Keith's notes may shape which question to
   ask and may be checked as a question ("My understanding is you're on <tool> today. Is that still
   right?"); never "you mentioned / you said / you told us / I saw / I noticed / I read"; never stated
   as current fact or as Arize fact; research is never revealed or quoted. Never sent to the call
   notes, the wrap-up or the follow-up email; never marks a must-learn done. A Level 1 check flags a
   finished card that says they mentioned something only Keith's notes contain ("Says they told you
   something only your notes say: check it"). Two draft scenarios (not Golden: Keith approves).
4. **"For next time".** At the top of the wrap-up (`#wuNext`, new renderer file
   `src/renderer/forNextTime.ts`), a few short lines built in code from the items Keith kept (never
   a model's words; pure, tested `forNextTimeDraft()` in new file `src/main/help/forNextTime.ts`),
   each with a label `noteLines` reads: "Deal so far · Oct 6: agreed: deep-dive Tuesday at 2",
   "They owe · Oct 6: …", "We promised · Oct 6: …", "To learn · Oct 6: who signs off · eval owner"
   (proposed stays "proposed", never "agreed"). Editable; "Save to What I know" puts it at the top of
   the account's notes (`prependAccountNotes`); "Copy" copies it. Practice (MOCK) wrap-ups show it
   with nothing to save (placeholders aren't notes).

## C. Click a must-learn mid-call

Clicking an open or partial item on the plan line (Call notes panel or compact strip) during a live
call is a HELP press for it (new renderer file `src/renderer/planPress.ts`, delegated clicks on
`.pl-item[data-item]`; IPC `help:pressPlanItem`). HelpService checks the item is one of this call's
must-learns and the call is live. A fresh request (never the background card), `press_mode`
`'plan_item'` ahead of another angle, closing words, a buying signal and the opening (WRAP is its own
button). Instruction block `<plan_press>`: get to "<item>" from where the talk is, as one natural
question in Keith's voice; if they just asked something or raised a concern, answer that first and
put the bridge in FOLLOW; if they're mid-answer, the question stays the ASK line and HAPPENING says to let
them finish; a must-learn they just answered isn't asked again; never imply they mentioned it; asked
is not answered. Clicked again for the same moment (2-20 s, nothing new said), it tells HELP the line he
already has and asks for a different way in (and records a 'passed' row, as another angle does). Labelled "Must learn". The item is stored in `timing_json`
(`press_plan_item`) and `PressDetail.plan_item`, so a practice moment replays it; the scorecard counts
these presses; the MOCK model answers it.
