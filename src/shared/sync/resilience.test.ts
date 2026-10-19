import { describe, expect, test } from 'bun:test'
import { runSync, type PartialStore, type SyncReport } from './engine'

/** Small chunks so the resume tests stay fast (the logic is size-independent). */
const CHUNK_SIZE = 64 * 1024
const chunk = { min: 3 * CHUNK_SIZE, size: CHUNK_SIZE }
import { httpRemote, withRetry, HttpError, type Fetch, type MacPeer } from './client'
import { createHandler, memPartials } from './server'
import { sha256 } from './hash'
import { toBase64, utf8Encode } from './bytes'
import { PEER_HEADER } from './protocol'
import type { Manifest } from './plan'
import { CiFs, MemFs, MemState, random, hashes } from './testkit'

/**
 * Fault injection: kill mid-transfer, dropped replies, damaged bytes, clock
 * skew, duplicate requests, a Mac restart mid-sync, edits racing the sync,
 * two phones at once. After every fault: nothing lost, nothing duplicated,
 * and the next clean run converges.
 */

const PEER = 'phone-abcdef12'
const fast = { attempts: 4, sleep: async () => undefined }

/** Phone vault with stat (size + mtime) and a partial store, like androidFs. */
class Phone extends MemFs {
  mtimes = new Map<string, number>()
  tick = 1
  partial: PartialStore = memPartials()
  override async write(p: string, d: Uint8Array): Promise<void> {
    await super.write(p, d)
    this.mtimes.set(p, this.tick++)
  }
  override async move(a: string, b: string): Promise<void> {
    await super.move(a, b)
    this.mtimes.set(b, this.tick++)
  }
  override async list(): Promise<Manifest> {
    const m = await super.list()
    for (const p of Object.keys(m)) m[p]!.mtime = this.mtimes.get(p) ?? 0
    return m
  }
  async stat(p: string): Promise<{ size: number; mtime: number } | null> {
    const d = this.files.get(p)
    return d ? { size: d.length, mtime: this.mtimes.get(p) ?? 0 } : null
  }
  /** An edit made by the user (bumps mtime). */
  async edit(p: string, text: string): Promise<void> {
    await this.write(p, utf8Encode(text))
  }
}

interface MacOpts {
  partials?: PartialStore
  now?: () => number
}

/** A Mac whose handler can be "restarted" (fresh instance: new replay cache; partials only if shared). */
function macServer(mac: CiFs, o: MacOpts = {}) {
  const key = random(32)
  const make = (opts: MacOpts) =>
    createHandler({
      device: { id: 'mac-1234567890', name: 'Mac' },
      fs: mac,
      random,
      getPeer: async (id) => (id === PEER ? { id, name: 'Pixel', key: toBase64(key), pairedAt: 0 } : null),
      pending: () => null,
      addPeer: async () => undefined,
      touchPeer: () => undefined,
      changed: () => undefined,
      ...(opts.partials ? { partials: opts.partials } : {}),
      ...(opts.now ? { now: opts.now } : {})
    })
  let handle = make(o)
  const log: string[] = []
  const fetchFn: Fetch = async (url, init) => {
    const path = new URL(url).pathname
    log.push(path)
    const r = await handle(init?.method ?? 'GET', path, init?.headers?.[PEER_HEADER] ?? null, init?.body ?? '')
    return { ok: r.status === 200, status: r.status, text: async () => r.body }
  }
  const peer: MacPeer = { id: 'mac-1234567890', name: 'Mac', key: toBase64(key), hosts: ['127.0.0.1'], port: 1 }
  return {
    fetchFn,
    peer,
    log,
    restart: (opts: MacOpts = o) => {
      handle = make(opts)
    },
    remote: (f: Fetch = fetchFn, opts: { features?: string[]; attempts?: number } = {}) =>
      httpRemote(f, '127.0.0.1', peer, PEER, random, { features: opts.features ?? ['progress', 'summary', 'chunks', 'expect'], retry: { ...fast, attempts: opts.attempts ?? 4 } })
  }
}

function blob(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    b[i] = x >>> 24
  }
  return b
}

const sync = (phone: Phone, remote: ReturnType<ReturnType<typeof macServer>['remote']>, state: MemState): Promise<SyncReport> =>
  runSync({ fs: phone, remote, state, remoteName: 'Mac', chunk })

async function converged(phone: Phone, mac: CiFs, s: ReturnType<typeof macServer>, state: MemState): Promise<void> {
  const r = await sync(phone, s.remote(), state)
  expect(hashes(await phone.list())).toEqual(hashes(await mac.list()))
  const again = await sync(phone, s.remote(), state)
  expect(again.pulled + again.pushed + again.deleted + again.moved + again.merged).toBe(0)
  void r
}

function vault(n: number, prefix = 'Work'): Record<string, string> {
  const o: Record<string, string> = {}
  for (let i = 0; i < n; i++) o[`${prefix}/n${i}.md`] = `# ${prefix} ${i}\n\nbody\n`
  return o
}

describe('fault injection', () => {
  test('app killed mid-transfer (no retries): next run converges, nothing lost or duplicated', async () => {
    const mac = new CiFs({ ...vault(400), 'assets/a.png': blob(300_000, 1) })
    const phone = new Phone({ 'Personal/mine.md': 'phone note\n' })
    const state = new MemState()
    const s = macServer(mac)
    let n = 0
    const dying: Fetch = async (url, init) => {
      if (++n === 3) throw new Error('Network request failed') // app frozen / killed
      return s.fetchFn(url, init)
    }
    await expect(sync(phone, s.remote(dying, { attempts: 1 }), state)).rejects.toThrow(/Network request failed/)
    expect(phone.files.size).toBeGreaterThan(1) // the first batch landed (and checkpointed)
    await converged(phone, mac, s, state)
    expect(mac.text('Personal/mine.md')).toBe('phone note\n')
    expect(mac.paths().length).toBe(402)
  })

  test('dropped replies are retried; replays are idempotent (same run converges)', async () => {
    const mac = new CiFs(vault(50))
    const phone = new Phone(vault(30, 'Phone'))
    const state = new MemState()
    const s = macServer(mac)
    let dropped = 0
    // The Mac does the work, but the reply never arrives — once per endpoint.
    const lossy: Fetch = async (url, init) => {
      const r = await s.fetchFn(url, init)
      const p = new URL(url).pathname
      if ((p === '/v1/apply' || p === '/v1/get') && dropped < 2 && !url.includes('#')) {
        dropped++
        throw new Error('socket hang up')
      }
      return r
    }
    const r = await sync(phone, s.remote(lossy), state)
    expect(dropped).toBe(2)
    expect(r.pulled).toBe(50)
    expect(r.pushed).toBe(30)
    expect(mac.paths().length).toBe(80)
    await converged(phone, mac, s, state)
  })

  test('damaged replies (bit flip) fail the seal and are retried', async () => {
    const mac = new CiFs(vault(20))
    const phone = new Phone()
    const state = new MemState()
    const s = macServer(mac)
    let flipped = 0
    const noisy: Fetch = async (url, init) => {
      const r = await s.fetchFn(url, init)
      if (new URL(url).pathname !== '/v1/get' || flipped++) return r
      const body = await r.text()
      const i = Math.floor(body.length / 2)
      const bad = body.slice(0, i) + (body[i] === 'A' ? 'B' : 'A') + body.slice(i + 1)
      return { ok: true, status: 200, text: async () => bad }
    }
    const rep = await sync(phone, s.remote(noisy), state)
    expect(rep.pulled).toBe(20)
    await converged(phone, mac, s, state)
  })

  test('bytes that disagree with the manifest are never written', async () => {
    const mac = new CiFs(vault(5))
    const phone = new Phone()
    const state = new MemState()
    const s = macServer(mac)
    const base = s.remote()
    const lying = { ...base, get: async (ps: string[]) => Object.fromEntries(Object.entries(await base.get(ps)).map(([p, d]) => [p, p.endsWith('n2.md') ? utf8Encode('garbage') : d])) }
    const r = await runSync({ fs: phone, remote: lying, state, remoteName: 'Mac' })
    expect(r.skipped).toBe(1)
    expect(phone.files.has('Work/n2.md')).toBe(false)
    await converged(phone, mac, s, state)
  })

  test('clock skew: within the window syncs; beyond it fails clearly (no retry storm), then recovers', async () => {
    const mac = new CiFs(vault(3))
    const phone = new Phone()
    const state = new MemState()
    let skew = 3 * 60_000
    const s = macServer(mac, { now: () => Date.now() + skew })
    expect((await sync(phone, s.remote(), state)).pulled).toBe(3)
    skew = 10 * 60_000
    const before = s.log.length
    const err = await sync(phone, s.remote(), state).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as Error).message).toMatch(/clocks are too far apart/)
    expect(s.log.length - before).toBe(1) // not retried
    skew = 0
    await converged(phone, mac, s, state)
  })

  test('duplicate requests: a replayed sealed body is refused, so nothing applies twice', async () => {
    const mac = new CiFs(vault(4))
    const phone = new Phone({ 'Phone/a.md': 'a\n' })
    const state = new MemState()
    const s = macServer(mac)
    const replays: number[] = []
    const doubled: Fetch = async (url, init) => {
      const r = await s.fetchFn(url, init)
      if (init?.method === 'POST') replays.push((await s.fetchFn(url, init)).status) // network duplicated the packet
      return r
    }
    await sync(phone, s.remote(doubled), state)
    expect(replays.length).toBeGreaterThan(0)
    expect(replays.every((st) => st === 401)).toBe(true)
    // App-level replay (fresh seal) of the same apply is idempotent.
    const remote = s.remote()
    const w = [{ path: 'Phone/b.md', data: utf8Encode('b\n'), hash: sha256(utf8Encode('b\n')), expect: null }]
    await remote.apply({ moves: [], writes: w, deletes: [] })
    await remote.apply({ moves: [], writes: w, deletes: [] })
    expect(mac.paths().filter((p) => p.startsWith('Phone/b')).length).toBe(1)
    await converged(phone, mac, s, state)
  })

  test('Mac restarts mid-sync: requests keep going against the new instance, run converges', async () => {
    const mac = new CiFs(vault(600))
    const phone = new Phone(vault(10, 'Phone'))
    const state = new MemState()
    const s = macServer(mac)
    let n = 0
    const restarting: Fetch = async (url, init) => {
      if (++n === 3) {
        s.restart()
        throw new Error('ECONNRESET') // the in-flight request dies with the old process
      }
      return s.fetchFn(url, init)
    }
    await sync(phone, s.remote(restarting), state)
    await converged(phone, mac, s, state)
    expect(mac.paths().length).toBe(610)
  })
})

describe('resumable big files', () => {
  test('download continues from the last chunk after the app is killed', async () => {
    const big = blob(CHUNK_SIZE * 6 + 1234, 7)
    const mac = new CiFs({ 'assets/video.m4a': big, 'Work/a.md': 'a\n' })
    const phone = new Phone()
    const state = new MemState()
    const s = macServer(mac)
    let chunks = 0
    const dying: Fetch = async (url, init) => {
      if (new URL(url).pathname === '/v1/chunk' && ++chunks === 4) throw new Error('Network request failed')
      return s.fetchFn(url, init)
    }
    await expect(sync(phone, s.remote(dying, { attempts: 1 }), state)).rejects.toThrow()
    expect(phone.files.has('assets/video.m4a')).toBe(false) // never a partial file in the vault
    expect(await phone.partial.size(sha256(big))).toBe(CHUNK_SIZE * 3)
    const before = s.log.filter((p) => p === '/v1/chunk').length
    const r = await sync(phone, s.remote(), state)
    expect(r.resumed).toBe(1)
    expect(s.log.filter((p) => p === '/v1/chunk').length - before).toBe(4) // 3 full + the tail, not 7
    expect(phone.files.get('assets/video.m4a')).toEqual(big)
    expect(await phone.partial.size(sha256(big))).toBe(0)
    await converged(phone, mac, s, state)
  })

  test('upload continues after a drop, even across a Mac restart (disk-backed partials)', async () => {
    const big = blob(CHUNK_SIZE * 5 + 99, 9)
    const mac = new CiFs({ 'Work/a.md': 'a\n' })
    const phone = new Phone({ 'assets/rec.m4a': big })
    const state = new MemState()
    const partials = memPartials() // stands in for the Mac's app-data dir
    const s = macServer(mac, { partials })
    let puts = 0
    const dying: Fetch = async (url, init) => {
      if (new URL(url).pathname === '/v1/put' && ++puts === 4) throw new Error('Network request failed')
      return s.fetchFn(url, init)
    }
    await expect(sync(phone, s.remote(dying, { attempts: 1 }), state)).rejects.toThrow()
    expect(mac.paths()).not.toContain('assets/rec.m4a') // nothing half-written in the vault
    s.restart({ partials })
    const before = s.log.filter((p) => p === '/v1/put').length
    const r = await sync(phone, s.remote(), state)
    expect(r.resumed).toBe(1)
    expect(s.log.filter((p) => p === '/v1/put').length - before).toBe(1 + 4) // status + remaining chunks
    expect(await mac.read('assets/rec.m4a')).toEqual(big)
    expect(partials.keys()).toEqual([])
    await converged(phone, mac, s, state)
  })

  test('older Mac (no chunks feature): big files still sync the old way', async () => {
    const big = blob(CHUNK_SIZE * 4, 3)
    const mac = new CiFs({ 'assets/x.bin': big })
    const phone = new Phone()
    const state = new MemState()
    const s = macServer(mac)
    await runSync({ fs: phone, remote: s.remote(s.fetchFn, { features: [] }), state, remoteName: 'Mac' })
    expect(s.log).not.toContain('/v1/chunk')
    expect(phone.files.get('assets/x.bin')).toEqual(big)
  })
})

describe('edits racing the sync', () => {
  test('a phone edit landing mid-sync is never overwritten by the pull', async () => {
    const mac = new CiFs({ 'Work/a.md': 'v1\n' })
    const phone = new Phone()
    const state = new MemState()
    const s = macServer(mac)
    await sync(phone, s.remote(), state)
    await mac.write('Work/a.md', utf8Encode('mac v2\n'))
    // The user types while the pull is in flight.
    const racing: Fetch = async (url, init) => {
      const r = await s.fetchFn(url, init)
      if (new URL(url).pathname === '/v1/get') await phone.edit('Work/a.md', 'phone v2\n')
      return r
    }
    const r = await sync(phone, s.remote(racing), state)
    expect(r.deferred).toBe(1)
    expect(phone.text('Work/a.md')).toBe('phone v2\n')
    // Next run sees both edits: merge or conflict copy, never a silent loss.
    await sync(phone, s.remote(), state)
    const all = [...phone.files.keys()].map((p) => phone.text(p)).join('|')
    expect(all).toContain('phone v2')
    expect(all).toContain('mac v2')
    await converged(phone, mac, s, state)
  })

  test('a Mac edit landing mid-sync is never clobbered by the push (expect check)', async () => {
    const mac = new CiFs({ 'Work/a.md': 'v1\n', 'Work/b.md': 'b\n' })
    const phone = new Phone()
    const state = new MemState()
    const s = macServer(mac)
    await sync(phone, s.remote(), state)
    await phone.edit('Work/a.md', 'phone v2\n')
    await phone.remove('Work/b.md')
    const racing: Fetch = async (url, init) => {
      if (new URL(url).pathname === '/v1/apply') {
        await mac.write('Work/a.md', utf8Encode('mac v2\n')) // edited on the Mac after the manifest
        await mac.write('Work/b.md', utf8Encode('b edited on mac\n'))
      }
      return s.fetchFn(url, init)
    }
    const r = await sync(phone, s.remote(racing), state)
    expect(r.deferred).toBe(2)
    expect(mac.text('Work/a.md')).toBe('mac v2\n')
    expect(mac.text('Work/b.md')).toBe('b edited on mac\n') // the delete didn't eat the edit
    await sync(phone, s.remote(), state)
    const all = mac.paths().map((p) => mac.text(p)).join('|')
    expect(all).toContain('phone v2')
    expect(all).toContain('mac v2')
    await converged(phone, mac, s, state)
  })

  test('two phones at once: applies are serialized, both converge', async () => {
    const mac = new CiFs(vault(20))
    const a = new Phone(vault(15, 'A'))
    const b = new Phone(vault(15, 'B'))
    const sa = new MemState()
    const sb = new MemState()
    const s = macServer(mac)
    await Promise.all([sync(a, s.remote(), sa), sync(b, s.remote(), sb)])
    await sync(a, s.remote(), sa)
    await sync(b, s.remote(), sb)
    expect(mac.paths().length).toBe(50)
    expect(hashes(await a.list())).toEqual(hashes(await mac.list()))
    expect(hashes(await b.list())).toEqual(hashes(await mac.list()))
  })
})

describe('retry policy', () => {
  test('backs off with jitter on transient errors, never on auth / handshake / bad request', async () => {
    const waits: number[] = []
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('timeout')
        },
        { attempts: 4, baseMs: 100, sleep: async (ms) => void waits.push(ms), random: () => 1 }
      )
    ).rejects.toThrow('timeout')
    expect(calls).toBe(4)
    expect(waits).toEqual([100, 200, 400])
    calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new HttpError(401, 'no')
        },
        { sleep: async () => undefined }
      )
    ).rejects.toThrow('no')
    expect(calls).toBe(1)
    let n = 0
    expect(await withRetry(async () => (++n < 3 ? Promise.reject(new HttpError(503, 'busy')) : 'ok'), { sleep: async () => undefined })).toBe('ok')
  })
})
