import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { buildLiveMarkdownDecorations, ImageWidget, TaskBoxWidget } from '../src/lib/liveMarkdown'
import type { LiveMarkdownOptions } from '../src/lib/liveMarkdown'

const options: LiveMarkdownOptions = {
  notePath: 'projects/Notes.md',
  files: ['assets/task.png'],
  vaultRoot: 'file:///vault/',
  title: 'A note',
  hideCompletedTasks: false
}

function widgets(doc: string, activeLine = -1, extra: Partial<LiveMarkdownOptions> = {}) {
  const state = EditorState.create({ doc })
  const found: Array<{ from: number; to: number; widget: unknown; className?: string }> = []
  buildLiveMarkdownDecorations(state, { ...options, ...extra }, activeLine, () => undefined).between(
    0,
    doc.length,
    (from, to, decoration) => {
      found.push({ from, to, widget: decoration.spec.widget, className: decoration.spec.class })
    }
  )
  return found
}

describe('Android live Markdown source and task preview', () => {
  test('bare [] and - [] become accessible task widgets without inserting a source space', () => {
    const source = '[] bare\n- [] bulleted\n[x] done'
    const state = EditorState.create({ doc: source })
    const boxes: TaskBoxWidget[] = []
    buildLiveMarkdownDecorations(state, options, -1, () => undefined).between(
      0,
      source.length,
      (_from, _to, decoration) => {
        if (decoration.spec.widget instanceof TaskBoxWidget) boxes.push(decoration.spec.widget)
      }
    )
    expect(boxes.map(({ checked, bullet }) => ({ checked, bullet }))).toEqual([
      { checked: false, bullet: false },
      { checked: false, bullet: true },
      { checked: true, bullet: false }
    ])
    expect(state.doc.toString()).toBe(source)
  })

  test('syntax decorations are presentation-only and reveal syntax on the active line', () => {
    const source = '# A note\n**bold** and [link](https://example.com)'
    const state = EditorState.create({ doc: source })
    const preview = widgets(source, -1, { title: 'Different title' })
    expect(preview.some((range) => range.from === 0 && range.to === 2 && range.widget === undefined)).toBe(true)
    expect(preview.some((range) => range.widget === undefined && range.to > range.from)).toBe(true)
    expect(state.doc.toString()).toBe(source)

    const editing = widgets(source, 1, { title: 'Different title' })
    expect(editing.some((range) => range.from === 0 && range.to === 2 && range.widget === undefined)).toBe(false)
  })

  test('local image decorations resolve through the existing vault resolver without rewriting the reference', () => {
    const source = 'See ![task|120](assets/task.png)'
    const state = EditorState.create({ doc: source })
    const images: ImageWidget[] = []
    buildLiveMarkdownDecorations(state, options, -1, () => undefined).between(
      0,
      source.length,
      (_from, _to, decoration) => {
        if (decoration.spec.widget instanceof ImageWidget) images.push(decoration.spec.widget)
      }
    )
    expect(images).toHaveLength(1)
    expect(images[0]?.uri).toBe('file:///vault/assets/task.png')
    expect(images[0]?.token.width).toBe(120)
    expect(state.doc.toString()).toBe(source)
  })

  test('completed tasks can still be hidden and remain unchanged in the source document', () => {
    const source = '[x] completed\n[] open'
    const state = EditorState.create({ doc: source })
    const found = widgets(source, -1, { hideCompletedTasks: true })
    expect(found.some((range) => range.className === 'cm-md-hidden-completed')).toBe(true)
    expect(state.doc.toString()).toBe(source)
  })
})
