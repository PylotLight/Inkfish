/**
 * Menu bar mode: how Inkfish lives in the macOS menu bar (the system tray on Windows/Linux).
 * Settings → Appearance → Menu bar. The tray icon can be turned off, its click can open quick
 * capture, append-to-today or the main window (anchored under the icon), and on macOS the Dock icon
 * can be hidden so Inkfish runs from the menu bar only.
 * Pure rules only; main/menubar.ts owns the Tray, the Dock and the popover placement.
 * Popout placement ported from Surffish's menu-bar mini window (shared/mini-window-menubar.ts).
 */

export const MENU_BAR_SETTINGS_FILE = 'menubar.json'

/** What a left click on the menu bar icon opens. */
export type MenuBarClick = 'capture' | 'today' | 'window'
export const MENU_BAR_CLICKS: readonly MenuBarClick[] = ['capture', 'today', 'window']

export interface MenuBarSettings {
  /** Show the menu bar (tray) icon. */
  showIcon: boolean
  /** macOS: hide the Dock icon (menu-bar-only). Only allowed while the icon shows, so Inkfish is always reachable. */
  hideDock: boolean
  /** What a left click opens. */
  click: MenuBarClick
  /** 'window': drop the main window under the icon (like a popover) instead of where it was. */
  anchorWindow: boolean
}

export const DEFAULT_MENU_BAR_SETTINGS: MenuBarSettings = {
  showIcon: true,
  hideDock: false,
  click: 'capture',
  anchorWindow: false
}

export function isMenuBarClick(value: unknown): value is MenuBarClick {
  return typeof value === 'string' && (MENU_BAR_CLICKS as readonly string[]).includes(value)
}

/**
 * Settings as stored (or sent from Settings); anything unreadable falls back to the defaults.
 * Hiding the Dock icon needs the menu bar icon: with neither, Inkfish would have no way back in
 * (besides the global shortcuts), so hideDock is dropped while the icon is off.
 */
export function parseMenuBarSettings(value: unknown): MenuBarSettings {
  const r = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const d = DEFAULT_MENU_BAR_SETTINGS
  const showIcon = typeof r.showIcon === 'boolean' ? r.showIcon : d.showIcon
  const hideDock = showIcon && (typeof r.hideDock === 'boolean' ? r.hideDock : d.hideDock)
  return {
    showIcon,
    hideDock,
    click: isMenuBarClick(r.click) ? r.click : d.click,
    anchorWindow: typeof r.anchorWindow === 'boolean' ? r.anchorWindow : d.anchorWindow
  }
}

/** Menu-bar preference applied when the user sends Inkfish to the background. */
export function backgroundMenuBarPatch(platform: string): Pick<MenuBarSettings, 'hideDock'> | null {
  return platform === 'darwin' ? { hideDock: true } : null
}

export interface MenuBarRect {
  x: number
  y: number
  width: number
  height: number
}
export interface MenuBarDisplay {
  bounds: MenuBarRect
  workArea: MenuBarRect
}

/** Gap between the icon (the menu bar) and the popout. */
export const MENU_BAR_GAP = 6
/** Kept from the work area's sides when the icon sits near a screen edge. */
export const MENU_BAR_MARGIN = 8

/**
 * Where a window of `size` goes for a click on the icon at `anchor` (the Tray's bounds; null or empty,
 * as on many Linux trays: the pointer at `cursor` stands in): centred under the icon, just below the
 * menu bar (its bottom or the work area's top, whichever is lower, so a notch's taller bar counts),
 * or just above the icon when it sits in the lower half of the display (a taskbar at the bottom).
 * Fitted to the work area, sides kept MENU_BAR_MARGIN in. `side` says which way it opened.
 */
export function menuBarPopoutBounds(
  anchor: MenuBarRect | null,
  cursor: { x: number; y: number },
  size: { width: number; height: number },
  display: MenuBarDisplay
): { bounds: MenuBarRect; side: 'below' | 'above' } {
  const icon =
    anchor && anchor.width > 0 && anchor.height > 0 ? anchor : { x: cursor.x, y: cursor.y, width: 0, height: 0 }
  const wa = display.workArea
  const width = Math.round(Math.min(Math.max(1, wa.width - 2 * MENU_BAR_MARGIN), size.width))
  const height = Math.round(Math.min(Math.max(1, wa.height - 2 * MENU_BAR_GAP), size.height))
  const centreX = icon.x + icon.width / 2
  const centreY = icon.y + icon.height / 2
  const minX = wa.x + Math.min(MENU_BAR_MARGIN, Math.max(0, (wa.width - width) / 2))
  const maxX = wa.x + wa.width - width - Math.min(MENU_BAR_MARGIN, Math.max(0, (wa.width - width) / 2))
  const x = Math.round(Math.min(maxX, Math.max(minX, centreX - width / 2)))
  const side: 'below' | 'above' = centreY > display.bounds.y + display.bounds.height / 2 ? 'above' : 'below'
  const wanted =
    side === 'below'
      ? Math.max(icon.y + icon.height, wa.y) + MENU_BAR_GAP
      : Math.min(icon.y, wa.y + wa.height) - height - MENU_BAR_GAP
  const y = Math.round(Math.min(wa.y + wa.height - height, Math.max(wa.y, wanted)))
  return { bounds: { x, y, width, height }, side }
}
