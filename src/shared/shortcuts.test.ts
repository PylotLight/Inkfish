import { describe, expect, test } from 'bun:test'
import { formatAccelerator, rawAcceleratorFromKeyEvent } from './mini-window'
import {
  knownShortcutsWith,
  normalizeGlobalShortcut,
  ownShortcutConflict,
  parseShortcutSettings,
  sameShortcut,
  validateGlobalShortcut
} from './shortcuts'
import { resolveProfile, shortcutsDisabled } from './profile'

const DEFAULTS = { capture: 'Alt+Space', daily: 'Shift+Alt+Space' }
const key = (
  code: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {},
  k = ''
) => ({
  code,
  key: k,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift
})

describe('normalizeGlobalShortcut', () => {
  test('normalizes modifier names and order', () => {
    expect(normalizeGlobalShortcut('option+shift+space')).toBe('Alt+Shift+Space')
    expect(normalizeGlobalShortcut('cmd+ctrl+k')).toBe('Command+Control+K')
  })
  test('rejects bare keys and Shift-only combos', () => {
    expect(normalizeGlobalShortcut('Space')).toBeNull()
    expect(normalizeGlobalShortcut('K')).toBeNull()
    expect(normalizeGlobalShortcut('Shift+K')).toBeNull()
  })
  test('function keys may stand alone or with Shift', () => {
    expect(normalizeGlobalShortcut('f13')).toBe('F13')
    expect(normalizeGlobalShortcut('Shift+F5')).toBe('Shift+F5')
    expect(normalizeGlobalShortcut('F5+Shift')).toBe('Shift+F5')
    expect(normalizeGlobalShortcut('Alt+F5')).toBe('Alt+F5')
    expect(normalizeGlobalShortcut('F25')).toBeNull()
  })
  test('rejects junk', () => {
    expect(normalizeGlobalShortcut('')).toBeNull()
    expect(normalizeGlobalShortcut('Alt+')).toBeNull()
    expect(normalizeGlobalShortcut('Alt+K+J')).toBeNull()
    expect(normalizeGlobalShortcut(42)).toBeNull()
  })
})

describe('validateGlobalShortcut', () => {
  test("'' turns it off", () => {
    expect(validateGlobalShortcut('', true)).toEqual({ ok: true, accelerator: '' })
  })
  test('accepts and normalizes a good combo', () => {
    expect(validateGlobalShortcut('Shift+Alt+Space', true)).toEqual({ ok: true, accelerator: 'Alt+Shift+Space' })
  })
  test('bare key: asks for a modifier (platform words)', () => {
    const mac = validateGlobalShortcut('Space', true)
    expect(mac.ok).toBe(false)
    if (!mac.ok) expect(mac.error).toContain('⌘, ⌃ or ⌥')
    const win = validateGlobalShortcut('Shift+K', false)
    if (!win.ok) expect(win.error).toContain('Ctrl, Alt or Super')
    else throw new Error('Shift+K should be refused')
  })
  test('modifiers only / two keys / unknown key', () => {
    expect(validateGlobalShortcut('Alt+Shift', true).ok).toBe(false)
    expect(validateGlobalShortcut('Alt+K+J', true).ok).toBe(false)
    const bad = validateGlobalShortcut('Alt+Banana', true)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('Banana')
  })
})

describe('parseShortcutSettings', () => {
  test('missing / garbage → defaults', () => {
    expect(parseShortcutSettings(undefined, DEFAULTS)).toEqual(DEFAULTS)
    expect(parseShortcutSettings({ capture: 'Space', daily: 7 }, DEFAULTS)).toEqual(DEFAULTS)
  })
  test("'' turns one off, valid values are normalized", () => {
    expect(parseShortcutSettings({ capture: 'ctrl+alt+n', daily: '' }, DEFAULTS)).toEqual({
      capture: 'Control+Alt+N',
      daily: ''
    })
    expect(parseShortcutSettings({ capture: 'F13' }, DEFAULTS)).toEqual({ capture: 'F13', daily: DEFAULTS.daily })
  })
})

describe('conflicts', () => {
  test('sameShortcut ignores modifier order and resolves CommandOrControl', () => {
    expect(sameShortcut('Shift+Alt+Space', 'Alt+Shift+Space', true)).toBe(true)
    expect(sameShortcut('CommandOrControl+K', 'Command+K', true)).toBe(true)
    expect(sameShortcut('CommandOrControl+K', 'Command+K', false)).toBe(false)
    expect(sameShortcut('', 'Alt+Space', true)).toBe(false)
  })
  test("ownShortcutConflict names Inkfish's other shortcut", () => {
    expect(ownShortcutConflict('Control+Alt+M', { 'mini window show/hide': 'Control+Alt+M' }, true)).toBe(
      "⌃⌥M is already Inkfish's mini window show/hide shortcut."
    )
    expect(ownShortcutConflict('Alt+Space', { daily: 'Alt+Shift+Space' }, true)).toBeNull()
    expect(ownShortcutConflict('', { daily: '' }, true)).toBeNull()
  })
  test('knownShortcutsWith swaps in the configured capture keys', () => {
    const known = knownShortcutsWith({ capture: 'Control+Alt+N', daily: '' })
    expect(known.find((k) => k.owner === 'Inkfish quick capture')?.accelerator).toBe('Control+Alt+N')
    expect(known.some((k) => k.owner === 'Inkfish append to today')).toBe(false)
    expect(known.some((k) => k.accelerator === 'Alt+Space')).toBe(false)
    expect(known.some((k) => k.owner === 'Spotlight')).toBe(true)
  })
})

describe('recording + formatting', () => {
  test('raw key events keep bare keys so Settings can explain the refusal', () => {
    expect(rawAcceleratorFromKeyEvent(key('Space', {}, ' '), true)).toBe('Space')
    expect(rawAcceleratorFromKeyEvent(key('AltLeft', { alt: true }, 'Alt'), true)).toBeNull()
    expect(rawAcceleratorFromKeyEvent(key('Space', { alt: true, shift: true }, ' '), true)).toBe('Alt+Shift+Space')
    expect(rawAcceleratorFromKeyEvent(key('F13', {}, 'F13'), true)).toBe('F13')
  })
  test('formats Mac symbols and other-platform words', () => {
    expect(formatAccelerator('Alt+Shift+Space', true)).toBe('⌥⇧Space')
    expect(formatAccelerator('Alt+Shift+Space', false)).toBe('Alt+Shift+Space')
    expect(formatAccelerator('Control+Alt+N', false)).toBe('Ctrl+Alt+N')
    expect(formatAccelerator('F13', true)).toBe('F13')
    expect(formatAccelerator('', true)).toBe('Off')
  })
})

describe('profile defaults', () => {
  test('INKFISH_SHORTCUTS=off disables', () => {
    expect(shortcutsDisabled('off')).toBe(true)
    expect(shortcutsDisabled(' NONE ')).toBe(true)
    expect(shortcutsDisabled(undefined)).toBe(false)
    expect(resolveProfile({ isPackaged: true }).captureShortcut).toBe('Alt+Space')
    expect(resolveProfile({ isPackaged: true, shortcutsEnv: 'off' }).captureShortcut).toBe('')
  })
})
