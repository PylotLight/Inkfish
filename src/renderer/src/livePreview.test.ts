import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { buildDecorations, ImageWidget } from './livePreview'

const opts = { onToggleTask: () => {}, resolveImage: (src: string) => [`asset://vault/${src}`] }

/** Visible text after hiding every replace decoration that has no widget. */
function decorated(doc: string, cursor = doc.length) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const set = buildDecorations(state, opts)
  const hidden: Array<[number, number]> = []
  const images: Array<{ from: number; to: number; w: ImageWidget }> = []
  set.between(0, doc.length, (from, to, deco) => {
    const w = deco.spec.widget
    if (w instanceof ImageWidget) images.push({ from, to, w })
    else if (deco.spec.widget === undefined && to > from && !deco.spec.class) hidden.push([from, to])
  })
  let visible = ''
  for (let i = 0; i < doc.length; i++) {
    const inHidden = hidden.some(([a, b]) => i >= a && i < b)
    const inImage = images.some((m) => m.to > m.from && i >= m.from && i < m.to)
    if (!inHidden && !inImage) visible += doc[i]
  }
  return { visible, images }
}

describe('live preview images', () => {
  const doc = 'AH Coflow feedback\n![](assets/2026/10/a_x.png)\nend'

  test('image renders as a widget — no bare "!" left behind', () => {
    const { visible, images } = decorated(doc, 0)
    expect(images).toHaveLength(1)
    expect(images[0]!.w.urls).toEqual(['asset://vault/assets/2026/10/a_x.png'])
    expect(images[0]!.to - images[0]!.from).toBe('![](assets/2026/10/a_x.png)'.length)
    expect(visible).toBe('AH Coflow feedback\n\nend')
  })

  test('caret on the ref shows its source plus the picture', () => {
    const at = doc.indexOf('![') + 3
    const { visible, images } = decorated(doc, at)
    expect(visible).toContain('![](assets/2026/10/a_x.png)')
    expect(images).toHaveLength(1)
    expect(images[0]!.from).toBe(images[0]!.to)
  })

  test('links still hide their URL; images inside code spans stay literal', () => {
    expect(decorated('a [site](http://x) b', 0).visible).toBe('a site b')
    const code = decorated('x `![](a.png)` y', 0)
    expect(code.images).toHaveLength(0)
    expect(code.visible).toBe('x ![](a.png) y')
  })
})

describe('live preview sized images (![alt|300](src))', () => {
  test('width/height reach the widget; alt drops the |N; src untouched', () => {
    const d = 'x\n![cat|300](assets/c.png)\n![|120x80](assets/d.png)\n![](assets/e.png)'
    const { images, visible } = decorated(d, 0)
    expect(images.map((m) => [m.w.alt, m.w.src, m.w.width, m.w.height])).toEqual([
      ['cat', 'assets/c.png', 300, undefined],
      ['', 'assets/d.png', 120, 80],
      ['', 'assets/e.png', undefined, undefined]
    ])
    expect(visible).toBe('x\n\n\n')
  })
  test('a resize changes widget identity (so it re-renders), same width does not', () => {
    const a = new ImageWidget(['u'], 'a', 's', 300)
    expect(a.eq(new ImageWidget(['u'], 'a', 's', 300))).toBe(true)
    expect(a.eq(new ImageWidget(['u'], 'a', 's', 200))).toBe(false)
    expect(a.eq(new ImageWidget(['u'], 'a', 's'))).toBe(false)
  })
  test('caret on a sized ref still reveals the full source', () => {
    const d = '![cat|300](assets/c.png)'
    const { visible, images } = decorated(d, 3)
    expect(visible).toBe(d)
    expect(images[0]!.w.width).toBe(300)
  })
})

describe('live preview: image stays a hidden-source block while resizing', () => {
  test('caret dragged onto the ref during a gesture keeps the replace widget', async () => {
    const { beginImageGestureSpec, imageGestureField } = await import('./imageEdit')
    const doc = 'a\n![|876](assets/x.png)\nb'
    const from = doc.indexOf('![')
    const to = doc.indexOf(')') + 1
    let s = EditorState.create({ doc, selection: EditorSelection.cursor(0), extensions: [imageGestureField] })
    s = s.update(beginImageGestureSpec(s, { from, to })).state
    s = s.update({ selection: { anchor: from + 4 } }).state
    const imgs: Array<[number, number]> = []
    buildDecorations(s, opts).between(0, doc.length, (f, t, d) => {
      if (d.spec.widget instanceof ImageWidget) imgs.push([f, t])
    })
    expect(imgs).toEqual([[from, to]])
  })
})

describe('live preview: click-selected image', () => {
  test('selected ref renders a selected widget (re-renders on change); others do not', async () => {
    const { selectImage, selectedImageField } = await import('./imageEdit')
    const doc = '![](assets/a.png)\n![](assets/b.png)'
    const from = 0
    const to = doc.indexOf('\n')
    let s = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length), extensions: [selectedImageField] })
    s = s.update({ selection: { anchor: 3 }, effects: selectImage.of({ from, to }) }).state
    const ws: ImageWidget[] = []
    buildDecorations(s, opts).between(0, doc.length, (_f, _t, d) => {
      if (d.spec.widget instanceof ImageWidget) ws.push(d.spec.widget)
    })
    expect(ws.map((w) => [w.src, w.selected])).toEqual([
      ['assets/a.png', true],
      ['assets/b.png', false]
    ])
    expect(new ImageWidget(['u'], 'a', 's', 1, 1, true).eq(new ImageWidget(['u'], 'a', 's', 1, 1))).toBe(false)
  })
})

describe('live preview: block images (alone on their line) never render inline', () => {
  function widgets(state: EditorState) {
    const out: Array<{ from: number; to: number; block: boolean; replace: boolean; w: ImageWidget }> = []
    buildDecorations(state, opts).between(0, state.doc.length, (from, to, d) => {
      const w = d.spec.widget
      if (w instanceof ImageWidget) out.push({ from, to, block: !!d.spec.block, replace: to > from, w })
    })
    return out
  }
  const doc = '- mouse icon should show as a button?\n![|725](assets/2026/10/a.png)\nnext'
  const from = doc.indexOf('![')
  const to = doc.indexOf('\nnext')

  test('hidden: the ref is replaced by the picture (no block widget, no source)', () => {
    const ws = widgets(EditorState.create({ doc, selection: EditorSelection.cursor(0) }))
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({ from, to, block: false, replace: true })
    expect(ws[0]!.w.block).toBe(false)
  })

  test('revealed: source stays as text, picture is a block widget at the line end (below the line)', () => {
    const s = EditorState.create({ doc, selection: EditorSelection.cursor(from + 3) })
    const ws = widgets(s)
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({ from: to, to, block: true, replace: false })
    expect(ws[0]!.w.block).toBe(true)
    expect(ws[0]!.w.width).toBe(725)
    expect(decorated(doc, from + 3).visible).toContain('![|725](assets/2026/10/a.png)')
  })

  test('revealed with surrounding spaces: still a block, placed after the trailing spaces', () => {
    const d = 'a\n  ![](x.png)  \nb'
    const lineEnd = d.indexOf('\nb')
    const ws = widgets(EditorState.create({ doc: d, selection: EditorSelection.cursor(d.indexOf('![') + 1) }))
    expect(ws[0]).toMatchObject({ from: lineEnd, block: true })
  })

  test('an image mixed with text stays inline when revealed', () => {
    const d = 'see ![](x.png) here'
    const end = d.indexOf(')') + 1
    const ws = widgets(EditorState.create({ doc: d, selection: EditorSelection.cursor(6) }))
    expect(ws[0]).toMatchObject({ from: end, to: end, block: false, replace: false })
    expect(ws[0]!.w.block).toBe(false)
  })

  test('block vs inline widgets are distinct (re-render on reveal toggle)', () => {
    const a = new ImageWidget(['u'], 'a', 's', 300, undefined, false, true)
    expect(a.eq(new ImageWidget(['u'], 'a', 's', 300, undefined, false, true))).toBe(true)
    expect(a.eq(new ImageWidget(['u'], 'a', 's', 300))).toBe(false)
  })

  test('livePreview() extension builds (decorations come from a StateField, block widgets allowed)', async () => {
    const { livePreview } = await import('./livePreview')
    let s = EditorState.create({ doc, selection: EditorSelection.cursor(0), extensions: [livePreview(opts)] })
    s = s.update({ selection: { anchor: from + 3 } }).state
    expect(s.doc.toString()).toBe(doc)
  })
})

describe('live preview: plain click on a picture selects it without revealing the source', () => {
  test('caret stays put, ring is set, source stays hidden; ⌘C target is the image', async () => {
    const m = await import('./imageEdit')
    const doc = 'hello\n![](assets/a.png)\nbye'
    const from = doc.indexOf('![')
    const to = doc.indexOf('\nbye')
    let s = EditorState.create({
      doc,
      selection: EditorSelection.range(0, 3),
      extensions: [m.imageGestureField, m.selectedImageField]
    })
    s = s.update(m.beginImageGestureSpec(s, { from, to })).state
    s = s.update(m.imageClickSpec(s, { from, to })).state
    expect(s.field(m.imageGestureField)).toBeNull()
    // Collapsed to the old head, nowhere near the ref.
    expect(s.selection.main.empty).toBe(true)
    expect(s.selection.main.head).toBe(3)
    expect(m.imageSourceRevealed(s, from, to)).toBe(false)
    expect(m.selectedImageRef(s)).toEqual({ from, to })
    const ws: Array<{ replace: boolean; selected: boolean }> = []
    buildDecorations(s, opts).between(0, doc.length, (f, t, d) => {
      if (d.spec.widget instanceof ImageWidget) ws.push({ replace: t > f, selected: d.spec.widget.selected })
    })
    expect(ws).toEqual([{ replace: true, selected: true }])
    // Re-dispatching the same selection (e.g. focus) keeps the ring; moving away clears it.
    expect(m.selectedImageRef(s.update({ selection: { anchor: 3 } }).state)).toEqual({ from, to })
    expect(m.selectedImageRef(s.update({ selection: { anchor: 1 } }).state)).toBeNull()
  })

  test('clicking a picture whose source is already revealed keeps it revealed', async () => {
    const m = await import('./imageEdit')
    const doc = '![](assets/a.png)'
    let s = EditorState.create({
      doc,
      selection: EditorSelection.cursor(4),
      extensions: [m.imageGestureField, m.selectedImageField]
    })
    s = s.update(m.beginImageGestureSpec(s, { from: 0, to: doc.length })).state
    s = s.update(m.imageClickSpec(s, { from: 0, to: doc.length })).state
    expect(s.selection.main.head).toBe(4)
    expect(m.imageSourceRevealed(s, 0, doc.length)).toBe(true)
    expect(m.selectedImageRef(s)).toEqual({ from: 0, to: doc.length })
  })
})
