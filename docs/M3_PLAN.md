# M3: the card you can trust, smarter presses, your call plan

Keith's picks from the post-M2 brainstorm (judged on deal impact, real use and effort). Locked rules
still hold: no pop-up cards (everything appears on a press or as quiet state on screen); nothing is
sent automatically; only approved knowledge is stated as Arize fact; asked is not answered, proposed
is not agreed; research is never something the buyer said. Instruction blocks go in the user message
after the call context, so the cached system prompt stays the same for every press (as WRAP does).

Shared contracts (already in the code, `src/shared/help.ts`): `CallSetup.must_learn`, `PlanStatus`,
`PlanItemStatus`, `CallNotes.plan`, `CallWrapup.plan_open`, `AccountMemoryKind` `'to_learn'`,
`HelpCardEvent.heard` (`HeardLine`), `HelpCardEvent.press_mode` (`PressMode`), `FeedbackType` `'passed'`.

## A. The card shows what it heard

1. **Heard line.** The top of every card shows what it answers: `Heard: "…do you integrate with Lang
   Smith?" (Speaker 1 · 4 s ago)`: the other side's latest words at the press (retrieval.ts
   `questionParts`: what they said last, else the last thing they asked), trimmed to about 90
   characters at a word, with the speaker as HELP names them and how long before the press they
   ended. Shown in the compact strip too (one line). No confidence dimming in this version: log a
   numbers-only spread of Deepgram word confidence per call (count, min, median, share under 0.6) so
   it can be calibrated on real calls first.
2. **The ready card survives a filler.** Today a press while Keith's own words are still being
   transcribed throws away the background card. If those words are only a short filler (at most 5
   words, from a fixed list: "great question", "good question", "yeah", "so", "okay", "right",
   "sure", "mm-hmm", "let me think", "that's a great question" and the like), the prepared card is
   still served. Keith's mic only; anything else he says still makes a fresh card.
3. **Background card on end of speech.** Deepgram's `speech_final` / `UtteranceEnd` on the meeting
   audio start the background card as soon as they finish speaking (today only finished turns plus
   a 700 ms debounce do); the debounce stays as a fallback and the 4-a-minute cap stays.
4. **Listening blind.** The compact strip's dot becomes two: `Them ●` and `You ●` (green
   listening, grey quiet, amber not transcribing), from the capture health the tiles already use.
   On a press, if the meeting audio has had sound for at least ~6 s with no words back from the
   speech service, the card warns "Their last ~N s weren't transcribed yet. HELP may be behind." and
   HELP's `<transcript_status>` says the same, so it asks rather than answering an old moment.

## B. Smarter presses

Each is a short instruction block after the context (like `wrap.ts`), a label on the card, and
stored in `timing_json.press_mode` so a practice moment replays it. Which applies, in order: the
WRAP button; another angle; closing words (M2); a buying signal; the opening; otherwise a normal press.

1. **Another angle.** Keith presses again within ~20 s of a card that finished and stayed on screen
   at least ~2 s, and nothing new was said since: a fresh request (never the background card) that
   tells HELP what he already got (its line and move) and asks for a genuinely different move or
   question. Labelled "Another angle". The first card gets a `passed` feedback row (not a rating;
   the scorecard counts passes).
2. **Buying signals.** A HELP press when the other side asked, in the last 30 s, about a pilot,
   POC or trial, rollout or implementation time, pricing or cost, or "something to send my VP/boss":
   the line answers or defers as usual (approved knowledge only; never a price) and FOLLOW proposes
   a concrete next step. Labelled "Next step". A tested `buyingSignal(text)` with a must-not-match
   list like `closingLanguage` ("token pricing in our pipeline", "rollout of our new model", "our
   internal pilot of the chatbot"). The WRAP button shows a small tag for the latest one ("pilot
   asked · 14:22"), and the next WRAP builds on it.
3. **Opening.** A press while the other side has said little (under about 40 words in all, within
   the first 5 minutes): with earlier calls (account memory), the line picks up where they left off
   and checks what they owed ("Last time you were pulling an eval sample together. How did that
   go?"); on a first call, it sets the agenda from the goal and Keith's must-learns. A question they
   just asked is answered first. Never research. Labelled "Opening".

## C. Your call plan, tracked

- **Setup strip: "Must learn"**, up to 3 short items (at most 80 characters each), entered as
  chips (Enter adds one, × removes). Stored in `CallSetup.must_learn`; changeable mid-call (the next
  notes update and HELP press use it). "Reuse last setup" (account memory) also brings over the last
  call's must-learns that were still open.
- **Status from the call notes.** The notes request returns `plan`: each must-learn with `open`,
  `partial` or `done` and the lines it rests on. Validation: only Keith's items; `done` needs cited
  lines; unclear stays `partial`; asked is not answered (Keith asking is not the buyer answering).
  Updates with the notes (about every 3 minutes) and the closing pass at Stop.
- **On screen, quiet.** One line at the top of the Call notes panel: `○ who signs off · ◐ eval
  process · ● deep-dive scope` (open, partial, done), hover shows the line each one rests on; the
  same line in the compact strip. No timer, score or percentage.
- **HELP.** The notes block lists the plan items still open. Prompt rule: steer toward one only in
  a lull or a long tangent, never over a question or concern the other side just raised.
- **WRAP.** With a must-learn still open, FOLLOW asks it naturally ("Before we go, who else would
  weigh in on a decision like this?") instead of the owed-items recap.
- **After Stop.** The wrap-up stores `plan_open` (open or partial) and shows it as "Still to learn"
  (read only). Account memory carries it as `to_learn` ("Still to learn" in the "Last time" box and
  "Keith still wanted to learn" in HELP's earlier calls).
