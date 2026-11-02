import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { buildLiveMarkdownDecorations, headingCollapseKey, ImageWidget, TaskBoxWidget } from '../src/lib/liveMarkdown'
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

  test('hiding a completed task also hides its indented image and continuation lines', () => {
    const source = '- [x] completed\n  ![[assets/task.png]]\n  details\n- [ ] open\n  ![[assets/task.png]]'
    const state = EditorState.create({ doc: source })
    const found = widgets(source, -1, { hideCompletedTasks: true })
    const lineStarts = source
      .split('\n')
      .map((line, index, lines) => lines.slice(0, index).join('\n').length + (index ? 1 : 0))
    const images = found.filter((range) => range.widget instanceof ImageWidget)

    expect(found.some((range) => range.className === 'cm-md-hidden-completed' && range.from === lineStarts[1])).toBe(
      true
    )
    expect(found.some((range) => range.className === 'cm-md-hidden-completed' && range.from === lineStarts[2])).toBe(
      true
    )
    expect(images).toHaveLength(1)
    expect(images[0]?.from).toBeGreaterThan(lineStarts[3])
    expect(state.doc.toString()).toBe(source)
  })

  test('a collapsed heading hides its nested content through the next same-or-higher heading only', () => {
    const source = '# Group\nintro\n![[assets/task.png]]\n## Child\nchild text\n# Next\nvisible\n![[assets/task.png]]'
    const state = EditorState.create({ doc: source })
    const key = headingCollapseKey('# Group', 1)
    const found = widgets(source, -1, { collapsedHeadings: [key] })
    const lines = source.split('\n')
    const starts = lines.map((_, index) => lines.slice(0, index).join('\n').length + (index ? 1 : 0))
    const images = found.filter((range) => range.widget instanceof ImageWidget)
    const foldedRows = found.filter((range) => range.className === 'cm-md-folded-line').map((range) => range.from)

    expect(foldedRows).toEqual([starts[1], starts[2], starts[3], starts[4]])
    expect(images).toHaveLength(1)
    expect(images[0]?.from).toBeGreaterThan(starts[5])
    expect(state.doc.toString()).toBe(source)
  })
})
