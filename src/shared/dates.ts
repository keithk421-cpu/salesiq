/**
 * Knowledge review dates. review_by (YYYY-MM-DD) is a calendar date on Keith's own clock: a document
 * is current through the whole of that day and stale from local midnight after it. (new Date() reads
 * "2026-10-10" as UTC midnight, which in US time zones is the evening before.) Shared by the
 * knowledge index (what HELP may state) and the Setup list's "Expires" tag, so the two always agree.
 */

/** The calendar day a review_by value names, as UTC midnight of that day (a day number, not a moment), or null when it isn't a date. */
function reviewDay(reviewBy: string): number | null {
  const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(reviewBy)
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    // "2026-02-30" rolls into March, as it always has; a month or day that can't exist is not a date.
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? Date.UTC(y, m - 1, d) : null
  }
  // Other wording ("October 10, 2026") is already read as local time; keep its calendar day.
  const t = new Date(reviewBy)
  return Number.isNaN(t.getTime()) ? null : Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())
}

/** Whole days from today (local) to the review date: 0 on the date itself, below 0 once it has passed; null if there's no usable date. */
export function daysUntilReview(reviewBy: string | null | undefined, now = new Date()): number | null {
  const day = reviewBy ? reviewDay(reviewBy) : null
  if (day === null) return null
  // Calendar days compared as UTC dates, so a daylight-saving change never makes a day 23 or 25 hours.
  return Math.round((day - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000)
}

/** Past its review date: true from local midnight after that date. No date (or one that can't be read) is never stale. */
export function isPastReview(reviewBy: string | null | undefined, now = new Date()): boolean {
  const days = daysUntilReview(reviewBy, now)
  return days !== null && days < 0
}

/** The "Expires" tag for a document due for review within two weeks, or null. */
export function expiresLabel(reviewBy: string | null | undefined, now = new Date()): string | null {
  const days = daysUntilReview(reviewBy, now)
  if (days === null || days < 0 || days > 14) return null
  return days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`
}
