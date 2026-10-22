import { describe, expect, test } from 'bun:test'
import {
  QUICK_DELETE_CHARS,
  bodyChars,
  deleteNeedsConfirm,
  noteBody,
  previewLines,
  renameCommit,
  renameStem,
  rowKeyAction,
  stripFrontMatter
} from './note-delete'

describe('quick delete rule', () => {
  test('empty and title-only notes skip the confirm', () => {
    expect(deleteNeedsConfirm('')).toBe(false)
    expect(deleteNeedsConfirm('# Untitled\n')).toBe(false)
    expect(deleteNeedsConfirm('# Shopping\n\n- \n- [ ] \n')).toBe(false)
    expect(deleteNeedsConfirm('---\ntags: [a, b]\ncreated: 2026-10-19\n---\n# Note\n\nhi\n')).toBe(false)
  })

  test('real content asks first', () => {
    const md = '# Plan\n\nCall the plumber about the leak under the sink on monday\n'
    expect(bodyChars(md)).toBeGreaterThanOrEqual(QUICK_DELETE_CHARS)
    expect(deleteNeedsConfirm(md)).toBe(true)
  })

  test('front matter does not count as content', () => {
    const fm = `---\n${'tags: [x]\n'.repeat(20)}---\n`
    expect(deleteNeedsConfirm(fm)).toBe(false)
    expect(stripFrontMatter(fm)).toBe('')
  })

  test('threshold is the boundary', () => {
    expect(deleteNeedsConfirm('x'.repeat(39))).toBe(false)
    expect(deleteNeedsConfirm('x'.repeat(40))).toBe(true)
    expect(deleteNeedsConfirm('x'.repeat(10), 5)).toBe(true)
  })

  test('only the leading heading is the title', () => {
    expect(noteBody('# A\n## B\ntext')).toBe('## B\ntext')
  })
})

describe('previewLines', () => {
  test('first non-blank body lines, clipped', () => {
    const md = `---\na: 1\n---\n# T\n\none\n\ntwo\nthree\nfour\nfive\nsix\nseven\n${'z'.repeat(300)}`
    expect(previewLines(md)).toEqual(['one', 'two', 'three', 'four', 'five', 'six'])
    const long = previewLines(`# T\n${'z'.repeat(300)}`, 6, 20)
    expect(long[0]!.length).toBe(20)
    expect(long[0]!.endsWith('…')).toBe(true)
  })
})

describe('inline rename', () => {
  test('stem drops .md', () => {
    expect(renameStem('Work/plan.md')).toBe('plan')
    expect(renameStem('img.png')).toBe('img.png')
  })
  test('commit ignores empty / unchanged names', () => {
    expect(renameCommit('Work/plan.md', '  ')).toBeNull()
    expect(renameCommit('Work/plan.md', 'plan')).toBeNull()
    expect(renameCommit('Work/plan.md', 'plan.md')).toBeNull()
    expect(renameCommit('Work/plan.md', ' Plan v2 ')).toBe('Plan v2')
  })
})

describe('row keys', () => {
  const k = (
    key: string,
    m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}
  ) => rowKeyAction({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m })
  test('F2 renames; Enter is left to the row (opens the note)', () => {
    expect(k('F2')).toBe('rename')
    expect(k('F2', { metaKey: true })).toBeNull()
    expect(k('Enter')).toBeNull()
    expect(k('Enter', { shiftKey: true })).toBeNull()
  })
  test('cmd+backspace deletes, plain backspace does not', () => {
    expect(k('Backspace', { metaKey: true })).toBe('delete')
    expect(k('Backspace', { metaKey: true, shiftKey: true })).toBe('delete')
    expect(k('Backspace', { ctrlKey: true })).toBe('delete')
    expect(k('Backspace')).toBeNull()
    expect(k('Backspace', { metaKey: true, altKey: true })).toBeNull()
  })
})
