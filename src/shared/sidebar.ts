/**
 * Core sidebar collapse: persisted flag + the ⌘\ / Ctrl+\ shortcut. Pure, so it is unit tested.
 *
 * Layout notes (index.css): the expand control lives in `.side-rail`, a slim drag strip that only
 * renders while collapsed. On macOS it starts right of the inset traffic lights
 * (window.ts: `trafficLightPosition { x: 16, y: 16 }`), which is exactly where the old topbar
 * toggle ended up once the sidebar was gone — under the window buttons, inside a drag region.
 */

export const SIDE_COLLAPSED_KEY = 'inkfish.side.collapsed'

/** Left edge (px) the collapsed rail's controls start at, clear of the macOS traffic lights. */
export const SIDE_RAIL_INSET_MAC = 84
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
