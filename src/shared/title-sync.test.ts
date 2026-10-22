import { describe, expect, test } from 'bun:test'
import {
  autoRenameTarget,
  createTitleSync,
  isUntitledName,
  matchesName,
  rewriteWikiLinks,
  sanitizeFileTitle,
  titleFromMarkdown
} from './title-sync'

describe('sanitizeFileTitle', () => {
  test('illegal chars, leading dots, whitespace, cap', () => {
    expect(sanitizeFileTitle('  Japan / list: 2026?  ')).toBe('Japan list 2026')
    expect(sanitizeFileTitle('a\\b*c"d<e>f|g')).toBe('a b c d e f g')
    expect(sanitizeFileTitle('...hidden')).toBe('hidden')
    expect(sanitizeFileTitle('trailing. ')).toBe('trailing')
    expect(sanitizeFileTitle('notes.md')).toBe('notes')
    expect(sanitizeFileTitle('   ')).toBe('')
    expect(sanitizeFileTitle('x'.repeat(150))).toHaveLength(100)
  })
})

describe('titleFromMarkdown', () => {
  test('first non-blank line when it is an H1', () => {
    expect(titleFromMarkdown('# Japan list\n- sushi')).toBe('Japan list')
    expect(titleFromMarkdown('\n\n#  **Japan** [list](x.md) ##\nbody')).toBe('Japan list')
    expect(titleFromMarkdown('just text\n# Later heading')).toBe('')
    expect(titleFromMarkdown('## H2 is not a title')).toBe('')
    expect(titleFromMarkdown('#hashtag')).toBe('')
    expect(titleFromMarkdown('')).toBe('')
  })
  test('front matter title wins', () => {
    expect(titleFromMarkdown('---\ntitle: "From FM"\ntags: [a]\n---\n# H1')).toBe('From FM')
    expect(titleFromMarkdown('---\ntags: [a]\n---\n\n# H1 after fm')).toBe('H1 after fm')
  })
})

describe('auto-named rule', () => {
  test('untitled names', () => {
    expect(isUntitledName('Untitled')).toBe(true)
    expect(isUntitledName('Untitled 3 2')).toBe(true)
    expect(isUntitledName('untitled 12')).toBe(true)
    expect(isUntitledName('Untitled draft')).toBe(false)
  })
  test('collision suffix still matches', () => {
    expect(matchesName('Japan list 2', 'Japan list')).toBe(true)
    expect(matchesName('japan list', 'Japan list')).toBe(true)
    expect(matchesName('Japan list v2', 'Japan list')).toBe(false)
    expect(matchesName('anything', '')).toBe(false)
  })
  test('Untitled follows the title', () => {
    expect(autoRenameTarget('personal/Untitled 3 2.md', '', 'Japan list')).toBe('Japan list')
  })
  const named = { inkfishNamed: true }
  test('a file Inkfish named from its title follows edits', () => {
    expect(autoRenameTarget('Japan.md', 'Japan', 'Japan trip', named)).toBe('Japan trip')
    expect(autoRenameTarget('Japan 2.md', 'Japan', 'Japan trip', named)).toBe('Japan trip')
  })
  test('imported notes named after their heading are left alone by default', () => {
    expect(autoRenameTarget('Japan.md', 'Japan', 'Japan trip')).toBeNull()
    expect(autoRenameTarget('japan.md', 'japan', 'Japan')).toBeNull()
  })
  test('opt-in: any heading-named note follows (Settings → also rename notes named after their heading)', () => {
    expect(autoRenameTarget('Japan.md', 'Japan', 'Japan trip', { headingNamed: true })).toBe('Japan trip')
    expect(autoRenameTarget('Travel ideas.md', 'Japan', 'Japan trip', { headingNamed: true })).toBeNull()
  })
  test('hand-renamed file stops following', () => {
    expect(autoRenameTarget('Travel ideas.md', 'Japan', 'Japan trip', named)).toBeNull()
  })
  test('empty title keeps the name; already-matching is a no-op', () => {
    expect(autoRenameTarget('Untitled.md', '', '')).toBeNull()
    expect(autoRenameTarget('Untitled.md', '', ' / ')).toBeNull()
    expect(autoRenameTarget('Japan.md', 'Japan', 'Japan', named)).toBeNull()
    expect(autoRenameTarget('Japan 2.md', 'Japan', 'Japan', named)).toBeNull()
  })
  test('case-only change renames', () => {
    expect(autoRenameTarget('japan.md', 'japan', 'Japan', named)).toBe('Japan')
  })
  test('inbox and daily notes never sync', () => {
    expect(autoRenameTarget('inbox/abc.md', '', 'Title')).toBeNull()
    expect(autoRenameTarget('daily/2026-10-19.md', '', 'Title')).toBeNull()
  })
})

describe('rewriteWikiLinks', () => {
  test('bare, alias, heading, path and .md forms', () => {
    const md =
      'see [[Untitled 3]] and [[Untitled 3|that]] and [[Untitled 3#Food]] and [[personal/Untitled 3]] and ![[Untitled 3.md]]'
    const r = rewriteWikiLinks(md, 'personal/Untitled 3.md', 'personal/Japan list.md', true)
    expect(r.text).toBe(
      'see [[Japan list]] and [[Japan list|that]] and [[Japan list#Food]] and [[personal/Japan list]] and ![[Japan list.md]]'
    )
    expect(r.changed).toBe(5)
  })
  test('bare links left alone when the name is ambiguous; other notes and code untouched', () => {
    const md = '[[Untitled 3]] [[other/Untitled 3]] [[personal/Untitled 3]]\n```\n[[personal/Untitled 3]]\n```\n'
    const r = rewriteWikiLinks(md, 'personal/Untitled 3.md', 'personal/Japan.md', false)
    expect(r.text).toBe('[[Untitled 3]] [[other/Untitled 3]] [[personal/Japan]]\n```\n[[personal/Untitled 3]]\n```\n')
  })
})

describe('createTitleSync', () => {
  const fake = (): { run: Array<[string, string]>; tick: () => void; sync: ReturnType<typeof createTitleSync> } => {
    let pending: Array<{ fn: () => void; id: number }> = []
    let seq = 0
    const run: Array<[string, string]> = []
    const sync = createTitleSync({
      run: (id, md) => run.push([id, md]),
      setTimer: (fn) => {
        const t = { fn, id: ++seq }
        pending.push(t)
        return t
      },
      clearTimer: (t) => {
        pending = pending.filter((p) => p !== t)
      }
    })
    return {
      run,
      sync,
      tick: () => {
        const due = pending
        pending = []
        for (const p of due) p.fn()
      }
    }
  }
  test('debounces to the newest text, never per keystroke', () => {
    const f = fake()
    f.sync.schedule('a', '# J')
    f.sync.schedule('a', '# Ja')
    f.sync.schedule('a', '# Japan')
    expect(f.run).toEqual([])
    f.tick()
    expect(f.run).toEqual([['a', '# Japan']])
    f.tick()
    expect(f.run).toHaveLength(1)
  })
  test('flush runs now (note switch / blur); cancel drops', () => {
    const f = fake()
    f.sync.schedule('a', '# A')
    f.sync.schedule('b', '# B')
    f.sync.flush('a')
    expect(f.run).toEqual([['a', '# A']])
    f.sync.cancel('b')
    f.sync.flush()
    f.tick()
    expect(f.run).toEqual([['a', '# A']])
  })
  test('rename carries a pending sync to the new id', () => {
    const f = fake()
    f.sync.schedule('Untitled.md', '# Japan trip')
    f.sync.rename('Untitled.md', 'Japan.md')
    expect(f.sync.pending('Untitled.md')).toBeUndefined()
    f.tick()
    expect(f.run).toEqual([['Japan.md', '# Japan trip']])
  })
})

describe('review fixes', () => {
  test('sanitize drops the characters that break [[wikilinks]]', () => {
    expect(sanitizeFileTitle('Japan #travel')).toBe('Japan travel')
    expect(sanitizeFileTitle('[draft] notes ^1')).toBe('draft notes 1')
  })
  test('rewriteWikiLinks: ambiguous new name gets the folder path', () => {
    expect(rewriteWikiLinks('[[Untitled]] [[Untitled|u]]', 'a/Untitled.md', 'a/Ideas.md', true, true).text).toBe(
      '[[a/Ideas]] [[a/Ideas|u]]'
    )
    expect(rewriteWikiLinks('[[Untitled]]', 'a/Untitled.md', 'a/Ideas.md', true, false).text).toBe('[[Ideas]]')
  })
})
