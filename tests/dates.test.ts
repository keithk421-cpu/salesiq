import { afterAll, describe, expect, it } from 'vitest'
import { isStale } from '../src/main/knowledge'
import { daysUntilReview, expiresLabel, isPastReview } from '../src/shared/dates'
import type { KnowledgeDocMeta } from '../src/shared/help'

// Keith's clock is behind UTC: reading "2026-10-10" as UTC midnight made a file stale the evening before.
const savedTz = process.env.TZ
process.env.TZ = 'America/New_York'
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

const meta = (review_by: string | null): KnowledgeDocMeta => ({
  doc_id: 'faq', title: 'Security FAQ', category: 'deployment_security', source: 'faq.md', version: '1', content_hash: 'h',
  approved: true, needs_reapproval: false, approved_by: null, approved_at: null, review_by, applies_to: [], tags: [], file: 'faq.md',
})

describe('review_by is a local calendar date', () => {
  it('runs in a time zone behind UTC', () => {
    expect(new Date(2026, 9, 9, 21, 0).getTimezoneOffset()).toBe(240)
  })

  it('is current through the whole review date and stale from local midnight after it', () => {
    const eveningBefore = new Date(2026, 9, 9, 21, 0) // already Oct 10 in UTC
    const lateOnTheDay = new Date(2026, 9, 10, 23, 59)
    const justAfter = new Date(2026, 9, 11, 0, 1)
    expect([eveningBefore, lateOnTheDay, justAfter].map((now) => isStale(meta('2026-10-10'), now))).toEqual([false, false, true])
    expect([eveningBefore, lateOnTheDay, justAfter].map((now) => isPastReview('2026-10-10', now))).toEqual([false, false, true])
    expect([eveningBefore, lateOnTheDay, justAfter].map((now) => daysUntilReview('2026-10-10', now))).toEqual([1, 0, -1])
  })

  it('labels the Setup tag in whole local days, "Expires today" on the date itself', () => {
    expect(expiresLabel('2026-10-10', new Date(2026, 9, 9, 21, 0))).toBe('Expires in 1 day')
    expect(expiresLabel('2026-10-10', new Date(2026, 9, 10, 8, 0))).toBe('Expires today')
    expect(expiresLabel('2026-10-10', new Date(2026, 9, 11, 0, 1))).toBeNull()
    expect(expiresLabel('2026-10-24', new Date(2026, 9, 10, 23, 0))).toBe('Expires in 14 days')
    expect(expiresLabel('2026-10-25', new Date(2026, 9, 10, 23, 0))).toBeNull()
  })

  it('counts calendar days across a daylight-saving change', () => {
    // Clocks go back on Nov 1, 2026: still five calendar days from Oct 31 to Nov 5, late evening or not.
    expect(daysUntilReview('2026-11-05', new Date(2026, 9, 31, 23, 30))).toBe(5)
    expect(daysUntilReview('2026-11-05', new Date(2026, 9, 31, 0, 30))).toBe(5)
    expect(expiresLabel('2026-11-05', new Date(2026, 10, 4, 23, 30))).toBe('Expires in 1 day')
  })

  it('reads other date wording as the same calendar day; no date, or one that cannot be read, is never stale', () => {
    expect(daysUntilReview('October 10, 2026', new Date(2026, 9, 9, 21, 0))).toBe(1)
    expect(daysUntilReview('2026-10-10T00:00:00Z', new Date(2026, 9, 9, 21, 0))).toBe(1)
    // A day past the month's end rolls over, as it always has.
    expect(daysUntilReview('2026-02-30', new Date(2026, 1, 28, 22, 0))).toBe(2)
    for (const bad of [null, '', 'soon', '2026-13-01', '2026-10-00']) {
      expect(isStale(meta(bad), new Date(2030, 0, 1)), String(bad)).toBe(false)
      expect(expiresLabel(bad, new Date(2026, 1, 20)), String(bad)).toBeNull()
    }
  })
})
