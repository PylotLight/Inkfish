import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { IMAGE_LONG_PRESS_MS, imageGestureActions, resizeImageEditAt } from '../src/lib/imageGestures'

function applyResize(source: string, width: number | null): string | null {
  const edit = resizeImageEditAt(source, 0, width)
  if (!edit) return null
  const state = EditorState.create({ doc: source })
  return state.update({ changes: edit }).state.doc.toString()
}

describe('Android direct image gestures', () => {
  test('uses a long-press threshold and offers copy plus common display widths', () => {
    expect(IMAGE_LONG_PRESS_MS).toBe(500)
    expect(imageGestureActions().map((action) => action.label)).toEqual([
      'Copy image',
      'Small · 120 px',
      'Medium · 240 px',
      'Large · 360 px'
    ])
  })

  test('offers reset only for an image with an explicit size', () => {
    expect(imageGestureActions(240).at(-1)).toEqual({ type: 'resize', label: 'Reset size', width: null })
  })

  test('resizes and resets a Markdown image while preserving its alt text and path', () => {
    const source = '![a flower](assets/flower.png)'
    expect(applyResize(source, 240)).toBe('![a flower|240](assets/flower.png)')
    expect(applyResize('![a flower|240](assets/flower.png)', null)).toBe(source)
  })

  test('resizes an Obsidian embed and preserves an existing aspect ratio', () => {
    expect(applyResize('![[assets/flower.png|120x60]]', 240)).toBe('![[assets/flower.png|240x120]]')
    expect(applyResize('![[assets/flower.png|240x120]]', null)).toBe('![[assets/flower.png]]')
  })
})
