# Keith's M0 Test Guide

Goal: prove the app hears your calls reliably with your **Razer headset + Zoom, set up exactly as you normally use them**. You don't change anything in Windows or Zoom, ever.

Takes about 20 minutes, plus one 60-minute call later.

---

## 0. Install (one time)
1. Get the installer from the **Latest build** page: https://github.com/keithk421-cpu/salesiq/releases/tag/latest (bookmark it; it always has the newest installer). Download the `.exe` under **Assets** and double-click it. The page says which build it is; the app shows the same number at the top of **Diagnostics**.
2. Windows may show a blue **"Windows protected your PC"** box, because the app isn't code-signed yet. Click **More info → Run anyway**.
3. If Windows asks for microphone access, allow it. (Settings → Privacy & security → Microphone → "Let desktop apps access your microphone" must be **On**.)

## 1. Before you start: take a "before" snapshot
- Take a screenshot of **Zoom → Settings → Audio** (shows your speaker and mic picks).
- Open the app → **Diagnostics & test report** (bottom of the call screen) → **Save device snapshot · BEFORE**. (First launch shows Setup; do the snapshot right after setup.)

## 2. Setup screen (first launch)
**Step 1, Connect Deepgram:** paste the key and click **Save key**. You only do this once.

**Step 2, Find your headset:**
1. Join a Zoom test meeting (or open Zoom Settings → Audio).
2. Click **Start listening**. The app listens to *every* output and mic on your PC at once. It only listens and changes nothing.
3. In Zoom: **Settings → Audio → Test Speaker**. Then say "testing, one two three".
4. The output that played the test sound gets a green **AUDIO PLAYING HERE** tag and the mic that heard you gets **HEARING YOU HERE**; both are picked for you. Check they look right (your Razer), then click **Use these devices**.

Tip: Razer software can add extra outputs (e.g. "7.1 Surround", "Game", "Chat"). That's fine: whichever one lights up is the one Zoom plays to.

## 3. Smoke test (about 5 minutes)
Join a Zoom call with a friend, or with your phone as the second person. **Wear the headset.**
Put the other person (or your phone) in a **different room**, or have them use headphones. If they're in the same room, their voice reaches your mic through the air, and the app has to guess which copy is real.
1. Click **Start** (it starts right away, no questions). It checks both streams first: play Zoom's Test Speaker or let your friend talk, and say a few words. Within a few seconds it should switch to **LIVE**. If you press Start before the other person joins, it just keeps waiting (up to 20 minutes) and goes live when it hears both sides at about the same time (a stray notification sound won't start it); **Stop** cancels, and so does locking the PC or letting it sleep (press Start again when you're back).
2. Talk back and forth. Your words show as blue **Keith · mic** bubbles on the right; the other side shows as **Remote · speaker 0 / speaker 1** on the left (speaker numbers are Deepgram's voice groups, not names).
3. Click **Pause**. Keep talking for 10 seconds, then click **Resume**. Nothing you said while paused should appear. You should see a **Paused** line.
4. **Headset test:** turn the headset **off** for about 10 seconds, then back **on**.
   - Within about 2 seconds a red banner says the device disconnected and that it **won't switch devices on its own**.
   - A red **gap** line should appear in the transcript.
   - When the headset comes back, an alert says it reconnected to the **same** device, and the transcript continues.
   - It must **never** jump to your laptop mic or speakers by itself.
5. Click **Stop**.

What's normal:
- Faded, dashed bubbles marked **live, not final** are words still being heard. They firm up into normal bubbles a moment later.
- The transcript header shows **delay**: how far behind real time the final text is running.
- Your BlackShark mic goes fully silent between your words (it has a noise gate). That's fine; you'll only see a note if it's silent for 60+ seconds.
- The word next to each device says how that side is doing:
  - **Listening** (green, pulsing): sound is coming in and being turned into text.
  - **Quiet** (steady green dot): audio is coming in, nobody has spoken for a few seconds. Normal: the buyer is just quiet. Your mic shows **Quiet (muted?)** after a minute of pure silence; fine if you've been listening.
  - **No audio arriving** (red): the headset stopped sending sound (see the headset test above). It never switches to another device by itself.
  - **Not transcribing** (amber): sound is coming in but no text is coming back from the speech service. The app reconnects it by itself.
- If the speech service goes silent while someone is talking (about 15 seconds with no text), the app reconnects it on its own. An amber bar says **speech service stopped responding**, then a blue one says **stopped responding; reconnected**, and the transcript shows a gap line ("speech service stopped responding") for the stretch that wasn't transcribed. If it happens again within 30 seconds, the gap line shows straight away and the reconnect follows up to 15 seconds later. Nothing is replayed, and devices are never changed for this. A quiet stretch, or the odd cough in one, never sets it off.

## 4. Check nothing changed
- Open **Diagnostics & test report** → **Save device snapshot · AFTER**.
- Re-check Zoom → Settings → Audio: same speaker and mic as your "before" screenshot?
- Did Zoom audio get quieter at any point when the app started listening? (It shouldn't.)

## 5. The 60-minute run
Do one real-length Zoom call (60+ minutes) with the app running. Don't babysit it.

## 6. Send back
- Click **Diagnostics → Save support files**. It makes a folder with logs, timings and counts only (no conversation text, no keys) and opens it. Zip that folder and send it.
- **Never send** `copilot.db`, the `sessions` folder or any `transcript.jsonl`: they contain the full conversations.
- Send your before/after Zoom screenshots.
- Tell me anything weird, with a screenshot if you can.

### If something goes wrong
- **No output lights up when you click Test Speaker:** take a screenshot of the setup screen during the test (each device shows "Nothing playing here", "Silent" or an error) plus Zoom → Settings → Audio, and send both. Also click **Diagnostics → Save support files** and send that folder: its log records exactly what Windows delivered for each device.
- **"Start blocked: … not found"**: the headset is off or plugged into a different USB port. Turn it on. If it's on a different port, Windows may have given it a new ID: pick it again in Step 2, test, and save.
- **"Start blocked: no meeting audio heard"** (after 20 minutes of waiting): click Zoom's Test Speaker during the check, or make sure Zoom is playing to the device you picked.
- **"no voice heard"**: is the headset muted (Razer mute button)?
- **"Speech service stopped responding" more than once or twice in a call**, or **Not transcribing** for more than a minute: check the internet connection, note the time, and send **Diagnostics → Save support files** afterwards. (It reconnects on its own, at most once every 30 seconds for each side.)

---

# M1: HELP

## One-time setup (5 minutes)
1. **Setup → step 3 "Connect Claude for HELP":** paste your Anthropic API key there (on your PC, not in chat) and click **Save key**. Leave the model on **Claude Sonnet 5.5**.
2. **Setup → step 4 "Knowledge pack" (optional but valuable):** click **Add a folder…** and pick the unzipped pack folder (it adds only the files that are ready, from `1-live-candidate`), or **Add files…** to pick single files. They arrive unapproved. Tick **Approved** on each file you've read; unticked files are never used. **Remove** takes a file out of use (it isn't deleted). If you edit a file later, it shows **Changed: approve again** and HELP stops using it until you re-tick it.
3. **Diagnostics (bottom of the call screen) → Run HELP speed test**, with no call running. It takes a few minutes, costs roughly $1-2, and compares Sonnet vs Opus on 43 practice moments. Send me the report (**Open report**). Its "Speed by stage" table shows how quickly each step comes after the press: the approved note, Claude's first word, and the first usable line.
4. **Review the 43 practice moments** in `docs/SCENARIO_REVIEW.md` (about 25 minutes). Reply with the numbers you agree with and a one-line fix for the rest. Only the ones you approve decide which model wins.

## On a call
- Under the HELP button, a small light says whether HELP is ready: **HELP ready** (green), **Practice mode** (no Claude key: cards are MOCK), or a red/amber problem in plain words (key not working, out of credit, Claude busy, no internet). It updates after every HELP press, so it matches what you just saw. Click it to check again.
- Fill the strip when you can: **Account** and **Deployment** (SaaS, self-hosted or not sure) matter most. With a deployment set, HELP won't state facts that only apply to the other one. You can change the strip (call type, goal, outcomes, account, deployment) at any point, even mid-call; the next HELP press uses it. **Stop** clears the account, goal, outcomes and deployment so the next call starts clean (the call type stays); so does closing the app without pressing Stop. What you type after Stop is for the next call and doesn't change the call you just finished.
- Press **Ctrl+Alt+H** (or the **HELP** button) whenever you want a line. The app window comes to the front without taking you out of Zoom (if HELP can't answer right now, e.g. the call is paused, it says why there). You'll see one Ask or Say line, maybe a one-line read above it, maybe a follow-up. The card's top right says which account and deployment it assumed.
- **Approved note:** when the other side asks about something one of your approved files clearly covers, a small green box appears the moment you press, before HELP's line: **Approved note · section · file** and its first sentence or two. It follows what they said last: if they asked something, you answered, and they moved on, the box is about the new thing (or there's no box). For objection notes the box starts with the question to ask, not the "possible reason" (that's a guess about buyers in general, so it stays inside **Whole note and source**). A plain statement about their own setup ("We're mostly on AWS.") doesn't bring up a note on its own; a question about it can. Click **Whole note and source** to read all of it and where it came from. It only uses files you approved, that are still current and that fit the deployment you set; "(SaaS only)" means the note covers SaaS only. It only shows up on a clear match, so often there's no box, and that's normal. When HELP's line is based on that note, the box says **HELP used this**. If HELP doesn't finish (too slow, an error, or you paused), the box stays and the card says so, so you still have the approved wording.
- A yellow note on a card means it includes a number or a "we support…" claim that isn't backed by your approved knowledge: check it before saying it. A crossed-out line marked **Don't use this line** came from an answer that failed its checks or was cut off (by Pause or Stop): press HELP again.
- **Ctrl+Alt+J** hides or shows the app window. The first press always brings it up (even when it's just behind Zoom); the next press tucks it away again. When the app has just come up by itself (after Ctrl+Alt+H, "Still on a call?" or unlocking the PC), one press tucks it away. (It's not one of Zoom's shortcuts.)
- During a call, the app window doesn't show up when you share your screen, record, or take a screenshot. Outside a call (Setup, or after Stop) screenshots just work, so that's the easy time to send me one. If you need one during a call, untick the box in **Diagnostics**; the next **Start** ticks it again for you.
- After a pause or a dropped connection the speech service numbers speakers afresh, so a note asks you to tap the remote speaker's name again if you'd labelled them (optional).
- Locking the PC or letting it sleep pauses the call. When you're back, the app window comes up (Zoom keeps the keyboard) and says it's still paused: press **Resume**. If nothing is said on the call by anyone for 10 minutes, the window comes up with a bar asking **Still on a call?**: click **Still on the call**, or a minute later the call **pauses** (it never stops by itself); press **Resume** to carry on with the same call. While a headset is disconnected that clock doesn't run.
- Click a remote speaker's name in the transcript to tag them as Buyer or Teammate/SA. Optional; HELP works without it.
- Tap **Useful**, **Should've stayed quiet** or **Bad** on cards. Each tap records feedback, nothing more.

### Call notes
- Above the transcript, the **Call notes** panel keeps a short running summary of the call: what you're talking about, their questions that haven't been answered yet, what they want, concerns they raised, facts they shared (their tools, team, timeline, budget, who decides, what good looks like), next steps (**Proposed** until they say yes, then **Agreed**), and what hasn't come up yet (timeline, decision process, current tools, success criteria).
- It's built only from what was said and updates by itself after about a minute of the other side talking, at most once every 3 minutes ("updated 40 s ago"), so it keeps up right to the end of a long call. It can lag a few minutes: if it ever disagrees with the transcript, trust the transcript. Hover over a line to see when it was said.
- HELP reads the notes too, so late in a long call it still knows what they said at the start (like their stack or who decides).
- It never gets in HELP's way: it waits while HELP is answering. It stops while paused. After **Stop** the notes stay on screen for your review; the next **Start** clears them.
- Click **Call notes** to fold the panel away. To switch it off: **Setup → step 3 → Keep running call notes**. It costs a little extra: at most 20 updates an hour, roughly 20 to 40 cents an hour (about double if HELP is set to Opus). The scorecard counts them and their cost (never the notes themselves).
- In Practice mode (no Claude key) the notes are placeholders marked **MOCK**. If the panel says "not updating" because of the key or credit, fix that in Setup, step 3; it starts again after the next HELP press that works.

## After a call
- **Review this call's cards** (under Start) lists every HELP card from the call: rate each one, tick **I used this line** for the ones you actually said, and add a note if something would have been better. 2 minutes; it's the most useful feedback for improving HELP. Your taps are counted in that call's scorecard (your note text stays on your PC).
- **Save a moment to practice on:** in that same list, click **Save as practice moment** under any card. It keeps the call exactly as it was when you pressed HELP for that card: what had been said up to then, who was who, the call setup and the knowledge HELP used. The button then says **Saved as a practice moment** (and still does when you reopen the review); each card is saved once. Your rating, **I used this line** tick and note go in with it, and if you change them afterwards the saved moment is updated too ("Practice moment updated with your rating"). Your moments stay on your PC (**Diagnostics → My practice moments → Open folder** shows them). Call notes aren't saved with a moment, so a moment from late in a long call may replay a little differently.
- **Run the speed test with your moments:** **Diagnostics → Run HELP speed test**, with **Include my saved moments (N)** ticked (it's on whenever you have some). Your moments are replayed alongside the built-in ones and get their own section at the end of the report; they never decide which model wins. Each moment adds a little to the cost of the run.
- **Export HELP feedback and send it to me:** **Diagnostics → Export HELP feedback**, pick the period (**Last 7 days** is the default; **Last 30 days** or **Everything**), and click it. It saves one file, `SalesCopilot-feedback-<date>.md`, to your Downloads folder and opens the folder: a short summary (calls, cards, your ratings and reasons, lines used, notes, speed, cost), then every card per call with your rating, whether you used it and your note. It has lines and notes from your calls, so send it to me directly (it isn't part of the support files).
- Every call is kept on your PC. (Diagnostics has an optional "Keep saved calls for" setting if you ever want old calls cleared out; it's off. If you turn it on, the clear-out never runs during a call, only between calls.)
- **Setup → step 4** shows which playbook HELP uses. If you edited it and made a typo, it says what's wrong and uses the built-in one until you fix it. When a new built-in playbook ships, it asks whether to switch (your copy is kept) or keep yours; if Windows won't let it switch because the playbook file is open, it says so: close the file and try again. Edits apply from the next call; no restart needed.
- Knowledge files close to their review date show **Expires in N days**: ask me for a refresh before then.

## Send me after a few calls
Diagnostics → **Save support files** → zip the folder it opens and send it. It has timings, counts, HELP speed reports and one numbers-only scorecard per call (how many times you pressed HELP, how fast lines came back, what it cost, your Useful/Bad taps), and no conversation text. Never send `copilot.db` or the `sessions` folder (they hold the full conversations). Your practice moments, and speed reports from runs that included them, are left out of the support files; send the **Export HELP feedback** file (above) for the lines and notes.

# M2: nothing slips between calls

## Before the call: "Last time with…"
- Start typing the **Account** in the strip: it suggests accounts you've had calls with. When it matches one, a box shows **Last time with <Account> · <date> (<n> calls)**: **You promised**, **They owe**, **Agreed next step**, **Still open**, **They want** and **What they told us**, each with the date of the call it came from. It comes from the wrap-ups of your last three calls with them (items you removed are left out, and your edits are kept) and their call notes.
- **Reuse last setup** fills the goal, outcomes and deployment from the last call, with call type **Follow-up**.
- When you press **Start** the box folds to one line so it doesn't push HELP's card down; click it to open it again.
- HELP knows these too: it may suggest a line like "Last time you mentioned X, is that still the case?". It treats them as what was true then, never as fact today, and won't promise again something you may already have done.

## During the call
- Lines are shorter now: an Ask or Say line is about 15 words, so you can read it in a glance. A technical answer from your approved files can run to about 30.
- A yellow **check before saying** note now appears as soon as the line does, not when the whole card is finished.
- **WRAP** (next to HELP, or **Ctrl+Alt+W**) near the end of the call gives you one line to lock the next step: what happens, who's there, and a date or time. If something was already agreed, it confirms the details; it never picks a date nobody said. The line underneath recaps what you promised to send. The card says **Wrapping up**.
- If you press HELP just as they say something like "we're out of time" or "what are the next steps?", HELP aims for the next step too, unless they just asked you a question; then it answers that first.
- **Compact** shrinks the app to a small strip on top of Zoom: HELP, WRAP, the line and its yellow note, and the approved note's first line. **Expand** brings the full window back. Between calls the strip shows no card.

## After Stop: the wrap-up
- **Stop** now finishes the call notes first (the last few minutes, when next steps usually get agreed), then a **Wrap-up** window opens by itself: "Finishing notes and wrap-up…" for a few seconds, then five short lists:
  - **We owe them**
  - **They said they'd do**
  - **Agreed next steps**
  - **Proposed, not agreed**
  - **Their questions, not answered yet**
- Each item shows the words it came from and when they were said. Tick the ones that are right, fix the wording, remove the wrong ones (Undo brings one back), and use **+ Add** for anything it missed.
- **Draft follow-up email** writes a short email from you: thanks, what you heard, the next step, what you'll send, and what they said they'd do. It answers their questions only from your approved files; otherwise it says you'll come back on it. It uses the items you ticked plus any you added (tick none to use them all). A yellow note means it has a number or an Arize claim that isn't in the call or your approved files: check it before sending. Edit it in the box, then **Copy email** and **Copy subject**. Nothing is ever sent for you.
- **Review cards** goes to the usual card ratings and comes back. **Done** closes it; the **Wrap-up** button next to **Review this call's cards** reopens it until the next call starts or you close the app. Copy the email before you close the app: the wrap-up stays saved (it feeds "Last time with…" next time) but can't be reopened after a restart.
- If it couldn't build ("Claude took too long"), click **Try again**, or add the items yourself.
- To switch it off: **Setup → step 3 → Wrap-up after each call**. Each wrap-up costs a few cents (one request after the call), and each email draft about a cent. In Practice mode (no Claude key) both are placeholders marked **MOCK**.
