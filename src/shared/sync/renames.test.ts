import { describe, expect, test } from 'bun:test'
import {
  applyRenames,
  matchRenames,
  plan,
  renameCandidates,
  renameScore,
  runSync,
  sha256,
  utf8Decode,
  utf8Encode
} from './index'
import type { Base, Manifest, Remote, SyncFs, SyncState } from './index'

class MemFs implements SyncFs {
  files = new Map<string, Uint8Array>()
  trashed: string[] = []
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, utf8Encode(v))
  }
  async list(): Promise<Manifest> {
    const m: Manifest = {}
    for (const [p, d] of this.files) m[p] = { hash: sha256(d), size: d.length, mtime: 0 }
    return m
  }
  async read(p: string): Promise<Uint8Array> {
    const d = this.files.get(p)
    if (!d) throw new Error(`ENOENT ${p}`)
    return d
  }
  async write(p: string, d: Uint8Array): Promise<void> {
    this.files.set(p, d)
  }
  async remove(p: string): Promise<void> {
    this.trashed.push(p)
    this.files.delete(p)
  }
  async move(a: string, b: string): Promise<void> {
    const d = this.files.get(a)
    if (d) {
      this.files.delete(a)
      this.files.set(b, d)
    }
  }
  set(p: string, t: string): void {
    this.files.set(p, utf8Encode(t))
  }
  rename(a: string, b: string, t?: string): void {
    const d = this.files.get(a)!
    this.files.delete(a)
    this.files.set(b, t === undefined ? d : utf8Encode(t))
  }
  text(p: string): string | undefined {
    const d = this.files.get(p)
    return d && utf8Decode(d)
  }
  paths(): string[] {
    return [...this.files.keys()].sort()
  }
}

class MemState implements SyncState {
  base: Base = {}
  texts = new Map<string, string>()
  async loadBase(): Promise<Base> {
    return { ...this.base }
  }
  async saveBase(b: Base): Promise<void> {
    this.base = b
  }
  async getText(h: string): Promise<string | null> {
    return this.texts.get(h) ?? null
  }
  async putText(h: string, t: string): Promise<void> {
    this.texts.set(h, t)
  }
  async pruneTexts(keep: Set<string>): Promise<void> {
    for (const k of [...this.texts.keys()]) if (!keep.has(k)) this.texts.delete(k)
  }
}

type ApplyLog = Array<{ moves: unknown[]; writes: string[]; deletes: string[] }>

/** An unchanged protocol-v1 Mac: manifest / get / apply(moves, writes, deletes) and nothing else. */
function macRemote(mac: MemFs, log: ApplyLog = []): Remote {
  return {
    manifest: () => mac.list(),
    async get(paths) {
      const out: Record<string, Uint8Array> = {}
      for (const p of paths) {
        const d = mac.files.get(p)
        if (d) out[p] = d
      }
      return out
    },
    async apply(r) {
      log.push({ moves: r.moves, writes: r.writes.map((w) => w.path), deletes: r.deletes })
      for (const m of r.moves) await mac.move(m.from, m.to)
      for (const w of r.writes) await mac.write(w.path, w.data)
      for (const d of r.deletes) await mac.remove(d)
      return mac.list()
    }
  }
}

async function synced(init: Record<string, string>) {
  const mac = new MemFs(init)
  const phone = new MemFs()
  const state = new MemState()
  const log: ApplyLog = []
  const remote = macRemote(mac, log)
  const sync = () => runSync({ fs: phone, remote, state, remoteName: 'Mac', now: new Date(2026, 9, 19, 9, 0) })
  await sync()
  expect(phone.paths()).toEqual(mac.paths())
  log.length = 0
  return { mac, phone, state, sync, log }
}

const body = '# Untitled\n\n- milk\n- eggs\n- bread\n- coffee\n'
const titled = '# Groceries\n\n- milk\n- eggs\n- bread\n- coffee\n'

describe('renameScore', () => {
  test('same front matter id decides, a different id never matches', () => {
    expect(renameScore('a.md', '---\nid: n-1\n---\nx\n', 'b.md', '---\nid: n-1\n---\ntotally different\n')).toBe(1)
    expect(
      renameScore('a.md', '---\nid: n-1\n---\nsame\nsame2\nsame3\n', 'b.md', '---\nid: n-2\n---\nsame\nsame2\nsame3\n')
    ).toBe(0)
  })
  test('title change + rename matches; an unrelated note does not', () => {
    expect(renameScore('work/Untitled.md', body, 'work/Groceries.md', titled)).toBeGreaterThan(0.5)
    expect(
      renameScore('work/Untitled.md', body, 'work/Other.md', '# Other\n\nnothing alike\nhere at all\nreally\n')
    ).toBe(0)
  })
  test('empty note → title-only note only counts for Untitled → title in the same folder', () => {
    expect(renameScore('work/Untitled 2.md', '', 'work/Groceries.md', '# Groceries\n')).toBeGreaterThan(0)
    expect(renameScore('work/Notes.md', '', 'work/Groceries.md', '# Groceries\n')).toBe(0)
    expect(renameScore('work/Untitled.md', '', 'other/Groceries.md', '# Groceries\n')).toBe(0)
  })
  test('short notes need the same body', () => {
    expect(renameScore('a.md', 'one\n', 'b.md', 'two\n')).toBe(0)
    expect(renameScore('a.md', 'one\n', 'b.md', 'one\n')).toBeGreaterThan(0)
  })
})

describe('matchRenames', () => {
  test('two equally good matches stay unpaired', () => {
    const gone = [{ path: 'a.md', side: 'remote' as const, edited: false }]
    const added = [
      { path: 'b.md', side: 'remote' as const, hash: 'x' },
      { path: 'c.md', side: 'remote' as const, hash: 'y' }
    ]
    const t = (p: string): string => (p === 'a.md' ? 'l1\nl2\nl3\nl4\n' : 'l1\nl2\nl3\nl4 changed\n')
    expect(matchRenames(gone, added, t)).toEqual([])
  })
})

describe('plan + rename pairing (pure)', () => {
  test('#72 title edit renames + changes content → moveLocal + pull, no delete', () => {
    const base: Base = { 'work/Untitled.md': 'h1' }
    const local: Manifest = { 'work/Untitled.md': { hash: 'h1', size: 1, mtime: 1 } }
    const remote: Manifest = { 'work/Groceries.md': { hash: 'h2', size: 1, mtime: 1 } }
    const ops = plan(local, remote, base)
    const { gone, added } = renameCandidates(ops, local, remote, base)
    const pairs = matchRenames(gone, added, (p) => (p === 'work/Untitled.md' ? body : titled))
    expect(applyRenames(ops, pairs, local, remote, base)).toEqual([
      { op: 'moveLocal', from: 'work/Untitled.md', to: 'work/Groceries.md' },
      { op: 'pull', path: 'work/Groceries.md', hash: 'h2' }
    ])
  })
})

describe('runSync: renames arrive as moves (against an unchanged protocol-v1 Mac)', () => {
  test('Mac title rename (name + content change) → phone moves the note, nothing trashed', async () => {
    const { mac, phone, sync } = await synced({ 'work/Untitled.md': body })
    mac.rename('work/Untitled.md', 'work/Groceries.md', titled)
    const r = await sync()
    expect(r.moved).toBe(1)
    expect(r.deleted).toBe(0)
    expect(r.movedLocal).toEqual([{ from: 'work/Untitled.md', to: 'work/Groceries.md' }])
    expect(phone.trashed).toEqual([])
    expect(phone.paths()).toEqual(['work/Groceries.md'])
    expect(phone.text('work/Groceries.md')).toBe(titled)
  })

  test('Mac rename + move of a note with an id (edited too) → move', async () => {
    const a = '---\nid: n-7\n---\n# Plan\n\nstep 1\n'
    const { mac, phone, sync } = await synced({ 'work/Plan.md': a })
    mac.rename('work/Plan.md', 'personal/Trip plan.md', '---\nid: n-7\n---\n# Trip plan\n\nstep 1\nstep 2\n')
    const r = await sync()
    expect(r.movedLocal).toEqual([{ from: 'work/Plan.md', to: 'personal/Trip plan.md' }])
    expect(phone.trashed).toEqual([])
    expect(phone.text('personal/Trip plan.md')).toContain('step 2')
  })

  test('Mac renames while the phone edits the old path → one note, both edits kept', async () => {
    const { mac, phone, sync } = await synced({ 'work/Untitled.md': body })
    mac.rename('work/Untitled.md', 'work/Groceries.md', titled)
    phone.set('work/Untitled.md', `${body}- butter\n`)
    const r = await sync()
    expect(r.conflicts).toEqual([])
    expect(phone.paths()).toEqual(['work/Groceries.md'])
    expect(mac.paths()).toEqual(['work/Groceries.md'])
    expect(phone.text('work/Groceries.md')).toBe(`${titled}- butter\n`)
    expect(mac.text('work/Groceries.md')).toBe(phone.text('work/Groceries.md'))
  })

  test('overlapping edit during a rename → conflict copy beside the renamed note, nothing lost', async () => {
    const { mac, phone, sync } = await synced({ 'work/Untitled.md': body })
    mac.rename('work/Untitled.md', 'work/Groceries.md', titled.replace('- eggs', '- 12 eggs'))
    phone.set('work/Untitled.md', body.replace('- eggs', '- 6 eggs'))
    const r = await sync()
    expect(r.conflicts).toHaveLength(1)
    expect(phone.text('work/Groceries.md')).toContain('6 eggs')
    expect(phone.text(r.conflicts[0]!)).toContain('12 eggs')
    expect(mac.paths()).toEqual(phone.paths())
    expect(phone.paths().filter((p) => p.includes('Untitled'))).toEqual([])
  })

  test('phone renames (with a title edit) → Mac gets one move + write, never delete + add', async () => {
    const { mac, phone, sync, log } = await synced({ 'work/Untitled.md': body })
    phone.rename('work/Untitled.md', 'work/Groceries.md', titled)
    await sync()
    expect(log).toEqual([
      { moves: [{ from: 'work/Untitled.md', to: 'work/Groceries.md' }], writes: ['work/Groceries.md'], deletes: [] }
    ])
    expect(mac.trashed).toEqual([])
    expect(mac.paths()).toEqual(['work/Groceries.md'])
    expect(mac.text('work/Groceries.md')).toBe(titled)
  })

  test('phone renames while the Mac edits the old path → merged at the new path', async () => {
    const { mac, phone, sync } = await synced({ 'work/Untitled.md': body })
    phone.rename('work/Untitled.md', 'work/Groceries.md', titled)
    mac.set('work/Untitled.md', `${body}- butter\n`)
    const r = await sync()
    expect(r.conflicts).toEqual([])
    expect(mac.trashed).toEqual([])
    expect(mac.paths()).toEqual(['work/Groceries.md'])
    expect(phone.paths()).toEqual(['work/Groceries.md'])
    expect(mac.text('work/Groceries.md')).toBe(`${titled}- butter\n`)
  })

  test('no cached base text still pairs (compares against the surviving copy)', async () => {
    const { mac, phone, state, sync } = await synced({ 'work/Untitled.md': body })
    state.texts.clear()
    mac.rename('work/Untitled.md', 'work/Groceries.md', titled)
    const r = await sync()
    expect(r.movedLocal).toHaveLength(1)
    expect(phone.paths()).toEqual(['work/Groceries.md'])
  })

  test('an unrelated delete + new note stay a delete + pull', async () => {
    const { mac, phone, sync } = await synced({ 'work/Old.md': 'old stuff\nmore old stuff\nand more\n' })
    await mac.remove('work/Old.md')
    mac.set('work/New.md', 'brand new\ncompletely different\ncontent\n')
    const r = await sync()
    expect(r.moved).toBe(0)
    expect(phone.trashed).toEqual(['work/Old.md'])
    expect(phone.paths()).toEqual(['work/New.md'])
  })

  test('exact-content rename is still a plain move', async () => {
    const { mac, phone, sync } = await synced({ 'a.md': 'same\n' })
    mac.rename('a.md', 'b.md')
    const r = await sync()
    expect(r.movedLocal).toEqual([{ from: 'a.md', to: 'b.md' }])
    expect(phone.text('b.md')).toBe('same\n')
  })
})
