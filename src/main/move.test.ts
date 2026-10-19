import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { moveEntry, renameToTitle } from './move'
import { movePath, type VaultPaths } from './vault'

let root = ''
let paths: VaultPaths

const put = (rel: string, text = ''): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inkfish-move-'))
  paths = { root, inboxDir: join(root, '.x/inbox'), dailyDir: join(root, '.x/daily'), assetsDir: join(root, 'assets'), dbPath: join(root, '.x/db') }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('movePath', () => {
  test('moves a file into a folder (created on demand) and to root', () => {
    put('a.md', 'x')
    expect(movePath('a.md', 'Work/Images', paths)).toBe('Work/Images/a.md')
    expect(existsSync(join(root, 'a.md'))).toBe(false)
    expect(movePath('Work/Images/a.md', '', paths)).toBe('a.md')
  })
  test('collision: throws by default, suffixes on rename (case-insensitive)', () => {
    put('a.md', 'one')
    put('Work/A.md', 'two')
    expect(() => movePath('a.md', 'Work', paths)).toThrow(/already exists/)
    expect(movePath('a.md', 'Work', paths, { onConflict: 'rename' })).toBe('Work/a 2.md')
    expect(read('Work/A.md')).toBe('two')
    expect(read('Work/a 2.md')).toBe('one')
  })
  test('refuses folder into itself / its child; no-op in same dir', () => {
    put('Work/Sub/n.md')
    expect(() => movePath('Work', 'Work/Sub', paths)).toThrow(/into itself/)
    expect(() => movePath('Work', 'Work', paths)).toThrow(/into itself/)
    expect(movePath('Work/Sub/n.md', 'Work/Sub', paths)).toBe('Work/Sub/n.md')
  })
})

describe('moveEntry', () => {
  test('note: own relative links rewritten, vault-root assets untouched', () => {
    put('Work/pic.png', 'png')
    put('assets/2026/10/a.png', 'png')
    put('Work/n.md', '---\ntags: [x]\n---\n![](./pic.png)\n![](assets/2026/10/a.png)\n')
    const r = moveEntry('Work/n.md', 'Archive/2026', paths)
    expect(r.rel).toBe('Archive/2026/n.md')
    expect(r.renamed).toBe(false)
    expect(r.moved).toEqual([{ from: 'Work/n.md', to: 'Archive/2026/n.md' }])
    expect(read('Archive/2026/n.md')).toBe('---\ntags: [x]\n---\n![](../../Work/pic.png)\n![](assets/2026/10/a.png)\n')
    expect(r.rewritten).toEqual(['Archive/2026/n.md'])
  })
  test('inbound relative links follow the moved note', () => {
    put('Notes/n.md', 'hi')
    put('Work/other.md', 'see [n](../Notes/n.md) and [x](Notes/n.md)')
    put('unrelated.md', '[y](./elsewhere.md)')
    const r = moveEntry('Notes/n.md', 'Archive', paths)
    expect(read('Work/other.md')).toBe('see [n](../Archive/n.md) and [x](Archive/n.md)')
    expect(read('unrelated.md')).toBe('[y](./elsewhere.md)')
    expect(r.rewritten).toEqual(['Work/other.md'])
  })
  test('folder: subtree moves, internal links stay, outward links fixed', () => {
    put('Top/pic.png', 'p')
    put('Proj/a.md', '[b](sub/b.md) ![](../Top/pic.png)')
    put('Proj/sub/b.md', '[a](../a.md)')
    const r = moveEntry('Proj', 'Clients/2026', paths)
    expect(r.rel).toBe('Clients/2026/Proj')
    expect(r.moved.map((m) => m.to).sort()).toEqual(['Clients/2026/Proj/a.md', 'Clients/2026/Proj/sub/b.md'])
    expect(read('Clients/2026/Proj/a.md')).toBe('[b](sub/b.md) ![](../../../Top/pic.png)')
    expect(read('Clients/2026/Proj/sub/b.md')).toBe('[a](../a.md)')
  })
  test('name collision is suffixed', () => {
    put('a/Note.md', 'one')
    put('b/note.md', 'two')
    const r = moveEntry('a/Note.md', 'b', paths)
    expect(r.rel).toBe('b/Note 2.md')
    expect(r.renamed).toBe(true)
  })
})

describe('renameToTitle', () => {
  test('renames in place, keeps .md, fixes inbound relative links and wikilinks', () => {
    put('personal/Untitled 3 2.md', '# Japan list\n- sushi\n')
    put('Work/other.md', 'see [it](../personal/Untitled%203%202.md) and [[Untitled 3 2]] and [[personal/Untitled 3 2|j]]')
    const r = renameToTitle('personal/Untitled 3 2.md', 'Japan list', paths)
    expect(r.rel).toBe('personal/Japan list.md')
    expect(read('personal/Japan list.md')).toBe('# Japan list\n- sushi\n')
    expect(existsSync(join(root, 'personal/Untitled 3 2.md'))).toBe(false)
    expect(read('Work/other.md')).toBe('see [it](../personal/Japan%20list.md) and [[Japan list]] and [[personal/Japan list|j]]')
    expect(r.rewritten).toEqual(['Work/other.md'])
  })
  test('collisions get " 2", " 3" (case-insensitive); sanitizes; empty is a no-op', () => {
    put('a/japan.md', 'x')
    put('a/Japan 2.md', 'y')
    put('a/Untitled.md', 'z')
    expect(renameToTitle('a/Untitled.md', 'Japan', paths).rel).toBe('a/Japan 3.md')
    expect(read('a/japan.md')).toBe('x')
    expect(renameToTitle('a/Japan 3.md', '  ', paths).rel).toBe('a/Japan 3.md')
    expect(renameToTitle('a/Japan 3.md', 'Trip: Tokyo/Kyoto?', paths).rel).toBe('a/Trip Tokyo Kyoto.md')
  })
  test('case-only rename of its own name is allowed', () => {
    put('japan.md', 'x')
    expect(renameToTitle('japan.md', 'Japan', paths).rel).toBe('Japan.md')
    expect(read('Japan.md')).toBe('x')
  })
  test('ambiguous bare wikilinks are left alone', () => {
    put('a/Untitled.md', '')
    put('b/Untitled.md', '')
    put('c.md', '[[Untitled]] [[a/Untitled]]')
    renameToTitle('a/Untitled.md', 'Alpha', paths)
    expect(read('c.md')).toBe('[[Untitled]] [[a/Alpha]]')
  })
})
