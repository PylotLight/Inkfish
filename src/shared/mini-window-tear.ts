import { clampMiniBounds, formatAccelerator, type MiniRect } from './mini-window'

/**
 * Making mini windows easy to find (renderer + main, no Electron imports so it's testable):
 * - tearing a tab out of the tab strip (Chrome-style) into a mini window at the drop point,
 * - the pop-out tooltip text,
 * - the one-time "tuck to the edge" hint shown in a new mini window.
 */

/** Pointer travel (px) before a press on a tab becomes a drag (smaller is a click). */
export const TAB_DRAG_START = 6
/** Dragged this far above/below the tab strip (or out of the window), the tab tears out. */
export const TAB_TEAR_DISTANCE = 48
/** Where the pointer sits on the torn-out window: near its top-left, on the (hidden) header. */
export const TEAR_GRAB_OFFSET = { x: 60, y: 14 }

export interface TearPoint { x: number; y: number }
export interface TearRect { left: number; top: number; right: number; bottom: number }

export type TabDragPhase = 'press' | 'drag' | 'tear'

/**
 * Where a tab drag stands. `start`/`current` are client coords, `bar` is the tab strip's client
 * rect and `viewport` the window's inner size. Out of the window, or TAB_TEAR_DISTANCE clear of
 * the strip vertically, is a tear; sideways along the strip is just a drag (no reordering yet).
 */
export function tabDragPhase(start: TearPoint, current: TearPoint, bar: TearRect, viewport: { width: number; height: number }): TabDragPhase {
  const moved = Math.hypot(current.x - start.x, current.y - start.y)
  if (moved < TAB_DRAG_START) return 'press'
  const outside = current.x < 0 || current.y < 0 || current.x >= viewport.width || current.y >= viewport.height
  if (outside) return 'tear'
  const away = current.y < bar.top ? bar.top - current.y : current.y > bar.bottom ? current.y - bar.bottom : 0
  return away >= TAB_TEAR_DISTANCE ? 'tear' : 'drag'
}

/**
 * Bounds for a mini window torn out at screen point `at`: its usual size, placed so the pointer is
 * on its top-left grab spot, kept inside the work area of the display under the pointer.
 */
export function tearOutBounds(at: TearPoint, size: { width: number; height: number }, workArea: MiniRect): MiniRect {
  return clampMiniBounds(
    { x: Math.round(at.x - TEAR_GRAB_OFFSET.x), y: Math.round(at.y - TEAR_GRAB_OFFSET.y), width: size.width, height: size.height },
    workArea
  )
}

/** Tooltip for the pop-out buttons: the in-app key and, when set, the global show/hide toggle. */
export function popOutTitle(globalShortcut: string | null | undefined, isMac: boolean): string {
  const pop = isMac ? '⇧⌘M' : 'Ctrl+Shift+M'
  const toggle = globalShortcut ? ` · ${formatAccelerator(globalShortcut, isMac)} shows/hides minis from any app` : ''
  return `Pop out to mini window (${pop})${toggle}`
}

// ---------------------------------------------------------------------------
// One-time edge-tuck hint

/** localStorage key (shared by every window of the app) — set once the hint has been seen. */
export const MINI_HINT_KEY = 'inkfish.mini.tuckHint.v1'
/** The hint dismisses itself after this long. */
export const MINI_HINT_MS = 9000

export interface MiniHintState {
  tuckEnabled: boolean
  docked: boolean
}

/** Show the tuck hint in this mini? Only once ever, only when tucking is on, never once already docked. */
export function shouldShowMiniHint(seen: string | null | undefined, state: MiniHintState | null): boolean {
  if (seen) return false
  if (!state) return false
  return state.tuckEnabled && !state.docked
}

/** The hint's text, with the user's global toggle (if any). */
export function miniHintText(globalShortcut: string | null | undefined, isMac: boolean): string {
  const toggle = globalShortcut ? ` ${formatAccelerator(globalShortcut, isMac)} shows/hides it from any app.` : ''
  return `Drag the top bar to a screen edge to tuck this note into a side tab — hover the tab to peek, click to slide it back.${toggle}`
}
