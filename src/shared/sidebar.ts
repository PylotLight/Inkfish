/**
 * Core sidebar collapse: persisted flag + the ⌘\ / Ctrl+\ shortcut. Pure, so it is unit tested.
 *
 * Layout notes (index.css): the toggle is `.titlebar-toggle`, Obsidian-style — `position: fixed`
 * in the titlebar strip just right of the inset traffic lights
 * (window.ts: `trafficLightPosition { x: 16, y: 16 }` → three 12px buttons ending ≈x68, centred
 * on y≈23). It sits at the same spot whether the sidebar is open or collapsed, and is `no-drag`
 * so macOS doesn't treat the click as a window drag. Collapsed, a 48px icon ribbon
 * (`.side-ribbon`) keeps navigation reachable; `.side-rail` (the content's top drag strip)
 * carries the live-recording chip beside the toggle.
 */

export const SIDE_COLLAPSED_KEY = 'inkfish.side.collapsed'

/** Fixed titlebar toggle box (px, window coords). Mac: clear of the traffic lights, vertically
 *  centred on them; elsewhere: centred over the 48px collapsed ribbon. Mirrors index.css. */
export const SIDE_TOGGLE_MAC = { left: 80, top: 9, width: 30, height: 28 } as const
export const SIDE_TOGGLE = { left: 9, top: 6, width: 30, height: 28 } as const
/** Collapsed icon ribbon width (px). */
export const SIDE_RIBBON_WIDTH = 48

export function sideTogglePos(platform: string | undefined): { left: number; top: number; width: number; height: number } {
  return platform === 'darwin' ? SIDE_TOGGLE_MAC : SIDE_TOGGLE
}

/** Left padding (px) of the collapsed content's top strip: content starts after the ribbon, and
 *  the recording chip must start right of the fixed toggle on mac. */
export const SIDE_RAIL_INSET_MAC = SIDE_TOGGLE_MAC.left + SIDE_TOGGLE_MAC.width - SIDE_RIBBON_WIDTH + 10
export const SIDE_RAIL_INSET = 16

export function sideRailInset(platform: string | undefined): number {
  return platform === 'darwin' ? SIDE_RAIL_INSET_MAC : SIDE_RAIL_INSET
}

/** Stored value -> collapsed? Anything but an explicit '1' means expanded. */
export function parseSideCollapsed(raw: string | null | undefined): boolean {
  return raw === '1'
}

export function serializeSideCollapsed(collapsed: boolean): string {
  return collapsed ? '1' : '0'
}

export interface ToggleKeyEvent {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

/**
 * ⌘\ on macOS, Ctrl+\ elsewhere (either modifier is accepted, like the palette shortcuts).
 * Shift/Alt variants are left alone (⇧⌘\ is CodeMirror's matching-bracket), and auto-repeat is
 * ignored so holding the keys doesn't flap the sidebar. `code` covers layouts where `\` is a
 * dead key or produces another character.
 */
export function isSidebarToggleKey(e: ToggleKeyEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.repeat) return false
  return e.key === '\\' || e.code === 'Backslash'
}

/** Height of the sidebar footer row (vault chip + Settings/Quit), Obsidian's bottom vault bar. */
export const SIDE_FOOT_HEIGHT = 38

/**
 * Footer vault chip label: the vault folder's own name. Handles POSIX + Windows separators and
 * trailing slashes; falls back to the whole path, then '…' while the vault is still loading.
 */
export function vaultLabel(root: string | null | undefined): string {
  if (!root) return '…'
  const trimmed = root.replace(/[\\/]+$/, '')
  if (!trimmed) return root
  return trimmed.split(/[\\/]/).pop() || trimmed
}

/** Chip tooltip: full path on top, app version underneath (version lives here + Settings › About). */
export function vaultTooltip(root: string | null | undefined, version?: string | null): string {
  const lines = [root || 'Vault loading…']
  if (root) lines.push('Click to open the vault folder')
  if (version) lines.push(`Inkfish v${version}`)
  return lines.join('\n')
}
