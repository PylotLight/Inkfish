import { describe, expect, test } from 'bun:test'
import {
  baseOf,
  breadcrumb,
  canDropInto,
  cleanFolderPath,
  dirOf,
  foldersOf,
  isWithin,
  joinRel,
  normalizeRel,
  rankFolders,
  relativeRel,
  remapPath,
  rewriteLinks,
  uniqueName,
  type LinkRewriteContext
} from './note-move'

describe('path helpers', () => {
  test('dirOf / baseOf / joinRel', () => {
    expect(dirOf('a/b/c.md')).toBe('a/b')
    expect(dirOf('c.md')).toBe('')
    expect(baseOf('a/b/c.md')).toBe('c.md')
    expect(joinRel('', 'x.md')).toBe('x.md')
    expect(joinRel('a', 'x.md')).toBe('a/x.md')
  })
  test('isWithin', () => {
    expect(isWithin('a/b', 'a')).toBe(true)
    expect(isWithin('a', 'a')).toBe(true)
    expect(isWithin('ab', 'a')).toBe(false)
    expect(isWithin('x', '')).toBe(true)
  })
  test('normalizeRel / relativeRel', () => {
    expect(normalizeRel('a/./b/../c.md')).toBe('a/c.md')
    expect(normalizeRel('../x')).toBeNull()
    expect(relativeRel('Work/Images', 'assets/p.png')).toBe('../../assets/p.png')
    expect(relativeRel('', 'a/b.md')).toBe('a/b.md')
    expect(relativeRel('a', 'a/b.md')).toBe('b.md')
  })
  test('remapPath', () => {
    expect(remapPath('a/x.md', 'a/x.md', 'b/x.md')).toBe('b/x.md')
    expect(remapPath('a/sub/x.md', 'a', 'b/a')).toBe('b/a/sub/x.md')
    expect(remapPath('ab/x.md', 'a', 'b/a')).toBeNull()
  })
  test('breadcrumb', () => {
    expect(breadcrumb('Work/Images/n.md')).toEqual([
      { name: 'Work', rel: 'Work' },
      { name: 'Images', rel: 'Work/Images' }
    ])
    expect(breadcrumb('n.md')).toEqual([])
  })
})

describe('canDropInto', () => {
  test('rejects no-op and self/descendant', () => {
    expect(canDropInto('a/x.md', 'file', 'a')).toBe(false)
    expect(canDropInto('a/x.md', 'file', '')).toBe(true)
    expect(canDropInto('x.md', 'file', '')).toBe(false)
    expect(canDropInto('a', 'dir', 'a')).toBe(false)
    expect(canDropInto('a', 'dir', 'a/b')).toBe(false)
    expect(canDropInto('a', 'dir', 'ab')).toBe(true)
    expect(canDropInto('a/b', 'dir', '')).toBe(true)
    expect(canDropInto('a/b', 'dir', 'a')).toBe(false)
  })
})

describe('uniqueName (collision naming)', () => {
  test('files get " 2", " 3" before the extension', () => {
    const taken = new Set(['note.md', 'note 2.md'])
    expect(uniqueName('Note.md', (n) => taken.has(n.toLowerCase()))).toBe('Note 3.md')
    expect(uniqueName('Fresh.md', () => false)).toBe('Fresh.md')
  })
  test('dirs keep dots in the name', () => {
    const taken = new Set(['v1.2'])
    expect(uniqueName('v1.2', (n) => taken.has(n), true)).toBe('v1.2 2')
  })
  test('dotfiles and extensionless', () => {
    expect(uniqueName('README', (n) => n === 'README')).toBe('README 2')
  })
})

describe('folders', () => {
  test('foldersOf includes ancestors', () => {
    expect(foldersOf(['a/b/c.md', 'x.md', 'a/d.md', 'z/q.md'])).toEqual(['a', 'a/b', 'z'])
  })
  test('rankFolders fuzzy', () => {
    const f = ['Personal', 'Work', 'Work/Images', 'Archive/Old work']
    expect(rankFolders('', f)).toEqual(f)
    expect(rankFolders('img', f)[0]).toBe('Work/Images')
    expect(rankFolders('work', f)[0]).toBe('Work')
    expect(rankFolders('zzz', f)).toEqual([])
  })
  test('cleanFolderPath', () => {
    expect(cleanFolderPath(' Work / Images/ ')).toBe('Work/Images')
    expect(cleanFolderPath('../x')).toBeNull()
    expect(cleanFolderPath('.git')).toBeNull()
    expect(cleanFolderPath('  ')).toBeNull()
  })
})

describe('rewriteLinks', () => {
  const files = new Set([
    'assets/2026/10/a.png',
    'Work/pic.png',
    'Work/other.md',
    'Notes/n.md',
    'Notes/sub/deep.md',
    'top.md'
  ])
  const ctx = (oldNotePath: string, newNotePath: string, moves: Record<string, string> = {}): LinkRewriteContext => ({
    oldNotePath,
    newNotePath,
    remap: (r) => moves[r] ?? null,
    exists: (r) => files.has(r) || Object.values(moves).includes(r)
  })

  test('vault-root asset paths are untouched', () => {
    const md = '![](assets/2026/10/a.png)'
    expect(rewriteLinks(md, ctx('Work/n.md', 'Archive/n.md', { 'Work/n.md': 'Archive/n.md' }))).toEqual({
      text: md,
      changed: 0
    })
  })
  test('note-relative image follows the move', () => {
    const md = 'x ![cat|300](./pic.png) y'
    const r = rewriteLinks(md, ctx('Work/n.md', 'Archive/2026/n.md', { 'Work/n.md': 'Archive/2026/n.md' }))
    expect(r.text).toBe('x ![cat|300](../../Work/pic.png) y')
    expect(r.changed).toBe(1)
  })
  test('bare note-relative file and ../ links', () => {
    const md = '[o](other.md) and [t](../top.md)'
    const r = rewriteLinks(md, ctx('Work/n.md', 'n.md', { 'Work/n.md': 'n.md' }))
    expect(r.text).toBe('[o](Work/other.md) and [t](top.md)')
  })
  test('./ prefix kept when still below', () => {
    const r = rewriteLinks('[d](./sub/deep.md)', ctx('Notes/n.md', 'Notes/x/n.md', { 'Notes/n.md': 'Notes/x/n.md' }))
    expect(r.text).toBe('[d](../sub/deep.md)')
    const r2 = rewriteLinks('[d](./Notes/sub/deep.md)', ctx('n.md', 'Notes/n.md', { 'n.md': 'Notes/n.md' }))
    expect(r2.text).toBe('[d](./sub/deep.md)')
  })
  test('inbound links to a moved note', () => {
    const md = 'see [n](../Notes/n.md#heading "title") or [abs](Notes/n.md)'
    const moves = { 'Notes/n.md': 'Archive/n.md' }
    const r = rewriteLinks(md, ctx('Work/other.md', 'Work/other.md', moves))
    expect(r.text).toBe('see [n](../Archive/n.md#heading "title") or [abs](Archive/n.md)')
    expect(r.changed).toBe(2)
  })
  test('folder moves: links inside the moved folder stay, links out are fixed', () => {
    const moves = { 'Notes/n.md': 'Archive/Notes/n.md', 'Notes/sub/deep.md': 'Archive/Notes/sub/deep.md' }
    const md = '[d](sub/deep.md) [p](../Work/pic.png)'
    const r = rewriteLinks(md, ctx('Notes/n.md', 'Archive/Notes/n.md', moves))
    expect(r.text).toBe('[d](sub/deep.md) [p](../../Work/pic.png)')
  })
  test('spaces: encoded and angle-bracket destinations', () => {
    const local = new Set(['My Folder/my pic.png'])
    const c: LinkRewriteContext = {
      oldNotePath: 'My Folder/n.md',
      newNotePath: 'n.md',
      remap: () => null,
      exists: (r) => local.has(r)
    }
    expect(rewriteLinks('![](my%20pic.png)', c).text).toBe('![](My%20Folder/my%20pic.png)')
    expect(rewriteLinks('![](<my pic.png>)', c).text).toBe('![](<My Folder/my pic.png>)')
  })
  test('leaves urls, anchors, absolute, missing files and code blocks alone', () => {
    const md = [
      '[u](https://x.com/a.md) [m](mailto:a@b.c) [h](#top) [abs](/Work/pic.png) [gone](./missing.md)',
      '```',
      '[code](./pic.png)',
      '```',
      '[real](./pic.png)'
    ].join('\n')
    const r = rewriteLinks(md, ctx('Work/n.md', 'n.md', { 'Work/n.md': 'n.md' }))
    expect(r.changed).toBe(1)
    expect(r.text).toContain('[code](./pic.png)')
    expect(r.text).toContain('[real](./Work/pic.png)')
    expect(r.text).toContain('[gone](./missing.md)')
  })
})
