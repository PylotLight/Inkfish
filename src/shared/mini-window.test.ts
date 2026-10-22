import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MINI_WINDOW_SETTINGS,
  MINI_WINDOW_CASCADE_STEP,
  MINI_WINDOW_DEFAULT_SIZE,
  MINI_WINDOW_MARGIN,
  acceleratorFromKeyEvent,
  cascadeMiniBounds,
  clampMiniBounds,
  formatAccelerator,
  freeMiniSlot,
  initialMiniBounds,
  isPopKey,
  miniDisplayKey,
  miniHash,
  minimalEdit,
  noteIdFromMiniHash,
  normalizeAccelerator,
  parseMiniGeometry,
  parseMiniSlots,
  parseMiniWindowSettings,
  shortcutClash,
  snapMiniToCorner,
  withMiniSlot
} from './mini-window'

const wa = { x: 0, y: 25, width: 1440, height: 875 }

describe('settings', () => {
  test("defaults, and the default toggle is not 1Password's ⌘⇧Space", () => {
    expect(parseMiniWindowSettings(undefined)).toEqual(DEFAULT_MINI_WINDOW_SETTINGS)
    expect(shortcutClash(DEFAULT_MINI_WINDOW_SETTINGS.shortcut, true)).toBeNull()
    expect(shortcutClash(DEFAULT_MINI_WINDOW_SETTINGS.shortcut, false)).toBeNull()
  })
  test('explicit empty shortcut turns it off; junk keeps the default', () => {
    expect(parseMiniWindowSettings({ shortcut: '' }).shortcut).toBe('')
    expect(parseMiniWindowSettings({ shortcut: 'shift+a' }).shortcut).toBe(DEFAULT_MINI_WINDOW_SETTINGS.shortcut)
  })
  test('opacity clamped and rounded, booleans kept, delay only from the list', () => {
    expect(parseMiniWindowSettings({ opacity: 0.1 }).opacity).toBe(0.4)
    expect(parseMiniWindowSettings({ opacity: 0.734 }).opacity).toBe(0.73)
    expect(parseMiniWindowSettings({ tuckToEdge: false, snapToCorners: false }).tuckToEdge).toBe(false)
    expect(parseMiniWindowSettings({ peekDelayMs: 600 }).peekDelayMs).toBe(600)
    expect(parseMiniWindowSettings({ peekDelayMs: 123 }).peekDelayMs).toBe(350)
  })
})

describe('accelerators', () => {
  test('normalize, need a non-Shift modifier', () => {
    expect(normalizeAccelerator('cmd+shift+space')).toBe('Command+Shift+Space')
    expect(normalizeAccelerator('ctrl+alt+m')).toBe('Control+Alt+M')
    expect(normalizeAccelerator('shift+m')).toBeNull()
    expect(normalizeAccelerator('m')).toBeNull()
  })
  test("clash warnings: 1Password, Spotlight, Inkfish's own keys", () => {
    expect(shortcutClash('Command+Shift+Space', true)).toBe('1Password Quick Access')
    expect(shortcutClash('CommandOrControl+Shift+Space', true)).toBe('1Password Quick Access')
    expect(shortcutClash('Control+Shift+Space', false)).toBe('1Password Quick Access')
    expect(shortcutClash('Command+Space', true)).toBe('Spotlight')
    expect(shortcutClash('Command+Space', false)).toBeNull()
    expect(shortcutClash('Alt+Space', true)).toBe('Inkfish quick capture')
    expect(shortcutClash('Command+Shift+M', true)).toBe('Inkfish pop out / return (in-app)')
  })
  test('key events and formatting', () => {
    const ev = { key: 'm', code: 'KeyM', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }
    expect(acceleratorFromKeyEvent(ev, true)).toBe('Control+Alt+M')
    expect(formatAccelerator('Control+Alt+M', true)).toBe('⌃⌥M')
    expect(formatAccelerator('Control+Alt+M', false)).toBe('Ctrl+Alt+M')
    expect(formatAccelerator('', true)).toBe('Off')
  })
  test('pop key is ⌘⇧M / Ctrl+Shift+M only', () => {
    expect(isPopKey({ key: 'M', code: 'KeyM', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(
      true
    )
    expect(isPopKey({ key: 'm', code: 'KeyM', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false })).toBe(
      true
    )
    expect(isPopKey({ key: 'm', code: 'KeyM', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(
      false
    )
  })
})

describe('geometry', () => {
  test('first open: top-right corner, saved spot clamped onto the display', () => {
    const b = initialMiniBounds(wa, undefined)
    expect(b).toEqual({
      x: wa.width - MINI_WINDOW_DEFAULT_SIZE.width - MINI_WINDOW_MARGIN,
      y: wa.y + MINI_WINDOW_MARGIN,
      ...MINI_WINDOW_DEFAULT_SIZE
    })
    expect(initialMiniBounds(wa, { x: 5000, y: -50, width: 300, height: 300 })).toEqual({
      x: 1140,
      y: 25,
      width: 300,
      height: 300
    })
    expect(clampMiniBounds({ x: 0, y: 0, width: 10, height: 10 }, wa).width).toBe(240)
  })
  test('corner snap only near both edges', () => {
    expect(snapMiniToCorner({ x: 10, y: 40, width: 300, height: 300 }, wa)).toEqual({
      x: 16,
      y: 41,
      width: 300,
      height: 300
    })
    expect(snapMiniToCorner({ x: 10, y: 300, width: 300, height: 300 }, wa)).toBeNull()
  })
  test('display keys + geometry parsing drop junk', () => {
    expect(miniDisplayKey(wa)).toBe('0,25,1440x875')
    expect(parseMiniGeometry({ a: { x: 1, y: 2, width: 3, height: 4 }, b: { x: 'no' } })).toEqual({
      a: { x: 1, y: 2, width: 3, height: 4 }
    })
  })
  test('slots and cascade', () => {
    expect(freeMiniSlot([0, 1, 3])).toBe(2)
    expect(freeMiniSlot([0, 1, 2, 3, 4, 5])).toBeNull()
    const a = initialMiniBounds(wa, undefined)
    const b = cascadeMiniBounds(a, [a], wa)
    expect(b.x).toBe(a.x - MINI_WINDOW_CASCADE_STEP)
    expect(b.y).toBe(a.y + MINI_WINDOW_CASCADE_STEP)
    const slots = withMiniSlot([], 2, { k: a })
    expect(slots.slots).toHaveLength(3)
    expect(parseMiniSlots(slots, parseMiniGeometry)[2]).toEqual({ k: a })
    expect(withMiniSlot(slots.slots, 2, {}).slots).toHaveLength(0)
  })
})

describe('live sync', () => {
  test('minimal edit keeps the shared prefix/suffix', () => {
    expect(minimalEdit('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' })
    expect(minimalEdit('abc', 'abc')).toBeNull()
    expect(minimalEdit('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' })
    const apply = (s: string, e: { from: number; to: number; insert: string }): string =>
      s.slice(0, e.from) + e.insert + s.slice(e.to)
    for (const [x, y] of [
      ['', 'x'],
      ['x', ''],
      ['abcabc', 'abXabc'],
      ['- [ ] a\n', '- [x] a\n']
    ] as const) {
      expect(apply(x, minimalEdit(x, y)!)).toBe(y)
    }
  })
  test('mini hash round-trips note ids with spaces and slashes', () => {
    const id = 'personal/Untitled 2.md'
    expect(noteIdFromMiniHash(`#${miniHash(id)}`)).toBe(id)
    expect(noteIdFromMiniHash('#capture')).toBeNull()
  })
})
