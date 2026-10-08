import { fromBase64, toBase64 } from './bytes'
import type { SyncFs } from './engine'
import { ignored } from './plan'
import {
  aad,
  openJson,
  PAIR_TTL_MS,
  PROTOCOL,
  safeRel,
  sealJson,
  SKEW_MS,
  type ApplyReq,
  type ApplyRes,
  type GetReq,
  type GetRes,
  type Hello,
  type ManifestRes,
  type PairReq,
  type PairRes,
  type Random
} from './protocol'

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
  getPeer(id: string): PeerRecord | null
  /** The QR currently on screen (one at a time). */
  pending(): PendingPair | null
  /** Called once a phone proves the pairing key. */
  addPeer(p: PeerRecord): void
  touchPeer(id: string, at: number): void
  /** Files changed by an apply (re-index, refresh UI). */
  changed(paths: string[]): void
  now?: () => number
}

export interface HttpResult {
  status: number
  body: string
  type: 'application/json' | 'text/plain'
}

const MAX_BODY = 64 * 1024 * 1024

export function createHandler(host: ServerHost): (method: string, path: string, peerId: string | null, body: string) => Promise<HttpResult> {
  const seen = new Map<string, number>() // nonce → ts (replay guard)
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

  return async (method, path, peerId, body) => {
    if (method === 'GET' && path === '/v1/hello') {
      const h: Hello = { app: 'inkfish', v: PROTOCOL, id: host.device.id, name: host.device.name }
      return { status: 200, body: JSON.stringify(h), type: 'application/json' }
    }
    if (method !== 'POST') return fail(405, 'method')
    if (!peerId || !/^[A-Za-z0-9_-]{8,64}$/.test(peerId)) return fail(400, 'peer')
    if (body.length > MAX_BODY) return fail(413, 'too large')

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
      host.addPeer({ id: peerId, name: String(req.name || 'Phone').slice(0, 60), key: toBase64(p.key), pairedAt: now() })
      const res: PairRes = { id: host.device.id, name: host.device.name }
      return ok(p.key, path, peerId, res)
    }

    const peer = host.getPeer(peerId)
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
      case '/v1/apply': {
        const r = req as ApplyReq
        const all = [...(r.moves ?? []).flatMap((m) => [m.from, m.to]), ...(r.writes ?? []).map((w) => w.path), ...(r.deletes ?? [])]
        if (all.some((p) => !safeRel(p) || ignored(p))) return fail(400, 'bad path')
        const changed: string[] = []
        for (const m of r.moves ?? []) {
          await host.fs.move(m.from, m.to)
          changed.push(m.from, m.to)
        }
        for (const w of r.writes ?? []) {
          await host.fs.write(w.path, fromBase64(w.data))
          changed.push(w.path)
        }
        for (const d of r.deletes ?? []) {
          await host.fs.remove(d)
          changed.push(d)
        }
        host.touchPeer(peerId, now())
        if (changed.length) host.changed(changed)
        return ok(key, path, peerId, { manifest: await host.fs.list() } satisfies ApplyRes)
      }
      case '/v1/done': {
        host.touchPeer(peerId, now())
        return ok(key, path, peerId, {})
      }
      default:
        return fail(404, 'not found')
    }
  }

  function ok(key: Uint8Array, path: string, peerId: string, res: unknown): HttpResult {
    return { status: 200, body: sealJson(key, res, aad('res', path, peerId), host.random, now()), type: 'text/plain' }
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

