import { describe, expect, test } from 'bun:test'
import { intersect, placePopover, popoverMaxWidth, type Rect } from './popover'

// Sidebar 288px wide in an 800px-tall window; sync badge is the first of three right-side
// footer buttons, 28px square, ~4px off the bottom.
const sidebar: Rect = { left: 0, top: 0, right: 288, bottom: 800 }
const badge: Rect = { left: 196, top: 764, right: 224, bottom: 792 }

const inside = (p: { left: number; top: number }, w: number, h: number, b: Rect, pad = 8): void => {
  expect(p.left).toBeGreaterThanOrEqual(b.left + pad)
  expect(p.left + w).toBeLessThanOrEqual(b.right - pad)
  expect(p.top).toBeGreaterThanOrEqual(b.top + pad)
  expect(p.top + h).toBeLessThanOrEqual(b.bottom - pad)
}

describe('placePopover', () => {
  test('wide popover never runs off the left edge of a narrow sidebar', () => {
    const p = placePopover(badge, { width: 300, height: 180 }, sidebar)
    expect(p.maxWidth).toBe(272)
    expect(p.left).toBe(8)
    expect(p.side).toBe('above')
    inside(p, p.maxWidth, 180, sidebar)
  })

  test('small popover right-aligns to the anchor when it fits', () => {
    const p = placePopover(badge, { width: 150, height: 100 }, sidebar)
    expect(p.left).toBe(224 - 150)
    expect(p.top).toBe(764 - 6 - 100)
  })

  test('shifts left when the anchor is near the right edge', () => {
    const a: Rect = { left: 260, top: 764, right: 288, bottom: 792 }
    const p = placePopover(a, { width: 200, height: 100 }, sidebar)
    expect(p.left).toBe(288 - 8 - 200)
  })

  test('stays inside at any sidebar width', () => {
    for (const w of [120, 180, 220, 288, 420]) {
      const b: Rect = { left: 0, top: 0, right: w, bottom: 800 }
      const a: Rect = { left: w - 92, top: 764, right: w - 64, bottom: 792 }
      const p = placePopover(a, { width: 300, height: 200 }, b)
      inside(p, Math.min(300, p.maxWidth), 200, b)
    }
  })

  test('respects a sidebar that does not start at x=0', () => {
    const b: Rect = { left: 48, top: 0, right: 260, bottom: 800 }
    const p = placePopover({ left: 180, top: 764, right: 208, bottom: 792 }, { width: 300, height: 120 }, b)
    expect(p.left).toBe(56)
    expect(p.maxWidth).toBe(260 - 48 - 16)
  })

  test('flips below when there is no room above, and caps height', () => {
    const a: Rect = { left: 196, top: 20, right: 224, bottom: 48 }
    const p = placePopover(a, { width: 200, height: 300 }, sidebar)
    expect(p.side).toBe('below')
    expect(p.top).toBe(48 + 6)
    const short = placePopover(badge, { width: 200, height: 2000 }, sidebar)
    expect(short.side).toBe('above')
    expect(short.maxHeight).toBe(764 - 6 - 8)
    expect(short.top).toBe(8)
  })
})

describe('helpers', () => {
  test('intersect clips the sidebar to the window', () => {
    expect(
      intersect({ left: -10, top: 0, right: 288, bottom: 900 }, { left: 0, top: 0, right: 1000, bottom: 800 })
    ).toEqual({
      left: 0,
      top: 0,
      right: 288,
      bottom: 800
    })
  })

  test('maxWidth never negative and capped', () => {
    expect(popoverMaxWidth({ left: 0, top: 0, right: 10, bottom: 10 })).toBe(0)
    expect(popoverMaxWidth({ left: 0, top: 0, right: 1000, bottom: 10 })).toBe(300)
  })
})
