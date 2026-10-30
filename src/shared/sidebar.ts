/**
 * Core sidebar collapse: persisted flag + the ⌘\ / Ctrl+\ shortcut. Pure, so it is unit tested.
 *
 * Layout (index.css): Obsidian-style collapse.
 *  - The 48px icon ribbon (`.side-ribbon`) is ALWAYS visible and carries all pane navigation
 *    (Home/Notes/Inbox, Today, Journal, Meetings, Settings). There is no dedicated toggle on it:
 *    clicking ANY ribbon icon re-opens a collapsed pane (Obsidian behaviour) — that is the
 *    mouse path back, since the pane's own toggle hides with the pane.
 *  - The collapse toggle lives in the pane's footer (`.side-foot`), left of the vault chip, so
 *    it sits with the other footer options and never moves with the tree above.
 *  - On macOS the ribbon is 72px wide so the inset traffic lights (window.ts
 *    `trafficLightPosition { x: 16, y: 16 }` → ending ≈x68) sit entirely inside it and the
 *    content never has to move (no top-strip jump, like Obsidian).
 *  - Expanded: the pane (search + tree + footer) opens to the RIGHT of the ribbon.
 *  - `.side-rail` (the content's top drag strip) grows to 46px only while the live-recording
 *    chip is visible (`.rail-tall`, added by Center.tsx) — the chip needs vertical room.
 *  - The buttons are `no-drag` so macOS doesn't eat the clicks as window drags.
 */

export const SIDE_COLLAPSED_KEY = 'inkfish.side.collapsed'

/** Icon ribbon width (px). Mac is wider: the inset traffic lights span x≈16–68
 *  (window.ts), and Obsidian keeps them inside the ribbon so the content never moves. */
export const SIDE_RIBBON_WIDTH = 48
export const SIDE_RIBBON_WIDTH_MAC = 72

export function sideRibbonWidth(platform: string | undefined): number {
  return platform === 'darwin' ? SIDE_RIBBON_WIDTH_MAC : SIDE_RIBBON_WIDTH
}

/** Left padding (px) of the content's top drag strip. The recording chip starts here; the
 *  traffic lights live inside the always-present ribbon (never over the content), so a single
 *  small inset works on every platform. */
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
