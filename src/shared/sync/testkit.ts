import { randomBytes } from 'node:crypto'
import { createHandler } from './server'
import { httpRemote, type Fetch, type MacPeer } from './client'
import { sha256 } from './hash'
import { utf8Decode, utf8Encode, toBase64 } from './bytes'
import { PEER_HEADER } from './protocol'
import type { PeerRecord } from './server'
import type { Base, Manifest } from './plan'
import type { Remote, SyncFs, SyncState } from './engine'

/**
 * Test doubles for sync: an in-memory case-sensitive vault (Android), a
 * case-insensitive, case-preserving vault (macOS APFS), the per-peer state,
 * and a wired-up Mac handler + phone Remote. Test-only (not exported from
 * ./index).
 */

export const random = (n: number): Uint8Array => new Uint8Array(randomBytes(n))

/** Case-sensitive in-memory vault (Android / Linux). */
export class MemFs implements SyncFs {
  files = new Map<string, Uint8Array>()
  /** Heal case-duplicate folders on list (like android `mergeCaseDuplicates`). */
  healCase = false
  constructor(init: Record<string, string | Uint8Array> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, typeof v === 'string' ? utf8Encode(v) : v)
  }
  async list(): Promise<Manifest> {
    if (this.healCase) this.heal()
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
    this.files.delete(p)
  }
  async move(a: string, b: string): Promise<void> {
    const d = this.files.get(a)
    if (d) {
      this.files.delete(a)
      this.files.set(b, d)
    }
  }
  text(p: string): string | undefined {
    const d = this.files.get(p)
    return d && utf8Decode(d)
  }
  /**
   * Same rule as android/src/lib/vault.ts `mergeCaseDuplicates` (non-empty
   * dirs only): sibling dirs that differ only by case collapse into the
   * lowercase spelling (identical files dedupe, different ones are bumped to
   * `name 2.md`).
   */
  heal(): void {
    let changed = true
    while (changed) {
      changed = false
      const byParent = new Map<string, Map<string, Set<string>>>()
      for (const p of this.files.keys()) {
        const segs = p.split('/')
        for (let i = 0; i < segs.length - 1; i++) {
          const parent = segs.slice(0, i).join('/')
          const fold = segs[i]!.toLowerCase()
          if (i === 0 && ['inbox', 'daily', 'assets'].includes(fold)) continue
          const g = byParent.get(parent) ?? new Map<string, Set<string>>()
          byParent.set(parent, g)
          const s = g.get(fold) ?? new Set<string>()
          g.set(fold, s)
          s.add(segs[i]!)
        }
      }
      for (const [parent, groups] of byParent) {
        for (const [fold, names] of groups) {
          if (names.size < 2) continue
          const prefix = parent ? `${parent}/` : ''
          for (const [p, d] of [...this.files]) {
            for (const n of names) {
              if (!p.startsWith(`${prefix}${n}/`)) continue
              const target = `${prefix}${fold}/${p.slice(prefix.length + n.length + 1)}`
              if (target === p) continue
              this.files.delete(p)
              const onto = this.files.get(target)
              if (!onto) this.files.set(target, d)
              else if (sha256(onto) !== sha256(d)) {
                const dot = target.lastIndexOf('.')
                let i = 2
                let t = `${target.slice(0, dot)} ${i}${target.slice(dot)}`
                while (this.files.has(t)) t = `${target.slice(0, dot)} ${++i}${target.slice(dot)}`
                this.files.set(t, d)
              }
              changed = true
            }
          }
        }
      }
    }
  }
}

/**
 * macOS APFS (default): case-insensitive, case-preserving. `work/x.md`
 * written while `Work/` exists lands in `Work/x.md`; a rename that only
 * changes the case of a folder segment leaves the folder spelled as it was.
 */
export class CiFs implements SyncFs {
  /** fold(path) → { path as stored, data } */
  store = new Map<string, { path: string; data: Uint8Array }>()
  writes = 0
  constructor(init: Record<string, string | Uint8Array> = {}) {
    for (const [k, v] of Object.entries(init))
      this.store.set(k.toLowerCase(), { path: k, data: typeof v === 'string' ? utf8Encode(v) : v })
  }
  private resolve(p: string): string {
    const segs = p.split('/')
    const out: string[] = []
    for (let i = 0; i < segs.length - 1; i++) {
      const prefix = [...out, segs[i]!].join('/').toLowerCase()
      let hit: string | null = null
      for (const e of this.store.values()) {
        const es = e.path.split('/')
        if (
          es.length > i + 1 &&
          es
            .slice(0, i + 1)
            .join('/')
            .toLowerCase() === prefix
        ) {
          hit = es[i]!
          break
        }
      }
      out.push(hit ?? segs[i]!)
    }
    const existing = this.store.get(p.toLowerCase())
    out.push(existing ? existing.path.split('/').pop()! : segs[segs.length - 1]!)
    return out.join('/')
  }
  async list(): Promise<Manifest> {
    const m: Manifest = {}
    for (const { path, data } of this.store.values()) m[path] = { hash: sha256(data), size: data.length, mtime: 0 }
    return m
  }
  async read(p: string): Promise<Uint8Array> {
    const e = this.store.get(p.toLowerCase())
    if (!e) throw new Error(`ENOENT ${p}`)
    return e.data
  }
  async write(p: string, d: Uint8Array): Promise<void> {
    this.writes++
    this.store.set(p.toLowerCase(), { path: this.resolve(p), data: d })
  }
  async remove(p: string): Promise<void> {
    this.store.delete(p.toLowerCase())
  }
  async move(a: string, b: string): Promise<void> {
    const e = this.store.get(a.toLowerCase())
    if (!e) return
    this.store.delete(a.toLowerCase())
    const resolved = this.resolve(b).split('/')
    resolved[resolved.length - 1] = b.split('/').pop()!
    this.store.set(b.toLowerCase(), { path: resolved.join('/'), data: e.data })
  }
  text(p: string): string | undefined {
    const e = this.store.get(p.toLowerCase())
    return e && utf8Decode(e.data)
  }
  paths(): string[] {
    return [...this.store.values()].map((e) => e.path).sort()
  }
}

export class MemState implements SyncState {
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

/** A paired Mac (handler over `mac`) and the phone's Remote to it. */
export function wired(mac: SyncFs): {
  remote: Remote
  changed: string[][]
  requests: string[]
  fetchFn: Fetch
  peer: MacPeer
} {
  const key = random(32)
  const peerId = 'phone-abcdef12'
  const peers = new Map<string, PeerRecord>([[peerId, { id: peerId, name: 'Pixel', key: toBase64(key), pairedAt: 0 }]])
  const changed: string[][] = []
  const requests: string[] = []
  const handle = createHandler({
    device: { id: 'mac-1234567890', name: 'Mac' },
    fs: mac,
    random,
    getPeer: async (id) => peers.get(id) ?? null,
    pending: () => null,
    addPeer: async () => undefined,
    touchPeer: () => undefined,
    changed: (ps) => changed.push(ps)
  })
  const fetchFn: Fetch = async (url, init) => {
    const u = new URL(url)
    requests.push(u.pathname)
    const r = await handle(init?.method ?? 'GET', u.pathname, init?.headers?.[PEER_HEADER] ?? null, init?.body ?? '')
    return { ok: r.status === 200, status: r.status, text: async () => r.body }
  }
  const peer: MacPeer = { id: 'mac-1234567890', name: 'Mac', key: toBase64(key), hosts: ['127.0.0.1'], port: 1 }
  return { remote: httpRemote(fetchFn, '127.0.0.1', peer, peerId, random), changed, requests, fetchFn, peer }
}

export function hashes(m: Manifest): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([p, e]) => [p, e.hash]))
}
