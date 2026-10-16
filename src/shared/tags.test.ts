import { describe, expect, test } from 'bun:test'
import { addTag, matchesTags, normalizeTag, parseTagQuery, parseTags, removeTag, setTags, uniqueTags } from './tags'

describe('normalizeTag', () => {
  test('strips # and spaces', () => {
    expect(normalizeTag('  #Work Stuff ')).toBe('Work-Stuff')
    expect(normalizeTag('##a/b')).toBe('a/b')
    expect(normalizeTag('#')).toBe('')
    expect(normalizeTag('"q"')).toBe('q')
  })
  test('uniqueTags dedupes case-insensitively', () => {
    expect(uniqueTags(['a', 'A', '#b', '', 'b'])).toEqual(['a', 'b'])
  })
})

describe('parseTags', () => {
  test('inline list', () => {
    expect(parseTags('---\ntags: [a, "b c", #d]\n---\nbody')).toEqual(['a', 'b-c', 'd'])
  })
  test('block list (indented or not)', () => {
    expect(parseTags('---\ntitle: x\ntags:\n  - one\n  - two\nkind: text\n---\n')).toEqual(['one', 'two'])
    expect(parseTags('---\ntags:\n- one\n- two\n---\n')).toEqual(['one', 'two'])
  })
  test('scalar', () => {
    expect(parseTags('---\ntags: a, b c\n---\n')).toEqual(['a', 'b', 'c'])
  })
  test('none', () => {
    expect(parseTags('no frontmatter #inline')).toEqual([])
    expect(parseTags('---\nkind: text\n---\n')).toEqual([])
    expect(parseTags('---\nunterminated')).toEqual([])
  })
})

describe('setTags', () => {
  test('adds frontmatter when missing, body untouched', () => {
    expect(setTags('# Hi\n', ['work'])).toBe('---\ntags: [work]\n---\n# Hi\n')
    expect(setTags('# Hi\n', [])).toBe('# Hi\n')
  })
  test('replaces existing key, keeps others verbatim', () => {
    const md = '---\nid: x\ntags:\n  - old\ncreated: "2026-01-01T00:00:00Z"\n---\nbody\n'
    expect(setTags(md, ['a', 'b'])).toBe('---\nid: x\ntags: [a, b]\ncreated: "2026-01-01T00:00:00Z"\n---\nbody\n')
  })
  test('appends key when frontmatter has none', () => {
    expect(setTags('---\nkind: text\n---\nb', ['x'])).toBe('---\nkind: text\ntags: [x]\n---\nb')
  })
  test('removing last tag drops key, and block when empty', () => {
    expect(setTags('---\nkind: text\ntags: [x]\n---\nb', [])).toBe('---\nkind: text\n---\nb')
    expect(setTags('---\ntags: [x]\n---\nb', [])).toBe('b')
  })
  test('quotes awkward tags and round-trips', () => {
    const md = setTags('', ['a:b'])
    expect(md).toBe('---\ntags: ["a:b"]\n---\n')
    expect(parseTags(md)).toEqual(['a:b'])
  })
  test('CRLF files keep CRLF', () => {
    expect(setTags('---\r\nkind: t\r\n---\r\nb', ['x'])).toBe('---\r\nkind: t\r\ntags: [x]\r\n---\r\nb')
  })
  test('add / remove helpers', () => {
    const a = addTag('body', '#Work')
    expect(parseTags(a)).toEqual(['Work'])
    expect(parseTags(addTag(a, 'work'))).toEqual(['Work'])
    expect(removeTag(a, 'WORK')).toBe('body')
  })
})

describe('tag search', () => {
  test('parseTagQuery', () => {
    expect(parseTagQuery('#work')).toEqual({ tags: ['work'], text: '' })
    expect(parseTagQuery('tag:Work meeting notes')).toEqual({ tags: ['work'], text: 'meeting notes' })
    expect(parseTagQuery('tag:#a #b')).toEqual({ tags: ['a', 'b'], text: '' })
    expect(parseTagQuery('plain text')).toBeNull()
    expect(parseTagQuery('#')).toBeNull()
  })
  test('matchesTags exact + nested', () => {
    expect(matchesTags(['Work', 'x'], ['work'])).toBe(true)
    expect(matchesTags(['work/client'], ['work'])).toBe(true)
    expect(matchesTags(['workshop'], ['work'])).toBe(false)
    expect(matchesTags(['a'], ['a', 'b'])).toBe(false)
  })
})
