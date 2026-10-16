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
