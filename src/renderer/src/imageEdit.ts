import { isolateHistory } from '@codemirror/commands'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { findImages, moveImageEdits, resizeImageEdit } from '../../shared/images'

/**
 * Editor transactions for resizing / moving an inline image ref. Pure over
 * EditorState (no DOM) so they're testable; the widget in livePreview.ts
 * dispatches them through the normal view path, so history, autosave and the
 * mini-window live sync all see an ordinary local edit.
 *
 * Each is isolated in history: one resize or one move = exactly one undo step,
 * never merged with typing or a previous resize.
 */

/** Smallest / default largest width a drag can set, in CSS px. */
export const MIN_IMAGE_WIDTH = 32

/** Range of the image ref with `src` touching `pos` (a widget's DOM position). */
export function imageRefNear(state: EditorState, pos: number, src: string): { from: number; to: number } | null {
  const line = state.doc.lineAt(Math.max(0, Math.min(pos, state.doc.length)))
  let best: { from: number; to: number } | null = null
  for (const im of findImages(line.text)) {
    const from = line.from + im.index
    const to = from + im.length
    if (im.src !== src || pos < from || pos > to) continue
    // Prefer an exact edge hit (replace widget starts at `from`, revealed widget sits at `to`).
    if (pos === from || pos === to || !best) best = { from, to }
  }
  return best
}

/** Set (or, with `width` null, remove) the `|N` width on the ref at `from`. */
export function resizeImageSpec(state: EditorState, from: number, width: number | null): TransactionSpec | null {
  const lineEnd = state.doc.lineAt(from).to
  const text = state.doc.sliceString(0, lineEnd)
  const edit = resizeImageEdit(text, from, width)
  if (!edit) return null
  return {
    changes: edit,
    userEvent: width === null ? 'input.image.reset' : 'input.image.resize',
    annotations: isolateHistory.of('full')
  }
}

/** Move the ref at `from..to` to `drop` (`place` matters for refs alone on their line). */
export function moveImageSpec(
  state: EditorState,
  from: number,
  to: number,
  drop: number,
  place: 'before' | 'after'
): TransactionSpec | null {
  const edits = moveImageEdits(state.doc.toString(), from, to, drop, place)
  if (!edits) return null
  return { changes: edits, userEvent: 'move.image', annotations: isolateHistory.of('full') }
}
