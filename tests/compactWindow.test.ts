import { describe, expect, it } from 'vitest'
import { loadAppSettings } from '../src/main/appRules'
import { COMPACT_SIZE, cleanBounds, cleanRect, defaultCompactRect, defaultNormalRect, onScreen, placeFor } from '../src/main/compactWindow'

const laptop = { x: 0, y: 0, width: 1920, height: 1040 }
const second = { x: 1920, y: 0, width: 2560, height: 1400 }

describe('compact window', () => {
  it('a first compact strip is about 460 x 240, top right of the screen the window is on', () => {
    expect(COMPACT_SIZE).toEqual({ width: 460, height: 240 })
    expect(defaultCompactRect(laptop)).toEqual({ x: 1444, y: 16, width: 460, height: 240 })
    expect(defaultCompactRect(second)).toEqual({ x: 1920 + 2560 - 476, y: 16, width: 460, height: 240 })
  })

  it('goes back to where it was in each mode, unless that place is no longer on a screen', () => {
    const onSecond = { x: 2400, y: 100, width: 460, height: 240 }
    expect(placeFor(onSecond, [laptop, second], null)).toEqual(onSecond)
    // The second monitor was unplugged: use the fallback instead of a window nobody can reach.
    const fallback = defaultCompactRect(laptop)
    expect(placeFor(onSecond, [laptop], fallback)).toEqual(fallback)
    expect(placeFor(undefined, [laptop], fallback)).toEqual(fallback)
    expect(placeFor(undefined, [laptop], null)).toBeNull()
    // Expand with nowhere remembered: the usual size, centred (smaller on a small screen).
    expect(defaultNormalRect(laptop)).toEqual({ x: 410, y: 70, width: 1100, height: 900 })
    expect(defaultNormalRect({ x: 0, y: 0, width: 1280, height: 680 })).toEqual({ x: 90, y: 0, width: 1100, height: 680 })
  })

  it('a window counts as on screen only if its top edge can be seen and dragged', () => {
    expect(onScreen({ x: 100, y: 100, width: 1100, height: 900 }, [laptop])).toBe(true)
    expect(onScreen({ x: 1850, y: 100, width: 1100, height: 900 }, [laptop])).toBe(false) // only 70 px showing
    expect(onScreen({ x: 100, y: -300, width: 1100, height: 900 }, [laptop])).toBe(false) // title bar above the screen
    expect(onScreen({ x: 100, y: 1020, width: 1100, height: 900 }, [laptop])).toBe(false) // below the taskbar
  })

  it('keeps only real rectangles from the settings file', () => {
    expect(cleanRect({ x: 10.4, y: 20, width: 460, height: 240 })).toEqual({ x: 10, y: 20, width: 460, height: 240 })
    expect(cleanRect({ x: 10, y: 20, width: 'big', height: 240 })).toBeNull()
    expect(cleanRect({ x: 10, y: 20, width: 50, height: 20 })).toBeNull()
    expect(cleanRect(null)).toBeNull()
    expect(cleanBounds({ normal: { x: 0, y: 0, width: 1100, height: 900 }, compact: 'x' })).toEqual({ normal: { x: 0, y: 0, width: 1100, height: 900 } })
    expect(cleanBounds({ normal: null })).toBeUndefined()
  })

  it('app settings remember both places across restarts', () => {
    const window_bounds = { normal: { x: 50, y: 40, width: 1100, height: 900 }, compact: { x: 1400, y: 16, width: 460, height: 240 } }
    const { settings } = loadAppSettings({ hide_from_capture: true, retention_days: null, retention_confirmed: false, settings_version: 2, window_bounds })
    expect(settings.window_bounds).toEqual(window_bounds)
    expect(loadAppSettings({ settings_version: 2, window_bounds: { normal: 'oops' } as never }).settings.window_bounds).toBeUndefined()
    // Content protection and the other settings are untouched by it.
    expect(settings.hide_from_capture).toBe(true)
  })
})
