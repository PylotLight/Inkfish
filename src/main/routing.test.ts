import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let dir = ''
let dataDir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inkfish-route-'))
  dataDir = mkdtempSync(join(tmpdir(), 'inkfish-route-data-'))
  process.env['INKFISH_VAULT'] = dir
  process.env['INKFISH_DATA'] = dataDir
})

afterEach(async () => {
  ;(await import('./db')).closeDb()
  rmSync(dir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env['INKFISH_VAULT']
  delete process.env['INKFISH_DATA']
})

const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), text)
}

async function setup(): Promise<{
  v: typeof import('./vault')
  r: typeof import('./routing')
  paths: import('./vault').VaultPaths
}> {
  const v = await import('./vault')
  const d = await import('./db')
  const r = await import('./routing')
  const paths = v.ensureVault(v.vaultPaths())
  // Alphabetically first folder holds meetings (what the live recorder made) — it used to win everything.
  put(
    'Abc Meetings/2026-10-20 0900 Standup.md',
    '---\nkind: meeting\ntags: [meeting]\n---\n# Standup\n\ntranscript: deploy, release, garden chat\n'
  )
  put(
    'Abc Meetings/2026-10-21 0900 Standup.md',
    '---\nkind: meeting\ntags: [meeting]\n---\n# Standup\n\ntranscript: release train\n'
  )
  put(
    'Garden/Tomato log.md',
    '---\ntags: [tomatoes]\n---\n# Tomato log\n\nroma tomato seedlings, staking, watering schedule\n'
  )
  put('Garden/Compost.md', '---\ntags: [compost]\n---\n# Compost\n\ncompost bin, worms, mulch for the beds\n')
  put('Rust/Borrow checker.md', '---\ntags: [rust]\n---\n# Borrow checker\n\nlifetimes, ownership, async traits\n')
  d.openDb(paths.dbPath)
  d.reindexVault(paths.root)
  return { v, r, paths }
}

const ok = <T>(out: T | { error: string }): T => {
  if (typeof out === 'object' && out !== null && 'error' in out) throw new Error(String(out.error))
  return out as T
}

describe('routeInboxItem', () => {
  test('unrelated capture stays in the inbox (no first-folder guess, meetings folder never wins)', async () => {
    const { v, r, paths } = await setup()
    const { item } = v.writeInboxItem({ kind: 'text', raw: 'book the dentist for thursday arvo' }, paths)
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true }))
    expect(out.note).toBeNull()
    expect(out.route.action).toBe('review')
    const back = v.readInboxItem(item.id, paths)
    expect(back?.status).toBe('inbox')
    expect(back?.route?.reason).toContain('left in inbox')
    expect(readdirSync(join(dir, 'Abc Meetings'))).toHaveLength(2)
  })

  test('content picks the folder; new note written there', async () => {
    const { v, r, paths } = await setup()
    r.saveRoutingPrefs({ allowAppend: false })
    const { item } = v.writeInboxItem({ kind: 'text', raw: 'worms escaping the compost bin again, more mulch' }, paths)
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true }))
    expect(out.route.action).toBe('new')
    expect(out.route.rel.startsWith('Garden/')).toBe(true)
    expect(v.readInboxItem(item.id, paths)?.status).toBe('ready')
  })

  test('closely related note gets an appended section; undo strips just that section', async () => {
    const { v, r, paths } = await setup()
    const before = readFileSync(join(dir, 'Garden/Tomato log.md'), 'utf8')
    const { item } = v.writeInboxItem(
      { kind: 'text', raw: 'tomato seedlings need staking, fix the watering schedule' },
      paths
    )
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true }))
    expect(out.route.action).toBe('append')
    expect(out.route.rel).toBe('Garden/Tomato log.md')
    const appended = readFileSync(join(dir, 'Garden/Tomato log.md'), 'utf8')
    expect(appended.startsWith(before)).toBe(true)
    expect(appended).toMatch(/\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n<!-- inkfish:inbox /)
    expect(appended).toContain('fix the watering schedule')

    expect(r.undoInboxRoute(item.id, paths)).toBe(true)
    expect(readFileSync(join(dir, 'Garden/Tomato log.md'), 'utf8')).toBe(before)
    expect(v.readInboxItem(item.id, paths)?.status).toBe('inbox')
    expect(v.readInboxItem(item.id, paths)?.route).toBeUndefined()
  })

  test('auto-file off: suggestion recorded, nothing written', async () => {
    const { v, r, paths } = await setup()
    r.saveRoutingPrefs({ autoFile: false, allowAppend: false })
    const { item } = v.writeInboxItem({ kind: 'text', raw: 'worms escaping the compost bin again, more mulch' }, paths)
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: r.loadRoutingPrefs().autoFile }))
    expect(out.note).toBeNull()
    expect(out.route).toMatchObject({ action: 'new', folder: 'Garden', suggested: true })
    expect(readdirSync(join(dir, 'Garden')).sort()).toEqual(['Compost.md', 'Tomato log.md'])
  })

  test('explicit folder wins (Move →), new note even if unrelated', async () => {
    const { v, r, paths } = await setup()
    const { item } = v.writeInboxItem({ kind: 'text', raw: 'tomato seedlings need staking' }, paths)
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true, hint: 'Rust' }))
    expect(out.route.action).toBe('new')
    expect(out.route.rel.startsWith('Rust/')).toBe(true)
  })

  test('default folder catches low-confidence captures when set', async () => {
    const { v, r, paths } = await setup()
    r.saveRoutingPrefs({ defaultFolder: 'Unsorted' })
    const { item } = v.writeInboxItem({ kind: 'text', raw: 'book the dentist for thursday arvo' }, paths)
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true }))
    expect(out.route.rel.startsWith('Unsorted/')).toBe(true)
  })
})
