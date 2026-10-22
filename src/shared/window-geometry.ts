/**
 * Main window geometry persistence (pure). Ported from Surffish src/shared/window-geometry.ts.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowState {
  bounds: Rect
  maximized: boolean
  fullScreen: boolean
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

export function parseSavedWindowState(value: unknown): SavedWindowState | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const bounds = record.bounds as Record<string, unknown> | undefined
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(finite)) return null
  if ((bounds.width as number) <= 0 || (bounds.height as number) <= 0) return null
  return {
    bounds: {
      x: Math.round(bounds.x as number),
      y: Math.round(bounds.y as number),
      width: Math.round(bounds.width as number),
      height: Math.round(bounds.height as number)
    },
    maximized: record.maximized === true,
    fullScreen: record.fullScreen === true
  }
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Put saved bounds back on a display that still exists. Picks the work area the window
 * overlaps most, shrinks it to fit, and nudges it fully on screen. Returns null when the
 * window would be off every display (monitor unplugged), so the caller uses defaults.
 */
export function fitBoundsToDisplays(bounds: Rect, workAreas: Rect[], minimum: { width: number; height: number }): Rect | null {
  let best: Rect | null = null
  let bestOverlap = 0
  for (const area of workAreas) {
    const overlap = overlapArea(bounds, area)
    if (overlap > bestOverlap) {
      best = area
      bestOverlap = overlap
    }
  }
  // Require a usable chunk on screen (at least the title bar region) before trusting it.
  if (!best || bestOverlap < Math.min(bounds.width, 120) * Math.min(bounds.height, 40)) return null
  const width = clamp(bounds.width, Math.min(minimum.width, best.width), best.width)
  const height = clamp(bounds.height, Math.min(minimum.height, best.height), best.height)
  const x = clamp(bounds.x, best.x, best.x + best.width - width)
  const y = clamp(bounds.y, best.y, best.y + best.height - height)
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/**
 * Bounds to show an already-open main window at. Unchanged when it's on a display; fitted back on
 * when it mostly is; centred on `fallback` (the primary work area) when it's off every display or
 * has collapsed to a zero/garbage size — e.g. a monitor was unplugged while the app kept running,
 * or a stale window-state put it somewhere you can't see, so "Show" looked like it did nothing.
 */
export function boundsToShow(
  bounds: Rect,
  workAreas: Rect[],
  minimum: { width: number; height: number },
  fallback: Rect
): Rect {
  const sane = [bounds.x, bounds.y, bounds.width, bounds.height].every(finite) && bounds.width > 0 && bounds.height > 0
  if (sane) {
    const fitted = fitBoundsToDisplays(bounds, workAreas, minimum)
    if (fitted) return fitted
  }
  const width = clamp(sane ? bounds.width : minimum.width, Math.min(minimum.width, fallback.width), fallback.width)
  const height = clamp(sane ? bounds.height : minimum.height, Math.min(minimum.height, fallback.height), fallback.height)
  return {
    x: Math.round(fallback.x + (fallback.width - width) / 2),
    y: Math.round(fallback.y + (fallback.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height)
  }
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** What the main-window getter does with what it holds: make a new one, reload a dead renderer, or reuse it. */
export type MainWindowPlan = 'create' | 'reload' | 'reuse'

export function planMainWindow(state: { exists: boolean; destroyed: boolean; crashed: boolean }): MainWindowPlan {
  if (!state.exists || state.destroyed) return 'create'
  if (state.crashed) return 'reload'
  return 'reuse'
}
