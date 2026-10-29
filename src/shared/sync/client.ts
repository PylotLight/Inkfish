import { fromBase64, toBase64 } from './bytes'
import { decodeFiles, type Remote, type SyncProgress } from './engine'
import type { PeerRun } from './progress'
import type { Manifest } from './plan'
import {
  aad,
  openJson,
  PEER_HEADER,
  sealJson,
  type ApplyReq,
  type ApplyRes,
  type ChunkReq,
  type ChunkRes,
  type PutReq,
  type PutRes,
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
import {
  compat,
  INCOMPATIBLE_STATUS,
  outdatedApp,
  parseIncompatible,
  peerVersion,
  SELF_VERSION,
  SyncIncompatible,
  versionHeaders,
  type PeerVersion
} from './compat'

/** Phone side: talk to a paired Mac over HTTP. `fetch` is injected for tests. */

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{
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

export type DiscoveryPhase = 'qr-addresses' | 'subnet-scan'

export interface DiscoveryProbe {
  phase: DiscoveryPhase
  host: string
  outcome: 'found' | 'other-device' | 'http-error' | 'invalid-response' | 'network-error' | 'aborted'
  status?: number
  ms: number
  error?: string
}

export type DiscoveryUpdate =
  | { type: 'phase'; phase: DiscoveryPhase; total: number; subnets: string[] }
  | { type: 'probe'; probe: DiscoveryProbe }
  | { type: 'sweep-progress'; checked: number; total: number }

export type DiscoveryObserver = (update: DiscoveryUpdate) => void

function lanSubnetPrefix(host: string): string | null {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null
  const a = Number(parts[0]!)
  const b = Number(parts[1]!)
  const c = Number(parts[2]!)
  const privateLan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  return privateLan ? `${a}.${b}.${c}` : null
}

async function withTimeout<T>(ms: number, f: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const ac = new AbortController()
  const cancel = (): void => ac.abort()
  if (parent?.aborted) cancel()
  else parent?.addEventListener('abort', cancel, { once: true })
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await f(ac.signal)
  } finally {
    clearTimeout(t)
    parent?.removeEventListener('abort', cancel)
  }
}

export async function hello(
  fetchFn: Fetch,
  host: string,
  port: number,
  timeoutMs = 1500,
  signal?: AbortSignal
): Promise<Hello | null> {
  try {
    return await withTimeout(
      timeoutMs,
      async (requestSignal) => {
        const r = await fetchFn(`http://${host}:${port}/v1/hello`, { signal: requestSignal })
        return r.ok ? parseHello(await r.text()) : null
      },
      signal
    )
  } catch {
    return null
  }
}

async function probeHello(
  fetchFn: Fetch,
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
  phase: DiscoveryPhase
): Promise<{ hello: Hello | null; probe: DiscoveryProbe }> {
  const started = Date.now()
  try {
    const r = await withTimeout(
      timeoutMs,
      async (requestSignal) => {
        const response = await fetchFn(`http://${host}:${port}/v1/hello`, { signal: requestSignal })
        if (!response.ok) return { ok: false, status: response.status, hello: null }
        return { ok: true, status: response.status, hello: parseHello(await response.text()) }
      },
      signal
    )
    const outcome = !r.ok ? 'http-error' : r.hello ? 'found' : 'invalid-response'
    return {
      hello: r.hello,
      probe: { phase, host, outcome, ...(!r.ok ? { status: r.status } : {}), ms: Date.now() - started }
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const outcome = /abort/i.test(message) ? 'aborted' : 'network-error'
    return {
      hello: null,
      probe: { phase, host, outcome, ms: Date.now() - started, error: message.slice(0, 120) }
    }
  }
}

/** Probe known addresses together so one stale IP cannot delay a live one. */
async function findAmong(
  fetchFn: Fetch,
  hosts: string[],
  peer: Pick<MacPeer, 'id' | 'port'>,
  phase: DiscoveryPhase,
  onProgress?: DiscoveryObserver
): Promise<{ host: string; hello: Hello } | null> {
  if (!hosts.length) return null
  return new Promise((resolve) => {
    const ac = new AbortController()
    let remaining = hosts.length
    let settled = false
    for (const host of hosts) {
      void probeHello(fetchFn, host, peer.port, 1500, ac.signal, phase).then(({ hello: result, probe }) => {
        onProgress?.({
          type: 'probe',
          probe: { ...probe, ...(result && result.id !== peer.id ? { outcome: 'other-device' } : {}) }
        })
        if (settled) return
        if (result?.id === peer.id) {
          settled = true
          ac.abort()
          resolve({ host, hello: result })
          return
        }
        remaining--
        if (remaining === 0) {
          settled = true
          resolve(null)
        }
      })
    }
  })
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
export async function findMac(
  fetchFn: Fetch,
  peer: Pick<MacPeer, 'id' | 'hosts' | 'port' | 'lastHost'>,
  onProgress?: DiscoveryObserver
): Promise<string | null> {
  return (await findMacHello(fetchFn, peer, onProgress))?.host ?? null
}

/** findMac plus the Mac's hello (protocol / minPeer for the handshake). */
export async function findMacHello(
  fetchFn: Fetch,
  peer: Pick<MacPeer, 'id' | 'hosts' | 'port' | 'lastHost'>,
  onProgress?: DiscoveryObserver
): Promise<{ host: string; hello: Hello } | null> {
  const first = [...new Set([peer.lastHost, ...peer.hosts].filter((h): h is string => !!h))]
  onProgress?.({ type: 'phase', phase: 'qr-addresses', total: first.length, subnets: [] })
  const known = await findAmong(fetchFn, first, peer, 'qr-addresses', onProgress)
  if (known) return known
  // VPN-overlay addresses are probed directly. A guessed /24 sweep there is
  // unreliable (and can fan out across a routed VPN range), so only sweep
  // conventional private LAN subnets for DHCP address changes.
  const prefixes = [...new Set(first.map(lanSubnetPrefix).filter((p): p is string => p !== null))]
  const candidates = prefixes
    .flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`))
    .filter((h) => !first.includes(h))
  if (candidates.length)
    onProgress?.({ type: 'phase', phase: 'subnet-scan', total: candidates.length, subnets: prefixes })
  const ac = new AbortController()
  let found: { host: string; hello: Hello } | null = null
  let i = 0
  let checked = 0
  const worker = async (): Promise<void> => {
    while (!found && i < candidates.length) {
      const h = candidates[i++]!
      const { hello: r, probe } = await probeHello(fetchFn, h, peer.port, 900, ac.signal, 'subnet-scan')
      checked++
      if (r?.id !== peer.id) {
        if (r) probe.outcome = 'other-device'
        onProgress?.({ type: 'probe', probe })
      } else {
        probe.outcome = 'found'
        onProgress?.({ type: 'probe', probe })
      }
      if (checked % 32 === 0 || r?.id === peer.id || checked === candidates.length)
        onProgress?.({ type: 'sweep-progress', checked, total: candidates.length })
      if (r?.id === peer.id) {
        found = { host: h, hello: r }
        ac.abort()
      }
    }
  }
  await Promise.all(Array.from({ length: 32 }, worker))
  return found
}

/** An HTTP-level failure from the Mac (status kept, so retries can tell transient from final). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Worth another try: network trouble, timeouts, damaged replies, a busy / restarting Mac. Never auth, handshake or bad requests. */
export function retryable(err: unknown): boolean {
  if (err instanceof SyncIncompatible) return false
  if (err instanceof HttpError)
    return err.status >= 500 || err.status === 408 || err.status === 429 || err.status === 422
  return true
}

export interface RetryOpts {
  attempts?: number
  baseMs?: number
  maxMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

/** Exponential backoff with full jitter. Throws the last error once out of attempts, or right away if it isn't retryable. */
export async function withRetry<T>(f: () => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const attempts = o.attempts ?? 4
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const rnd = o.random ?? Math.random
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    if (o.signal?.aborted) throw last ?? new Error('cancelled')
    try {
      return await f()
    } catch (err) {
      last = err
      if (!retryable(err) || i === attempts - 1) throw err
      const cap = Math.min(o.maxMs ?? 4000, (o.baseMs ?? 300) * 2 ** i)
      await sleep(Math.round(cap * (0.5 + rnd() / 2)))
    }
  }
  throw last
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
    fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', [PEER_HEADER]: me, ...versionHeaders() },
      body: sealed,
      signal
    })
  )
  const text = await r.text()
  if (r.status === INCOMPATIBLE_STATUS) {
    const app = parseIncompatible(text)
    if (app) throw new SyncIncompatible(app, text.split(':').slice(2).join(':'))
  }
  if (!r.ok)
    throw new HttpError(
      r.status,
      r.status === 401
        ? /stale/.test(text)
          ? 'Phone and Mac clocks are too far apart (check date & time)'
          : 'This phone is no longer paired with the Mac'
        : `Mac said ${r.status}: ${text.slice(0, 80)}`
    )
  return openJson<Res>(key, text, aad('res', path, me)).body
}

/** Pair with a Mac from its QR. Returns the stored peer record. */
export async function pairWithMac(
  fetchFn: Fetch,
  qr: PairPayload,
  me: { id: string; name: string },
  random: Random,
  now = Date.now(),
  onStage?: (stage: string) => void,
  onDiscovery?: DiscoveryObserver
): Promise<MacPeer> {
  if (qr.exp < now) throw new Error('That code expired. Show a new one on the Mac.')
  let key: Uint8Array
  try {
    key = fromBase64(qr.key)
  } catch {
    throw new Error('This pairing code has an invalid key. Show a new code on the Mac.')
  }
  if (key.length !== 32) throw new Error('This pairing code has an invalid key. Show a new code on the Mac.')
  onStage?.('Looking for the Mac on this Wi-Fi…')
  const probes: DiscoveryProbe[] = []
  const found = await findMacHello(fetchFn, { id: qr.id, hosts: qr.hosts, port: qr.port }, (update) => {
    if (update.type === 'probe') probes.push(update.probe)
    onDiscovery?.(update)
  })
  if (!found) {
    const responder = probes.find(
      (p) => p.outcome === 'other-device' || p.outcome === 'http-error' || p.outcome === 'invalid-response'
    )
    if (responder) {
      throw new Error(
        `A device responded at ${responder.host}:${qr.port}, but it did not identify as this Mac (${responder.outcome}${responder.status ? `, HTTP ${responder.status}` : ''}). Show a fresh QR code and check for a VPN or proxy intercepting local HTTP.`
      )
    }
    const attempted = [...new Set(probes.filter((p) => p.phase === 'qr-addresses').map((p) => p.host))]
    const addressList = attempted.length ? attempted.slice(0, 4).join(', ') : 'no usable QR addresses'
    const more = attempted.length > 4 ? ` and ${attempted.length - 4} more` : ''
    throw new Error(
      `No reply from this Mac at ${addressList}${more} on port ${qr.port}. Check the same non-guest network, then try with VPN/proxy off and allow Inkfish through the Mac firewall. See scan details for the addresses tried.`
    )
  }
  assertCompatible(found.hello)
  onStage?.('Mac found. Completing secure pairing…')
  const host = found.host
  const res = await call<{ name: string }, PairRes>(
    fetchFn,
    `http://${host}:${qr.port}`,
    '/v1/pair',
    me.id,
    key,
    { name: me.name },
    random
  )
  return { id: res.id, name: res.name, key: qr.key, hosts: qr.hosts, port: qr.port, lastHost: host }
}

export interface RemoteOpts {
  /** Hello.features of this Mac — turns on chunked transfers when it has `chunks`. */
  features?: readonly string[]
  /** Per-request retry (backoff + jitter). Pass `{ attempts: 1 }` to turn it off. */
  retry?: RetryOpts
}

/**
 * The Mac as a Remote. Every request retries on transient failures (all of
 * them are safe to replay: reads are reads, applies are idempotent — same
 * bytes to the same path, moves/deletes of something already moved/deleted
 * are no-ops — and each attempt is freshly sealed, so the replay guard is
 * happy).
 */
export function httpRemote(
  fetchFn: Fetch,
  host: string,
  peer: MacPeer,
  me: string,
  random: Random,
  opts: RemoteOpts = {}
): Remote {
  const base = `http://${host}:${peer.port}`
  const key = fromBase64(peer.key)
  const r = <T>(f: () => Promise<T>): Promise<T> => withRetry(f, opts.retry)
  const remote: Remote = {
    manifest: () =>
      r(async () => (await call<object, ManifestRes>(fetchFn, base, '/v1/manifest', me, key, {}, random)).manifest),
    get: (paths) =>
      r(async () =>
        decodeFiles(
          (await call<{ paths: string[] }, GetRes>(fetchFn, base, '/v1/get', me, key, { paths }, random)).files
        )
      ),
    apply: (req): Promise<Manifest> =>
      r(async () => {
        const writes = req.writes.map((w) => ({
          path: w.path,
          data: toBase64(w.data),
          ...(w.hash ? { hash: w.hash } : {}),
          ...(w.expect !== undefined ? { expect: w.expect } : {})
        }))
        const body: ApplyReq = {
          moves: req.moves,
          writes,
          deletes: req.deletes,
          ...(req.deleteExpect ? { deleteExpect: req.deleteExpect } : {})
        }
        return (await call<ApplyReq, ApplyRes>(fetchFn, base, '/v1/apply', me, key, body, random, 120_000)).manifest
      })
  }
  if (opts.features?.includes('chunks')) {
    remote.chunk = (path, offset, length) =>
      r(async () => {
        const c = await call<ChunkReq, ChunkRes>(fetchFn, base, '/v1/chunk', me, key, { path, offset, length }, random)
        return c.size < 0 ? null : { data: fromBase64(c.data), size: c.size }
      })
    remote.put = (q) =>
      r(async () =>
        call<PutReq, PutRes>(
          fetchFn,
          base,
          '/v1/put',
          me,
          key,
          {
            path: q.path,
            hash: q.hash,
            size: q.size,
            offset: q.offset,
            ...(q.data ? { data: toBase64(q.data) } : {}),
            ...(q.expect !== undefined ? { expect: q.expect } : {})
          },
          random
        )
      )
  }
  return remote
}

/** End the session. `summary` (a PeerRun) shows in the Mac's sync history; older Macs ignore it. */
export async function markDone(
  fetchFn: Fetch,
  host: string,
  peer: MacPeer,
  me: string,
  random: Random,
  summary?: PeerRun
): Promise<void> {
  await call<DoneReq, object>(
    fetchFn,
    `http://${host}:${peer.port}`,
    '/v1/done',
    me,
    fromBase64(peer.key),
    summary ? { summary } : {},
    random
  )
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
    inFlight = call<ProgressReq, object>(
      fetchFn,
      `http://${host}:${peer.port}`,
      '/v1/progress',
      me,
      fromBase64(peer.key),
      { progress: { ...p, sentAt: clock() } },
      random,
      5000
    )
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
