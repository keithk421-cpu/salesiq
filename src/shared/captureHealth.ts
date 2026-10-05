/**
 * What a source tile says about one stream, at a glance. Three cases must never look alike:
 * nobody is talking ("Quiet", normal), the device isn't delivering audio ("No audio arriving"),
 * and audio is arriving but no text is coming back ("Not transcribing"). Show only: devices are
 * never switched because of any of these.
 */

export type CaptureHealth =
  | 'idle'
  | 'paused'
  | 'unavailable'
  | 'listening'
  | 'quiet'
  | 'muted'
  | 'no_audio'
  | 'reconnecting_device'
  | 'not_transcribing'

export interface HealthInput {
  /** Session state: idle | checking | live | paused | stopping | stopped. */
  session: string
  /** What Windows reports for the endpoint (active, unplugged, ...). */
  device: string
  capture: 'off' | 'capturing' | 'lost' | 'recovering'
  /** Speech-service connection state, or 'none'. */
  provider: string
  /** Sound on this stream in the last few seconds (the activity meter's recent window). */
  soundRecently: boolean
  /** Mic only: exact digital silence long enough to have raised the "No sound from microphone" note. */
  muted: boolean
  /** Sound went out but the speech service has said nothing for a while (stall watchdog). */
  unanswered: boolean
}

export function captureHealth(i: HealthInput): CaptureHealth {
  if (i.capture === 'lost') return 'no_audio'
  if (i.capture === 'recovering') return 'reconnecting_device'
  if (i.capture !== 'capturing') return i.device !== 'active' ? 'unavailable' : i.session === 'paused' ? 'paused' : 'idle'
  // While Start is still checking, nothing is sent yet: the check list shows the speech service.
  if (i.session === 'live' && (i.provider !== 'open' || i.unanswered)) return 'not_transcribing'
  if (i.muted) return 'muted'
  return i.soundRecently ? 'listening' : 'quiet'
}

/** Tile wording: `text` on the tile, `hint` on hover, `cls` picks the dot colour. */
export const HEALTH_LABEL: Record<CaptureHealth, { text: string; cls: '' | 'ok' | 'quiet' | 'warn' | 'err'; hint: string }> = {
  idle: { text: 'Idle', cls: '', hint: 'Not listening right now.' },
  paused: { text: 'Paused', cls: '', hint: 'Paused: nothing is being listened to.' },
  unavailable: { text: 'Not connected', cls: 'err', hint: 'Windows says this device is off or unplugged.' },
  listening: { text: 'Listening', cls: 'ok', hint: 'Hearing sound and turning it into text.' },
  quiet: { text: 'Quiet', cls: 'quiet', hint: 'Audio is arriving; nobody has spoken for a few seconds. That is normal.' },
  muted: { text: 'Quiet (muted?)', cls: 'warn', hint: "Pure silence from the mic for a minute. Fine if you've been listening; if you've been talking, check the headset's mute." },
  no_audio: { text: 'No audio arriving', cls: 'err', hint: 'The device stopped sending audio. Waiting for it to come back; no other device is used.' },
  reconnecting_device: { text: 'Reconnecting device…', cls: 'warn', hint: 'The same device is back; reopening it.' },
  not_transcribing: { text: 'Not transcribing', cls: 'warn', hint: 'Audio is arriving but no text is coming back. The app reconnects the speech service by itself; the gap is marked.' },
}
