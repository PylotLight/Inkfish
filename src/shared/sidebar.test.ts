import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SIDE_RAIL_INSET_MAC,
  isSidebarToggleKey,
  parseSideCollapsed,
  serializeSideCollapsed,
  sideRailInset
} from './sidebar'

const key = (over: Partial<Parameters<typeof isSidebarToggleKey>[0]>): Parameters<typeof isSidebarToggleKey>[0] => ({
  key: '\\',
  code: 'Backslash',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over
})

describe('sidebar collapse state', () => {
  test('round-trips through storage', () => {
    expect(parseSideCollapsed(serializeSideCollapsed(true))).toBe(true)
    expect(parseSideCollapsed(serializeSideCollapsed(false))).toBe(false)
  })
  test('missing or junk values mean expanded', () => {
    expect(parseSideCollapsed(null)).toBe(false)
    expect(parseSideCollapsed(undefined)).toBe(false)
    expect(parseSideCollapsed('true')).toBe(false)
  })
})

describe('isSidebarToggleKey', () => {
  test('⌘\\ and Ctrl+\\ toggle', () => {
    expect(isSidebarToggleKey(key({ metaKey: true }))).toBe(true)
    expect(isSidebarToggleKey(key({ ctrlKey: true }))).toBe(true)
  })
  test('needs a modifier', () => {
    expect(isSidebarToggleKey(key({}))).toBe(false)
  })
  test('leaves ⇧⌘\\ (matching bracket) and ⌥ variants alone', () => {
    expect(isSidebarToggleKey(key({ metaKey: true, shiftKey: true, key: '|' }))).toBe(false)
    expect(isSidebarToggleKey(key({ metaKey: true, altKey: true }))).toBe(false)
  })
  test('ignores auto-repeat so a held chord does not flap', () => {
    expect(isSidebarToggleKey(key({ metaKey: true, repeat: true }))).toBe(false)
  })
  test('matches by physical key on layouts where \\ is another character', () => {
    expect(isSidebarToggleKey(key({ metaKey: true, key: '#', code: 'Backslash' }))).toBe(true)
    expect(isSidebarToggleKey(key({ metaKey: true, key: 'a', code: 'KeyA' }))).toBe(false)
  })
})

describe('collapsed rail layout', () => {
  test('mac controls start right of the inset traffic lights', () => {
    // window.ts: trafficLightPosition { x: 16, y: 16 } — three 12px buttons + gaps end near x≈70.
    expect(sideRailInset('darwin')).toBeGreaterThanOrEqual(80)
    expect(sideRailInset('linux')).toBeLessThan(sideRailInset('darwin'))
  })

  // Regression for "collapse sidebar doesn't work": the toggle sat in a -webkit-app-region: drag
  // bar without no-drag (clicks became window drags on macOS) and, once collapsed, under the
  // traffic lights. Guard the CSS that fixes it.
  const css = readFileSync(join(import.meta.dir, '../renderer/src/index.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`)
    expect(at).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }
  test('toggle buttons opt out of the window drag region', () => {
    expect(rule('.side-toggle')).toContain('-webkit-app-region: no-drag')
  })
  test('mac rail clears the traffic lights', () => {
    expect(rule(".shell[data-platform='darwin'] .side-rail")).toContain(`padding-left: ${SIDE_RAIL_INSET_MAC}px`)
  })
  test('collapsed sidebar takes no width at all', () => {
    const collapsed = rule('.shell.side-collapsed .sidebar.core')
    expect(collapsed).toContain('width: 0')
    expect(collapsed).toContain('border-right-width: 0')
  })
})
