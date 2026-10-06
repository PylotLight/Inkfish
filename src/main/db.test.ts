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
      v.ensureSeedProjects(paths)
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
