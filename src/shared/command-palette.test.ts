import { describe, expect, test } from 'bun:test'
import {
  formatAccelerator,
  fuzzyScore,
  matchFields,
  parsePaletteQuery,
  parseRecent,
  rankPalette,
  recordRecent,
  type PaletteCommand,
  type PaletteNote
} from './command-palette'

const commands: PaletteCommand[] = [
  { id: 'new-note', title: 'New Note', section: 'Notes', keywords: ['create', 'file'] },
  { id: 'today', title: 'Open Today', section: 'Notes', keywords: ['daily', 'journal'] },
  { id: 'toggle-sidebar', title: 'Toggle Sidebar', section: 'View', accelerator: 'CmdOrCtrl+\\' },
  { id: 'pop-out', title: 'Pop Out to Mini Window', section: 'Window', accelerator: 'CmdOrCtrl+Shift+M' },
  { id: 'disabled', title: 'Close Tab', section: 'Tabs', enabled: false }
]
const notes: PaletteNote[] = [
  { id: 'a', title: 'Groceries', path: 'Personal/groceries.md', tags: ['shopping'], updatedAt: 3 },
  { id: 'b', title: 'Surffish roadmap', path: 'Projects/Surffish/roadmap.md', updatedAt: 2 },
  { id: 'c', title: 'Standup notes', path: 'Work/standup.md', updatedAt: 1 }
]
const rank = (input: string, mode: 'all' | 'notes' | 'commands' = 'all', recent: string[] = []) =>
  rankPalette({ input, mode, commands, notes, recent, platform: 'darwin' })

describe('fuzzy matching', () => {
  test('prefix beats word start beats anywhere; non-subsequence is null', () => {
    const prefix = fuzzyScore('tog', 'Toggle Sidebar')!
    const word = fuzzyScore('side', 'Toggle Sidebar')!
    const inner = fuzzyScore('gle', 'Toggle Sidebar')!
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inner)
    expect(fuzzyScore('xyz', 'Toggle Sidebar')).toBeNull()
    expect(fuzzyScore('tsb', 'Toggle Sidebar')).not.toBeNull()
  })
  test('every term must match some field', () => {
    expect(matchFields('open daily', ['Open Today', 'daily'])).not.toBeNull()
    expect(matchFields('open zzz', ['Open Today', 'daily'])).toBeNull()
  })
})

describe('accelerators', () => {
  test('mac symbols and other platforms', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+M', 'darwin')).toBe('⇧⌘M')
    expect(formatAccelerator('CmdOrCtrl+Shift+M', 'linux')).toBe('Ctrl+Shift+M')
    expect(formatAccelerator(null, 'darwin')).toBeNull()
  })
})

describe('recents', () => {
  test('most recent first, deduped, capped', () => {
    expect(recordRecent(['cmd:a', 'note:b'], 'note:b')).toEqual(['note:b', 'cmd:a'])
    expect(parseRecent(['x', 'x', 3, '', 'y'])).toEqual(['x', 'y'])
    expect(parseRecent('nope')).toEqual([])
  })
})

describe('rankPalette', () => {
  test('> forces commands only', () => {
    expect(parsePaletteQuery('> tog', 'all')).toEqual({ query: 'tog', mode: 'commands' })
    expect(rank('>').every((i) => i.kind === 'command')).toBe(true)
    expect(rank('>').length).toBe(4)
  })
  test('empty query shows recent commands, then recent notes by recency', () => {
    const items = rank('', 'all', ['note:c', 'cmd:today'])
    expect(items[0]).toMatchObject({ kind: 'command', commandId: 'today' })
    expect(items.filter((i) => i.kind === 'note').map((i) => i.key)).toEqual(['note:c', 'note:a', 'note:b'])
  })
  test('notes mode never lists commands', () => {
    expect(rank('new', 'notes').some((i) => i.kind === 'command')).toBe(false)
  })
  test('finds notes by title, folder and tag', () => {
    expect(rank('groc')[0]).toMatchObject({ kind: 'note', noteId: 'a' })
    expect(rank('surffish road')[0]).toMatchObject({ noteId: 'b' })
    expect(rank('#shopping')[0]).toMatchObject({ noteId: 'a' })
  })
  test('finds commands by keyword and shows the shortcut; disabled commands are hidden', () => {
    expect(rank('journal')[0]).toMatchObject({ kind: 'command', commandId: 'today' })
    expect(rank('pop out')[0]).toMatchObject({ commandId: 'pop-out', shortcut: '⇧⌘M' })
    expect(rank('close tab').some((i) => i.kind === 'command')).toBe(false)
  })
  test('recent picks get a boost', () => {
    const plain = rank('st').map((i) => i.key)
    const boosted = rank('st', 'all', ['note:c']).map((i) => i.key)
    expect(boosted.indexOf('note:c')).toBeLessThanOrEqual(plain.indexOf('note:c'))
    expect(boosted[0]).toBe('note:c')
  })
})
