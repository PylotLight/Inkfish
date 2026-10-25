import { describe, expect, test } from 'bun:test'
import { bodyOf, frontmatterHead, planSave, relocate, withBody, withTitle } from '../src/lib/notesave'
import { parseFrontmatter } from '../src/lib/format'
import { keepFrontmatter } from '../../src/shared/autosave'
import { titleFromMarkdown } from '../../src/shared/title-sync'

describe('withBody keeps front matter verbatim (Mac keepFrontmatter parity)', () => {
  test('plain note gets no empty front matter block', () => {
    expect(withBody('# Groceries\nmilk\n', '# Groceries\nmilk\neggs')).toBe('# Groceries\nmilk\neggs\n')
    expect(withBody('', '# New')).toBe('# New\n')
  })

  test('YAML block lists, quoting and unknown keys survive an edit', () => {
    const file = '---\nid: n-1\ntitle: "Trip: Japan"\ntags:\n  - travel\n  - japan\naliases: [jp]\n---\n# Trip\nold\n'
    const out = withBody(file, '# Trip\nnew line')
    expect(out).toBe(
      '---\nid: n-1\ntitle: "Trip: Japan"\ntags:\n  - travel\n  - japan\naliases: [jp]\n---\n# Trip\nnew line\n'
    )
    expect(titleFromMarkdown(out)).toBe('Trip: Japan')
  })

  test('matches the Mac save for the same edit (modulo trailing newline)', () => {
    const file = '---\nid: x\nkind: text\n---\n# A\nbody\n'
    const body = '# A\nbody edited'
    expect(withBody(file, body)).toBe(`${keepFrontmatter(file, body)}\n`)
    expect(withBody('# plain', body)).toBe(`${keepFrontmatter('# plain', body)}\n`)
  })

  test('body/head split agrees with parseFrontmatter', () => {
    for (const f of ['---\nid: a\n---\n# T\nx\n', '# no fm\n', '---\nunterminated\n# T', '---\n---\n# T\n']) {
      expect(bodyOf(f)).toBe(parseFrontmatter(f)[1])
      expect(frontmatterHead(f) + (frontmatterHead(f) ? '\n' : '') + bodyOf(f)).toBe(f)
    }
  })
})

describe('withTitle updates display-title metadata without changing the body', () => {
  test('adds a quoted title to a plain note', () => {
    const head = withTitle('', 'Trip: Japan "2026"')
    const file = withBody(head, '# Old heading\nbody')
    expect(file).toBe('---\ntitle: "Trip: Japan \\"2026\\""\n---\n# Old heading\nbody\n')
    expect(titleFromMarkdown(file)).toBe('Trip: Japan "2026"')
  })

  test('replaces an existing title and preserves other front matter and body', () => {
    const head = frontmatterHead('---\nid: n-1\ntitle: Old\ntags: [travel]\n---\n# Body heading\ntext\n')
    const file = withBody(withTitle(head, 'New title'), '# Body heading\ntext')
    expect(file).toBe('---\nid: n-1\ntitle: "New title"\ntags: [travel]\n---\n# Body heading\ntext\n')
    expect(titleFromMarkdown(file)).toBe('New title')
  })
})

describe('planSave: sync changed the note while the editor had it open', () => {
  const at = new Date(2026, 9, 19, 14, 30)

  test('unchanged on disk → plain save', () => {
    const disk = '---\nid: a\n---\n# T\none\n'
    const p = planSave({ path: 'work/T.md', disk, base: '# T\none\n', next: '# T\none\ntwo', at })
    expect(p).toEqual({ file: '---\nid: a\n---\n# T\none\ntwo\n', body: '# T\none\ntwo', merged: false })
  })

  test('Mac edit pulled mid-edit is merged, not overwritten', () => {
    const base = '# T\nline 1\nline 2\nline 3\n'
    const disk = '# T\nline 1 (mac)\nline 2\nline 3\n' // Mac changed line 1, sync pulled it
    const next = '# T\nline 1\nline 2\nline 3\nphone line\n' // phone appended
    const p = planSave({ path: 'work/T.md', disk, base, next, at })
    expect(p.merged).toBe(true)
    expect(p.conflict).toBeUndefined()
    expect(p.file).toBe('# T\nline 1 (mac)\nline 2\nline 3\nphone line\n')
  })

  test('overlapping edits keep the phone text and save the disk copy beside it', () => {
    const base = '# T\nsame line\n'
    const disk = '---\nid: a\n---\n# T\nmac wording\n'
    const next = '# T\nphone wording\n'
    const p = planSave({ path: 'work/T.md', disk, base, next, at })
    expect(p.file).toBe('---\nid: a\n---\n# T\nphone wording\n')
    expect(p.conflict).toEqual({ path: 'work/T (conflict · synced copy · 2026-10-19 1430).md', text: disk })
  })

  test('disk already equals the edit → no merge', () => {
    const p = planSave({ path: 'a.md', disk: '# x\nb\n', base: '# x\na\n', next: '# x\nb', at })
    expect(p.merged).toBe(false)
    expect(p.file).toBe('# x\nb\n')
  })
})

describe('relocate: the open note was moved/deleted by sync', () => {
  test('pure move (Mac sidebar rename / folder move) → found by content', () => {
    const c = [
      { path: 'work/Other.md', body: 'nope' },
      { path: 'personal/Renamed.md', body: '# Idea\ntext\n' }
    ]
    expect(relocate(c, '# Idea\ntext', 'work/Untitled.md')).toBe('personal/Renamed.md')
  })

  test('deleted (or renamed + edited) → recreate at the old path instead of dropping the edit', () => {
    expect(relocate([{ path: 'a.md', body: 'x' }], '# Idea\ntext', 'work/Untitled.md')).toBe('work/Untitled.md')
  })

  test('ambiguous or empty base never guesses', () => {
    const c = [
      { path: 'a/Untitled.md', body: '' },
      { path: 'b/Untitled.md', body: '' }
    ]
    expect(relocate(c, '', 'x/Untitled.md')).toBe('x/Untitled.md')
    const dup = [
      { path: 'a.md', body: 'same' },
      { path: 'b.md', body: 'same' }
    ]
    expect(relocate(dup, 'same', 'old.md')).toBe('old.md')
  })
})
