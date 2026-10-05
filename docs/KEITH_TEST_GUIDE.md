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
1. Click **Start**. A small box asks who the call is with, their deployment, and whether you've told everyone it's being transcribed. Click **Yes, start** (or **Not recording today** to skip). Then it checks both streams: play Zoom's Test Speaker or let your friend talk, and say a few words. Within a few seconds it should switch to **LIVE**. If you press Start before the other person joins, it just keeps waiting (up to 20 minutes) and goes live when it hears both sides; **Stop** cancels.
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

---

# M1: HELP

## One-time setup (5 minutes)
1. **Setup → step 3 "Connect Claude for HELP":** paste your Anthropic API key there (on your PC, not in chat) and click **Save key**. Leave the model on **Claude Sonnet 5.5**.
2. **Setup → step 4 "Knowledge pack" (optional but valuable):** click **Add a folder…** and pick the unzipped pack folder (it adds only the files that are ready, from `1-live-candidate`), or **Add files…** to pick single files. They arrive unapproved. Tick **Approved** on each file you've read; unticked files are never used. **Remove** takes a file out of use (it isn't deleted). If you edit a file later, it shows **Changed: approve again** and HELP stops using it until you re-tick it.
3. **Diagnostics (bottom of the call screen) → Run HELP speed test**, with no call running. It takes a few minutes, costs roughly $1-2, and compares Sonnet vs Opus on 43 practice moments. Send me the report (**Open report**).
4. **Review the 43 practice moments** in `docs/SCENARIO_REVIEW.md` (about 25 minutes). Reply with the numbers you agree with and a one-line fix for the rest. Only the ones you approve decide which model wins.

## On a call
- Under the HELP button, a small light says whether HELP is ready: **HELP ready** (green), **Practice mode** (no Claude key: cards are MOCK), or a red/amber problem in plain words (key not working, out of credit, no internet). Click it to check again.
- **Start** asks who the call is with and their **Deployment** (SaaS, self-hosted or not sure). With a deployment set, HELP won't state facts that only apply to the other one. You can change the strip (call type, goal, outcomes, account, deployment) at any point during the call; the next HELP press uses it. **Stop** clears the account, goal, outcomes and deployment so the next call starts clean (the call type stays).
- Press **Ctrl+Alt+H** (or the **HELP** button) whenever you want a line. The app window comes to the front without taking you out of Zoom. You'll see one Ask or Say line, maybe a one-line read above it, maybe a follow-up. The card's top right says which account and deployment it assumed.
- A yellow note on a card means it includes a number or a "we support…" claim that isn't backed by your approved knowledge: check it before saying it. A crossed-out line marked **Don't use this line** came from an answer that failed its checks: press HELP again.
- **Ctrl+Alt+Shift+H** hides or shows the app window (if no other app uses that shortcut).
- The app window doesn't show up when you share your screen, record, or take a screenshot. To send me a screenshot, untick that box in **Diagnostics**, take it, then tick it again.
- Locking the PC or letting it sleep pauses the call; press **Resume** when you're back. If nothing is heard from the other side for 10 minutes, a bar asks **Still on a call?**: click **Still on the call** or it stops a minute later.
- Click a remote speaker's name in the transcript to tag them as Buyer or Teammate/SA. Optional; HELP works without it.
- Tap **Useful**, **Should've stayed quiet** or **Bad** on cards. Each tap records feedback, nothing more.

## Send me after a few calls
Diagnostics → **Save support files** → zip the folder it opens and send it. It has timings, counts, HELP speed reports and one numbers-only scorecard per call (how many times you pressed HELP, how fast lines came back, what it cost, your Useful/Bad taps), and no conversation text. Never send `copilot.db` or the `sessions` folder (they hold the full conversations).
