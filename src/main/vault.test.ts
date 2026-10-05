import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inkfish-vault-'))
  process.env['INKFISH_VAULT'] = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['INKFISH_VAULT']
})

async function vault(): Promise<typeof import('./vault')> {
  return import('./vault')
}

describe('frontmatter', () => {
  test('round-trips data + body', async () => {
    const v = await vault()
    const md = `${v.stringifyFrontmatter({ id: 'x', tags: ['a', 'b'], n: 3 })}hello\n`
    const [fm, body] = v.parseFrontmatter(md)
    expect(fm['id']).toBe('x')
    expect(fm['tags']).toEqual(['a', 'b'])
    expect(body).toBe('hello\n')
  })

  test('plain text has no frontmatter', async () => {
    const v = await vault()
    const [fm, body] = v.parseFrontmatter('just text')
    expect(fm).toEqual({})
    expect(body).toBe('just text')
  })
})

describe('inbox', () => {
  test('write → read → list → status', async () => {
    const v = await vault()
    const paths = v.ensureVault()
    const { item } = v.writeInboxItem({ kind: 'text', raw: 'hello #t', source: 'tray' }, paths)
    expect(item.status).toBe('inbox')
    expect(item.projectHint).toBe('auto')
    const back = v.readInboxItem(item.id, paths)
    expect(back?.raw).toBe('hello #t')
    expect(v.listInbox(paths)).toHaveLength(1)
    expect(v.setInboxStatus(item.id, 'ready', paths)).toBe(true)
    expect(v.readInboxItem(item.id, paths)?.status).toBe('ready')
    expect(v.setInboxStatus('nope', 'ready', paths)).toBe(false)
  })
})

describe('projects + routing', () => {
  test('seeds, create, route, undo keeps raw', async () => {
    const v = await vault()
    const paths = v.ensureVault()
    const seeds = v.ensureSeedProjects(paths)
    expect(seeds.map((s) => s.name)).toContain('personal')
    const p = v.createProject('My Project!')
    expect(p.name).toBe('my-project')
    expect(() => v.createProject('!!!')).toThrow()

    const { item } = v.writeInboxItem({ kind: 'text', raw: 'note body', source: 'tray' }, paths)
    const routed = v.routeToProject(
      { inboxId: item.id, projectName: 'my-project', title: 'Hello World', tags: ['x'], markdown: 'note body', kind: 'text' },
      paths
    )
    expect(routed.vaultRel).toMatch(/^projects\/my-project\/\d{4}-\d{2}-\d{2}-hello-world\.md$/)

    expect(v.undoRoute(item.id, paths)).toBe(true)
    // Raw inbox file untouched, status reset.
    expect(v.readInboxItem(item.id, paths)?.status).toBe('inbox')
    expect(v.undoRoute('missing', paths)).toBe(false)
  })
})

describe('assets', () => {
  test('save + resolve', async () => {
    const v = await vault()
    const paths = v.ensureVault()
    const rel = v.saveAsset('pic.png', Buffer.from([1, 2, 3]), paths)
    expect(rel).toMatch(/^assets\/\d{4}\/\d{2}\//)
    expect(v.resolveAsset(rel, paths)).toBe(join(paths.root, rel))
  })
})

describe('meeting vtt', () => {
  test('parses speakers + timestamps, builds note', async () => {
    const v = await vault()
    const cues = v.parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alice>hello</v>\n\n00:00:04.000 --> 00:00:06.000\nBob: ship it\n'
    )
    expect(cues).toEqual([
      { at: '00:00:01.000', speaker: 'Alice', line: 'hello' },
      { at: '00:00:04.000', speaker: 'Bob', line: 'ship it' }
    ])
    const md = v.meetingToMarkdown(cues, 'Standup')
    expect(md).toContain('## Attendees')
    expect(md).toContain('- Alice')
    expect(md).toContain('## Decisions')
    expect(md).toContain('## Actions')
  })
})

describe('slugify', () => {
  test('names become dir-safe slugs', async () => {
    const v = await vault()
    expect(v.slugify('Hello, World!')).toBe('hello-world')
    expect(v.slugify('!!!')).toBe('untitled')
  })
})

describe('vault home', () => {
  test('stored choice round-trips; env beats stored beats default', async () => {
    const v = await vault()
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-'))
    try {
      v.setConfigDir(cfg)
      delete process.env['INKFISH_VAULT']
      expect(v.readStoredRoot()).toBeNull()

      const chosen = join(cfg, 'MyVault')
      v.storeRoot(chosen)
      expect(v.readStoredRoot()).toBe(chosen)
      expect(v.resolveVaultRoot()).toBe(chosen)
      expect(v.vaultConfigured()).toBe(true)

      const envDir = mkdtempSync(join(tmpdir(), 'inkfish-env-'))
      try {
        process.env['INKFISH_VAULT'] = envDir
        expect(v.resolveVaultRoot()).toBe(envDir)
        expect(v.envManaged()).toBe(true)
        expect(v.vaultConfigured()).toBe(true)
      } finally {
        delete process.env['INKFISH_VAULT']
        rmSync(envDir, { recursive: true, force: true })
      }
      expect(v.envManaged()).toBe(false)
      expect(v.resolveVaultRoot()).toBe(chosen)
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })

  test('db lives in app data, never in the notes home', async () => {
    const v = await vault()
    const notes = mkdtempSync(join(tmpdir(), 'inkfish-notes-'))
    const data = mkdtempSync(join(tmpdir(), 'inkfish-data-'))
    try {
      v.setConfigDir('')
      process.env['INKFISH_VAULT'] = notes
      process.env['INKFISH_DATA'] = data
      expect(v.vaultPaths().dbPath).toBe(join(data, 'inkfish.db'))
      expect(v.appDataDir()).toBe(data)
      delete process.env['INKFISH_DATA']
      expect(v.vaultPaths().dbPath).toBe(join(notes, 'inkfish.db'))
    } finally {
      delete process.env['INKFISH_DATA']
      rmSync(notes, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  })

  test('requireNotes throws before any location is chosen', async () => {
    const v = await vault()
    const { homedir } = await import('node:os')
    const { existsSync } = await import('node:fs')
    // Only meaningful on machines without a pre-existing default vault.
    if (existsSync(join(homedir(), 'Inkfish'))) return
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-empty-'))
    try {
      v.setConfigDir(cfg)
      delete process.env['INKFISH_VAULT']
      expect(v.vaultConfigured()).toBe(false)
      expect(() => v.requireNotes()).toThrow(/not chosen/)
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })

  test('import: existing md trees index with folder projects, hidden skipped', async () => {
    const v = await vault()
    const db = await import('./db')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const notes = mkdtempSync(join(tmpdir(), 'inkfish-obsidian-'))
    try {
      process.env['INKFISH_VAULT'] = notes
      mkdirSync(join(notes, 'My Recipes'), { recursive: true })
      mkdirSync(join(notes, '.obsidian'), { recursive: true })
      writeFileSync(join(notes, 'My Recipes', 'cake.md'), '# Cake\nflour sugar\n')
      writeFileSync(join(notes, 'todo.md'), '- [ ] buy milk\n')
      writeFileSync(join(notes, '.obsidian', 'app.json'), '{}')
      const paths = v.vaultPaths()
      const n = db.reindexVault(paths.root)
      expect(n).toBe(2)
      const all = db.listNotes(null)
      expect(all.map((e) => e.path).sort()).toEqual(['My Recipes/cake.md', 'todo.md'])
      const cake = all.find((e) => e.path === 'My Recipes/cake.md')
      expect(cake?.projectId).toBe('my-recipes')
      // …and the folder shows up as a project to file under.
      const projs = v.listProjects(paths)
      expect(projs.map((p) => p.id)).toContain('my-recipes')
    } finally {
      delete process.env['INKFISH_VAULT']
      rmSync(notes, { recursive: true, force: true })
    }
  })

  test('title overrides round-trip in app data (empty clears)', async () => {
    const v = await vault()
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-titles-'))
    try {
      v.setConfigDir(cfg)
      expect(v.loadTitles()).toEqual({})
      v.setTitleOverride('a/b.md', '  Custom Title  ')
      expect(v.loadTitles()).toEqual({ 'a/b.md': 'Custom Title' })
      // Empty clears back to filename.
      v.setTitleOverride('a/b.md', '   ')
      expect(v.loadTitles()).toEqual({})
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })
})

describe('file ops', () => {
  test('create/rename/trash round-trip with unique names', async () => {
    const v = await vault()
    const { writeFileSync, existsSync, mkdirSync } = await import('node:fs')
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-fs-'))
    try {
      v.setConfigDir(cfg)
      const a = v.createNoteFile('')
      const b = v.createNoteFile('')
      expect(a).not.toBe(b)
      expect(a.endsWith('Untitled.md')).toBe(true)
      expect(existsSync(join(dir, a))).toBe(true)

      const renamed = v.renamePath(a, 'Hello World')
      expect(renamed).toBe('Hello World.md')
      expect(existsSync(join(dir, renamed))).toBe(true)

      mkdirSync(join(dir, 'sub', 'deep'), { recursive: true })
      writeFileSync(join(dir, 'sub', 'deep', 'x.md'), '# X\n')
      const mv = v.renamePath('sub', 'sub2')
      expect(mv).toBe('sub2')
      expect(existsSync(join(dir, 'sub2', 'deep', 'x.md'))).toBe(true)

      const entry = v.trashPath('sub2')
      expect(entry.isDir).toBe(true)
      expect(existsSync(join(dir, 'sub2'))).toBe(false)
      expect(v.purgeTrash()).toBe(0)

      // Backdate the manifest → sweep purges it.
      const { readFileSync } = await import('node:fs')
      const man = join(cfg, 'trash', 'manifest.json')
      const entries = JSON.parse(readFileSync(man, 'utf8')) as Array<Record<string, unknown>>
      entries[0]!['deletedAt'] = 0
      writeFileSync(man, JSON.stringify(entries))
      expect(v.purgeTrash()).toBe(1)
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })

  test('migrateTitles follows file and dir renames', async () => {
    const v = await vault()
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-mig-'))
    try {
      v.setConfigDir(cfg)
      v.setTitleOverride('sub/old.md', 'Old')
      v.setTitleOverride('other.md', 'Other')
      const moved = v.migrateTitles('sub', 'sub2')
      expect(moved['sub2/old.md']).toBe('Old')
      expect(moved['other.md']).toBe('Other')
      expect('sub/old.md' in moved).toBe(false)
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })

  test('metadata: size + mtime indexed from fs', async () => {
    const v = await vault()
    const db = await import('./db')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'sized.md'), '# Sized\n' + 'x'.repeat(3000))
    const before = Date.now()
    const n = db.reindexVault(dir)
    expect(n).toBeGreaterThan(0)
    const found = db.listNotes(null).find((e) => e.path === 'sized.md')
    expect(found?.size).toBeGreaterThan(3000)
    expect(found?.updatedAt).toBeLessThanOrEqual(before + 1000)
    expect(found?.createdAt).toBeLessThanOrEqual(found?.updatedAt ?? 0)
  })
})
