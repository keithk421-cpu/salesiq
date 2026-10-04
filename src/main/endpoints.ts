/**
 * Saved-endpoint resolution. Endpoints are resolved ONLY by endpoint_id.
 * A missing ID is never replaced automatically: we may *suggest* candidates
 * that look like the saved device, but Keith must confirm one explicitly.
 */
import type { AudioEndpointConfig, EndpointRef } from '../shared/contracts'
import type { EndpointInfo, EndpointState, MixFormat } from '../shared/nativeApi'

export interface ResolvedEndpoint {
  saved: EndpointRef
  state: EndpointState
  current: EndpointInfo | null
  /** Suggestions only (never auto-adopted). Populated when the saved ID is not active. */
  candidates: EndpointInfo[]
}

export interface ResolvedConfig {
  system: ResolvedEndpoint
  mic: ResolvedEndpoint
  ready: boolean
  problems: string[]
}

export function formatMix(m?: MixFormat): string {
  if (!m) return ''
  return `${m.sampleRate}Hz/${m.channels}ch/${m.bitsPerSample}bit${m.isFloat ? 'f' : ''}`
}

export function toEndpointRef(e: EndpointInfo): EndpointRef {
  return {
    endpoint_id: e.id,
    data_flow: e.flow,
    friendly_name: e.friendlyName,
    fingerprint: {
      device_description: e.deviceDescription,
      interface_name: e.interfaceName,
      form_factor: e.formFactor,
      mix_format: formatMix(e.mixFormat),
    },
  }
}

export function looksLike(saved: EndpointRef, e: EndpointInfo): boolean {
  if (e.flow !== saved.data_flow || e.id === saved.endpoint_id) return false
  if (e.friendlyName && e.friendlyName === saved.friendly_name) return true
  const fp = saved.fingerprint
  return (
    !!fp.interface_name &&
    e.interfaceName === fp.interface_name &&
    e.deviceDescription === fp.device_description
  )
}

function resolveOne(saved: EndpointRef, all: EndpointInfo[]): ResolvedEndpoint {
  const current = all.find((e) => e.id === saved.endpoint_id) ?? null
  const state: EndpointState = current ? current.state : 'missing'
  const candidates =
    state === 'active' ? [] : all.filter((e) => e.state === 'active' && looksLike(saved, e))
  return { saved, state, current, candidates }
}

export function resolveConfig(config: AudioEndpointConfig, all: EndpointInfo[]): ResolvedConfig {
  const system = resolveOne(config.system_output, all)
  const mic = resolveOne(config.microphone, all)
  const problems: string[] = []
  const describe = (label: string, r: ResolvedEndpoint) => {
    if (r.state === 'active') return
    const what =
      r.state === 'missing'
        ? 'is not found on this PC (unplugged, or Windows gave it a new ID)'
        : `is ${r.state}`
    problems.push(`${label} "${r.saved.friendly_name}" ${what}.`)
  }
  describe('Meeting audio output', system)
  describe('Microphone', mic)
  if (system.current && system.current.flow !== 'render') problems.push('Saved meeting-audio device is not an output device.')
  if (mic.current && mic.current.flow !== 'capture') problems.push('Saved microphone is not an input device.')
  return { system, mic, ready: problems.length === 0, problems }
}

/** Short, non-sensitive form of an endpoint ID for display. */
export function shortId(id: string): string {
  const m = /\{([0-9a-fA-F-]{36})\}\s*$/.exec(id)
  const guid = m ? m[1] : id
  return guid.length > 8 ? `…${guid.slice(-8)}` : guid
}
