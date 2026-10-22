/**
 * Sync benchmark: phone-side sync against an in-process Mac server, with a
 * simulated phone (RN bridge latency on every file-system call) and LAN.
 *
 *   bun scripts/bench-sync.ts [--notes 2000] [--images 60] [--legacy] [--json]
 *
 * `--legacy` swaps in the pre-#83 phone manifest walk (sequential, two stats
 * per file + a full case-heal walk) so before/after can be compared on the
 * same engine. Run it on an older checkout for the old engine. Numbers are
 * simulated wall time (real sleeps), not a device measurement.
 */
import { randomBytes } from 'node:crypto'
import { createHandler } from '../src/shared/sync/server'
import { httpRemote, type Fetch, type MacPeer } from '../src/shared/sync/client'
import { runSync, type SyncFs, type SyncState } from '../src/shared/sync/engine'
import { sha256 } from '../src/shared/sync/hash'
import { toBase64, utf8Encode } from '../src/shared/sync/bytes'
import { PEER_HEADER } from '../src/shared/sync/protocol'
import type { Base, Manifest } from '../src/shared/sync/plan'

export interface BenchOpts {
  notes: number
  images: number
  legacy: boolean
  /** Multiplies every simulated latency (0 = no sleeps; counts only). */
  scale: number
  /** Print each scenario as it finishes. */
  verbose?: boolean
}

export function fmt(r: ScenarioResult): string {
  const k = r.counters
  return `${r.name.padEnd(40)} ${String(r.ms).padStart(7)} ms  ↓${r.pulled} ↑${r.pushed}  stat=${k.stat} read=${k.read} write=${k.write} hash=${k.hash} textGet=${k.textGet} textPut=${k.textPut} req=${JSON.stringify(k.requests)}`
}

/** Simulated costs (ms). Rough Pixel 8 Pro + expo-file-system legacy + home Wi-Fi. */
export const COST = {
  stat: 1.5,
  readDir: 2,
  ioBase: 1.2,
  /** base64 over the bridge + decode, MB/s */
  ioMBs: 40,
  /** pure-JS sha256 on Hermes, MB/s (beyond bun's real hashing) */
  hashMBs: 25,
  rtt: 6,
  netMBs: 20
}

const sleep = (ms: number): Promise<void> => (ms > 0.05 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

export class Counters {
  stat = 0
  readDir = 0
  read = 0
  write = 0
  hash = 0
  textGet = 0
  textPut = 0
  requests: Record<string, number> = {}
  bytesUp = 0
  bytesDown = 0
  reset(): void {
    Object.assign(this, new Counters())
  }
}

/** Phone vault as a tree, with bridge latency on each call. */
class PhoneFs implements SyncFs {
  files = new Map<string, { data: Uint8Array; mtime: number }>()
  cache: Record<string, { size: number; mtime: number; hash: string }> = {}
  tick = 1
  constructor(
    readonly o: BenchOpts,
    readonly c: Counters
  ) {}
  private async cost(ms: number): Promise<void> {
    await sleep(ms * this.o.scale)
  }
  private io(bytes: number): number {
    return COST.ioBase + bytes / (COST.ioMBs * 1024)
  }
  private dirs(): Set<string> {
    const d = new Set<string>()
    for (const p of this.files.keys()) {
      const s = p.split('/')
      for (let i = 1; i < s.length; i++) d.add(s.slice(0, i).join('/'))
    }
    return d
  }
  private children(dir: string): string[] {
    const out = new Set<string>()
    const pre = dir ? `${dir}/` : ''
    for (const p of this.files.keys()) if (p.startsWith(pre)) out.add(p.slice(pre.length).split('/')[0]!)
    return [...out]
  }
  private async statRel(rel: string): Promise<{ dir: boolean; size: number; mtime: number }> {
    this.c.stat++
    await this.cost(COST.stat)
    const f = this.files.get(rel)
    return f ? { dir: false, size: f.data.length, mtime: f.mtime } : { dir: this.dirs().has(rel), size: 0, mtime: 0 }
  }
  private async readDir(rel: string): Promise<string[]> {
    this.c.readDir++
    await this.cost(COST.readDir)
    return this.children(rel)
  }
  private async hashOf(rel: string): Promise<string> {
    const d = this.files.get(rel)!.data
    this.c.hash++
    await this.cost(this.io(d.length) + d.length / (COST.hashMBs * 1024))
    return sha256(d)
  }

  async list(): Promise<Manifest> {
    return this.o.legacy ? this.listLegacy() : this.listNew()
  }

  /** android-v0.2.6 `androidFs.list`: heal walk (stat per entry), then a sequential walk with two stats per file. */
  private async listLegacy(): Promise<Manifest> {
    const heal = async (dir: string): Promise<void> => {
      for (const n of await this.readDir(dir)) {
        const rel = dir ? `${dir}/${n}` : n
        const st = await this.statRel(rel)
        if (st.dir) await heal(rel)
      }
    }
    await heal('')
    const next: typeof this.cache = {}
    const m: Manifest = {}
    const walk = async (dir: string): Promise<void> => {
      for (const n of await this.readDir(dir)) {
        const rel = dir ? `${dir}/${n}` : n
        const st = await this.statRel(rel)
        if (st.dir) await walk(rel)
        else {
          const st2 = await this.statRel(rel) // add() stats again
          const c = this.cache[rel]
          const hash = c && c.size === st2.size && c.mtime === st2.mtime ? c.hash : await this.hashOf(rel)
          next[rel] = { size: st2.size, mtime: st2.mtime, hash }
          m[rel] = { hash, size: st2.size, mtime: st2.mtime }
        }
      }
    }
    await walk('')
    this.cache = next
    await this.cost(this.io(JSON.stringify(next).length)) // hashes.json rewrite, every list
    return m
  }

  private async listNew(): Promise<Manifest> {
    // Lazy import so `--legacy` runs on checkouts without walk.ts.
    const { walkManifest } = await import('../src/shared/sync/walk')
    const toRel = (uri: string): string => uri.replace(/^v:\/\/?/, '').replace(/\/$/, '')
    const r = await walkManifest(
      {
        readDir: (uri) => this.readDir(toRel(uri)),
        stat: async (uri) => {
          const st = await this.statRel(toRel(uri))
          return { exists: true, isDirectory: st.dir, size: st.size, mtime: st.mtime }
        },
        hash: (uri) => this.hashOf(toRel(uri))
      },
      [{ uri: 'v://', prefix: '', deep: true }],
      this.cache
    )
    this.cache = r.cache
    if (r.dirty) await this.cost(this.io(JSON.stringify(r.cache).length))
    return r.manifest
  }
  async read(p: string): Promise<Uint8Array> {
    const f = this.files.get(p)
    if (!f) throw new Error(`ENOENT ${p}`)
    this.c.read++
    await this.cost(this.io(f.data.length))
    return f.data
  }
  async write(p: string, d: Uint8Array, hash?: string): Promise<void> {
    this.c.write++
    await this.cost(this.io(d.length) + COST.stat * 3) // mkdirp check + temp write + delete + move
    const mtime = this.tick++
    this.files.set(p, { data: d, mtime })
    // Same as androidFs: a known hash goes straight into the cache (one stat), no re-read next walk.
    if (hash && !this.o.legacy) {
      await this.cost(COST.stat)
      this.cache[p] = { size: d.length, mtime, hash }
    }
  }
  async remove(p: string): Promise<void> {
    await this.cost(COST.stat * 3)
    this.files.delete(p)
  }
  async move(a: string, b: string): Promise<void> {
    await this.cost(COST.stat * 3)
    const f = this.files.get(a)
    if (f) {
      this.files.delete(a)
      this.files.set(b, { ...f, mtime: this.tick++ })
    }
  }
}

class MacFs implements SyncFs {
  files = new Map<string, Uint8Array>()
  private hashes = new Map<Uint8Array, string>()
  async list(): Promise<Manifest> {
    const m: Manifest = {}
    for (const [p, d] of this.files) {
      let h = this.hashes.get(d)
      if (!h) this.hashes.set(d, (h = sha256(d)))
      m[p] = { hash: h, size: d.length, mtime: 0 }
    }
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
}

class PhoneState implements SyncState {
  base: Base = {}
  texts = new Map<string, string>()
  constructor(
    readonly o: BenchOpts,
    readonly c: Counters
  ) {}
  async loadBase(): Promise<Base> {
    await sleep((COST.ioBase + JSON.stringify(this.base).length / (COST.ioMBs * 1024)) * this.o.scale)
    return { ...this.base }
  }
  async saveBase(b: Base): Promise<void> {
    await sleep((COST.ioBase + JSON.stringify(b).length / (COST.ioMBs * 1024)) * this.o.scale)
    this.base = b
  }
  async getText(h: string): Promise<string | null> {
    this.c.textGet++
    await sleep(COST.ioBase * this.o.scale)
    return this.texts.get(h) ?? null
  }
  async putText(h: string, t: string): Promise<void> {
    this.c.textPut++
    await sleep(COST.ioBase * 2 * this.o.scale)
    this.texts.set(h, t)
  }
  async pruneTexts(keep: Set<string>): Promise<void> {
    await sleep(COST.readDir * this.o.scale)
    for (const k of [...this.texts.keys()]) if (!keep.has(k)) this.texts.delete(k)
  }
}

function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n)
  let x = seed * 2654435761
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    b[i] = x >>> 24
  }
  return b
}

function note(i: number, rev = 0): Uint8Array {
  const words = 'the quick brown fox jumps over a lazy dog while notes sync between devices'.split(' ')
  const lines = [`# Note ${i}`, '', `tags: #t${i % 13}`, '']
  for (let k = 0; k < 20 + (i % 40); k++)
    lines.push(Array.from({ length: 12 }, (_, j) => words[(i + k + j) % words.length]).join(' '))
  if (rev) lines.push('', `edit ${rev}`)
  return utf8Encode(`${lines.join('\n')}\n`)
}

export function buildMacVault(o: BenchOpts): MacFs {
  const mac = new MacFs()
  const folders = ['Work', 'Work/Projects', 'Personal', 'Reading', 'Ideas', 'Journal/2026']
  for (let i = 0; i < o.notes; i++) mac.files.set(`${folders[i % folders.length]}/note ${i}.md`, note(i))
  for (let i = 0; i < o.images; i++) {
    const size = i % 10 === 0 ? 2_000_000 : 60_000 + ((i * 7919) % 400_000)
    mac.files.set(
      `assets/2026/${String((i % 12) + 1).padStart(2, '0')}/img-${i}.${i % 3 ? 'jpg' : 'png'}`,
      bytes(size, i + 1)
    )
  }
  return mac
}

function wire(mac: MacFs, o: BenchOpts, c: Counters): { remote: ReturnType<typeof httpRemote> } {
  const key = new Uint8Array(randomBytes(32))
  const peerId = 'phone-benchmark'
  const handle = createHandler({
    device: { id: 'mac-bench-000001', name: 'Mac' },
    fs: mac,
    random: (n) => new Uint8Array(randomBytes(n)),
    getPeer: async (id) => (id === peerId ? { id, name: 'Pixel', key: toBase64(key), pairedAt: 0 } : null),
    pending: () => null,
    addPeer: async () => undefined,
    touchPeer: () => undefined,
    changed: () => undefined
  })
  const fetchFn: Fetch = async (url, init) => {
    const path = new URL(url).pathname
    c.requests[path] = (c.requests[path] ?? 0) + 1
    const up = init?.body?.length ?? 0
    c.bytesUp += up
    await sleep((COST.rtt / 2 + up / (COST.netMBs * 1024)) * o.scale)
    const r = await handle(init?.method ?? 'GET', path, init?.headers?.[PEER_HEADER] ?? null, init?.body ?? '')
    c.bytesDown += r.body.length
    await sleep((COST.rtt / 2 + r.body.length / (COST.netMBs * 1024)) * o.scale)
    return { ok: r.status === 200, status: r.status, text: async () => r.body }
  }
  const peer: MacPeer = { id: 'mac-bench-000001', name: 'Mac', key: toBase64(key), hosts: ['127.0.0.1'], port: 1 }
  return { remote: httpRemote(fetchFn, '127.0.0.1', peer, peerId, (n) => new Uint8Array(randomBytes(n))) }
}

export interface ScenarioResult {
  name: string
  ms: number
  pulled: number
  pushed: number
  counters: Omit<Counters, 'reset'>
}

export async function runBench(o: BenchOpts): Promise<ScenarioResult[]> {
  const c = new Counters()
  const mac = buildMacVault(o)
  const phone = new PhoneFs(o, c)
  const state = new PhoneState(o, c)
  const { remote } = wire(mac, o, c)
  const out: ScenarioResult[] = []
  const run = async (name: string): Promise<void> => {
    c.reset()
    const t0 = performance.now()
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    const ms = performance.now() - t0
    const { reset: _r, ...counters } = c
    out.push({
      name,
      ms: Math.round(ms),
      pulled: r.pulled,
      pushed: r.pushed,
      counters: JSON.parse(JSON.stringify(counters))
    })
    if (o.verbose) console.log(fmt(out[out.length - 1]!))
  }
  await run('initial (fresh phone)')
  await run('idle (nothing changed)')
  // A typical "came back to the app" sync: a few edits each side + a couple of new photos.
  for (let i = 0; i < 5; i++) mac.files.set(`Work/note ${i * 6}.md`, note(i * 6, 1))
  for (let i = 0; i < 3; i++) await phone.write(`Personal/note ${i * 6 + 2}.md`, note(i * 6 + 2, 2))
  for (let i = 0; i < 2; i++) mac.files.set(`assets/2026/10/new-${i}.jpg`, bytes(1_500_000, 900 + i))
  await run('small change (5↓ 3↑ notes, 2 photos)')
  await run('idle again')
  return out
}

if (import.meta.main) {
  const arg = (k: string, d: number): number => {
    const i = process.argv.indexOf(`--${k}`)
    return i > 0 ? Number(process.argv[i + 1]) : d
  }
  const o: BenchOpts = {
    notes: arg('notes', 2000),
    images: arg('images', 60),
    legacy: process.argv.includes('--legacy'),
    scale: arg('scale', 1)
  }
  const json = process.argv.includes('--json')
  if (!json) console.log(`notes=${o.notes} images=${o.images} walk=${o.legacy ? 'legacy' : 'new'} scale=${o.scale}`)
  const res = await runBench({ ...o, verbose: !json })
  if (json) console.log(JSON.stringify({ opts: o, res }, null, 2))
}
