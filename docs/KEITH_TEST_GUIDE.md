# Keith's M0 Test Guide

Goal: prove the app hears your calls reliably with your **Razer headset + Zoom, set up exactly as you normally use them**. You don't change anything in Windows or Zoom, ever.

Takes about 20 minutes, plus one 60-minute call later.

---

## 0. Install (one time)
1. Get the installer from GitHub: repo **salesiq** → **Actions** tab → newest green **M0 build** run → scroll to **Artifacts** → download **SalesCopilot-M0-Windows-Installer** (a zip). Unzip it and double-click `SalesCopilot-M0-Setup-….exe`.
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
1. Click **Start**. It checks both streams first. Play Zoom's Test Speaker or let your friend talk, and say a few words. Within a few seconds it should switch to **LIVE**.
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
- Click **Diagnostics → Open data folder**. Zip the `sessions` and `logs` folders and send them over. They hold the transcripts and diagnostics; your Deepgram key is not in them.
- Send your before/after Zoom screenshots.
- Tell me anything weird, with a screenshot if you can.

### If something goes wrong
- **No output lights up when you click Test Speaker:** take a screenshot of the setup screen during the test (each device shows "Nothing playing here", "Silent" or an error) plus Zoom → Settings → Audio, and send both. Also click **Diagnostics → Open data folder** and send `logs/app.jsonl`: it records exactly what Windows delivered for each device.
- **"Start blocked: … not found"**: the headset is off or plugged into a different USB port. Turn it on. If it's on a different port, Windows may have given it a new ID: pick it again in Step 2, test, and save.
- **"Start blocked: no meeting audio heard"**: click Zoom's Test Speaker during the check, or make sure Zoom is playing to the device you picked.
- **"no voice heard"**: is the headset muted (Razer mute button)?

---

# M1: HELP

## One-time setup (5 minutes)
1. **Setup → step 3 "Connect Claude for HELP":** paste your Anthropic API key there (on your PC, not in chat) and click **Save key**. Leave the model on **Claude Sonnet 5.5**.
2. **Setup → step 4 "Knowledge pack" (optional but valuable):** click **Open knowledge folder** and drop in only the files you're ready to use (keep anything still under review in a different folder). Click **Re-scan folder**, then tick **Approved** on each file you've read. Unticked files are never used. If you edit a file later, it shows **Changed: approve again** and HELP stops using it until you re-tick it.
3. **Diagnostics (bottom of the call screen) → Run HELP speed test**, with no call running. It takes a few minutes, costs roughly $1, and compares Sonnet vs Opus on 33 practice moments. Send me the report (**Open report**).
4. **Review the 33 practice moments** in `docs/SCENARIO_REVIEW.md` (about 20 minutes). Reply with the numbers you agree with and a one-line fix for the rest. Only the ones you approve decide which model wins.

## On a call
- Before Start, fill the strip: call type, goal, outcomes and, if you know it, **Deployment** (SaaS or self-hosted). 10 seconds; optional. With a deployment set, HELP won't state facts that only apply to the other one.
- Press **Ctrl+Alt+H** (or the **HELP** button) whenever you want a line. You'll see one Ask or Say line, maybe a one-line read above it, maybe a follow-up.
- Click a remote speaker's name in the transcript to tag them as Buyer or Teammate/SA. Optional; HELP works without it.
- Tap **Useful**, **Should've stayed quiet** or **Bad** on cards. Each tap records feedback, nothing more.

## Send me after a few calls
Diagnostics → **Open data folder** → zip `copilot.db`, `logs`, `sessions` and `reports`. These hold your calls, so send them privately.
