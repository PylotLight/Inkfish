import { resizeImageEdit, type AltEdit } from '../../../src/shared/images'

export const IMAGE_LONG_PRESS_MS = 500

export type ImageGestureAction =
  { type: 'copy'; label: string } | { type: 'resize'; label: string; width: number | null }

/** Native-feeling menu actions for a held image; widths are CSS pixels. */
export function imageGestureActions(currentWidth?: number): ImageGestureAction[] {
  return [
    { type: 'copy', label: 'Copy image' },
    { type: 'resize', label: 'Small · 120 px', width: 120 },
    { type: 'resize', label: 'Medium · 240 px', width: 240 },
    { type: 'resize', label: 'Large · 360 px', width: 360 },
    ...(currentWidth ? [{ type: 'resize' as const, label: 'Reset size', width: null }] : [])
  ]
}

/** Resize a Markdown image or Obsidian embed without disturbing its path or label. */
export function resizeImageEditAt(text: string, from: number, width: number | null): AltEdit | null {
  const markdownEdit = resizeImageEdit(text, from, width)
  if (markdownEdit) return markdownEdit

  if (text.slice(from, from + 3) !== '![[') return null
  const close = text.indexOf(']]', from + 3)
  if (close < 0) return null
  const raw = text.slice(from + 3, close)
  const size = /\|\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/.exec(raw)
  if (width === null) {
    if (!size) return null
    return { from: from + 3, to: close, insert: raw.slice(0, size.index).trimEnd() }
  }

  const nextWidth = Math.max(1, Math.min(99999, Math.round(width)))
  const base = size ? raw.slice(0, size.index).trimEnd() : raw
  const currentWidth = size ? Number(size[1]) : null
  const currentHeight = size?.[2] ? Number(size[2]) : null
  const height =
    currentWidth && currentHeight ? Math.max(1, Math.round((currentHeight * nextWidth) / currentWidth)) : null
  const next = `${base}|${nextWidth}${height ? `x${height}` : ''}`
  if (next === raw) return null
  return { from: from + 3, to: close, insert: next }
}
