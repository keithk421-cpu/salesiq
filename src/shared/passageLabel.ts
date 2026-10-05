/**
 * The label on the HELP card's approved note. What the note is about (its section heading) comes
 * before the file it is from, so a narrow window or a long file title never hides the topic.
 */
import type { ApprovedPassage } from './help'

const SCOPE_NOTE: Record<string, string> = { saas: ' (SaaS only)', self_hosted: ' (self-hosted only)' }

export function passageLabel(p: Pick<ApprovedPassage, 'title' | 'heading' | 'applies_to'>): string {
  const scope = p.applies_to.length && !p.applies_to.includes('all') ? p.applies_to.map((a) => SCOPE_NOTE[a] ?? ` (${a.replace(/_/g, ' ')} only)`).join('') : ''
  const about = p.heading && p.heading !== p.title ? `${p.heading} · ${p.title}` : p.title
  return `Approved note${scope} · ${about}`
}
