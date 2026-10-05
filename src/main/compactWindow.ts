/**
 * Compact window: a small strip (about 460 x 240) that stays on top of Zoom with just HELP, WRAP, a
 * status dot, the card's line with its checks and the approved note's first line. Where the window
 * sits is remembered for each mode (app settings), and a remembered place is only used again while
 * it's still on a screen (a monitor unplugged since would otherwise put the window out of reach).
 * Index.ts does the Electron part; these rules are kept here so they can be tested.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where the window was last time, in each mode. */
export interface WindowBounds {
  normal?: Rect
  compact?: Rect
}

export const COMPACT_SIZE = { width: 460, height: 240 }
/** Gap from the screen's edge for a first-time compact strip (top right, clear of Zoom's own controls). */
const EDGE = 16
/** At least this much of the window's top (where it can be dragged) must be on a screen. */
const GRAB = { width: 120, height: 40 }

/** A saved rectangle, or null if it isn't one (a hand-edited or older settings file). */
export function cleanRect(raw: unknown): Rect | null {
  const r = raw as Partial<Record<keyof Rect, unknown>> | null
  if (!r || typeof r !== 'object') return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  const x = n(r.x)
  const y = n(r.y)
  const width = n(r.width)
  const height = n(r.height)
  if (x === null || y === null || width === null || height === null || width < 200 || height < 120) return null
  return { x, y, width, height }
}

/** Saved bounds for both modes, keeping only the ones that are real rectangles. */
export function cleanBounds(raw: unknown): WindowBounds | undefined {
  const b = raw as { normal?: unknown; compact?: unknown } | null
  if (!b || typeof b !== 'object') return undefined
  const normal = cleanRect(b.normal)
  const compact = cleanRect(b.compact)
  if (!normal && !compact) return undefined
  return { ...(normal ? { normal } : {}), ...(compact ? { compact } : {}) }
}

/** Enough of the window's top edge is on one of the screens (their work areas) to see and drag it. */
export function onScreen(r: Rect, workAreas: Rect[]): boolean {
  return workAreas.some((a) => {
    const w = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x)
    const topInside = r.y >= a.y && r.y + GRAB.height <= a.y + a.height
    return topInside && w >= Math.min(GRAB.width, r.width)
  })
}

/** A first-time compact strip: top right of the screen the window is on. */
export function defaultCompactRect(workArea: Rect): Rect {
  return {
    x: workArea.x + Math.max(0, workArea.width - COMPACT_SIZE.width - EDGE),
    y: workArea.y + EDGE,
    width: COMPACT_SIZE.width,
    height: COMPACT_SIZE.height,
  }
}

/** The full window when there's no remembered place for it: the usual size, centred on the screen it's on. */
export function defaultNormalRect(workArea: Rect): Rect {
  const width = Math.min(1100, workArea.width)
  const height = Math.min(900, workArea.height)
  return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height }
}

/** Where to put the window for a mode: its remembered place while that's still on a screen, else the fallback. */
export function placeFor(saved: Rect | undefined, workAreas: Rect[], fallback: Rect | null): Rect | null {
  return saved && onScreen(saved, workAreas) ? saved : fallback
}
