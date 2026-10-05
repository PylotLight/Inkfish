import { describe, expect, test } from 'bun:test'
import { baseName, displayTitle, dropDupH1, fmtBytes, fmtChars, plain } from './text'

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

  test('assetUrl maps vault-relative images to asset:// only', async () => {
    const { assetUrl } = await import('./md')
    expect(assetUrl('assets/2026/10/x.png')).toBe('asset://assets/2026/10/x.png')
    expect(assetUrl('https://a/b.png')).toBe('https://a/b.png')
    expect(assetUrl('data:image/png;base64,xx')).toBe('data:image/png;base64,xx')
    expect(assetUrl('a b/c.png')).toBe('asset://a%20b/c.png')
  })
})
