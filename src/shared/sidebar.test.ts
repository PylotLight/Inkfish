import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SIDE_RAIL_INSET,
  SIDE_RIBBON_WIDTH,
  SIDE_RIBBON_WIDTH_MAC,
  sideRibbonWidth,
  isSidebarToggleKey,
  parseSideCollapsed,
  serializeSideCollapsed,
  sideRailInset,
  SIDE_FOOT_HEIGHT,
  vaultLabel,
  vaultTooltip
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

describe('sidebar toggle + collapsed rail layout', () => {
  test('mac ribbon is wide enough to contain the inset traffic lights', () => {
    // window.ts: trafficLightPosition { x: 16, y: 16 } — three 12px buttons + gaps end near x≈68.
    expect(SIDE_RIBBON_WIDTH_MAC).toBeGreaterThanOrEqual(68 + 2)
    expect(sideRibbonWidth('darwin')).toBe(SIDE_RIBBON_WIDTH_MAC)
    expect(sideRibbonWidth('linux')).toBe(SIDE_RIBBON_WIDTH)
  })
  test('recording chip inset is small on every platform', () => {
    // The lights live inside the always-present ribbon, so the chip never has to clear them —
    // one shared inset.
    expect(sideRailInset('darwin')).toBe(SIDE_RAIL_INSET)
    expect(sideRailInset('linux')).toBe(SIDE_RAIL_INSET)
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
    expect(rule('.ribbon-btn')).toContain('-webkit-app-region: no-drag')
  })
  test('the ribbon is always present — no separate floating toggle', () => {
    // Obsidian pattern: the pane opens beside a permanent ribbon; there is no fixed
    // titlebar button to duplicate the collapse affordance.
    expect(css.indexOf('.titlebar-toggle')).toBe(-1)
    const collapsedRibbon = css.indexOf('.shell.side-collapsed .side-ribbon')
    expect(collapsedRibbon).toBe(-1)
  })
  test('ribbon width matches the shared constants (base + mac)', () => {
    expect(rule('.side-ribbon')).toContain(`width: ${SIDE_RIBBON_WIDTH}px`)
    expect(rule(".shell[data-platform='darwin'] .side-ribbon")).toContain(`width: ${SIDE_RIBBON_WIDTH_MAC}px`)
  })
  test('the content only moves for the recording chip (.rail-tall)', () => {
    expect(rule('.side-rail.rail-tall')).toContain('height: 46px')
    expect(rule('.content.center.rail-tall')).toContain('padding-top: 46px')
    // Regression: no blanket collapsed-state padding jump.
    expect(css.indexOf('.shell.side-collapsed .content.center')).toBe(-1)
  })
  test('the ribbon is not gated on the collapsed state in the JSX (always visible)', () => {
    const tsx = readFileSync(join(import.meta.dir, '../renderer/src/shell/Sidebar.tsx'), 'utf8')
    expect(tsx.indexOf('{sideCollapsed && (')).toBe(-1)
  })
  test('the ribbon has no dedicated toggle — its icons re-open a collapsed pane (Obsidian)', () => {
    const tsx = readFileSync(join(import.meta.dir, '../renderer/src/shell/Sidebar.tsx'), 'utf8')
    const ribbonStart = tsx.indexOf('side-ribbon')
    const ribbon = tsx.slice(ribbonStart, tsx.indexOf('</nav>', ribbonStart))
    // The old boxed first button is gone; unboxing the affordance, not losing it.
    expect(ribbon).not.toContain('panel-left')
    expect(ribbon).toContain('uncollapse()')
    // Obsidian-sized ribbon icons: 24px, not the old 18px.
    expect(ribbon).toContain('size={24}')
    expect(ribbon).not.toContain('size={18}')
  })
  test('the pane footer carries the collapse toggle, left of the vault chip', () => {
    const tsx = readFileSync(join(import.meta.dir, '../renderer/src/shell/Sidebar.tsx'), 'utf8')
    const footStart = tsx.indexOf('side-foot')
    const foot = tsx.slice(footStart, tsx.indexOf('</aside>', footStart))
    expect(foot).toContain('panel-left')
    expect(foot).toContain('setSideCollapsed(true)')
    // Stable spot: the toggle leads the row, the vault chip follows.
    expect(foot.indexOf('panel-left')).toBeLessThan(foot.indexOf('vault-chip'))
  })
  test('the pane carries no scope/quick-action rows (navigation rides the ribbon)', () => {
    const tsx = readFileSync(join(import.meta.dir, '../renderer/src/shell/Sidebar.tsx'), 'utf8')
    expect(tsx.indexOf('scope-tabs')).toBe(-1)
    expect(tsx.indexOf('side-actions')).toBe(-1)
  })
  test('collapsed sidebar takes no width at all', () => {
    const collapsed = rule('.shell.side-collapsed .sidebar.core')
    expect(collapsed).toContain('width: 0')
    expect(collapsed).toContain('border-right-width: 0')
  })
})

describe('sidebar footer (vault bar)', () => {
  test('vault chip label is the folder name across separators', () => {
    expect(vaultLabel('/Users/me/Documents/NotesVault')).toBe('NotesVault')
    expect(vaultLabel('/Users/me/NotesVault/')).toBe('NotesVault')
    expect(vaultLabel('C:\\Users\\me\\NotesVault')).toBe('NotesVault')
    expect(vaultLabel('/')).toBe('/')
    expect(vaultLabel(null)).toBe('…')
    expect(vaultLabel('')).toBe('…')
  })
  test('tooltip carries the full path and the version, not the main line', () => {
    const t = vaultTooltip('/Users/me/NotesVault', '0.2.8')
    expect(t).toContain('/Users/me/NotesVault')
    expect(t).toContain('v0.2.8')
    expect(vaultTooltip(null, null)).not.toContain('Click')
  })

  const css = readFileSync(join(import.meta.dir, '../renderer/src/index.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`)
    expect(at).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }
  test('one compact row with a subtle divider, no bold', () => {
    const foot = rule('.sidebar.core .side-foot')
    expect(foot).toContain(`height: ${SIDE_FOOT_HEIGHT}px`)
    expect(foot).toContain('align-items: center')
    expect(foot).toContain('border-top: 1px solid')
    expect(rule('.vault-chip')).toContain('font-weight: 400')
    expect(rule('.vault-chip')).toContain('min-width: 0')
    expect(rule('.vault-chip .vault-name')).toContain('text-overflow: ellipsis')
  })
  test('settings + quit are equal-size icon buttons', () => {
    const btn = rule('.foot-btn')
    expect(btn).toContain('width: 28px')
    expect(btn).toContain('height: 28px')
    expect(rule('.side-foot')).toContain('-webkit-app-region: no-drag')
  })
})
