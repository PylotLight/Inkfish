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
