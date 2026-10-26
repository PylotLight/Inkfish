import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  test('unmatched capture proposes a root note and approval files that exact proposal', async () => {
    const { v, r, paths } = await setup()
    const { item } = v.writeInboxItem({ kind: 'text', raw: 'book the dentist for thursday arvo' }, paths)
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true }))
    expect(out.note).toBeNull()
    expect(out.route).toMatchObject({ action: 'new', folder: '', suggested: true })
    expect(out.route.title).toBeTruthy()
    expect(out.route.rel).toMatch(/^\d{4}-\d{2}-\d{2}-/)
    expect(existsSync(join(paths.root, out.route.rel))).toBe(false)
    const back = v.readInboxItem(item.id, paths)
    expect(back?.status).toBe('inbox')
    expect(back?.route).toMatchObject({ title: out.route.title, rel: out.route.rel, suggested: true })
    expect(back?.route?.markdown).toBeUndefined()

    const approved = ok(
      await r.routeInboxItem(item.id, paths, {
        apply: true,
        manual: true,
        approveSuggestion: true,
        llm: async () => {
          throw new Error('saved proposals must not be reclassified')
        }
      })
    )
    expect(approved.note?.path).toBe(out.route.rel)
    expect(approved.route.suggested).toBe(false)
    expect(readFileSync(join(paths.root, approved.note!.path), 'utf8')).toContain(`# ${out.route.title}`)
    expect(readFileSync(join(paths.root, approved.note!.path), 'utf8')).toContain('book the dentist for thursday arvo')
    expect(readdirSync(join(dir, 'Abc Meetings'))).toHaveLength(2)
  })

  test('pending root proposals reserve their paths so duplicate captures do not collide', async () => {
    const { v, r, paths } = await setup()
    const first = v.writeInboxItem({ kind: 'text', raw: 'call the dentist about Thursday' }, paths).item
    const second = v.writeInboxItem({ kind: 'text', raw: 'call the dentist about Thursday' }, paths).item
    const a = ok(await r.routeInboxItem(first.id, paths, { apply: true }))
    const b = ok(await r.routeInboxItem(second.id, paths, { apply: true }))
    expect(a.route.suggested).toBe(true)
    expect(b.route.suggested).toBe(true)
    expect(a.route.rel).not.toBe(b.route.rel)
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

  test('File applies the saved append target rather than asking the router again', async () => {
    const { v, r, paths } = await setup()
    r.saveRoutingPrefs({ autoFile: false })
    const target = join(dir, 'Garden/Tomato log.md')
    const before = readFileSync(target, 'utf8')
    const { item } = v.writeInboxItem(
      { kind: 'text', raw: 'tomato seedlings need staking, change the watering schedule' },
      paths
    )
    const suggestion = ok(await r.routeInboxItem(item.id, paths, { apply: false }))
    expect(suggestion.route).toMatchObject({ action: 'append', rel: 'Garden/Tomato log.md', suggested: true })

    const filed = ok(
      await r.routeInboxItem(item.id, paths, {
        apply: true,
        manual: true,
        approveSuggestion: true,
        llm: async () => {
          throw new Error('saved proposals must not be reclassified')
        }
      })
    )
    expect(filed.note?.path).toBe('Garden/Tomato log.md')
    expect(filed.route.suggested).toBe(false)
    expect(readFileSync(target, 'utf8').startsWith(before)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('change the watering schedule')
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

describe('previewRoute (capture popover)', () => {
  const filedKey = (r: { action: string; folder: string; rel: string }): string =>
    r.action === 'append' ? `append:${r.rel}` : r.action === 'review' ? 'review:' : `new:${r.folder}`

  test('preview == filing decision for the same input (append / new / inbox / overrides / suggest-only)', async () => {
    const { v, r, paths } = await setup()
    const sr = await import('../shared/routing')
    const cases: Array<{ raw: string; hint?: string; prefs?: Partial<import('../shared/routing').RoutingPrefs> }> = [
      { raw: 'tomato seedlings need staking, fix the watering schedule' },
      { raw: 'worms escaping the compost bin again, more mulch', prefs: { allowAppend: false } },
      { raw: 'book the dentist for thursday arvo' },
      { raw: 'tomato seedlings need staking', hint: 'Rust' },
      { raw: 'worms in the compost bin', hint: sr.appendHint('Garden/Tomato log.md') },
      { raw: 'tomato seedlings need staking, fix the watering schedule', hint: sr.KEEP_IN_INBOX },
      { raw: 'worms escaping the compost bin again, more mulch', prefs: { autoFile: false, allowAppend: false } }
    ]
    const seen = new Set<string>()
    for (const c of cases) {
      r.saveRoutingPrefs({ ...sr.DEFAULT_ROUTING_PREFS, ...(c.prefs ?? {}) })
      const p = r.previewRoute(c.raw, 'text', c.hint ?? 'auto', paths)
      const { item } = v.writeInboxItem({ kind: 'text', raw: c.raw, projectHint: c.hint ?? 'auto' }, paths)
      const out = ok(await r.routeInboxItem(item.id, paths, { apply: r.loadRoutingPrefs().autoFile }))
      const filed = filedKey({ ...out.route, rel: out.route.action === 'append' ? out.route.rel : '' })
      expect(sr.routeKey({ action: p.action, folder: p.folder, rel: p.target?.rel })).toBe(filed)
      expect(p.confidence).toBeCloseTo(out.route.confidence, 2)
      expect(p.suggested).toBe(out.route.suggested)
      seen.add(p.action)
      if (out.route.action === 'append' && !out.route.suggested) r.undoInboxRoute(item.id, paths)
    }
    expect([...seen].sort()).toEqual(['append', 'inbox', 'new'])
  })

  test('override always wins: append to a chosen note, keep in inbox', async () => {
    const { v, r, paths } = await setup()
    const sr = await import('../shared/routing')
    const hint = sr.appendHint('Rust/Borrow checker.md')
    const p = r.previewRoute('book the dentist for thursday arvo', 'text', hint, paths)
    expect(p).toMatchObject({ action: 'append', override: true, folder: 'Rust' })
    expect(p.target?.rel).toBe('Rust/Borrow checker.md')
    const { item } = v.writeInboxItem(
      { kind: 'text', raw: 'book the dentist for thursday arvo', projectHint: hint },
      paths
    )
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true }))
    expect(out.route).toMatchObject({ action: 'append', rel: 'Rust/Borrow checker.md', provider: 'picker' })
    expect(readFileSync(join(dir, 'Rust/Borrow checker.md'), 'utf8')).toContain('book the dentist')

    // Keep in inbox beats a confident append; "Route" clicked later routes it normally.
    const raw = 'tomato seedlings need staking, fix the watering schedule'
    const keep = v.writeInboxItem({ kind: 'text', raw, projectHint: sr.KEEP_IN_INBOX }, paths).item
    const kept = ok(await r.routeInboxItem(keep.id, paths, { apply: true }))
    expect(kept.route).toMatchObject({ action: 'review', reason: 'kept in inbox' })
    const later = ok(await r.routeInboxItem(keep.id, paths, { apply: true, manual: true }))
    expect(later.route.action).toBe('append')
  })

  test('AI can refine but never beats an override; a different outcome is flagged on the inbox row', async () => {
    const { v, r, paths } = await setup()
    r.saveRoutingPrefs({ allowAppend: false, useAiProvider: true })
    const raw = 'worms escaping the compost bin again, more mulch'
    expect(r.previewRoute(raw, 'text', 'auto', paths, true)).toMatchObject({
      action: 'new',
      folder: 'Garden',
      aiMayRefine: true
    })
    const llm = async (): Promise<string> =>
      JSON.stringify({ action: 'new', folder: 'Rust', targetNote: null, title: 'x', tags: [], confidence: 0.9 })
    const { item } = v.writeInboxItem({ kind: 'text', raw, previewed: 'new:Garden' }, paths)
    expect(v.readInboxItem(item.id, paths)?.previewed).toBe('new:Garden')
    const out = ok(await r.routeInboxItem(item.id, paths, { apply: true, llm }))
    expect(out.route.folder).toBe('Rust')
    expect(out.route.reason).toContain('preview said new note in Garden')

    // The user picked Garden in the preview: the picker wins over the model, nothing to flag.
    expect(r.previewRoute(raw, 'text', 'Garden', paths, true)).toMatchObject({ override: true, aiMayRefine: false })
    const two = v.writeInboxItem({ kind: 'text', raw, projectHint: 'Garden', previewed: 'new:Garden' }, paths).item
    const out2 = ok(await r.routeInboxItem(two.id, paths, { apply: true, llm }))
    expect(out2.route.folder).toBe('Garden')
    expect(out2.route.reason).not.toContain('preview said')
  })
})
