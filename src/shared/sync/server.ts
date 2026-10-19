import { fromBase64, toBase64 } from './bytes'
import type { SyncFs } from './engine'
import { ignored } from './plan'
import {
  aad,
  openJson,
  PAIR_TTL_MS,
  safeRel,
  sealJson,
  SKEW_MS,
  type ApplyReq,
  type ApplyRes,
  type ChunkReq,
  type ChunkRes,
  type PutReq,
  type PutRes,
  MAX_CHUNK,
  type DoneReq,
  type ProgressReq,
  FEATURES,
  type GetReq,
  type GetRes,
  type Hello,
  type ManifestRes,
  type PairReq,
  type PairRes,
  type Random
} from './protocol'
import { cleanProgress, cleanRun, type LiveProgress, type PeerRun } from './progress'
import { sha256 } from './hash'
import type { PartialStore } from './engine'
import { compat, incompatibleBody, INCOMPATIBLE_STATUS, outdatedApp, peerVersion, SELF_VERSION, type PeerVersion } from './compat'

/**
 * The Mac side of the protocol, transport-agnostic: feed it a method, path,
 * peer header and body text; it returns status + body. `src/main/sync` wraps
 * it in node:http. Also used in-process by the tests.
 */

export interface PeerRecord {
  id: string
  name: string
  /** base64 32-byte key */
  key: string
  pairedAt: number
  lastSync?: number
}

export interface PendingPair {
  key: Uint8Array
  exp: number
}

export interface ServerHost {
  device: { id: string; name: string }
  fs: SyncFs
  random: Random
  getPeer(id: string): Promise<PeerRecord | null>
  /** The QR currently on screen (one at a time). */
  pending(): PendingPair | null
  /** Called once a phone proves the pairing key. */
  addPeer(p: PeerRecord): Promise<void>
  touchPeer(id: string, at: number): void
  /** Files changed by an apply (re-index, refresh UI). */
  changed(paths: string[], peerId?: string): void
  /** Optional sink for apply problems (sync log). Never throws. */
  note?: (msg: string) => void
  now?: () => number
  /** Override the advertised protocol / minPeer (tests). Defaults to this build's. */
  version?: PeerVersion
  /** Live progress a phone posted (`/v1/progress`). Already sanitized. */
  progress?: (peerId: string, p: LiveProgress) => void
  /** A phone finished a session and said how it went (`/v1/done` summary). Already sanitized. */
  finished?: (peerId: string, run: PeerRun) => void
  /** Where resumable uploads accumulate (feature `chunks`). Defaults to memory (lost on restart). */
  partials?: PartialStore
  /** Optional range read (big files) — falls back to read + slice. */
  readRange?: (path: string, offset: number, length: number) => Promise<{ data: Uint8Array; size: number }>
}

export interface HttpResult {
  status: number
  body: string
  type: 'application/json' | 'text/plain'
}

const MAX_BODY = 64 * 1024 * 1024

/** What the phone said about itself (the x-inkfish-protocol / x-inkfish-min-peer headers). Absent on older phones. */
export interface PeerMeta {
  protocol?: unknown
  minPeer?: unknown
}

export function createHandler(
  host: ServerHost
): (method: string, path: string, peerId: string | null, body: string, meta?: PeerMeta) => Promise<HttpResult> {
  const seen = new Map<string, number>() // nonce → ts (replay guard)
  // One writer at a time: two phones (or a phone's retry racing its original) never interleave applies.
  let lock: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(f: () => Promise<T>): Promise<T> => {
    const run = lock.then(f, f)
    lock = run.catch(() => undefined)
    return run
  }
  const partials: PartialStore = host.partials ?? memPartials()
  const currentHash = async (p: string): Promise<string | null> => {
    try {
      return sha256(await host.fs.read(p))
    } catch {
      return null
    }
  }
  const now = (): number => host.now?.() ?? Date.now()
  const fail = (status: number, msg: string): HttpResult => ({ status, body: msg, type: 'text/plain' })

  const fresh = (nonce: string, ts: number): boolean => {
    const t = now()
    if (Math.abs(t - ts) > SKEW_MS) return false
    for (const [n, at] of seen) if (t - at > 2 * SKEW_MS) seen.delete(n)
    if (seen.has(nonce)) return false
    seen.set(nonce, t)
    return true
  }

  return async (method, path, peerId, body, meta) => {
    if (method === 'GET' && path === '/v1/hello') {
      const self = host.version ?? SELF_VERSION
      const h: Hello = {
        app: 'inkfish',
        v: self.protocol,
        id: host.device.id,
        name: host.device.name,
        protocol: self.protocol,
        minPeer: self.minPeer,
        features: [...FEATURES]
      }
      return { status: 200, body: JSON.stringify(h), type: 'application/json' }
    }
    if (method !== 'POST') return fail(405, 'method')
    if (!peerId || !/^[A-Za-z0-9_-]{8,64}$/.test(peerId)) return fail(400, 'peer')
    if (body.length > MAX_BODY) return fail(413, 'too large')

    // Handshake: refuse (loudly) a phone we can't talk to, or one that needs a newer Mac.
    const theirs: PeerVersion = peerVersion(meta)
    const self = host.version ?? SELF_VERSION
    const app = outdatedApp('mac', compat(self, theirs))
    if (app) return fail(INCOMPATIBLE_STATUS, incompatibleBody(app, self, theirs))

    // Pairing: sealed with the key from the QR on screen.
    if (path === '/v1/pair') {
      const p = host.pending()
      if (!p || p.exp < now()) return fail(403, 'no pairing in progress')
      let req: PairReq
      try {
        const o = openJson<PairReq>(p.key, body, aad('req', path, peerId))
        if (!fresh(o.nonce, o.ts)) return fail(401, 'stale')
        req = o.body
      } catch {
        return fail(401, 'bad pairing key')
      }
      await host.addPeer({ id: peerId, name: String(req.name || 'Phone').slice(0, 60), key: toBase64(p.key), pairedAt: now() })
      const res: PairRes = { id: host.device.id, name: host.device.name }
      return ok(p.key, path, peerId, res)
    }

    const peer = await host.getPeer(peerId)
    if (!peer) return fail(401, 'unknown peer')
    const key = fromBase64(peer.key)
    let req: unknown
    try {
      const o = openJson<unknown>(key, body, aad('req', path, peerId))
      if (!fresh(o.nonce, o.ts)) return fail(401, 'stale')
      req = o.body
    } catch {
      return fail(401, 'bad seal')
    }

    switch (path) {
      case '/v1/manifest': {
        const res: ManifestRes = { manifest: await host.fs.list() }
        return ok(key, path, peerId, res)
      }
      case '/v1/get': {
        const { paths } = req as GetReq
        const files: GetRes['files'] = {}
        for (const p of Array.isArray(paths) ? paths : []) {
          if (!safeRel(p) || ignored(p)) continue
          try {
            files[p] = toBase64(await host.fs.read(p))
          } catch {
            // missing now — client re-plans next run
          }
        }
        return ok(key, path, peerId, { files } satisfies GetRes)
      }
      case '/v1/chunk': {
        const { path: p, offset, length } = (req ?? {}) as ChunkReq
        if (typeof p !== 'string' || !safeRel(p) || ignored(p)) return fail(400, 'bad path')
        const off = Math.max(0, Math.floor(Number(offset) || 0))
        const len = Math.max(0, Math.min(MAX_CHUNK, Math.floor(Number(length) || 0)))
        try {
          const r = host.readRange
            ? await host.readRange(p, off, len)
            : await host.fs.read(p).then((all) => ({ data: all.subarray(off, off + len), size: all.length }))
          return ok(key, path, peerId, { data: toBase64(r.data), size: r.size } satisfies ChunkRes)
        } catch {
          return ok(key, path, peerId, { data: '', size: -1 } satisfies ChunkRes)
        }
      }
      case '/v1/put': {
        const r = (req ?? {}) as PutReq
        if (typeof r.path !== 'string' || !safeRel(r.path) || ignored(r.path)) return fail(400, 'bad path')
        if (typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash) || !(r.size >= 0) || r.size > 512 * 1024 * 1024) return fail(400, 'bad put')
        return exclusive(async () => {
          const pk = sha256(`${peerId}\0${r.path}\0${r.hash}`).slice(0, 40)
          let have = await partials.size(pk).catch(() => 0)
          if (r.offset === -1 || r.offset !== have || !r.data) {
            // Already there (a finished put whose reply got lost)? Say so.
            if (have === 0 && (await currentHash(r.path)) === r.hash) return ok(key, path, peerId, { have: r.size, done: true } satisfies PutRes)
            return ok(key, path, peerId, { have, done: false } satisfies PutRes)
          }
          const bytes = fromBase64(r.data)
          if (bytes.length > MAX_CHUNK || have + bytes.length > r.size) return fail(400, 'bad chunk')
          await partials.append(pk, bytes)
          have += bytes.length
          if (have < r.size) return ok(key, path, peerId, { have, done: false } satisfies PutRes)
          const all = await partials.read(pk)
          await partials.drop(pk)
          if (sha256(all) !== r.hash) return fail(422, 'upload damaged — starting over')
          if (r.expect !== undefined) {
            const cur = await currentHash(r.path)
            if (cur !== r.expect && cur !== r.hash) return ok(key, path, peerId, { have, done: true, deferred: true } satisfies PutRes)
          }
          await host.fs.write(r.path, all)
          host.touchPeer(peerId, now())
          host.changed([r.path], peerId)
          return ok(key, path, peerId, { have, done: true } satisfies PutRes)
        })
      }
      case '/v1/apply': {
        return exclusive(() => apply(req as ApplyReq, key, path, peerId))
      }
      case '/v1/progress': {
        const lp = cleanProgress((req as ProgressReq | null)?.progress, now())
        if (lp) {
          try {
            host.progress?.(peerId, lp)
          } catch {
            // display only
          }
        }
        return ok(key, path, peerId, {})
      }
      case '/v1/done': {
        host.touchPeer(peerId, now())
        const run = cleanRun((req as DoneReq | null)?.summary, now())
        if (run) {
          try {
            host.finished?.(peerId, run)
          } catch {
            // display only
          }
        }
        return ok(key, path, peerId, {})
      }
      default:
        return fail(404, 'not found')
    }
  }

  async function apply(r: ApplyReq, key: Uint8Array, path: string, peerId: string): Promise<HttpResult> {
    const all = [...(r.moves ?? []).flatMap((m) => [m.from, m.to]), ...(r.writes ?? []).map((w) => w.path), ...(r.deletes ?? [])]
    if (all.some((p) => typeof p !== 'string' || !safeRel(p) || ignored(p))) return fail(400, 'bad path')
    // Per-op errors must not abort the rest — apply what's possible and
    // report the failures so the client logs them and retries next run.
    const changed: string[] = []
    const errors: string[] = []
    const deferred: string[] = []
    const failOne = (what: string, err: unknown): void => {
      errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
    }
    for (const m of r.moves ?? []) {
      try {
        await host.fs.move(m.from, m.to)
        changed.push(m.from, m.to)
      } catch (err) {
        failOne(`${m.from} → ${m.to}`, err)
      }
    }
    for (const w of r.writes ?? []) {
      try {
        const bytes = fromBase64(w.data)
        if (typeof w.hash === 'string' && sha256(bytes) !== w.hash) throw new Error('content hash mismatch')
        if (w.expect !== undefined) {
          const cur = await currentHash(w.path)
          // Changed here since the phone planned (and not already this content): leave it for the next run's merge.
          if (cur !== w.expect && cur !== (w.hash ?? sha256(bytes))) {
            deferred.push(w.path)
            continue
          }
        }
        await host.fs.write(w.path, bytes)
        changed.push(w.path)
      } catch (err) {
        failOne(w.path, err)
      }
    }
    for (const d of r.deletes ?? []) {
      try {
        const want = r.deleteExpect?.[d]
        if (want !== undefined) {
          const cur = await currentHash(d)
          if (cur === null) continue // already gone
          if (cur !== want) {
            deferred.push(d) // edited here meanwhile: the edit wins
            continue
          }
        }
        await host.fs.remove(d)
        changed.push(d)
      } catch (err) {
        failOne(d, err)
      }
    }
    host.touchPeer(peerId, now())
    if (changed.length) host.changed(changed, peerId)
    if (errors.length) {
      try {
        host.note?.(`apply from ${peerId}: ${errors.length} failed — ${errors[0]}`)
      } catch {
        // logging never breaks sync
      }
      return fail(500, `apply: ${errors.length} op(s) failed — ${errors[0]}`)
    }
    return ok(key, path, peerId, { manifest: await host.fs.list(), ...(deferred.length ? { deferred } : {}) } satisfies ApplyRes)
  }

  function ok(key: Uint8Array, path: string, peerId: string, res: unknown): HttpResult {
    return { status: 200, body: sealJson(key, res, aad('res', path, peerId), host.random, now()), type: 'text/plain' }
  }
}

/** In-memory partial uploads (tests, or a host without disk-backed ones). */
export function memPartials(): PartialStore & { keys(): string[] } {
  const m = new Map<string, Uint8Array[]>()
  return {
    size: async (k) => (m.get(k) ?? []).reduce((n, b) => n + b.length, 0),
    append: async (k, d) => {
      const a = m.get(k) ?? []
      a.push(new Uint8Array(d))
      m.set(k, a)
    },
    read: async (k) => {
      const a = m.get(k) ?? []
      const out = new Uint8Array(a.reduce((n, b) => n + b.length, 0))
      let o = 0
      for (const b of a) {
        out.set(b, o)
        o += b.length
      }
      return out
    },
    drop: async (k) => {
      m.delete(k)
    },
    keys: () => [...m.keys()]
  }
}

/** Parse the plain JSON `/v1/hello` body. */
export function parseHello(text: string): Hello | null {
  try {
    const h = JSON.parse(text) as Hello
    return h.app === 'inkfish' && typeof h.id === 'string' ? h : null
  } catch {
    return null
  }
}

