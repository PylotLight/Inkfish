/**
 * Core sidebar collapse: persisted flag + the ⌘\ / Ctrl+\ shortcut. Pure, so it is unit tested.
 *
 * Layout (index.css): Obsidian-style collapse.
 *  - Expanded: the toggle is `.titlebar-toggle`, `position: fixed` just right of the inset
 *    traffic lights (window.ts: `trafficLightPosition { x: 16, y: 16 }` → three 12px buttons
 *    ending ≈x68, centred on y≈23). Clicking it collapses the sidebar.
 *  - Collapsed: the fixed toggle hides, and the 48px icon ribbon (`.side-ribbon`) appears. Its
 *    FIRST button is the sidebar toggle (like Obsidian's file-explorer ribbon icon) — click it
 *    to expand. On macOS the ribbon is 72px wide so the inset traffic lights sit entirely
 *    inside it and the content never has to move (no 28px top-strip jump, like Obsidian).
 *  - `.side-rail` (the content's top drag strip) grows to 46px only while the live-recording
 *    chip is visible (`.rail-tall`, added by Center.tsx) — the chip needs vertical room.
 *  - The buttons are `no-drag` so macOS doesn't eat the clicks as window drags.
 */

export const SIDE_COLLAPSED_KEY = 'inkfish.side.collapsed'

/** Fixed titlebar toggle box, expanded state (px, window coords). Mac: clear of the traffic
 *  lights, vertically centred on them; elsewhere: top-left of the sidebar head strip.
 *  Mirrors index.css (`.titlebar-toggle`). Hidden while collapsed. */
export const SIDE_TOGGLE_MAC = { left: 80, top: 9, width: 30, height: 28 } as const
export const SIDE_TOGGLE = { left: 9, top: 6, width: 30, height: 28 } as const

/** Collapsed icon ribbon width (px). Mac is wider: the inset traffic lights span x≈16–68
 *  (window.ts), and Obsidian keeps them inside the ribbon so the content never moves. */
export const SIDE_RIBBON_WIDTH = 48
export const SIDE_RIBBON_WIDTH_MAC = 72

export function sideTogglePos(platform: string | undefined): {
  left: number
  top: number
  width: number
  height: number
} {
  return platform === 'darwin' ? SIDE_TOGGLE_MAC : SIDE_TOGGLE
}

export function sideRibbonWidth(platform: string | undefined): number {
  return platform === 'darwin' ? SIDE_RIBBON_WIDTH_MAC : SIDE_RIBBON_WIDTH
}

/** Left padding (px) of the content's top drag strip. The recording chip starts here; the
 *  traffic lights live inside the ribbon (never over the content) and the fixed toggle is
 *  hidden while collapsed, so a single small inset works on every platform. */
export const SIDE_RAIL_INSET = 16

export function sideRailInset(_platform?: string): number {
  return SIDE_RAIL_INSET
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
