import { describe, expect, test } from 'bun:test'
import { history, undo, redo } from '@codemirror/commands'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import {
  beginImageGestureSpec,
  endImageGestureSpec,
  imageGestureField,
  imageRefNear,
  imageSourceRevealed,
  moveImageSpec,
  resizeImageSpec
} from './imageEdit'

/** Minimal dispatch target over an EditorState with history (no DOM). */
function editor(doc: string) {
  const t = {
    state: EditorState.create({ doc, extensions: [history()] }),
    dispatch(tr: import('@codemirror/state').Transaction) {
      t.state = tr.state
    },
    apply(spec: TransactionSpec | null) {
      expect(spec).not.toBeNull()
      t.state = t.state.update(spec!).state
    },
    get text() {
      return t.state.doc.toString()
    }
  }
  return t
}

describe('resize transaction', () => {
  test('one resize = one undo step, even back to back', () => {
    const doc = 'hello\n![cat](assets/c.png)\nbye'
    const e = editor(doc)
    const from = doc.indexOf('![')
    e.apply(resizeImageSpec(e.state, from, 300))
    expect(e.text).toBe('hello\n![cat|300](assets/c.png)\nbye')
    e.apply(resizeImageSpec(e.state, from, 180))
    expect(e.text).toBe('hello\n![cat|180](assets/c.png)\nbye')
    undo(e)
    expect(e.text).toBe('hello\n![cat|300](assets/c.png)\nbye')
    undo(e)
    expect(e.text).toBe(doc)
    redo(e)
    expect(e.text).toBe('hello\n![cat|300](assets/c.png)\nbye')
  })
  test('reset removes |N; nothing to reset → null; user event tagged', () => {
    const e = editor('![|240](a.png)')
    const spec = resizeImageSpec(e.state, 0, null)!
    expect(spec.userEvent).toBe('input.image.reset')
    e.apply(spec)
    expect(e.text).toBe('![](a.png)')
    expect(resizeImageSpec(e.state, 0, null)).toBeNull()
    expect(resizeImageSpec(e.state, 0, 100)!.userEvent).toBe('input.image.resize')
  })
  test('resize does not merge with adjacent typing in history', () => {
    const e = editor('![](a.png)')
    e.apply({ changes: { from: 10, insert: ' x' }, userEvent: 'input.type' })
    e.apply(resizeImageSpec(e.state, 0, 64))
    e.apply({ changes: { from: e.state.doc.length, insert: 'y' }, userEvent: 'input.type' })
    expect(e.text).toBe('![|64](a.png) xy')
    undo(e)
    expect(e.text).toBe('![|64](a.png) x')
    undo(e)
    expect(e.text).toBe('![](a.png) x')
  })
})

describe('move transaction', () => {
  test('block image moves line-wise in a single undo step', () => {
    const doc = '# t\n![|300](a.png)\npara one\npara two'
    const e = editor(doc)
    const from = doc.indexOf('![')
    const to = from + '![|300](a.png)'.length
    e.apply(moveImageSpec(e.state, from, to, doc.indexOf('para two'), 'after'))
    expect(e.text).toBe('# t\npara one\npara two\n![|300](a.png)')
    undo(e)
    expect(e.text).toBe(doc)
  })
  test('inline image moves to the drop offset; no-op drop → null', () => {
    const doc = 'a ![](x.png) b c'
    const e = editor(doc)
    const from = doc.indexOf('![')
    const to = from + '![](x.png)'.length
    expect(moveImageSpec(e.state, from, to, from + 1, 'after')).toBeNull()
    e.apply(moveImageSpec(e.state, from, to, doc.length, 'after'))
    expect(e.text).toBe('a  b c![](x.png)')
    undo(e)
    expect(e.text).toBe(doc)
  })
})

describe('imageRefNear', () => {
  const doc = 'x ![](a.png) ![](b.png)\n![](a.png)'
  const s = EditorState.create({ doc })
  test('finds the ref by widget position (start for replaced, end for revealed)', () => {
    const a = doc.indexOf('![](a')
    expect(imageRefNear(s, a, 'a.png')).toEqual({ from: a, to: a + 10 })
    expect(imageRefNear(s, a + 10, 'a.png')).toEqual({ from: a, to: a + 10 })
    const b = doc.indexOf('![](b')
    expect(imageRefNear(s, b, 'b.png')).toEqual({ from: b, to: b + 10 })
    expect(imageRefNear(s, b, 'a.png')).toBeNull()
    const last = doc.lastIndexOf('![')
    expect(imageRefNear(s, last, 'a.png')).toEqual({ from: last, to: last + 10 })
  })
})

describe('resize/move gesture keeps the image source hidden', () => {
  const doc = 'hello\n![|876](assets/2026/10/a.png)\nbye'
  const from = doc.indexOf('![')
  const to = doc.indexOf(')') + 1
  const base = () => EditorState.create({ doc, selection: { anchor: 2 }, extensions: [history(), imageGestureField] })

  test('selection landing on the ref mid-gesture does not reveal it; selection restored; one undo', () => {
    let s = base()
    expect(imageSourceRevealed(s, from, to)).toBe(false)
    s = s.update(beginImageGestureSpec(s, { from, to })).state
    // Native mouse selection drags the caret onto the image line.
    s = s.update({ selection: { anchor: from + 3 } }).state
    expect(imageSourceRevealed(s, from, to)).toBe(false)
    s = s.update(endImageGestureSpec(s, resizeImageSpec(s, from, 400))).state
    expect(s.doc.toString()).toBe('hello\n![|400](assets/2026/10/a.png)\nbye')
    expect(s.selection.main.anchor).toBe(2)
    expect(s.field(imageGestureField)).toBeNull()
    expect(imageSourceRevealed(s, from, s.doc.line(2).to)).toBe(false)
    const t = { state: s, dispatch: (tr: import('@codemirror/state').Transaction) => (t.state = tr.state) }
    undo(t)
    expect(t.state.doc.toString()).toBe(doc)
  })

  test('cancel (Esc) restores the selection and changes nothing', () => {
    let s = base()
    s = s.update(beginImageGestureSpec(s, { from, to })).state
    s = s.update({ selection: { anchor: to } }).state
    s = s.update(endImageGestureSpec(s, null)).state
    expect(s.doc.toString()).toBe(doc)
    expect(s.selection.main.anchor).toBe(2)
  })

  test('after the gesture the normal caret-reveal rule applies again', () => {
    let s = base()
    s = s.update(beginImageGestureSpec(s, { from, to })).state
    s = s.update(endImageGestureSpec(s, { selection: { anchor: from + 2 } }, true)).state
    expect(s.selection.main.anchor).toBe(from + 2)
    expect(imageSourceRevealed(s, from, to)).toBe(true)
  })

  test('a ref already revealed when the gesture starts stays revealed (no widget swap mid-drag)', () => {
    let s = EditorState.create({ doc, selection: { anchor: to }, extensions: [imageGestureField] })
    s = s.update(beginImageGestureSpec(s, { from, to })).state
    s = s.update({ selection: { anchor: 0 } }).state
    expect(imageSourceRevealed(s, from, to)).toBe(true)
  })
})

describe('click-selected image (⌘C copies the picture)', () => {
  const doc = 'hi\n![cat](assets/c.png)\nbye'
  const from = doc.indexOf('![')
  const to = doc.indexOf(')') + 1
  async function setup() {
    const m = await import('./imageEdit')
    let s = EditorState.create({ doc, extensions: [m.imageGestureField, m.selectedImageField] })
    // Plain click = gesture begin, then end with caret + selectImage in one transaction.
    s = s.update(m.beginImageGestureSpec(s, { from, to })).state
    s = s.update(
      m.endImageGestureSpec(s, { selection: { anchor: from + 2 }, effects: m.selectImage.of({ from, to }) }, true)
    ).state
    return { m, s }
  }
  test('a plain click selects the image and keeps its effects through the gesture end', async () => {
    const { m, s } = await setup()
    expect(s.field(m.imageGestureField)).toBeNull()
    expect(m.selectedImageRef(s)).toEqual({ from, to })
    expect(s.selection.main.head).toBe(from + 2)
  })
  test('caret moves inside the ref keep it; leaving, range-selecting or editing clears it', async () => {
    const { m, s } = await setup()
    expect(m.selectedImageRef(s.update({ selection: { anchor: to } }).state)).toEqual({ from, to })
    expect(m.selectedImageRef(s.update({ selection: { anchor: 0 } }).state)).toBeNull()
    expect(m.selectedImageRef(s.update({ selection: { anchor: from, head: to } }).state)).toBeNull()
    expect(m.selectedImageRef(s.update({ changes: { from: 0, insert: 'x' } }).state)).toBeNull()
  })
  test('explicit deselect', async () => {
    const { m, s } = await setup()
    expect(m.selectedImageRef(s.update({ effects: m.selectImage.of(null) }).state)).toBeNull()
  })
})
