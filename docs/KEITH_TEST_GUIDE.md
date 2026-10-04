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
- Open the app, scroll to the bottom and click **Save device snapshot: BEFORE**.

## 2. Paste your Deepgram key
Step 1 in the app. Paste the key and click **Save key**. You only do this once.

## 3. Pick, test and save your devices
Step 2 in the app.
1. **Meeting audio:** pick the Razer output that Zoom plays to (in Zoom Settings → Audio → Speaker).
2. **Microphone:** pick the Razer mic Zoom uses.
3. Click **Test these devices**. Then:
   - In Zoom Settings → Audio, click **Test Speaker**: the **Meeting audio** bar should jump and show ✓ heard.
   - Say "testing one two three": the **Microphone** bar should jump and show ✓ heard.
4. Click **Save these devices**.

Tip: Razer software sometimes adds a "7.1 Surround" device. Pick whichever one Zoom is set to play to.

## 4. Smoke test (about 5 minutes)
Join a Zoom call with a friend, or with your phone as the second person. **Wear the headset.**
1. Click **Start**. It checks both streams first. Play Zoom's Test Speaker or let your friend talk, and say a few words. Within a few seconds it should switch to **LIVE**.
2. Talk back and forth. You should see **KEITH:** lines for you and **REMOTE_0 / REMOTE_1:** lines for the other side.
3. Click **Pause**. Keep talking for 10 seconds, then click **Resume**. Nothing you said while paused should appear. You should see a red **GAP … pause** line.
4. **Headset test:** turn the headset **off** for about 10 seconds, then back **on**.
   - Within about 2 seconds you should see a red alert: the device was lost, and it is **not switching devices**.
   - A red **GAP** line should appear in the transcript.
   - When the headset comes back, an alert says it reconnected to the **same** device, and the transcript continues.
   - It must **never** jump to your laptop mic or speakers by itself.
5. Click **Stop**.

## 5. Check nothing changed
- Click **Save device snapshot: AFTER**.
- Re-check Zoom → Settings → Audio: same speaker and mic as your "before" screenshot?
- Did Zoom audio get quieter at any point when the app started listening? (It shouldn't.)

## 6. The 60-minute run
Do one real-length Zoom call (60+ minutes) with the app running. Don't babysit it.

## 7. Send back
- Click **Open data folder**. Zip the `sessions` and `logs` folders and send them over. They hold the transcripts and diagnostics; your Deepgram key is not in them.
- Send your before/after Zoom screenshots.
- Tell me anything weird, with a screenshot if you can.

### If something goes wrong
- **"Start blocked: … not found"**: the headset is off or plugged into a different USB port. Turn it on. If it's on a different port, Windows may have given it a new ID: pick it again in Step 2, test, and save.
- **"Start blocked: no meeting audio heard"**: click Zoom's Test Speaker during the check, or make sure Zoom is playing to the device you picked.
- **"no voice heard"**: is the headset muted (Razer mute button)?
