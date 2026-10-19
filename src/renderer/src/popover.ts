/**
 * Collision-aware placement for small hover popovers (sidebar-footer sync badge). Pure so it is
 * unit tested; the component measures rects and renders the result `position: fixed`.
 *
 * Rules: keep the popover inside `bounds` (the sidebar ∩ the window) minus `pad` on every side.
 * Horizontally it prefers right-aligning to the anchor (it hangs off a right-side footer button)
 * and shifts left/right only as far as it has to; if it is wider than the room, it is clamped to
 * the room (`maxWidth`) and pinned to the left edge. Vertically it prefers sitting above the
 * anchor, flips below when there is more room there, and caps `maxHeight` to whatever is left.
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

export interface PopoverPlacement {
  left: number
  top: number
  maxWidth: number
  maxHeight: number
  side: 'above' | 'below'
}

export interface PlaceOptions {
  /** Gap kept between the popover and the bounds edges. */
  pad?: number
  /** Gap between the anchor and the popover. */
  gap?: number
  /** Widest the popover may ever be, room permitting. */
  maxWidth?: number
}

/** Intersect two rects (e.g. sidebar rect ∩ viewport). Collapses to zero size if disjoint. */
export function intersect(a: Rect, b: Rect): Rect {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.max(left, Math.min(a.right, b.right))
  const bottom = Math.max(top, Math.min(a.bottom, b.bottom))
  return { left, top, right, bottom }
}

/** Max width the popover may take inside `bounds` — known before measuring, so it can be applied
 *  first and the content wraps to it. */
export function popoverMaxWidth(bounds: Rect, opts: PlaceOptions = {}): number {
  const pad = opts.pad ?? 8
  const cap = opts.maxWidth ?? 300
  return Math.max(0, Math.min(cap, bounds.right - bounds.left - pad * 2))
}

export function placePopover(anchor: Rect, size: Size, bounds: Rect, opts: PlaceOptions = {}): PopoverPlacement {
  const pad = opts.pad ?? 8
  const gap = opts.gap ?? 6
  const maxWidth = popoverMaxWidth(bounds, opts)
  const width = Math.min(size.width, maxWidth)

  const minLeft = bounds.left + pad
  const maxLeft = bounds.right - pad - width
  // Preferred: right edges aligned with the anchor; then shift to stay in bounds. Left edge wins
  // if the room is somehow smaller than the popover (never clip the start of the text).
  let left = anchor.right - width
  left = Math.min(left, maxLeft)
  left = Math.max(left, minLeft)

  const roomAbove = anchor.top - gap - (bounds.top + pad)
  const roomBelow = bounds.bottom - pad - (anchor.bottom + gap)
  const side: 'above' | 'below' = size.height <= roomAbove || roomAbove >= roomBelow ? 'above' : 'below'
  const maxHeight = Math.max(0, side === 'above' ? roomAbove : roomBelow)
  const height = Math.min(size.height, maxHeight)
  const top = side === 'above' ? anchor.top - gap - height : anchor.bottom + gap

  return {
    left: Math.round(left),
    top: Math.round(top),
    maxWidth: Math.floor(maxWidth),
    maxHeight: Math.floor(maxHeight),
    side
  }
}
