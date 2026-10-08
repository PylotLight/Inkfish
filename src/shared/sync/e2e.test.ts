import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  createHandler, SyncHeld, encodePairUri, decodePairUri, httpRemote, pairWithMac, runSync, sha256, toBase64, utf8Decode, utf8Encode,
  fromBase64, PEER_HEADER, type Fetch, type Manifest, type PeerRecord, type SyncFs, type SyncState, type Base
} from './index'

const random = (n: number): Uint8Array => new Uint8Array(randomBytes(n))

class MemFs implements SyncFs {
  files = new Map<string, Uint8Array>()
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
  async write(p: string, d: Uint8Array): Promise<void> { this.files.set(p, d) }
  async remove(p: string): Promise<void> { this.files.delete(p) }
  async move(a: string, b: string): Promise<void> { const d = this.files.get(a); if (d) { this.files.delete(a); this.files.set(b, d) } }
  text(p: string): string | undefined { const d = this.files.get(p); return d && utf8Decode(d) }
}

class MemState implements SyncState {
  base: Base = {}
  texts = new Map<string, string>()
  async loadBase(): Promise<Base> { return { ...this.base } }
  async saveBase(b: Base): Promise<void> { this.base = b }
  async getText(h: string): Promise<string | null> { return this.texts.get(h) ?? null }
  async putText(h: string, t: string): Promise<void> { this.texts.set(h, t) }
  async pruneTexts(keep: Set<string>): Promise<void> { for (const k of [...this.texts.keys()]) if (!keep.has(k)) this.texts.delete(k) }
}

function setup(mac: MemFs) {
  const peers = new Map<string, PeerRecord>()
  let pending: { key: Uint8Array; exp: number } | null = null
  const changed: string[] = []
  const handle = createHandler({
    device: { id: 'mac-1234567890', name: 'Mac' },
    fs: mac,
    random,
    getPeer: (id) => peers.get(id) ?? null,
    pending: () => pending,
    addPeer: (p) => { peers.set(p.id, p); pending = null },
    touchPeer: (id, at) => { const p = peers.get(id); if (p) p.lastSync = at },
    changed: (ps) => changed.push(...ps)
  })
  const fetchFn: Fetch = async (url, init) => {
    const u = new URL(url)
    if (u.hostname !== '192.168.1.20') throw new Error('unreachable')
    const r = await handle(init?.method ?? 'GET', u.pathname, init?.headers?.[PEER_HEADER] ?? null, init?.body ?? '')
    return { ok: r.status === 200, status: r.status, text: async () => r.body }
  }
  const showQr = (): string => {
    const key = random(32)
    pending = { key, exp: Date.now() + 60_000 }
    return encodePairUri({ v: 1, id: 'mac-1234567890', name: 'Mac', key: toBase64(key, true), hosts: ['192.168.1.99', '192.168.1.20'], port: 47821, exp: pending.exp })
  }
  return { fetchFn, showQr, peers, changed }
}

describe('pair + sync over the wire', () => {
  test('pairs, syncs both ways, merges, and rejects strangers', async () => {
    const mac = new MemFs({ 'work/a.md': '# A\n\none\n\ntwo\n', 'assets/x.bin': 'BIN', 'daily/2026-10-08.md': '# d\n\n## 09:00\n\nmac\n' })
    const phone = new MemFs({ 'inbox/p1.md': 'captured on phone\n', 'daily/2026-10-08.md': '# d\n\n## 10:00\n\nphone\n' })
    const state = new MemState()
    const { fetchFn, showQr, peers, changed } = setup(mac)

    const qr = decodePairUri(showQr())!
    expect(qr).not.toBeNull()
    const peer = await pairWithMac(fetchFn, qr, { id: 'phone-abcdef12', name: 'Pixel' }, random)
    expect(peer.lastHost).toBe('192.168.1.20')
    expect(peers.get('phone-abcdef12')?.name).toBe('Pixel')

    const remote = httpRemote(fetchFn, '192.168.1.20', peer, 'phone-abcdef12', random)
    const r1 = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r1.pulled).toBe(2)
    expect(phone.text('work/a.md')).toBe('# A\n\none\n\ntwo\n')
    expect(mac.text('inbox/p1.md')).toBe('captured on phone\n')
    expect(mac.text('daily/2026-10-08.md')).toBe('# d\n\n## 09:00\n\nmac\n\n## 10:00\n\nphone\n')
    expect(phone.text('daily/2026-10-08.md')).toBe(mac.text('daily/2026-10-08.md'))
    expect(changed).toContain('inbox/p1.md')

    // Concurrent edits to different lines merge cleanly using the cached base.
    await mac.write('work/a.md', utf8Encode('# A\n\nONE (mac)\n\ntwo\n'))
    await phone.write('work/a.md', utf8Encode('# A\n\none\n\nTWO (phone)\n'))
    // Phone renames, Mac deletes an asset.
    await phone.move('inbox/p1.md', 'work/p1.md')
    await mac.remove('assets/x.bin')
    const r2 = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r2.merged).toBe(1)
    expect(mac.text('work/a.md')).toBe('# A\n\nONE (mac)\n\nTWO (phone)\n')
    expect(phone.text('work/a.md')).toBe(mac.text('work/a.md'))
    expect(mac.files.has('inbox/p1.md')).toBe(false)
    expect(mac.text('work/p1.md')).toBe('captured on phone\n')
    expect(phone.files.has('assets/x.bin')).toBe(false)

    // Same line edited on both: conflict copy, nothing lost.
    await mac.write('work/a.md', utf8Encode('# A\n\nmac wins?\n\nTWO (phone)\n'))
    await phone.write('work/a.md', utf8Encode('# A\n\nphone wins?\n\nTWO (phone)\n'))
    const r3 = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r3.conflicts.length).toBe(1)
    expect(mac.text('work/a.md')).toContain('phone wins?')
    expect(mac.text(r3.conflicts[0]!)).toContain('mac wins?')
    expect(phone.text(r3.conflicts[0]!)).toContain('mac wins?')

    // Nothing to do → no-op.
    const r4 = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r4.pulled + r4.pushed + r4.merged + r4.deleted + r4.moved).toBe(0)

    // Unknown device / wrong key gets nothing.
    const stranger = httpRemote(fetchFn, '192.168.1.20', { ...peer, key: toBase64(random(32)) }, 'phone-abcdef12', random)
    await expect(stranger.manifest()).rejects.toThrow()
    const unknown = httpRemote(fetchFn, '192.168.1.20', peer, 'other-phone-123', random)
    await expect(unknown.manifest()).rejects.toThrow(/no longer paired/)
  })

  test('a big deletion is held, kept, or applied as asked', async () => {
    const init: Record<string, string> = {}
    for (let i = 0; i < 20; i++) init[`work/n${i}.md`] = `note ${i}\n`
    const mac = new MemFs(init)
    const phone = new MemFs()
    const state = new MemState()
    const { fetchFn, showQr } = setup(mac)
    const peer = await pairWithMac(fetchFn, decodePairUri(showQr())!, { id: 'phone-abcdef12', name: 'Pixel' }, random)
    const remote = httpRemote(fetchFn, '192.168.1.20', peer, 'phone-abcdef12', random)
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(phone.files.size).toBe(20)

    // Mac loses a whole folder. Without a handler the run holds and changes nothing.
    for (let i = 0; i < 15; i++) await mac.remove(`work/n${i}.md`)
    const held = await runSync({ fs: phone, remote, state, remoteName: 'Mac' }).catch((e: unknown) => e)
    expect(held).toBeInstanceOf(SyncHeld)
    expect((held as SyncHeld).pending.local.length).toBe(15)
    expect(phone.files.size).toBe(20)

    // "Keep" copies them back to the Mac.
    let asked = 0
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac', confirmDelete: async () => (asked++, 'keep') })
    expect(asked).toBe(1)
    expect(r.pushed).toBe(15)
    expect(mac.files.size).toBe(20)

    // A small deletion goes straight through.
    await mac.remove('work/n0.md')
    const small = await runSync({ fs: phone, remote, state, remoteName: 'Mac', confirmDelete: async () => 'hold' })
    expect(small.deleted).toBe(1)
    expect(phone.files.has('work/n0.md')).toBe(false)

    // "Apply" deletes them on the phone too.
    for (let i = 1; i < 15; i++) await mac.remove(`work/n${i}.md`)
    const r2 = await runSync({ fs: phone, remote, state, remoteName: 'Mac', confirmDelete: async () => 'apply' })
    expect(r2.deleted).toBe(14)
    expect(phone.files.size).toBe(5)
  })

  test('expired / reused pairing code is refused', async () => {
    const { fetchFn, showQr } = setup(new MemFs())
    const qr = decodePairUri(showQr())!
    await pairWithMac(fetchFn, qr, { id: 'phone-aaaaaaaa', name: 'A' }, random)
    await expect(pairWithMac(fetchFn, qr, { id: 'phone-bbbbbbbb', name: 'B' }, random)).rejects.toThrow()
    await expect(pairWithMac(fetchFn, { ...qr, exp: 1 }, { id: 'phone-cccccccc', name: 'C' }, random)).rejects.toThrow(/expired/)
  })

  test('utf8 + base64 roundtrip', () => {
    const s = 'héllo 🐙 — 日本語'
    expect(utf8Decode(utf8Encode(s))).toBe(s)
    expect(Buffer.from(utf8Encode(s)).toString()).toBe(s)
    const b = random(1000)
    expect(fromBase64(toBase64(b))).toEqual(b)
    expect(toBase64(b)).toBe(Buffer.from(b).toString('base64'))
    expect(fromBase64(toBase64(b, true))).toEqual(b)
  })
})
