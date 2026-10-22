import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { moveEntry, renameEntry, renameToTitle, scanLookup, type LookupFn } from './move'
import { movePath, renamePath, type VaultPaths } from './vault'

let root = ''
let paths: VaultPaths

const put = (rel: string, text = ''): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'inkfish-move-'))
  paths = {
    root,
    inboxDir: join(root, '.x/inbox'),
    dailyDir: join(root, '.x/daily'),
    assetsDir: join(root, 'assets'),
    dbPath: join(root, '.x/db')
  }
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
  test('note: own relative links rewritten, vault-root assets untouched', async () => {
    put('Work/pic.png', 'png')
    put('assets/2026/10/a.png', 'png')
    put('Work/n.md', '---\ntags: [x]\n---\n![](./pic.png)\n![](assets/2026/10/a.png)\n')
    const r = await moveEntry('Work/n.md', 'Archive/2026', paths)
    expect(r.rel).toBe('Archive/2026/n.md')
    expect(r.renamed).toBe(false)
    expect(r.moved).toEqual([{ from: 'Work/n.md', to: 'Archive/2026/n.md' }])
    expect(read('Archive/2026/n.md')).toBe('---\ntags: [x]\n---\n![](../../Work/pic.png)\n![](assets/2026/10/a.png)\n')
    expect(r.rewritten).toEqual(['Archive/2026/n.md'])
  })
  test('inbound relative links follow the moved note', async () => {
    put('Notes/n.md', 'hi')
    put('Work/other.md', 'see [n](../Notes/n.md) and [x](Notes/n.md)')
    put('unrelated.md', '[y](./elsewhere.md)')
    const r = await moveEntry('Notes/n.md', 'Archive', paths)
    expect(read('Work/other.md')).toBe('see [n](../Archive/n.md) and [x](Archive/n.md)')
    expect(read('unrelated.md')).toBe('[y](./elsewhere.md)')
    expect(r.rewritten).toEqual(['Work/other.md'])
  })
  test('folder: subtree moves, internal links stay, outward links fixed', async () => {
    put('Top/pic.png', 'p')
    put('Proj/a.md', '[b](sub/b.md) ![](../Top/pic.png)')
    put('Proj/sub/b.md', '[a](../a.md)')
    const r = await moveEntry('Proj', 'Clients/2026', paths)
    expect(r.rel).toBe('Clients/2026/Proj')
    expect(r.moved.map((m) => m.to).sort()).toEqual(['Clients/2026/Proj/a.md', 'Clients/2026/Proj/sub/b.md'])
    expect(read('Clients/2026/Proj/a.md')).toBe('[b](sub/b.md) ![](../../../Top/pic.png)')
    expect(read('Clients/2026/Proj/sub/b.md')).toBe('[a](../a.md)')
  })
  test('name collision is suffixed', async () => {
    put('a/Note.md', 'one')
    put('b/note.md', 'two')
    const r = await moveEntry('a/Note.md', 'b', paths)
    expect(r.rel).toBe('b/Note 2.md')
    expect(r.renamed).toBe(true)
  })
})

describe('renameToTitle', () => {
  test('renames in place, keeps .md, fixes inbound relative links and wikilinks', async () => {
    put('personal/Untitled 3 2.md', '# Japan list\n- sushi\n')
    put(
      'Work/other.md',
      'see [it](../personal/Untitled%203%202.md) and [[Untitled 3 2]] and [[personal/Untitled 3 2|j]]'
    )
    const r = await renameToTitle('personal/Untitled 3 2.md', 'Japan list', paths)
    expect(r.rel).toBe('personal/Japan list.md')
    expect(read('personal/Japan list.md')).toBe('# Japan list\n- sushi\n')
    expect(existsSync(join(root, 'personal/Untitled 3 2.md'))).toBe(false)
    expect(read('Work/other.md')).toBe(
      'see [it](../personal/Japan%20list.md) and [[Japan list]] and [[personal/Japan list|j]]'
    )
    expect(r.rewritten).toEqual(['Work/other.md'])
  })
  test('collisions get " 2", " 3" (case-insensitive); sanitizes; empty is a no-op', async () => {
    put('a/japan.md', 'x')
    put('a/Japan 2.md', 'y')
    put('a/Untitled.md', 'z')
    expect((await renameToTitle('a/Untitled.md', 'Japan', paths)).rel).toBe('a/Japan 3.md')
    expect(read('a/japan.md')).toBe('x')
    expect((await renameToTitle('a/Japan 3.md', '  ', paths)).rel).toBe('a/Japan 3.md')
    expect((await renameToTitle('a/Japan 3.md', 'Trip: Tokyo/Kyoto?', paths)).rel).toBe('a/Trip Tokyo Kyoto.md')
  })
  test('case-only rename of its own name is allowed', async () => {
    put('japan.md', 'x')
    expect((await renameToTitle('japan.md', 'Japan', paths)).rel).toBe('Japan.md')
    expect(read('Japan.md')).toBe('x')
  })
  test('ambiguous bare wikilinks are left alone', async () => {
    put('a/Untitled.md', '')
    put('b/Untitled.md', '')
    put('c.md', '[[Untitled]] [[a/Untitled]]')
    await renameToTitle('a/Untitled.md', 'Alpha', paths)
    expect(read('c.md')).toBe('[[Untitled]] [[a/Alpha]]')
  })
})

describe('renameToTitle review fixes', () => {
  test('case-sensitive disk: a differently-cased sibling is a different file and is never overwritten', async () => {
    put('foo.md', 'mine')
    put('Foo.md', 'theirs')
    // Only meaningful where both exist (Linux / case-sensitive APFS); on a case-insensitive disk put() wrote one file.
    if (readdirSync(root).length === 2) {
      const r = await renameToTitle('foo.md', 'Foo', paths)
      expect(r.rel).toBe('Foo 2.md')
      expect(read('Foo.md')).toBe('theirs')
      expect(read('Foo 2.md')).toBe('mine')
    }
  })
  test('inbound [[wikilinks]] in another case are found and rewritten', async () => {
    put('notes/Untitled.md', '# Ideas\n')
    put('other.md', 'see [[UNTITLED]] and [[notes/untitled|x]]')
    const r = await renameToTitle('notes/Untitled.md', 'Ideas', paths)
    expect(r.rel).toBe('notes/Ideas.md')
    expect(read('other.md')).toBe('see [[Ideas]] and [[notes/Ideas|x]]')
  })
  test('new name already used elsewhere: rewritten bare links get the folder path', async () => {
    put('a/Untitled.md', '# Ideas\n')
    put('b/Ideas.md', 'the other ideas')
    put('c.md', '[[Untitled]] vs [[Ideas]]')
    await renameToTitle('a/Untitled.md', 'Ideas', paths)
    expect(read('c.md')).toBe('[[a/Ideas]] vs [[Ideas]]')
  })
  test('# ^ [ ] in a title never reach the file name (they break [[links]])', async () => {
    put('Untitled.md', '')
    expect((await renameToTitle('Untitled.md', 'Japan #travel [draft]^1', paths)).rel).toBe('Japan travel draft 1.md')
  })
  test('refuses inbox/daily (staging) paths and paths that climb out of the vault', async () => {
    put('x.md', '')
    await expect(renameToTitle('inbox/x.md', 'Y', paths)).rejects.toThrow()
    await expect(renameToTitle('daily/2026-10-19.md', 'Y', paths)).rejects.toThrow()
    await expect(renameToTitle('../x.md', 'Y', paths)).rejects.toThrow()
    await expect(renameToTitle('a/../x.md', 'Y', paths)).rejects.toThrow()
    expect(read('x.md')).toBe('')
  })
})

describe('renamePath (hand rename)', () => {
  test('case-only rename of the same file is allowed (APFS resolves both spellings to it)', () => {
    put('japan.md', 'x')
    // Simulate a case-insensitive disk: the new spelling resolves to the same inode.
    linkSync(join(root, 'japan.md'), join(root, 'Japan.md'))
    expect(() => renamePath('japan.md', 'Japan', paths)).not.toThrow()
  })
  test('a different file under another case still blocks the rename', () => {
    put('japan.md', 'x')
    put('Japan.md', 'y')
    if (readdirSync(root).length === 2) expect(() => renamePath('japan.md', 'Japan', paths)).toThrow(/already exists/)
  })
})

describe('index-backed lookup (no full-vault reads)', () => {
  test('title rename only opens the candidates the lookup returns', async () => {
    put('Untitled.md', '# Ideas\n')
    put('linker.md', 'see [[Untitled]]')
    // Mentions the old name too, but the (stale) index says otherwise: never opened.
    put('not-a-candidate.md', '[[Untitled]]')
    const asked: string[][] = []
    const lookup: LookupFn = (needles) => {
      asked.push(needles)
      return { notes: ['Untitled.md', 'linker.md', 'not-a-candidate.md'], candidates: ['linker.md'] }
    }
    const r = await renameToTitle('Untitled.md', 'Ideas', paths, lookup)
    expect(r.rel).toBe('Ideas.md')
    expect(asked).toEqual([['untitled.md', 'untitled']])
    expect(read('linker.md')).toBe('see [[Ideas]]')
    expect(read('not-a-candidate.md')).toBe('[[Untitled]]')
    expect(r.rewritten).toEqual(['linker.md'])
    expect(r.move).toEqual({
      from: 'Untitled.md',
      to: 'Ideas.md',
      notes: [{ from: 'Untitled.md', to: 'Ideas.md', bareUnique: true, newAmbiguous: false }]
    })
  })
  test("bare-link ambiguity is judged from the lookup's note list", async () => {
    put('a/Untitled.md', '')
    put('c.md', '[[Untitled]] [[a/Untitled]]')
    const lookup: LookupFn = () => ({ notes: ['a/Untitled.md', 'b/Untitled.md', 'c.md'], candidates: ['c.md'] })
    await renameToTitle('a/Untitled.md', 'Alpha', paths, lookup)
    expect(read('c.md')).toBe('[[Untitled]] [[a/Alpha]]')
  })
  test('scanLookup (fallback) matches case-insensitively', () => {
    put('x.md', 'see [[FOO]]')
    put('y.md', 'nope')
    expect(scanLookup(root)(['foo']).candidates).toEqual(['x.md'])
  })
})

describe('hand rename fixes links like a title rename', () => {
  test('file: [[wikilinks]] and relative links follow', async () => {
    put('notes/Old name.md', '# whatever\n')
    put('other.md', '[[Old name]] [[notes/Old name|x]] [r](notes/Old%20name.md) [[Old name#Part]]')
    const r = await renameEntry('notes/Old name.md', 'New name', paths)
    expect(r.rel).toBe('notes/New name.md')
    expect(read('other.md')).toBe('[[New name]] [[notes/New name|x]] [r](notes/New%20name.md) [[New name#Part]]')
    expect(r.rewritten).toEqual(['other.md'])
    expect(r.move?.notes).toEqual([
      { from: 'notes/Old name.md', to: 'notes/New name.md', bareUnique: true, newAmbiguous: false }
    ])
  })
  test('folder: path wikilinks and relative links into it follow, bare links untouched', async () => {
    put('Proj/a.md', '[[Proj/sub/b]]')
    put('Proj/sub/b.md', 'b')
    put('top.md', '[[Proj/a]] [[a]] [b](Proj/sub/b.md)')
    const r = await renameEntry('Proj', 'Project', paths)
    expect(r.rel).toBe('Project')
    expect(read('top.md')).toBe('[[Project/a]] [[a]] [b](Project/sub/b.md)')
    expect(read('Project/a.md')).toBe('[[Project/sub/b]]')
    expect(r.rewritten.sort()).toEqual(['Project/a.md', 'top.md'])
  })
})

describe('Move to fixes [[wikilinks]] too', () => {
  test('path-qualified wikilinks follow the moved note', async () => {
    put('Notes/n.md', 'hi')
    put('w.md', '[[Notes/n]] and [[n]]')
    const r = await moveEntry('Notes/n.md', 'Archive', paths)
    expect(r.rel).toBe('Archive/n.md')
    expect(read('w.md')).toBe('[[Archive/n]] and [[n]]')
    expect(r.rewritten).toEqual(['w.md'])
  })
})

describe('stale window text after a rename (mini window autosave race)', () => {
  test('a save of pre-rename text, merged with the logged move, keeps the rewritten links', async () => {
    put('notes/Untitled.md', '# Ideas\n')
    put('open-in-mini.md', 'draft line\n[[Untitled]] and [i](notes/Untitled.md)\n')
    // The mini window has this text pending (typed before the rename's rewrite landed).
    const stale = 'draft line, more typing\n[[Untitled]] and [i](notes/Untitled.md)\n'
    const r = await renameToTitle('notes/Untitled.md', 'Ideas', paths)
    expect(read('open-in-mini.md')).toBe('draft line\n[[Ideas]] and [i](notes/Ideas.md)\n')
    const { mergeLinkMoves } = await import('../shared/link-moves')
    const merged = mergeLinkMoves(stale, 'open-in-mini.md', [r.move!], (p) => existsSync(join(root, p)))
    expect(merged).toBe('draft line, more typing\n[[Ideas]] and [i](notes/Ideas.md)\n')
  })
})
