import { describe, expect, it } from 'bun:test'
import { findMatches, isInvalidQuery, matchAtOrAfter, replacementFor, seedFromSelection, wrapIndex } from './find'

describe('findMatches', () => {
  it('is case-insensitive by default', () => {
    expect(findMatches('Foo foo FOO', 'foo')).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 8, to: 11 }
    ])
  })
  it('honours match case', () => {
    expect(findMatches('Foo foo FOO', 'foo', { caseSensitive: true })).toEqual([{ from: 4, to: 7 }])
  })
  it('treats regex chars literally unless regex mode', () => {
    expect(findMatches('a.b axb', 'a.b')).toEqual([{ from: 0, to: 3 }])
    expect(findMatches('a.b axb', 'a.b', { regex: true })).toHaveLength(2)
  })
  it('whole word skips partial hits, unicode aware', () => {
    expect(findMatches('cat concat cat_x café cat', 'cat', { wholeWord: true })).toEqual([
      { from: 0, to: 3 },
      { from: 22, to: 25 }
    ])
    expect(findMatches('café cafés', 'café', { wholeWord: true })).toEqual([{ from: 0, to: 4 }])
  })
  it('skips zero-length regex hits and survives invalid regex', () => {
    expect(findMatches('abc', 'x*', { regex: true })).toEqual([])
    expect(findMatches('abc', '(', { regex: true })).toEqual([])
    expect(isInvalidQuery('(', { regex: true })).toBe(true)
    expect(isInvalidQuery('(', {})).toBe(false)
  })
  it('regex ^ is per line', () => {
    expect(findMatches('- a\n- b', '^- ', { regex: true })).toHaveLength(2)
  })
})

describe('helpers', () => {
  it('wrapIndex', () => {
    expect(wrapIndex(-1, 3)).toBe(2)
    expect(wrapIndex(3, 3)).toBe(0)
    expect(wrapIndex(5, 0)).toBe(0)
  })
  it('matchAtOrAfter lands on the next hit from the caret, wrapping', () => {
    const m = findMatches('x a x b x', 'x')
    expect(matchAtOrAfter(m, 0)).toBe(0)
    expect(matchAtOrAfter(m, 3)).toBe(1)
    expect(matchAtOrAfter(m, 9)).toBe(0)
  })
  it('replacementFor expands groups only in regex mode', () => {
    const t = 'john smith'
    const [m] = findMatches(t, '(\\w+) (\\w+)', { regex: true })
    expect(replacementFor(t, m!, '(\\w+) (\\w+)', '$2, $1', { regex: true })).toBe('smith, john')
    const [p] = findMatches(t, 'john')
    expect(replacementFor(t, p!, 'john', '$1')).toBe('$1')
  })
  it('seedFromSelection', () => {
    expect(seedFromSelection('word')).toBe('word')
    expect(seedFromSelection('a\nb')).toBeNull()
    expect(seedFromSelection('')).toBeNull()
  })
})
