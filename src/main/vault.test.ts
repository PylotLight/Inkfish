import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let dataDir = ''

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'inkfish-vault-'))
  dataDir = mkdtempSync(join(tmpdir(), 'inkfish-data-'))
  process.env['INKFISH_VAULT'] = dir
  process.env['INKFISH_DATA'] = dataDir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env['INKFISH_VAULT']
  delete process.env['INKFISH_DATA']
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
    expect(routed.vaultRel).toMatch(/^my-project\/\d{4}-\d{2}-\d{2}-hello-world\.md$/)

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
      // No app-data dir → refuse instead of polluting the vault.
      v.setConfigDir('')
      expect(() => v.vaultPaths()).toThrow(/app data dir unavailable/)
    } finally {
      delete process.env['INKFISH_DATA']
      rmSync(notes, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  })

  test('daily append creates day-log; vault holds finalised outputs only', async () => {
    const v = await vault()
    const { existsSync, readdirSync } = await import('node:fs')
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-daily-'))
    try {
      v.setConfigDir(cfg)
      delete process.env['INKFISH_DATA']
      const paths = v.ensureVault()
      expect(existsSync(paths.dailyDir)).toBe(true)
      expect(existsSync(paths.inboxDir)).toBe(true)
      // Vault root: finalised outputs only — no inbox/, daily/, projects/ app dirs.
      const top = readdirSync(paths.root).sort()
      expect(top).toEqual(['assets'])
      // Staging lives in app data.
      expect(paths.inboxDir.startsWith(cfg)).toBe(true)
      expect(paths.dailyDir.startsWith(cfg)).toBe(true)
      const out = v.appendDaily('standup: shipped x', { kind: 'text' }, paths)
      expect(out.vaultRel).toMatch(/^daily\/\d{4}-\d{2}-\d{2}\.md$/)
      expect(existsSync(out.path)).toBe(true)
      const again = v.appendDaily('second update', {}, paths)
      expect(again.vaultRel).toBe(out.vaultRel)
      // Staging rels resolve into app data, vault rels into the vault.
      expect(v.resolveNoteAbs(out.vaultRel, paths)).toBe(out.path)
      expect(v.resolveNoteAbs('work/n.md', paths)).toBe(join(paths.root, 'work/n.md'))
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })

  test('legacy vault inbox/daily migrate to staging once', async () => {
    const v = await vault()
    const { writeFileSync, existsSync, mkdirSync, readdirSync } = await import('node:fs')
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-migstage-'))
    try {
      v.setConfigDir(cfg)
      delete process.env['INKFISH_DATA']
      const paths = v.ensureVault()
      // Simulate a pre-move vault with working dirs inside it.
      mkdirSync(join(paths.root, 'inbox'), { recursive: true })
      mkdirSync(join(paths.root, 'daily'), { recursive: true })
      writeFileSync(join(paths.root, 'inbox', 'in-old.md'), '# old\n')
      writeFileSync(join(paths.root, 'daily', '2026-01-01.md'), '# day\n')
      const { moved } = v.migrateStaging(paths)
      expect(moved).toBe(2)
      expect(existsSync(join(paths.inboxDir, 'in-old.md'))).toBe(true)
      expect(existsSync(join(paths.dailyDir, '2026-01-01.md'))).toBe(true)
      expect(existsSync(join(paths.root, 'inbox'))).toBe(false)
      expect(existsSync(join(paths.root, 'daily'))).toBe(false)
      expect(readdirSync(paths.root).sort()).toEqual(['assets'])
      // Second run is a no-op.
      expect(v.migrateStaging(paths)).toEqual({ moved: 0, skipped: 0 })
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })

  test('legacy projects/ container migrates to top-level folders', async () => {
    const v = await vault()
    const { writeFileSync, existsSync, mkdirSync, readdirSync } = await import('node:fs')
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-migproj-'))
    try {
      v.setConfigDir(cfg)
      delete process.env['INKFISH_DATA']
      const paths = v.ensureVault()
      // Legacy layout + a colliding top-level folder.
      mkdirSync(join(paths.root, 'projects', 'work'), { recursive: true })
      mkdirSync(join(paths.root, 'Work'), { recursive: true })
      writeFileSync(join(paths.root, 'projects', 'work', 'a.md'), '# A\n')
      writeFileSync(join(paths.root, 'Work', 'a.md'), '# existing\n')
      writeFileSync(join(paths.root, 'projects', 'work', '.a.md.undone'), '# residue\n')
      const { moved } = v.migrateProjects(paths)
      expect(moved).toBe(2)
      expect(existsSync(join(paths.root, 'work', 'a.md'))).toBe(true)
      expect(existsSync(join(paths.root, 'Work', 'a.md'))).toBe(true)
      expect(existsSync(join(paths.root, 'projects'))).toBe(false)
      // No app container dir left; routed notes land top-level.
      const { item } = v.writeInboxItem({ kind: 'text', raw: 'x', source: 'tray' }, paths)
      const routed = v.routeToProject(
        { inboxId: item.id, projectName: 'work', title: 'T', tags: [], markdown: 'x', kind: 'text' },
        paths
      )
      expect(routed.vaultRel).toMatch(/^work\/\d{4}-\d{2}-\d{2}-t\.md$/)
      expect(readdirSync(paths.root).sort()).toEqual(['Work', 'assets', 'work'])
      expect(v.migrateProjects(paths)).toEqual({ moved: 0, skipped: 0 })
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })

  test('profiles round-trip in app data; switch changes active root', async () => {
    const v = await vault()
    const cfg = mkdtempSync(join(tmpdir(), 'inkfish-cfg-prof-'))
    try {
      v.setConfigDir(cfg)
      const a = mkdtempSync(join(tmpdir(), 'inkfish-prof-a-'))
      const b = mkdtempSync(join(tmpdir(), 'inkfish-prof-b-'))
      try {
        v.saveProfile('work', a)
        v.saveProfile('personal', b)
        expect(v.listProfiles().map((p) => p.id).sort()).toEqual(['personal', 'work'])
        expect(v.switchProfile('work')).toBe(a)
        expect(v.readStoredRoot()).toBe(a)
      } finally {
        rmSync(a, { recursive: true, force: true })
        rmSync(b, { recursive: true, force: true })
      }
    } finally {
      rmSync(cfg, { recursive: true, force: true })
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

describe('case-duplicate healing', () => {
  test('Personal + personal merge into personal, files kept', async () => {
    const v = await vault()
    const { writeFileSync, mkdirSync, readdirSync } = await import('node:fs')
    const paths = v.ensureVault()
    mkdirSync(join(dir, 'Personal'), { recursive: true })
    mkdirSync(join(dir, 'personal'), { recursive: true })
    writeFileSync(join(dir, 'Personal', 'a.md'), '# A\n')
    writeFileSync(join(dir, 'personal', 'b.md'), '# B\n')
    const rep = v.mergeCaseDuplicates(paths.root)
    expect(rep.dirs).toBe(1)
    expect(readdirSync(dir).filter((e) => e === 'Personal' || e === 'personal')).toEqual(['personal'])
    expect(readdirSync(join(dir, 'personal')).sort()).toEqual(['a.md', 'b.md'])
  })

  test('identical files dedupe, conflicting ones bump', async () => {
    const v = await vault()
    const { writeFileSync, mkdirSync, readdirSync } = await import('node:fs')
    const paths = v.ensureVault()
    mkdirSync(join(dir, 'Notes'), { recursive: true })
    mkdirSync(join(dir, 'notes'), { recursive: true })
    writeFileSync(join(dir, 'Notes', 'same.md'), '# Same\n')
    writeFileSync(join(dir, 'notes', 'same.md'), '# Same\n')
    writeFileSync(join(dir, 'Notes', 'clash.md'), '# One\n')
    writeFileSync(join(dir, 'notes', 'clash.md'), '# Two\n')
    v.mergeCaseDuplicates(paths.root)
    const kids = readdirSync(join(dir, 'notes')).sort()
    expect(kids).toContain('same.md')
    expect(kids.filter((f) => f.startsWith('clash'))).toHaveLength(2)
  })

  test('second run is a no-op', async () => {
    const v = await vault()
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const paths = v.ensureVault()
    mkdirSync(join(dir, 'Personal'), { recursive: true })
    writeFileSync(join(dir, 'Personal', 'a.md'), '# A\n')
    expect(v.mergeCaseDuplicates(paths.root)).toEqual({ dirs: 0, files: 0 })
  })

  test('createDir reuses a case-variant sibling instead of forking', async () => {
    const v = await vault()
    const { mkdirSync, readdirSync } = await import('node:fs')
    v.ensureVault()
    mkdirSync(join(dir, 'personal'), { recursive: true })
    expect(v.createDir('', 'Personal')).toBe('personal')
    expect(readdirSync(dir).filter((e) => e.toLowerCase() === 'personal')).toEqual(['personal'])
  })

  test('resolveDirRel maps to on-disk spelling', async () => {
    const v = await vault()
    const { mkdirSync } = await import('node:fs')
    v.ensureVault()
    mkdirSync(join(dir, 'personal', 'Trips'), { recursive: true })
    expect(v.resolveDirRel('Personal/trips')).toBe('personal/Trips')
    expect(v.resolveDirRel('')).toBe('')
  })
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
      // Trash lives in app data: point it at this cfg for the assertion below.
      delete process.env['INKFISH_DATA']
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
