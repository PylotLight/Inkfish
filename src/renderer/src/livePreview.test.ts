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
