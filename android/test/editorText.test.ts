import { describe, expect, test } from 'bun:test'
import { insertImageReference, toggleTaskLine } from '../src/lib/editorText'

describe('Android editor task toggling', () => {
  test('bare brackets can be checked without inserting an interior space first', () => {
    expect(toggleTaskLine('[] buy milk', '2026-11-02')).toBe('[x] buy milk ✅ 2026-11-02')
    expect(toggleTaskLine('- [] buy milk', '2026-11-02')).toBe('- [x] buy milk ✅ 2026-11-02')
  })

  test('checked tasks uncheck and drop a completion date', () => {
    expect(toggleTaskLine('  - [X] done ✅ 2026-11-02', '2026-11-03')).toBe('  - [ ] done')
  })

  test('non-task bracket text stays untouched', () => {
    expect(toggleTaskLine('- [open] issue', '2026-11-02')).toBeNull()
    expect(toggleTaskLine('[]x', '2026-11-02')).toBeNull()
  })
})

describe('Android editor image reference insertion', () => {
  test('inserts an image at an empty caret', () => {
    expect(insertImageReference('', { start: 0, end: 0 }, 'assets/2026/11/a.png')).toEqual({
      text: '![](assets/2026/11/a.png)',
      selection: { start: 25, end: 25 }
    })
  })

  test('replaces the selected text and preserves the surrounding lines', () => {
    const text = 'alpha beta gamma'
    const start = text.indexOf('beta')
    const result = insertImageReference(text, { start, end: start + 4 }, 'assets/a.png')
    expect(result.text).toBe('alpha\n![](assets/a.png)\ngamma')
    expect(result.selection.start).toBe('alpha\n![](assets/a.png)\n'.length)
    expect(result.selection.end).toBe(result.selection.start)
  })
})
