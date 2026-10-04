# Locked Audio-Device Requirement
Locked 2026-10-04. This is non-negotiable and takes precedence over any other doc on audio devices, including PRIOR_SPEC_v3.md.

## Keith's real setup
- Windows PC.
- Razer USB wireless headset (2.4 GHz USB dongle), used for both microphone and meeting audio.
- Zoom desktop app with Keith's normal microphone and speaker selections.

The copilot fits this setup. Keith does not change his setup to fit the copilot.

## Non-negotiable
The application must never:
- change the Windows default input device (Console, Multimedia or Communications role);
- change the Windows default output device (any role);
- change Zoom's microphone selection;
- change Zoom's speaker/output selection;
- install, bundle or require a virtual audio device, virtual cable or audio driver;
- require Keith to manually reroute audio before or after a call.

The same applies to anything that has the same effect:
- Open WASAPI streams in **shared mode only**. Never open exclusive mode, because it would take the headset away from Zoom.
- Do not change endpoint volume, mute, format, enhancements/APOs, "allow exclusive control", or the Windows ducking setting.
- Open the microphone stream so it does not trigger Windows communications ducking (do not register it as a communications stream). If Zoom audio gets quieter when capture starts, that is a failure.
- Read-only access to the Windows audio configuration. The app enumerates and watches endpoints and never writes to them.

Razer software (Synapse, the "7.1 Surround" virtual device) is Keith's own software. The app neither requires it nor removes it. If Zoom plays to a Razer virtual endpoint, the app captures **that** endpoint.

## Capture architecture (unchanged)
The Project Raven-derived Windows architecture from M0_RAVEN_TEARDOWN.md:
- WASAPI loopback on the Windows **output endpoint that carries the Zoom/meeting audio**. This must be the explicitly selected endpoint, not "whatever the default is".
- Separate WASAPI capture on Keith's selected **microphone endpoint**.
- Raven-style Rust/NAPI boundary.
- Echo/duplicate suppression as specified in M0.
- Deepgram streaming downstream.

Two separate streams stay separate: `local_mic` and `system_remote`. The system stream is labeled honestly as system audio from that endpoint, not "Zoom only".

## Endpoint selection and persistence
1. **Enumerate** active Windows render (output) and capture (input) endpoints through the native layer. For each one, show the friendly name, device description, form factor, whether it is currently a Windows default (for information only), state, and mix format.
2. **Keith selects** one output endpoint (the one Zoom plays to) and one microphone endpoint. Defaults may be pre-highlighted as a suggestion. Nothing is auto-confirmed.
3. **Test the pair** before saving:
   - Output: Keith plays Zoom's own "Test Speaker" sound or joins a test meeting. The `system_remote` meter must move from that endpoint's loopback.
   - Mic: Keith speaks. The `local_mic` meter must move.
   - Both meters move at the same time, Zoom still works normally, and Keith's Windows/Zoom settings are unchanged.
4. **Keith confirms**, then persist an `AudioEndpointConfig` (see CONTRACTS.md) keyed by the **stable Windows endpoint ID** (the IMMDevice ID string), plus a fingerprint used only for diagnostics and for re-confirmation prompts. Display names like "Razer Headset" are never the key.

Windows can give a USB headset a new endpoint ID, for example after the dongle moves to another USB port or the driver is reinstalled. Treat that as **saved endpoint missing**. The app may suggest a candidate with a matching fingerprint, but Keith must explicitly confirm it before it is used and saved. It is never adopted silently.

## Session-start gate
Before a real session can start:
1. Resolve both saved endpoint IDs.
2. Check that each endpoint exists and is in the ACTIVE state.
3. Check system-output audio activity on the selected output loopback: a real signal above the noise floor, not just API success. Keith can use Zoom's Test Speaker or the meeting audio itself.
4. Check microphone audio activity on the selected mic: Keith speaks a short phrase.
5. Show the actual selected devices by name and short ID in the capture UI, plus both live meters.
6. **Block Start** if either stream is missing, unopenable, or silent. Show which stream failed and why. Never start a "real" session with one stream silently unavailable. A degraded single-stream mode, if it is ever added, must be explicitly named and chosen by Keith. It is not part of M0.

Note: digital silence on loopback can just mean nothing is playing yet. The gate asks for a short active test instead of guessing. After Start, a lack of remote audio is shown on the meter but is not treated as device failure while the endpoint is still present and the stream is healthy.

## Device loss or change during a call
Triggers include: the headset powering off or going out of range, the dongle being unplugged, the endpoint being disabled or changing state, the stream being invalidated (`AUDCLNT_E_DEVICE_INVALIDATED`), a format change, or a Windows default change. Default changes are informational only, because the app is bound to explicit IDs.

On any of these:
- **Surface the failure immediately**: which stream, which device, the time, and the reason, both on the debug screen and in diagnostics.
- **Never** change Windows defaults, change Zoom settings, or silently switch to another endpoint. That includes the new default, a same-named device, or the laptop's built-in mic or speakers.
- Stop sending that stream to Deepgram. The other stream keeps running and stays honestly labeled.
- **Mark the transcript gap**: set `discontinuity_before` on the next frame, insert a GAP turn marker, and log stream, start timestamp, duration, device state, provider state and recovery result (as in the M0 gap log).
- **Reconnect only to an explicitly selected/confirmed endpoint**: either the same saved endpoint ID when it comes back (auto-reopen is allowed because it is the confirmed device), or a different endpoint that Keith picks and confirms right then.
- **Resume from current audio only.** Drop any audio buffered before or during the loss. Never replay stale buffered audio. Start a new Deepgram connection epoch with a new speaker-cluster namespace, as for any reconnect.
- If the endpoint does not come back, the session stays visibly degraded until Keith fixes it, picks an endpoint, or stops.

## M0 acceptance (adds to the existing hard gates)
M0 cannot pass unless all of this is shown on **Keith's actual Windows PC with his Razer USB wireless headset and normal Zoom configuration**:
- [ ] Before/after snapshot of Windows default devices (all roles) and Zoom audio selections: identical after setup, after a session, and after app exit.
- [ ] No virtual audio device present or installed by the app (device list before/after install).
- [ ] Zoom audio volume is not ducked when capture starts.
- [ ] The Razer endpoints are enumerated, selected, tested and saved by endpoint ID.
- [ ] After app restart, the saved IDs resolve and the start gate passes without re-selection.
- [ ] Start is blocked, with a clear reason, when the headset is off, and when the mic or system stream is silent during the gate.
- [ ] Mid-call headset power-off or dongle unplug: failure shown within ~2 s, gap marked, no endpoint switch, Windows/Zoom unchanged.
- [ ] Headset back on: capture reconnects only to the confirmed endpoint, and no pre-loss audio appears in the transcript.
- [ ] Dongle moved to another USB port (if it changes the ID): treated as missing and needs Keith's confirmation.
- [ ] Combined with the 60-minute Zoom run in M0_RAVEN_TEARDOWN.md.

Record the results in `docs/m0_test_report.md` with Windows build, Zoom version, Razer model/firmware, endpoint IDs (they are not secrets, but redact the user name if it appears), and the snapshots.
