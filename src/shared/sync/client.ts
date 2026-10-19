import { fromBase64 } from './bytes'
import { decodeFiles, encodeFiles, type Remote, type SyncProgress } from './engine'
import type { PeerRun } from './progress'
import type { Manifest } from './plan'
import {
  aad,
  openJson,
  PEER_HEADER,
  sealJson,
  type ApplyRes,
  type DoneReq,
  type ProgressReq,
  type GetRes,
  type Hello,
  type ManifestRes,
  type PairPayload,
  type PairRes,
  type Random
} from './protocol'
import { parseHello } from './server'
import { compat, INCOMPATIBLE_STATUS, outdatedApp, parseIncompatible, peerVersion, SELF_VERSION, SyncIncompatible, versionHeaders, type PeerVersion } from './compat'

/** Phone side: talk to a paired Mac over HTTP. `fetch` is injected for tests. */

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface MacPeer {
  /** Mac device id */
  id: string
  name: string
  /** base64 32-byte key shared with this Mac */
  key: string
  hosts: string[]
  port: number
  /** host that answered last time */
  lastHost?: string
  lastSync?: number
}

async function withTimeout<T>(ms: number, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await f(ac.signal)
  } finally {
    clearTimeout(t)
  }
}

export async function hello(fetchFn: Fetch, host: string, port: number, timeoutMs = 1500): Promise<Hello | null> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const r = await fetchFn(`http://${host}:${port}/v1/hello`, { signal })
      return r.ok ? parseHello(await r.text()) : null
    })
  } catch {
    return null
  }
}

/** Throws SyncIncompatible when this phone and the Mac that sent `h` can't sync. Older Macs (no fields) count as protocol 1. */
export function assertCompatible(h: Hello, self: PeerVersion = SELF_VERSION): void {
  const theirs = peerVersion(h)
  const app = outdatedApp('phone', compat(self, theirs))
  if (app) throw new SyncIncompatible(app, `Mac v${theirs.protocol}, phone v${self.protocol}`)
}

/**
 * Find the paired Mac on this network: last good host, then the QR's
 * addresses, then a sweep of those /24 subnets (DHCP may have moved it).
 */
export async function findMac(fetchFn: Fetch, peer: Pick<MacPeer, 'id' | 'hosts' | 'port' | 'lastHost'>): Promise<string | null> {
  return (await findMacHello(fetchFn, peer))?.host ?? null
}

/** findMac plus the Mac's hello (protocol / minPeer for the handshake). */
export async function findMacHello(
  fetchFn: Fetch,
  peer: Pick<MacPeer, 'id' | 'hosts' | 'port' | 'lastHost'>
): Promise<{ host: string; hello: Hello } | null> {
  const first = [...new Set([peer.lastHost, ...peer.hosts].filter((h): h is string => !!h))]
  for (const h of first) {
    const r = await hello(fetchFn, h, peer.port)
    if (r?.id === peer.id) return { host: h, hello: r }
  }
  const prefixes = [...new Set(first.map((h) => h.split('.').slice(0, 3).join('.')).filter((p) => /^\d+\.\d+\.\d+$/.test(p)))]
  const candidates = prefixes.flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`)).filter((h) => !first.includes(h))
  let found: { host: string; hello: Hello } | null = null
  let i = 0
  const worker = async (): Promise<void> => {
    while (!found && i < candidates.length) {
      const h = candidates[i++]!
      const r = await hello(fetchFn, h, peer.port, 900)
      if (r?.id === peer.id) found = { host: h, hello: r }
    }
  }
  await Promise.all(Array.from({ length: 32 }, worker))
  return found
}

async function call<Req, Res>(
  fetchFn: Fetch,
  base: string,
  path: string,
  me: string,
  key: Uint8Array,
  body: Req,
  random: Random,
  timeoutMs = 60_000
): Promise<Res> {
  const sealed = sealJson(key, body, aad('req', path, me), random)
  const r = await withTimeout(timeoutMs, (signal) =>
    fetchFn(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'text/plain', [PEER_HEADER]: me, ...versionHeaders() }, body: sealed, signal })
  )
  const text = await r.text()
  if (r.status === INCOMPATIBLE_STATUS) {
    const app = parseIncompatible(text)
    if (app) throw new SyncIncompatible(app, text.split(':').slice(2).join(':'))
  }
  if (!r.ok) throw new Error(r.status === 401 ? 'This phone is no longer paired with the Mac' : `Mac said ${r.status}: ${text.slice(0, 80)}`)
  return openJson<Res>(key, text, aad('res', path, me)).body
}

/** Pair with a Mac from its QR. Returns the stored peer record. */
export async function pairWithMac(fetchFn: Fetch, qr: PairPayload, me: { id: string; name: string }, random: Random, now = Date.now()): Promise<MacPeer> {
  if (qr.exp < now) throw new Error('That code expired. Show a new one on the Mac.')
  const found = await findMacHello(fetchFn, { id: qr.id, hosts: qr.hosts, port: qr.port })
  if (!found) throw new Error("Can't reach the Mac. Make sure both are on the same Wi-Fi.")
  assertCompatible(found.hello)
  const host = found.host
  const key = fromBase64(qr.key)
  const res = await call<{ name: string }, PairRes>(fetchFn, `http://${host}:${qr.port}`, '/v1/pair', me.id, key, { name: me.name }, random)
  return { id: res.id, name: res.name, key: qr.key, hosts: qr.hosts, port: qr.port, lastHost: host }
}

export function httpRemote(fetchFn: Fetch, host: string, peer: MacPeer, me: string, random: Random): Remote {
  const base = `http://${host}:${peer.port}`
  const key = fromBase64(peer.key)
  return {
    manifest: async () => (await call<object, ManifestRes>(fetchFn, base, '/v1/manifest', me, key, {}, random)).manifest,
    get: async (paths) => decodeFiles((await call<{ paths: string[] }, GetRes>(fetchFn, base, '/v1/get', me, key, { paths }, random)).files),
    apply: async (req): Promise<Manifest> =>
      (
        await call<object, ApplyRes>(fetchFn, base, '/v1/apply', me, key, { moves: req.moves, writes: encodeFiles(req.writes), deletes: req.deletes }, random, 120_000)
      ).manifest
  }
}

/** End the session. `summary` (a PeerRun) shows in the Mac's sync history; older Macs ignore it. */
export async function markDone(fetchFn: Fetch, host: string, peer: MacPeer, me: string, random: Random, summary?: PeerRun): Promise<void> {
  await call<DoneReq, object>(fetchFn, `http://${host}:${peer.port}`, '/v1/done', me, fromBase64(peer.key), summary ? { summary } : {}, random)
}

/** Does this Mac take live progress (Hello.features)? */
export function supportsProgress(h: Hello | null | undefined): boolean {
  return Array.isArray(h?.features) && h.features.includes('progress')
}

/**
 * Phone → Mac live progress, throttled and fire-and-forget: at most one
 * request in flight and one every `everyMs`; the newest value wins, and the
 * last one is always sent. Errors are swallowed (display only).
 */
export function progressPoster(
  fetchFn: Fetch,
  host: string,
  peer: MacPeer,
  me: string,
  random: Random,
  everyMs = 1000,
  clock: () => number = Date.now
): { post: (p: SyncProgress) => void; flush: () => Promise<void> } {
  let latest: SyncProgress | null = null
  let inFlight: Promise<void> | null = null
  let lastSent = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let dead = false
  const send = (): void => {
    timer = null
    if (!latest || inFlight || dead) return
    const p = latest
    latest = null
    lastSent = clock()
    inFlight = call<ProgressReq, object>(fetchFn, `http://${host}:${peer.port}`, '/v1/progress', me, fromBase64(peer.key), { progress: { ...p, sentAt: clock() } }, random, 5000)
      .then(() => undefined)
      .catch(() => {
        dead = true // older Mac / gone: stop trying this session
      })
      .finally(() => {
        inFlight = null
        if (latest) schedule()
      })
  }
  const schedule = (): void => {
    if (timer || dead) return
    timer = setTimeout(send, Math.max(0, everyMs - (clock() - lastSent)))
  }
  return {
    post: (p) => {
      latest = p
      schedule()
    },
    flush: async () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (inFlight) await inFlight
      if (latest) send()
      if (inFlight) await inFlight
    }
  }
}
