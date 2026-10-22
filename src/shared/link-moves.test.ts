import { describe, expect, test } from 'bun:test'
import { applyLinkMove, createMoveLog, linkNeedles, mergeLinkMoves, movedNotes, type LinkMove } from './link-moves'

const vault = (paths: string[]): ((rel: string) => boolean) => {
  const set = new Set(paths)
  return (rel) => set.has(rel)
}

describe('movedNotes', () => {
  test('bare-link flags judged after the move', () => {
    const before = ['a/Untitled.md', 'b/Untitled.md', 'Ideas.md', 'c.md']
    expect(movedNotes(before, 'a/Untitled.md', 'a/Ideas.md', [{ from: 'a/Untitled.md', to: 'a/Ideas.md' }])).toEqual([
      { from: 'a/Untitled.md', to: 'a/Ideas.md', bareUnique: false, newAmbiguous: true }
    ])
    expect(movedNotes(['x.md', 'c.md'], 'x.md', 'y.md', [{ from: 'x.md', to: 'y.md' }])).toEqual([
      { from: 'x.md', to: 'y.md', bareUnique: true, newAmbiguous: false }
    ])
  })
  test('a folder move keeps names, so bare links are unique and unchanged', () => {
    const n = movedNotes(['P/a.md', 'q.md'], 'P', 'Q/P', [{ from: 'P/a.md', to: 'Q/P/a.md' }])
    expect(n).toEqual([{ from: 'P/a.md', to: 'Q/P/a.md', bareUnique: true, newAmbiguous: false }])
  })
})

describe('linkNeedles', () => {
  test('file: name, encoded forms and stem; folder: its name', () => {
    expect(linkNeedles('notes/Japan List.md', false)).toEqual(['japan list.md', 'japan%20list.md', 'japan list'])
    expect(linkNeedles('Proj', true)).toEqual(['proj'])
  })
})

describe('mergeLinkMoves (save path: stale text from a window)', () => {
  const rename: LinkMove = {
    from: 'notes/Untitled.md',
    to: 'notes/Ideas.md',
    notes: [{ from: 'notes/Untitled.md', to: 'notes/Ideas.md', bareUnique: true, newAmbiguous: false }]
  }
  const after = vault(['notes/Ideas.md', 'other.md'])

  test('a mini window saving pre-rename text gets the new links merged in', () => {
    const stale = 'typed more\n[[Untitled]] [it](notes/Untitled.md) [[notes/Untitled|x]]'
    expect(mergeLinkMoves(stale, 'other.md', [rename], after)).toBe(
      'typed more\n[[Ideas]] [it](notes/Ideas.md) [[notes/Ideas|x]]'
    )
  })
  test('idempotent: already-fixed text is untouched', () => {
    const fixed = '[[Ideas]] [it](notes/Ideas.md)'
    expect(mergeLinkMoves(fixed, 'other.md', [rename], after)).toBe(fixed)
    const once = mergeLinkMoves('[[Untitled]]', 'other.md', [rename], after)
    expect(mergeLinkMoves(once, 'other.md', [rename], after)).toBe(once)
  })
  test('skipped once something has the old name again (a fresh link to it is not redirected)', () => {
    const taken = vault(['notes/Ideas.md', 'notes/Untitled.md', 'other.md'])
    expect(mergeLinkMoves('[[Untitled]]', 'other.md', [rename], taken)).toBe('[[Untitled]]')
  })
  test('chained renames apply in order', () => {
    const second: LinkMove = {
      from: 'notes/Ideas.md',
      to: 'notes/Ideas 2026.md',
      notes: [{ from: 'notes/Ideas.md', to: 'notes/Ideas 2026.md', bareUnique: true, newAmbiguous: false }]
    }
    expect(mergeLinkMoves('[[Untitled]]', 'other.md', [rename, second], vault(['notes/Ideas 2026.md']))).toBe(
      '[[Ideas 2026]]'
    )
  })
  test("the moved note's own relative links: fixed once, never twice", () => {
    const move: LinkMove = {
      from: 'Work/n.md',
      to: 'Archive/2026/n.md',
      notes: [{ from: 'Work/n.md', to: 'Archive/2026/n.md', bareUnique: true, newAmbiguous: false }]
    }
    const exists = vault(['Work/pic.png', 'Archive/2026/n.md'])
    const merged = mergeLinkMoves('![](./pic.png)', 'Archive/2026/n.md', [move], exists)
    expect(merged).toBe('![](../../Work/pic.png)')
    expect(mergeLinkMoves(merged, 'Archive/2026/n.md', [move], exists)).toBe(merged)
  })
})

describe('applyLinkMove (disk rewrite)', () => {
  test('inbound relative + wikilinks in one pass', () => {
    const move: LinkMove = {
      from: 'a.md',
      to: 'b.md',
      notes: [{ from: 'a.md', to: 'b.md', bareUnique: true, newAmbiguous: false }]
    }
    expect(applyLinkMove('[x](a.md) [[a]]', 'c.md', null, move, vault(['b.md', 'c.md']))).toBe('[x](b.md) [[b]]')
  })
})

describe('createMoveLog', () => {
  test('keeps recent moves, ages them out, caps the count', () => {
    let t = 0
    const log = createMoveLog({ max: 2, ttlMs: 1000, now: () => t })
    const m = (n: number): LinkMove => ({ from: `${n}.md`, to: `${n}b.md`, notes: [] })
    log.add(m(1))
    log.add({ from: 'same.md', to: 'same.md', notes: [] }) // no-op move ignored
    t = 500
    log.add(m(2))
    log.add(m(3))
    expect(log.recent().map((x) => x.from)).toEqual(['2.md', '3.md'])
    t = 1600
    expect(log.recent()).toEqual([])
  })
})
