import { describe, expect, test } from 'bun:test'
import { DEFAULT_PORT } from './sync/protocol'
import {
  cleanProfileName,
  profileBadgeText,
  resolveProfile,
  shortcutLabel,
  shouldIsolateUserData
} from './profile'

describe('resolveProfile', () => {
  test('packaged app is the release profile, unchanged', () => {
    const p = resolveProfile({ isPackaged: true })
    expect(p).toMatchObject({
      kind: 'release',
      name: 'Inkfish',
      badge: '',
      vaultDirName: 'Inkfish',
      syncPort: DEFAULT_PORT,
      captureShortcut: 'Alt+Space',
      dailyShortcut: 'Shift+Alt+Space',
      miniShortcutDefault: 'Control+Alt+M'
    })
  })

  test('unpackaged (bun dev) runs as Inkfish Dev with its own folder, port and keys', () => {
    const p = resolveProfile({ isPackaged: false })
    expect(p.kind).toBe('dev')
    expect(p.name).toBe('Inkfish Dev')
    expect(p.badge).toBe('dev')
    expect(p.vaultDirName).toBe('Inkfish Dev')
    expect(p.syncPort).not.toBe(DEFAULT_PORT)
    expect(p.captureShortcut).not.toBe('Alt+Space')
    expect(p.dailyShortcut).not.toBe('Shift+Alt+Space')
    expect(p.miniShortcutDefault).toBe('')
  })

  test('INKFISH_PROFILE picks a named profile, packaged or not', () => {
    for (const isPackaged of [true, false]) {
      const p = resolveProfile({ isPackaged, profileEnv: ' qa/2 ' })
      expect(p.kind).toBe('custom')
      expect(p.name).toBe('Inkfish qa2')
      expect(p.badge).toBe('qa2')
    }
  })

  test('INKFISH_SHORTCUTS=off registers none', () => {
    const p = resolveProfile({ isPackaged: false, shortcutsEnv: 'off' })
    expect(p.captureShortcut).toBe('')
    expect(p.dailyShortcut).toBe('')
  })

  test('cleanProfileName strips path and shell characters', () => {
    expect(cleanProfileName('../../etc')).toBe('....etc')
    expect(cleanProfileName('  ')).toBe('')
    expect(cleanProfileName(undefined)).toBe('')
  })
})

describe('shouldIsolateUserData', () => {
  const dev = resolveProfile({ isPackaged: false })
  const rel = resolveProfile({ isPackaged: true })
  test('dev moves the default userData', () => {
    expect(shouldIsolateUserData(dev, '/Users/x/Library/Application Support', '/Users/x/Library/Application Support')).toBe(true)
  })
  test('an explicit --user-data-dir is left alone (Surffish #69)', () => {
    expect(shouldIsolateUserData(dev, '/tmp/smoke', '/Users/x/Library/Application Support')).toBe(false)
  })
  test('release never moves', () => {
    expect(shouldIsolateUserData(rel, '/a', '/a')).toBe(false)
  })
})

describe('labels', () => {
  test('badge text keeps the profile marker beside the count', () => {
    const dev = resolveProfile({ isPackaged: false })
    const rel = resolveProfile({ isPackaged: true })
    expect(profileBadgeText(dev, 0)).toBe('dev')
    expect(profileBadgeText(dev, 3)).toBe('dev 3')
    expect(profileBadgeText(rel, 3)).toBe('3')
    expect(profileBadgeText(rel, 0)).toBe('')
  })
  test('shortcut labels', () => {
    expect(shortcutLabel('Alt+Space', true)).toBe('⌥Space')
    expect(shortcutLabel('Shift+Alt+Space', true)).toBe('⇧⌥Space')
    expect(shortcutLabel('Control+Alt+Space', true)).toBe('⌃⌥Space')
    expect(shortcutLabel('Shift+Control+Alt+Space', true)).toBe('⇧⌃⌥Space')
    expect(shortcutLabel('Control+Alt+Space', false)).toBe('Ctrl+Alt+Space')
    expect(shortcutLabel('', true)).toBe('')
  })
})
