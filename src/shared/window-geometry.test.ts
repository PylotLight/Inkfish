import { describe, expect, test } from 'bun:test'
import { fitBoundsToDisplays, parseSavedWindowState } from './window-geometry'

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
