import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { buildDecorations, ImageWidget, listEnterUpdate, taskShorthandUpdate, TaskBulletWidget } from './livePreview'

const opts = { onToggleTask: () => {}, resolveImage: (src: string) => [`asset://vault/${src}`] }

/** Dispatch Enter at `cursor`; returns the new doc (null = key not handled) and caret. */
function pressEnter(doc: string, cursor: number): { doc: string | null; head: number } {
  const s = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const u = listEnterUpdate(s)
  if (!u) return { doc: null, head: -1 }
  const s2 = s.update(u).state
  return { doc: s2.doc.toString(), head: s2.selection.main.head }
}

describe('list keys: Enter continues lists (incl. nested)', () => {
  test('top-level bullet gets a sibling', () => {
    expect(pressEnter('- apple', '- apple'.length)).toEqual({ doc: '- apple\n- ', head: 10 })
  })

  test('nested bullet keeps its indent (2 and 4 spaces)', () => {
    expect(pressEnter('  - apple', '  - apple'.length).doc).toBe('  - apple\n  - ')
    expect(pressEnter('    - apple', '    - apple'.length).doc).toBe('    - apple\n    - ')
  })

  test('nested item under a parent keeps the nesting depth', () => {
    const doc = '- parent\n  - child'
    expect(pressEnter(doc, doc.length)).toEqual({ doc: '- parent\n  - child\n  - ', head: doc.length + 5 })
  })

  test('`*` and `+` markers continue with themselves', () => {
    expect(pressEnter('* star', 6).doc).toBe('* star\n* ')
    expect(pressEnter('  + plus', 8).doc).toBe('  + plus\n  + ')
  })

  test('nested task re-opens unchecked', () => {
    const doc = '  - [x] done'
    expect(pressEnter(doc, doc.length).doc).toBe('  - [x] done\n  - [ ] ')
  })

  test('numbered items increment', () => {
    expect(pressEnter('  3. apple', '  3. apple'.length).doc).toBe('  3. apple\n  4. ')
  })

  test('Enter on an empty nested item clears it (exits the list)', () => {
    const doc = '- parent\n  - '
    const r = pressEnter(doc, doc.length)
    expect(r.doc).toBe('- parent\n')
    expect(r.head).toBe(9)
  })

  test('markerless tasks continue without a marker, keeping their indent', () => {
    expect(pressEnter('[ ] todo', 8)).toEqual({ doc: '[ ] todo\n[ ] ', head: 13 })
    expect(pressEnter('[x] done', 8).doc).toBe('[x] done\n[ ] ')
    expect(pressEnter('  [ ] todo', '  [ ] todo'.length).doc).toBe('  [ ] todo\n  [ ] ')
  })

  test('Enter on an empty markerless task clears it (exits the list)', () => {
    expect(pressEnter('[ ]', 3)).toEqual({ doc: '', head: 0 })
  })

  test('bracket text that is not a task is left to the default keymap', () => {
    expect(pressEnter('[open] issue', 12).doc).toBeNull()
    expect(pressEnter('[x]!', 4).doc).toBeNull()
  })

  test('plain text lines are left to the default keymap', () => {
    expect(pressEnter('hello', 5).doc).toBeNull()
    // Caret mid-line: not ours.
    expect(pressEnter('- apple', 3).doc).toBeNull()
  })
})

/** Dispatch a space press at `cursor`; returns the new doc (null = key not handled) and caret. */
function pressSpace(doc: string, cursor: number): { doc: string | null; head: number } {
  const s = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const u = taskShorthandUpdate(s)
  if (!u) return { doc: null, head: -1 }
  const s2 = s.update(u).state
  return { doc: s2.doc.toString(), head: s2.selection.main.head }
}

describe('list keys: [] expands to a task on space', () => {
  test('bare [] with the caret after it becomes [ ] ', () => {
    expect(pressSpace('[]', 2)).toEqual({ doc: '[ ] ', head: 4 })
  })

  test('indented [] keeps its indent', () => {
    expect(pressSpace('  []', 4)).toEqual({ doc: '  [ ] ', head: 6 })
  })

  test('a caret not at the end of the brackets is left alone', () => {
    expect(pressSpace('[]', 1).doc).toBeNull()
  })

  test('brackets with text before or after are left alone', () => {
    expect(pressSpace('a []', 4).doc).toBeNull()
    expect(pressSpace('[]x', 3).doc).toBeNull()
    expect(pressSpace('[ ]', 3).doc).toBeNull()
  })

  test('expands only the line the caret is on', () => {
    expect(pressSpace('foo\n[]', 6)).toEqual({ doc: 'foo\n[ ] ', head: 8 })
  })
})

describe('live preview task checkboxes', () => {
  /** Task widgets found in the doc (one per rendered checkbox). */
  function taskWidgets(doc: string): Array<{ from: number; checked: boolean; bullet: boolean }> {
    const state = EditorState.create({ doc })
    const out: Array<{ from: number; checked: boolean; bullet: boolean }> = []
    const set = buildDecorations(state, opts)
    set.between(0, doc.length, (from, _to, deco) => {
      if (deco.spec.widget instanceof TaskBulletWidget) {
        out.push({ from, checked: deco.spec.widget.checked, bullet: deco.spec.widget.bullet })
      }
    })
    return out
  }

  test('dashes, asterisks and plusses all render a checkbox', () => {
    for (const line of ['- [ ] todo', '* [ ] todo', '+ [ ] todo']) {
      const w = taskWidgets(line)
      expect(w).toHaveLength(1)
      expect(w[0]!.checked).toBe(false)
      expect(w[0]!.bullet).toBe(true)
    }
  })

  test('a checked task renders a checked box', () => {
    const w = taskWidgets('- [x] done')
    expect(w).toHaveLength(1)
    expect(w[0]!.checked).toBe(true)
  })

  test('markerless [ ] and [x] lines render a checkbox without the bullet', () => {
    expect(taskWidgets('[ ] todo')).toEqual([{ from: 0, checked: false, bullet: false }])
    expect(taskWidgets('[x] done')).toEqual([{ from: 0, checked: true, bullet: false }])
    expect(taskWidgets('  [ ] indented')).toHaveLength(1)
  })

  test('deeply nested tasks keep their checkbox (no indent cap)', () => {
    const w = taskWidgets('        - [ ] twelve spaces') // 3 levels of 4-space nesting
    expect(w).toHaveLength(1)
  })

  test('bracket text that is not a task stays literal', () => {
    expect(taskWidgets('- [open] issue')).toHaveLength(0)
    expect(taskWidgets('- []')).toHaveLength(0)
    expect(taskWidgets('[]')).toHaveLength(0) // incomplete: no state char yet
  })
})

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

describe('live preview: caret left on a ref by paste/resize does not reveal its source', () => {
  async function setup(doc: string, cursor: number) {
    const m = await import('./imageEdit')
    const { livePreview } = await import('./livePreview')
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [livePreview(opts)]
    })
    const replaced = (s: EditorState) => {
      const out: boolean[] = []
      buildDecorations(s, opts).between(0, s.doc.length, (f, t, d) => {
        if (d.spec.widget instanceof ImageWidget) out.push(t > f)
      })
      return out
    }
    return { m, state, replaced }
  }
  const ref = '![](assets/2026/10/a-2026-10-18-622a47.png)'

  test('pasted ref (caret right after it) stays hidden, through a resize too', async () => {
    const { m, state, replaced } = await setup('hello\nbye', 5)
    // insertImages(): ref on its own line, caret right after it, no userEvent.
    const insert = `\n${ref}`
    let s = state.update({ changes: { from: 5, insert }, selection: { anchor: 5 + insert.length } }).state
    const from = 6
    let to = from + ref.length
    expect(s.selection.main.head).toBe(to)
    expect(m.imageSourceRevealed(s, from, to)).toBe(false)
    expect(replaced(s)).toEqual([true])

    // Resize gesture: begin (frozen hidden), Chromium's native selection lands on
    // the ref mid-drag, release writes |481 and puts the caret back.
    s = s.update(m.beginImageGestureSpec(s, { from, to })).state
    s = s.update({ selection: { anchor: from + 2 }, userEvent: 'select.pointer' }).state
    expect(m.imageSourceRevealed(s, from, to)).toBe(false)
    expect(replaced(s)).toEqual([true])
    s = s.update(m.endImageGestureSpec(s, m.resizeImageSpec(s, from, 481))).state
    to = from + ref.length + '|481'.length
    expect(s.doc.sliceString(from, to)).toBe('![|481](assets/2026/10/a-2026-10-18-622a47.png)')
    expect(s.selection.main.head).toBe(to)
    expect(m.imageSourceRevealed(s, from, to)).toBe(false)
    expect(replaced(s)).toEqual([true])

    // Deliberately putting the caret on it (arrow key / click) reveals it as before.
    const arrowed = s.update({ selection: { anchor: from }, userEvent: 'select' }).state
    expect(m.imageSourceRevealed(arrowed, from, to)).toBe(true)
    expect(replaced(arrowed)).toEqual([false])
    // Typing next to it ends the concealment too (backspace back onto it reveals).
    const typed = s.update({
      changes: { from: to, insert: 'x' },
      selection: { anchor: to + 1 },
      userEvent: 'input.type'
    }).state
    expect(typed.field(m.concealedImageField)).toBeNull()
    const back = typed.update({
      changes: { from: to, to: to + 1 },
      selection: { anchor: to },
      userEvent: 'delete.backward'
    }).state
    expect(m.imageSourceRevealed(back, from, to)).toBe(true)
  })

  test('a ref typed by hand stays revealed while you type it', async () => {
    const partial = ref.slice(0, -1)
    const { m, state } = await setup(partial, partial.length)
    const s = state.update({
      changes: { from: partial.length, insert: ')' },
      selection: { anchor: ref.length },
      userEvent: 'input.type'
    }).state
    expect(m.imageSourceRevealed(s, 0, ref.length)).toBe(true)
  })

  test('a deliberately revealed ref stays revealed through a resize (no layout jump)', async () => {
    const doc = `hello\n${ref}\nbye`
    const from = doc.indexOf('![')
    const { m, state } = await setup(doc, from + 3)
    let s = state.update({ selection: { anchor: from + 3 }, userEvent: 'select' }).state
    s = s.update(m.beginImageGestureSpec(s, { from, to: from + ref.length })).state
    s = s.update(m.endImageGestureSpec(s, m.resizeImageSpec(s, from, 300))).state
    expect(m.imageSourceRevealed(s, from, from + ref.length + 4)).toBe(true)
  })
})

describe('live preview underscore emphasis', () => {
  test('_italic_ and __bold__ hide their markers like the * forms', () => {
    expect(decorated('x\n_Day started._', 0).visible).toBe('x\nDay started.')
    expect(decorated('x\na __big__ deal', 0).visible).toBe('x\na big deal')
    expect(decorated('x\n*star* and _under_', 0).visible).toBe('x\nstar and under')
  })
  test('snake_case and lone underscores stay literal', () => {
    expect(decorated('x\nsome_var_name here', 0).visible).toBe('x\nsome_var_name here')
    expect(decorated('x\na _ b _ c', 0).visible).toBe('x\na _ b _ c')
  })
})
