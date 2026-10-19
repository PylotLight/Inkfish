import { isolateHistory } from '@codemirror/commands'
import {
  EditorSelection,
  type EditorState,
  StateEffect,
  StateField,
  type Transaction,
  type TransactionSpec
} from '@codemirror/state'
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

/**
 * An in-flight resize / move gesture on one image ref. While it is set, live
 * preview renders that ref exactly as it looked when the gesture began
 * (normally a hidden-source block image) no matter where the selection goes,
 * and the selection from before the gesture is put back when it ends. Without
 * this, Chromium's native mouse selection (pointerdown preventDefault doesn't
 * stop it) dragged the caret onto the ref mid-resize and revealed its source.
 */
export interface ImageGesture {
  from: number
  to: number
  /** Whether the ref's source was showing when the gesture started. */
  revealed: boolean
  /** Selection before the gesture, restored when it ends. */
  selection: EditorSelection
}

export const setImageGesture = StateEffect.define<ImageGesture | null>()

export const imageGestureField = StateField.define<ImageGesture | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setImageGesture)) value = e.value
    if (value && tr.docChanged) {
      // Remote/live-sync edits during a drag: keep tracking the same ref.
      value = {
        from: tr.changes.mapPos(value.from, 1),
        to: tr.changes.mapPos(value.to, -1),
        revealed: value.revealed,
        selection: value.selection.map(tr.changes)
      }
    }
    return value
  }
})

/** Is any selection range touching `from..to` (the live-preview reveal rule)? */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

/**
 * An image ref whose source stays hidden even though the caret touches it,
 * because the caret got there as a side effect rather than by the user
 * putting it there: a pasted / dropped / moved ref leaves the caret right
 * after itself. Without this the dimmed `![|481](…)` source showed above the
 * picture after every paste and stayed up through every resize (the gesture
 * froze it revealed, then put the caret back on its edge). It clears on the
 * next deliberate caret move (arrow keys, a click on text) or typing, so
 * walking the caret onto the ref still reveals it like before. Gestures
 * (resize, move, click-select) map it along but never clear it, so Chromium's
 * native mouse selection mid-drag can't either.
 */
export const concealImage = StateEffect.define<{ from: number; to: number } | null>()

export const concealedImageField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(concealImage)) return e.value
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1)
      const to = tr.changes.mapPos(value.to, -1)
      value = to > from ? { from, to } : null
    }
    const gesture = !!tr.startState.field(imageGestureField, false) || !!tr.state.field(imageGestureField, false)
    if (gesture) return value
    const inserted = insertedRefAtCaret(tr)
    if (inserted) return inserted
    if (tr.isUserEvent('select') || tr.isUserEvent('input.type') || tr.isUserEvent('delete')) return null
    return value
  }
})

/** The image ref this transaction inserted whole, if the new caret sits on it. */
function insertedRefAtCaret(tr: Transaction): { from: number; to: number } | null {
  if (!tr.docChanged || !tr.selection) return null
  if (tr.isUserEvent('input.type') || tr.isUserEvent('delete')) return null
  const sel = tr.state.selection.main
  if (!sel.empty) return null
  const line = tr.state.doc.lineAt(sel.head)
  for (const im of findImages(line.text)) {
    const from = line.from + im.index
    const to = from + im.length
    if (sel.head < from || sel.head > to) continue
    let whole = false
    tr.changes.iterChangedRanges((_fA, _tA, fB, tB) => {
      if (fB <= from && tB >= to) whole = true
    })
    if (whole) return { from, to }
  }
  return null
}

/** Whether live preview should show the source of the image ref at `from..to`. */
export function imageSourceRevealed(state: EditorState, from: number, to: number): boolean {
  const g = state.field(imageGestureField, false)
  if (g && g.from <= to && g.to >= from) return g.revealed
  const c = state.field(concealedImageField, false)
  if (c && c.from <= to && c.to >= from) return false
  return selectionTouches(state, from, to)
}

/** Start a gesture on `ref`: freezes its rendering and remembers the selection. */
export function beginImageGestureSpec(state: EditorState, ref: { from: number; to: number }): TransactionSpec {
  return {
    effects: setImageGesture.of({
      from: ref.from,
      to: ref.to,
      revealed: imageSourceRevealed(state, ref.from, ref.to),
      selection: state.selection
    })
  }
}

/**
 * End the gesture, optionally together with its edit (`spec` from
 * resizeImageSpec / moveImageSpec): one transaction that applies the edit,
 * puts the pre-gesture selection back (mapped through the edit) and unfreezes.
 * With `keepSelection` the spec's own selection wins (a plain click placing
 * the caret on the ref).
 */
export function endImageGestureSpec(
  state: EditorState,
  spec: TransactionSpec | null,
  keepSelection = false
): TransactionSpec {
  const g = state.field(imageGestureField, false)
  // Keep any effects the edit spec carries (e.g. selectImage on a plain click).
  const own = spec?.effects ? (Array.isArray(spec.effects) ? spec.effects : [spec.effects]) : []
  const effects = [...own, setImageGesture.of(null)]
  if (!g) return { ...(spec ?? {}), effects }
  if (keepSelection && spec?.selection) return { ...spec, effects }
  const changes = spec?.changes ? state.changes(spec.changes) : null
  const selection = changes ? g.selection.map(changes) : g.selection
  return { ...(spec ?? {}), selection, effects }
}

/**
 * The image ref picked by a plain click (shown with a selection ring). While
 * set, Copy (⌘C / Edit › Copy) with an empty selection copies the picture
 * itself instead of text. It clears as soon as the selection leaves the ref,
 * becomes a range, or the document changes.
 */
export const selectImage = StateEffect.define<{ from: number; to: number } | null>()

export const selectedImageField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(selectImage)) return e.value
    if (!value) return null
    if (tr.docChanged) return null
    // A re-dispatch of the same selection (focus, gesture end) keeps the ring.
    if (tr.selection && !tr.state.selection.eq(tr.startState.selection)) {
      const inside = tr.state.selection.ranges.every((r) => r.empty && r.from >= value.from && r.to <= value.to)
      if (!inside) return null
    }
    return value
  }
})

/** The click-selected image ref, if Copy should copy the picture right now. */
export function selectedImageRef(state: EditorState): { from: number; to: number } | null {
  const sel = state.field(selectedImageField, false)
  if (!sel) return null
  return state.selection.ranges.every((r) => r.empty) ? sel : null
}

/**
 * End a plain click on a picture: select it (ring; ⌘C copies the image) but
 * do NOT move the caret onto its ref, so the source stays hidden. The
 * pre-gesture selection is collapsed to its head (an empty selection is what
 * lets Copy take the picture). Putting the caret on the line by keyboard or by
 * clicking the text is what reveals the source.
 */
export function imageClickSpec(state: EditorState, ref: { from: number; to: number }): TransactionSpec {
  const g = state.field(imageGestureField, false)
  const prev = g ? g.selection : state.selection
  return endImageGestureSpec(
    state,
    { selection: EditorSelection.cursor(prev.main.head), effects: selectImage.of(ref), userEvent: 'select.pointer' },
    true
  )
}
