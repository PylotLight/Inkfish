import { describe, expect, test } from 'bun:test'
import { baseName, displayTitle, dropDupH1, findAll, fmtBytes, fmtChars, plain } from './text'

describe('display titles', () => {
  test('filename wins over indexed first line', () => {
    const e = { id: 'history/a.md', path: 'history/a.md', title: 'Yes, **Monaco** blah' }
    expect(displayTitle(e, {})).toBe('a')
  })

  test('override wins over filename; inbox keeps first line', () => {
    const e = { id: 'history/a.md', path: 'history/a.md', title: 'whatever' }
    expect(displayTitle(e, { 'history/a.md': 'Custom' })).toBe('Custom')
    const inbox = { id: 'in-1', path: 'inbox/in-1.md', title: '**hello** world' }
    expect(displayTitle(inbox, {})).toBe('hello world')
  })

  test('portable frontmatter title wins over both filename and legacy override', () => {
    const e = { id: 'history/a.md', path: 'history/a.md', title: 'body heading', frontmatterTitle: 'Trip: Japan' }
    expect(displayTitle(e, { 'history/a.md': 'Old local title' })).toBe('Trip: Japan')
    expect(displayTitle({ ...e, frontmatterTitle: '**Trip** [notes](https://example.com)' }, {})).toBe('Trip notes')
  })

  test('baseName strips dirs and .md', () => {
    expect(baseName('history/diffs/undo/History & diff mgmt.md')).toBe('History & diff mgmt')
    expect(baseName('todo.md')).toBe('todo')
  })

  test('dropDupH1 removes a leading H1 matching the title only', () => {
    expect(dropDupH1('# Cake\nyummy', 'Cake')).toBe('yummy')
    expect(dropDupH1('# Cake\nyummy', 'Pie')).toBe('# Cake\nyummy')
    expect(dropDupH1('Just text', 'Just text')).toBe('Just text')
    expect(dropDupH1('## Cake\nyummy', 'Cake')).toBe('## Cake\nyummy')
  })

  test('fmtChars + fmtBytes + plain sanity', () => {
    expect(fmtChars(42)).toBe('42 chars')
    expect(fmtChars(2048)).toBe('2.0k chars')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(plain('Yes, **Monaco** [x](y)')).toBe('Yes, Monaco x')
  })

  test('findAll locates case-insensitive hits in order', () => {
    expect(findAll('Hello hello HELLO world', 'hello')).toEqual([0, 6, 12])
    expect(findAll('aaa', 'aa')).toEqual([0])
    expect(findAll('nothing here', 'z')).toEqual([])
    expect(findAll('anything', '')).toEqual([])
  })
})

describe('daily note titles', () => {
  test('day notes read as a friendly date; overrides still win', () => {
    const y = new Date().getFullYear()
    const e = { id: 'd', path: `daily/${y}-10-20.md`, title: '' }
    expect(displayTitle(e, {})).toMatch(/^[A-Z][a-z]{2} 20 Oct$/)
    expect(displayTitle(e, { d: 'custom' })).toBe('custom')
    expect(displayTitle({ id: 'n', path: 'work/2026-10-20.md', title: '' }, {})).toBe('2026-10-20')
  })
})
