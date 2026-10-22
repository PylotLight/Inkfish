import { describe, expect, test } from 'bun:test'
import {
  TAB_DRAG_START,
  TAB_TEAR_DISTANCE,
  TEAR_GRAB_OFFSET,
  miniHintText,
  popOutTitle,
  shouldShowMiniHint,
  tabDragPhase,
  tearOutBounds
} from './mini-window-tear'

const bar = { left: 200, top: 40, right: 1200, bottom: 76 }
const vp = { width: 1280, height: 800 }
const start = { x: 300, y: 58 }

describe('tabDragPhase', () => {
  test('a small wobble is still a press (click)', () => {
    expect(tabDragPhase(start, { x: start.x + TAB_DRAG_START - 1, y: start.y }, bar, vp)).toBe('press')
  })
  test('sideways along the strip is a drag, not a tear', () => {
    expect(tabDragPhase(start, { x: 900, y: 60 }, bar, vp)).toBe('drag')
  })
  test('just below the strip is still a drag', () => {
    expect(tabDragPhase(start, { x: 300, y: bar.bottom + TAB_TEAR_DISTANCE - 1 }, bar, vp)).toBe('drag')
  })
  test('pulled down past the tear distance tears', () => {
    expect(tabDragPhase(start, { x: 300, y: bar.bottom + TAB_TEAR_DISTANCE }, bar, vp)).toBe('tear')
  })
  test('pulled above the strip tears too', () => {
    expect(tabDragPhase({ x: 300, y: 70 }, { x: 300, y: 70 - 60 - TAB_TEAR_DISTANCE }, { ...bar, top: 70 }, vp)).toBe(
      'tear'
    )
  })
  test('out of the window (any side) tears', () => {
    expect(tabDragPhase(start, { x: -5, y: 58 }, bar, vp)).toBe('tear')
    expect(tabDragPhase(start, { x: 1290, y: 58 }, bar, vp)).toBe('tear')
    expect(tabDragPhase(start, { x: 300, y: -3 }, bar, vp)).toBe('tear')
    expect(tabDragPhase(start, { x: 300, y: 900 }, bar, vp)).toBe('tear')
  })
})

describe('tearOutBounds', () => {
  const wa = { x: 0, y: 25, width: 1440, height: 875 }
  test('puts the pointer on the grab spot', () => {
    expect(tearOutBounds({ x: 700, y: 400 }, { width: 360, height: 440 }, wa)).toEqual({
      x: 700 - TEAR_GRAB_OFFSET.x,
      y: 400 - TEAR_GRAB_OFFSET.y,
      width: 360,
      height: 440
    })
  })
  test('stays inside the work area near an edge', () => {
    const r = tearOutBounds({ x: 1435, y: 890 }, { width: 360, height: 440 }, wa)
    expect(r.x + r.width).toBeLessThanOrEqual(wa.x + wa.width)
    expect(r.y + r.height).toBeLessThanOrEqual(wa.y + wa.height)
    const tl = tearOutBounds({ x: 5, y: 0 }, { width: 360, height: 440 }, wa)
    expect(tl.x).toBe(0)
    expect(tl.y).toBe(25)
  })
  test('works on a second display left of the primary', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1050 }
    expect(tearOutBounds({ x: -1000, y: 300 }, { width: 360, height: 440 }, left).x).toBe(-1000 - TEAR_GRAB_OFFSET.x)
  })
})

describe('pop-out tooltip', () => {
  test('mac names both keys', () => {
    expect(popOutTitle('Control+Alt+M', true)).toBe('Pop out to mini window (⇧⌘M) · ⌃⌥M shows/hides minis from any app')
  })
  test('no global toggle set (dev profile)', () => {
    expect(popOutTitle('', true)).toBe('Pop out to mini window (⇧⌘M)')
    expect(popOutTitle(null, false)).toBe('Pop out to mini window (Ctrl+Shift+M)')
  })
})

describe('tuck hint', () => {
  test('shows once, only with tucking on and not yet docked', () => {
    expect(shouldShowMiniHint(null, { tuckEnabled: true, docked: false })).toBe(true)
    expect(shouldShowMiniHint('1', { tuckEnabled: true, docked: false })).toBe(false)
    expect(shouldShowMiniHint(null, { tuckEnabled: false, docked: false })).toBe(false)
    expect(shouldShowMiniHint(null, { tuckEnabled: true, docked: true })).toBe(false)
    expect(shouldShowMiniHint(null, null)).toBe(false)
  })
  test('text mentions the toggle only when set', () => {
    expect(miniHintText('Control+Alt+M', true)).toContain('⌃⌥M shows/hides')
    expect(miniHintText('', true)).not.toContain('shows/hides')
  })
})
