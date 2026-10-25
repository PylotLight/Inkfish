import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inkfish-db-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function db(): Promise<typeof import('./db')> {
  return import('./db')
}

describe('index', () => {
  test('open → index → search → list → remove', async () => {
    const d = await db()
    const kind = d.openDb(join(dir, 'inkfish.db'))
    expect(['sqlite+fts5', 'memory']).toContain(kind)

    const file = join(dir, 'in-2026-10-05-abc123.md')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      file,
      '---\nid: in-2026-10-05-abc123\nkind: text\nstatus: inbox\ncreated: 2026-10-05T00:00:00.000Z\n---\n# Oat milk run\nbuy oat milk\n'
    )
    const entry = d.indexFile(file, 'inbox/in-2026-10-05-abc123.md')
    expect(entry?.title).toBe('Oat milk run')

    expect(d.searchNotes('oat milk').map((n) => n.id)).toContain('in-2026-10-05-abc123')
    expect(d.searchNotes('')).toEqual([])
    expect(d.listNotes('inbox')).toHaveLength(1)
    expect(d.countInbox()).toBe(1)

    d.removeNote('in-2026-10-05-abc123')
    expect(d.searchNotes('oat milk')).toEqual([])
    expect(d.countInbox()).toBe(0)
  })

  test('indexes explicit frontmatter titles for cross-device display', async () => {
    const d = await db()
    d.openDb(join(dir, 'titles.db'))
    const { writeFileSync } = await import('node:fs')
    const file = join(dir, 'Original file.md')
    writeFileSync(file, '---\nid: title-test\ntitle: "Trip: Japan"\n---\n# Different body heading\n')
    const entry = d.indexFile(file, 'Original file.md')
    expect(entry?.title).toBe('Trip: Japan')
    expect(entry?.frontmatterTitle).toBe('Trip: Japan')
  })

  test('related ranks by cosine similarity', async () => {
    const d = await db()
    d.openDb(join(dir, 'r.db'))
    const { writeFileSync } = await import('node:fs')
    for (const [id, body] of [
      ['a', '# A\nsame topic here'],
      ['b', '# B\nsame topic here too'],
      ['c', '# C\ntotally different zebra']
    ] as Array<[string, string]>) {
      const f = join(dir, `${id}.md`)
      writeFileSync(f, `---\nid: ${id}\nkind: text\nstatus: ready\n---\n${body}\n`)
      d.indexFile(f, `p/${id}.md`)
    }
    // Hand-set embeddings: a≈b, c orthogonal.
    d.saveEmbedding('a', [1, 0])
    d.saveEmbedding('b', [0.9, 0.1])
    d.saveEmbedding('c', [0, 1])
    const rel = d.relatedNotes('a').map((n) => n.id)
    expect(rel[0]).toBe('b')
    expect(d.relatedNotes('c')).toEqual([])
    expect(d.relatedNotes('missing')).toEqual([])
  })

  test('reindex walks a vault tree; staging indexed separately', async () => {
    const d = await db()
    d.openDb(join(dir, 'scan.db'))
    const v = await import('./vault')
    process.env['INKFISH_VAULT'] = dir
    const dataDir = mkdtempSync(join(tmpdir(), 'inkfish-db-data-'))
    process.env['INKFISH_DATA'] = dataDir
    try {
      const paths = v.ensureVault(v.vaultPaths())
      v.writeInboxItem({ kind: 'text', raw: 'scan me' }, paths)
      v.appendDaily('day note', {}, paths)
      // Vault scan skips the staging namespace (nothing finalised yet).
      expect(d.reindexVault(paths.root)).toBe(0)
      // Staging scan picks up the inbox item + day-log.
      expect(d.reindexStaging(paths)).toBe(2)
      expect(d.countInbox()).toBe(1)
    } finally {
      delete process.env['INKFISH_VAULT']
      delete process.env['INKFISH_DATA']
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('targeted index ops (rename / trash / restore)', () => {
  const put = async (rel: string, text: string): Promise<void> => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }

  for (const backend of ['sqlite', 'memory'] as const) {
    test(`${backend}: linkLookup finds only notes mentioning the needles, from the index`, async () => {
      const d = await db()
      if (backend === 'sqlite') d.openDb(join(dir, 'll.db'))
      else d.closeDb() // must() falls back to the in-memory index
      await put('a.md', '# A\nsee [[Japan List]]\n')
      await put('b.md', '# B\nnothing here\n')
      await put('c/über.md', '# C\nlink to [[Ünïcode Note]]\n')
      await put('d.md', '---\nid: n-d\n---\n# D\n[x](../Japan%20List.md)\n')
      for (const rel of ['a.md', 'b.md', 'c/über.md', 'd.md']) d.indexFile(join(dir, rel), rel)
      // Staging never counts.
      await put('inbox/x.md', '[[Japan List]]')
      d.indexFile(join(dir, 'inbox/x.md'), 'inbox/x.md')

      const r = d.linkLookup(['Japan List.md', 'Japan%20List.md', 'Japan List'])
      expect(r.candidates.sort()).toEqual(['a.md', 'd.md'])
      expect(r.notes.sort()).toEqual(['a.md', 'b.md', 'c/über.md', 'd.md'])
      // Non-ASCII needles are folded in JS (SQLite lower() is ASCII-only).
      expect(d.linkLookup(['ÜNÏCODE NOTE']).candidates).toEqual(['c/über.md'])
      expect(d.linkLookup([]).candidates).toEqual([])
      d.closeDb()
    })

    test(`${backend}: removePath drops a file or a folder's notes (front matter ids too); indexPath re-adds`, async () => {
      const d = await db()
      if (backend === 'sqlite') d.openDb(join(dir, 'rp.db'))
      else d.closeDb()
      await put('proj/a.md', '---\nid: n-a\n---\n# A\n')
      await put('proj/sub/b.md', '# B\n')
      await put('project-x.md', '# not under proj/\n')
      for (const rel of ['proj/a.md', 'proj/sub/b.md', 'project-x.md']) d.indexFile(join(dir, rel), rel)
      expect(d.removePath('proj')).toBe(2)
      expect(d.listNotes(null).map((n) => n.path)).toEqual(['project-x.md'])
      expect(d.removePath('project-x.md')).toBe(1)
      expect(d.listNotes(null)).toEqual([])

      expect(d.indexPath(dir, 'proj')).toBe(2)
      expect(d.getNote('n-a', dir)?.path).toBe('proj/a.md')
      expect(d.indexPath(dir, 'project-x.md')).toBe(1)
      expect(d.indexPath(dir, 'missing.md')).toBe(0)
      expect(d.listNotes(null)).toHaveLength(3)
      d.closeDb()
    })
  }
})
