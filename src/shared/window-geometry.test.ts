import { describe, expect, test } from 'bun:test'
import {
  boundsToShow,
  fitBoundsToDisplays,
  isUsableRect,
  parseSavedWindowState,
  planMainWindow
} from './window-geometry'

const MIN = { width: 980, height: 640 }
const laptop = { x: 0, y: 25, width: 1512, height: 920 }
const external = { x: 1512, y: 0, width: 2560, height: 1415 }

describe('parseSavedWindowState', () => {
  test('accepts a valid record and rounds', () => {
    expect(parseSavedWindowState({ bounds: { x: 10.4, y: 20, width: 1200, height: 800 }, maximized: true })).toEqual({
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      maximized: true,
      fullScreen: false
    })
  })
  test('rejects junk', () => {
    expect(parseSavedWindowState(null)).toBeNull()
    expect(parseSavedWindowState({ bounds: { x: 0, y: 0, width: 0, height: 10 } })).toBeNull()
    expect(parseSavedWindowState({ bounds: { x: 'a', y: 0, width: 10, height: 10 } })).toBeNull()
  })
})

describe('fitBoundsToDisplays', () => {
  test('keeps bounds that are fully on a display', () => {
    const b = { x: 1700, y: 100, width: 1300, height: 900 }
    expect(fitBoundsToDisplays(b, [laptop, external], MIN)).toEqual(b)
  })
  test('null when the display it was on is gone', () => {
    expect(fitBoundsToDisplays({ x: 1700, y: 100, width: 1300, height: 900 }, [laptop], MIN)).toBeNull()
  })
  test('shrinks and nudges onto the display it mostly overlaps', () => {
    expect(fitBoundsToDisplays({ x: 400, y: 0, width: 1400, height: 1000 }, [laptop], MIN)).toEqual({
      x: 112,
      y: 25,
      width: 1400,
      height: 920
    })
  })
})

describe('boundsToShow', () => {
  test('leaves on-screen bounds alone', () => {
    const b = { x: 100, y: 100, width: 1200, height: 800 }
    expect(boundsToShow(b, [laptop, external], MIN, laptop)).toEqual(b)
  })
  test('centres on the fallback when the display it was on is gone', () => {
    expect(boundsToShow({ x: 1700, y: 100, width: 1300, height: 900 }, [laptop], MIN, laptop)).toEqual({
      x: 106,
      y: 35,
      width: 1300,
      height: 900
    })
  })
  test('centres a zero-size or junk window at the minimum size', () => {
    expect(boundsToShow({ x: 0, y: 0, width: 0, height: 0 }, [laptop], MIN, laptop)).toEqual({
      x: 266,
      y: 165,
      width: 980,
      height: 640
    })
    expect(boundsToShow({ x: Number.NaN, y: 0, width: 1200, height: 800 }, [laptop], MIN, laptop).width).toBe(980)
  })
  test('way offscreen (negative coords) comes back', () => {
    const r = boundsToShow({ x: -30000, y: -30000, width: 1200, height: 800 }, [laptop, external], MIN, laptop)
    expect(r.x).toBeGreaterThanOrEqual(laptop.x)
    expect(r.y).toBeGreaterThanOrEqual(laptop.y)
  })
})

describe('isUsableRect', () => {
  test('accepts a finite positive rect', () => {
    expect(isUsableRect({ x: 100, y: 100, width: 1200, height: 800 })).toBe(true)
  })
  test('rejects missing, zero-size and non-finite rects', () => {
    expect(isUsableRect(null)).toBe(false)
    expect(isUsableRect(undefined)).toBe(false)
    expect(isUsableRect({ x: 0, y: 0, width: 0, height: 0 })).toBe(false)
    expect(isUsableRect({ x: 0, y: 0, width: 800, height: -1 })).toBe(false)
    expect(isUsableRect({ x: Number.NaN, y: 0, width: 800, height: 600 })).toBe(false)
    expect(isUsableRect({ x: 0, y: Number.POSITIVE_INFINITY, width: 800, height: 600 })).toBe(false)
  })
  test('honours the minimum size when one is given', () => {
    expect(isUsableRect({ x: 0, y: 0, width: 500, height: 400 }, MIN)).toBe(false)
    expect(isUsableRect({ x: 0, y: 0, width: 980, height: 640 }, MIN)).toBe(true)
  })
})

describe('planMainWindow', () => {
  test('missing or destroyed → create', () => {
    expect(planMainWindow({ exists: false, destroyed: false, crashed: false })).toBe('create')
    expect(planMainWindow({ exists: true, destroyed: true, crashed: false })).toBe('create')
  })
  test('crashed renderer → reload, healthy → reuse', () => {
    expect(planMainWindow({ exists: true, destroyed: false, crashed: true })).toBe('reload')
    expect(planMainWindow({ exists: true, destroyed: false, crashed: false })).toBe('reuse')
  })
})
