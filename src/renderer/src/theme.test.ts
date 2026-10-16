import { describe, expect, test } from 'bun:test'
import { DEFAULT_PREFS, noteWidthFrom } from './theme'

describe('noteWidthFrom', () => {
  test('defaults to full width', () => {
    expect(DEFAULT_PREFS.noteWidth).toBe('full')
    expect(noteWidthFrom(null)).toBe('full')
    expect(noteWidthFrom({})).toBe('full')
  })

  test('old readableWidth flag is ignored (saved for everyone, so it never meant a choice)', () => {
    expect(noteWidthFrom({ readableWidth: true })).toBe('full')
    expect(noteWidthFrom({ readableWidth: false })).toBe('full')
  })

  test('keeps an explicit choice', () => {
    expect(noteWidthFrom({ noteWidth: 'wide', readableWidth: true })).toBe('wide')
    expect(noteWidthFrom({ noteWidth: 'readable' })).toBe('readable')
    expect(noteWidthFrom({ noteWidth: 'full' })).toBe('full')
  })

  test('junk falls back to full', () => {
    expect(noteWidthFrom({ noteWidth: 'huge' })).toBe('full')
    expect(noteWidthFrom({ noteWidth: 3 })).toBe('full')
  })
})
