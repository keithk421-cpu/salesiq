import { describe, expect, it } from 'vitest'
import { cardChecks, findCapabilityClaim } from '../src/main/help/protocol'
import type { HelpCardContent } from '../src/shared/help'

const CLAIM_CHECK = 'Says what Arize can do without an approved source. Check it before saying it.'
const turnOnly = new Map([['T1', 'turn' as const]])
const card = (over: Partial<HelpCardContent>): HelpCardContent => ({
  move: 'technical_clarification', primary_kind: 'say', primary: 'Good question.', happening: null, follow_up: null, source_ids: ['T1'], note: null, ...over,
})

describe('capability claims (live "check before saying" note and Level 1)', () => {
  it('a hedge only excuses a claim in its own clause', () => {
    for (const line of [
      'Let me check the details, but we support SAML SSO on SaaS.',
      "I'll confirm pricing later, but Arize supports SCIM provisioning today.",
      'Good that you ask - we support self-hosted on Kubernetes.',
      'Good that you ask — we support self-hosted on Kubernetes.',
      'Let me verify one thing: we support SSO on every plan.',
      'You can see we support SSO out of the box.',
    ]) {
      expect(findCapabilityClaim(line), line).not.toBeNull()
      expect(cardChecks(card({ primary: line }), [], turnOnly), line).toEqual([CLAIM_CHECK])
    }
  })

  it('checking, asking and everyday "we have" are still not claims', () => {
    for (const line of [
      'Let me confirm we support that for self-hosted before I answer.',
      'I want to check whether, on self-hosted, we support SSO.',
      'Can we provide the questionnaire answers in parallel with the technical evaluation?',
      'Okay, so could we offer that as part of the pilot?',
      'How would we support that on your side?',
      'Which languages are supported in your stack today?',
      'We have a call next week',
      'Can we have 15 minutes with your security lead?',
      'Sounds like we have alignment on the pilot scope.',
      'Once we have the traces, we can compare runs.',
      'Self-hosted is a common ask - what does your security team prefer?',
    ]) {
      expect(findCapabilityClaim(line), line).toBeNull()
    }
  })

  it('a hedge in one field never excuses a claim in another field', () => {
    const hedged = card({ primary: 'Let me confirm the details with our SA.', follow_up: 'We support SAML SSO on SaaS.' })
    expect(cardChecks(hedged, [], turnOnly)).toEqual([CLAIM_CHECK])
    expect(cardChecks(card({ primary: 'Let me check on that', happening: 'Arize supports SCIM provisioning' }), [], turnOnly)).toEqual([CLAIM_CHECK])
    // Citing approved knowledge clears it.
    expect(cardChecks({ ...hedged, source_ids: ['K1'] }, [], new Map([['K1', 'knowledge' as const]]))).toEqual([])
  })
})
