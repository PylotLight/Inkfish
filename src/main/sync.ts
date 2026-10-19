import { BrowserWindow, safeStorage } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import QRCode from 'qrcode'
import {
  createHandler,
  encodePairUri,
  ignored,
  appendCollapsed,
  PAIR_TTL_MS,
  PEER_HEADER,
  PROTOCOL_HEADER,
  MIN_PEER_HEADER,
  INCOMPATIBLE_STATUS,
  parseIncompatible,
  safeRel,
  toBase64,
  type Entry,
  type Manifest,
  type PendingPair,
  type SyncFs,
  type SyncLogEntry
} from '../shared/sync'
import { indexFile } from './db'
import { migratePeers, openPeer, sealPeer, type StoredPeer } from './peer-keys'
import { profile } from './profile'
import { setTrayTooltip } from './tray'
import { badgeChanged, deriveSyncBadge, emptyActivity, trayTooltip, type PeerActivity, type SyncBadge } from '../shared/sync-badge'
import { appDataDir, isStagingRel, mergeCaseDuplicates, resolveNoteAbs, trashPath, vaultConfigured, vaultPaths } from './vault'

/**
 * Mac side of LAN sync: an HTTP listener on the local network that only
 * paired phones can use (every body is sealed with that phone's key — see
 * src/shared/sync/protocol.ts). The phone drives each sync; this side serves
 * the manifest and applies changes atomically, then re-indexes.
 */

export interface SyncPeerInfo {
  id: string
  name: string
  pairedAt: number
  lastSync: number | null
}

export interface SyncStatus {
  running: boolean
  error: string | null
  deviceName: string
  hosts: string[]
  port: number
  peers: SyncPeerInfo[]
  pairing: { svg: string; uri: string; exp: number } | null
  /** Live badge (sidebar footer + tray tooltip). */
  badge: SyncBadge
}

interface Stored {
  deviceId: string
  deviceName: string
  port: number
  /** key field holds safeStorage-encrypted base64 when `enc` is true */
  peers: StoredPeer[]
}

let server: Server | null = null
let listenError: string | null = null
let pending: PendingPair | null = null
let pendingQr: { svg: string; uri: string; exp: number } | null = null
let store: Stored | null = null

function storePath(): string | null {
  const d = appDataDir()
  return d ? join(d, 'sync.json') : null
}

function load(): Stored {
  if (store) return store
  const p = storePath()
  let s: Partial<Stored> = {}
  try {
    if (p && existsSync(p)) s = JSON.parse(readFileSync(p, 'utf8')) as Partial<Stored>
  } catch {
    s = {}
  }
  store = {
    deviceId: s.deviceId ?? `mac-${randomBytes(9).toString('base64url')}`,
    deviceName: s.deviceName ?? defaultDeviceName(),
    // Dev / custom profiles prefer DEFAULT_PORT + 1 so they never take the release app's :47821.
    port: s.port ?? profile.syncPort,
    peers: s.peers ?? []
  }
  if (!s.deviceId) save()
  return store
}

function defaultDeviceName(): string {
  const host = hostname().replace(/\.local$/, '') || 'Mac'
  return profile.badge ? `${host} (${profile.name})` : host
}

function save(): void {
  const p = storePath()
  if (!p || !store) return
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}

let migrated = false
/** Once per launch: re-seal any stored peer keys the async safeStorage flags for re-encryption. */
function migratePeerKeys(): void {
  if (migrated) return
  migrated = true
  void migratePeers(safeStorage, load().peers, save).catch((err: unknown) => {
    console.warn('[sync] peer key migration failed', err instanceof Error ? err.message : String(err))
  })
}

function hosts(): string[] {
  const out: string[] = []
  const ifs = networkInterfaces()
  // en0 (Wi-Fi) first on macOS.
  for (const name of Object.keys(ifs).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : a.localeCompare(b)))) {
    for (const a of ifs[name] ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address)
    }
  }
  return out
}

function broadcastChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('inkfish:vault-changed')
}
function broadcastStatus(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync:status-changed')
  scheduleBadge()
}

// --- live badge -----------------------------------------------------------------
// Event-driven: every request from a paired phone (and pair/unpair/listen
// changes) schedules one throttled recompute; the only timer is a single
// one-shot at the next moment the derived state flips on its own (session
// idle, online window expiring). No polling.

const activity = new Map<string, PeerActivity>()
let lastBadge: SyncBadge | null = null
let badgeTimer: ReturnType<typeof setTimeout> | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
const BADGE_THROTTLE_MS = 250

function actFor(id: string): PeerActivity {
  let a = activity.get(id)
  if (!a) {
    a = emptyActivity()
    activity.set(id, a)
  }
  return a
}

function currentBadge(now = Date.now()): SyncBadge {
  const s = load()
  return deriveSyncBadge(
    {
      running: !!server,
      error: listenError,
      peers: s.peers.map((p) => ({ id: p.id, name: p.name, lastSync: p.lastSync ?? null, activity: activity.get(p.id) ?? null }))
    },
    now
  )
}

function scheduleBadge(): void {
  if (badgeTimer) return
  badgeTimer = setTimeout(() => {
    badgeTimer = null
    publishBadge()
  }, BADGE_THROTTLE_MS)
  badgeTimer.unref?.()
}

function publishBadge(): void {
  const b = currentBadge()
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = null
  if (b.nextChangeAt !== null) {
    expiryTimer = setTimeout(scheduleBadge, Math.max(250, b.nextChangeAt - Date.now() + 50))
    expiryTimer.unref?.()
  }
  setTrayTooltip(trayTooltip(profile.name, b))
  if (!badgeChanged(lastBadge, b)) return
  lastBadge = b
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync:badge', b)
}

export function syncBadge(): SyncBadge {
  return currentBadge()
}

const SESSION_PATHS = new Set(['/v1/manifest', '/v1/get', '/v1/apply'])

/** Track a request from a paired phone around the handler. Returns the "after" hook. */
function trackRequest(peerId: string | null, path: string): (status: number, body: string) => void {
  if (!peerId || !load().peers.some((p) => p.id === peerId)) return () => undefined
  const a = actFor(peerId)
  a.inFlight++
  if (SESSION_PATHS.has(path) && a.sessionSince === null) a.sessionSince = Date.now()
  scheduleBadge()
  let done = false
  return (status, body) => {
    if (done) return
    done = true
    a.inFlight = Math.max(0, a.inFlight - 1)
    const now = Date.now()
    if (status === 200) {
      a.lastSeen = now
      a.outdated = null
      if (path === '/v1/done') a.sessionSince = null
    } else if (status === INCOMPATIBLE_STATUS && parseIncompatible(body)) {
      // Handshake refusal: show "update phone" / "update Mac" instead of a generic error.
      a.lastSeen = now
      a.outdated = { at: now, app: parseIncompatible(body)! }
      a.sessionSince = null
    } else if (status >= 400 && status !== 404) {
      a.lastError = { at: now, message: `${path.replace('/v1/', '')}: ${status} ${body}`.slice(0, 200) }
      a.sessionSince = null
    }
    scheduleBadge()
  }
}

// --- sync history log (Settings › Sync › Recent) --------------------------------
// One entry per phone-driven apply plus local heal/error notes, capped.
// Best-effort: logging never breaks sync.

function syncLogPath(): string | null {
  const data = appDataDir()
  return data ? join(data, 'sync-log.json') : null
}

export function appendSyncLog(e: SyncLogEntry): void {
  try {
    const p = syncLogPath()
    if (!p) return
    let log: SyncLogEntry[] = []
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
      if (Array.isArray(raw)) log = raw as SyncLogEntry[]
    } catch {
      // fresh log
    }
    writeFileSync(p, JSON.stringify(appendCollapsed(log, e)))
  } catch {
    // never break sync for logging
  }
}

export function readSyncLog(): SyncLogEntry[] {
  try {
    const p = syncLogPath()
    if (!p) return []
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as SyncLogEntry[]) : []
  } catch {
    return []
  }
}

function peerName(id: string): string {
  return load().peers.find((p) => p.id === id)?.name ?? id.slice(0, 8)
}

// --- files ------------------------------------------------------------------

const hashCache = new Map<string, { size: number; mtime: number; hash: string }>()

function entryFor(abs: string): Entry | null {
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > 200 * 1024 * 1024) return null
    const c = hashCache.get(abs)
    if (c && c.size === st.size && c.mtime === st.mtimeMs) return { hash: c.hash, size: st.size, mtime: st.mtimeMs }
    const hash = createHash('sha256').update(readFileSync(abs)).digest('hex')
    hashCache.set(abs, { size: st.size, mtime: st.mtimeMs, hash })
    return { hash, size: st.size, mtime: st.mtimeMs }
  } catch {
    return null
  }
}

function absFor(rel: string): string {
  if (!safeRel(rel) || ignored(rel)) throw new Error(`refused path ${rel}`)
  const paths = vaultPaths()
  const abs = resolveNoteAbs(rel, paths)
  const base = rel.startsWith('inbox/') ? paths.inboxDir : rel.startsWith('daily/') ? paths.dailyDir : paths.root
  if (!(abs + sep).startsWith(base + sep) && abs !== base) throw new Error(`outside vault: ${rel}`)
  return abs
}

const macFs: SyncFs = {
  async list(): Promise<Manifest> {
    const paths = vaultPaths()
    // Heal here, not just at boot: the phone may hold the old spelling
    // while this Mac still has both. Whoever manifests first converges.
    try {
      mergeCaseDuplicates(paths.root)
    } catch (err) {
      console.warn('[sync] case-merge failed', err instanceof Error ? err.message : String(err))
    }
    const m: Manifest = {}
    const walk = (dir: string): void => {
      let entries: Dirent<string>[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const abs = join(dir, e.name)
        const rel = relative(paths.root, abs).split(sep).join('/')
        // Root-level inbox/ + daily/ are legacy; staging is the real one.
        if (rel === 'inbox' || rel === 'daily') continue
        if (e.isDirectory()) walk(abs)
        else if (e.isFile() && !ignored(rel)) {
          const en = entryFor(abs)
          if (en) m[rel] = en
        }
      }
    }
    walk(paths.root)
    for (const [dir, prefix] of [
      [paths.inboxDir, 'inbox'],
      [paths.dailyDir, 'daily']
    ] as const) {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const n of names) {
        if (n.startsWith('.')) continue
        const en = entryFor(join(dir, n))
        if (en) m[`${prefix}/${n}`] = en
      }
    }
    return m
  },
  async read(rel) {
    return new Uint8Array(readFileSync(absFor(rel)))
  },
  async write(rel, data) {
    const abs = absFor(rel)
    const attempt = (): void => {
      mkdirSync(dirname(abs), { recursive: true })
      const tmp = join(dirname(abs), `.${randomBytes(4).toString('hex')}.inkfish-sync`)
      writeFileSync(tmp, data)
      renameSync(tmp, abs)
    }
    try {
      attempt()
    } catch {
      // The parent can vanish mid-op (a heal or a parallel apply won the
      // race) — recreate it and retry once before giving up.
      attempt()
    }
  },
  async remove(rel) {
    const abs = absFor(rel)
    if (!existsSync(abs)) return
    const paths = vaultPaths()
    // Recoverable: same app trash as deleting in the UI.
    if (isStagingRel(rel)) {
      const scope = rel.startsWith('inbox/') ? 'inbox' : 'daily'
      const root = scope === 'inbox' ? paths.inboxDir : paths.dailyDir
      trashPath(relative(root, abs), { ...paths, root }, scope)
    } else trashPath(rel, paths)
  },
  async move(from, to) {
    const a = absFor(from)
    const b = absFor(to)
    if (!existsSync(a)) return
    mkdirSync(dirname(b), { recursive: true })
    try {
      renameSync(a, b)
    } catch {
      // Vault and app data may be on different volumes.
      writeFileSync(b, readFileSync(a))
      unlinkSync(a)
    }
  }
}

// --- applied changes: debounced reindex + log ------------------------------------

const pendingChanged = new Map<string, Set<string>>() // peer id ('' = unknown) → rels
let changedTimer: ReturnType<typeof setTimeout> | null = null
const CHANGED_DEBOUNCE_MS = 300

function queueChanged(rels: string[], peerId?: string): void {
  const key = peerId ?? ''
  const set = pendingChanged.get(key) ?? new Set<string>()
  for (const r of rels) set.add(r)
  pendingChanged.set(key, set)
  if (changedTimer) clearTimeout(changedTimer)
  changedTimer = setTimeout(flushChanged, CHANGED_DEBOUNCE_MS)
  changedTimer.unref?.()
}

function flushChanged(): void {
  changedTimer = null
  const batches = [...pendingChanged]
  pendingChanged.clear()
  if (!batches.length) return
  // A synced drop can introduce a case-variant dir (Personal vs personal) —
  // fold it before indexing so both sides converge.
  let merged = { dirs: 0, files: 0 }
  try {
    merged = mergeCaseDuplicates(vaultPaths().root)
  } catch (err) {
    console.warn('[sync] case-merge failed', err instanceof Error ? err.message : String(err))
  }
  if (merged.dirs > 0 || merged.files > 0) {
    appendSyncLog({
      at: Date.now(),
      peer: '',
      kind: 'heal',
      message: `merged ${merged.dirs} folder(s), ${merged.files} file(s) with case-duplicate names`
    })
  }
  for (const [peerId, rels] of batches) {
    for (const rel of rels) {
      if (!rel.endsWith('.md')) continue
      try {
        indexFile(resolveNoteAbs(rel), rel)
      } catch (err) {
        console.warn('[sync] reindex failed', rel, err)
      }
    }
    const name = peerId ? peerName(peerId) : 'phone'
    // One row per burst; back-to-back bursts from this phone fold together in the log too.
    appendSyncLog({ at: Date.now(), peer: name, kind: 'apply', files: rels.size, message: `${rels.size} file change(s) from ${name}` })
  }
  broadcastChanged()
  broadcastStatus()
}

// --- server -------------------------------------------------------------------

const handler = createHandler({
  get device() {
    const s = load()
    return { id: s.deviceId, name: s.deviceName }
  },
  fs: macFs,
  random: (n) => new Uint8Array(randomBytes(n)),
  getPeer: async (id) => {
    const p = load().peers.find((x) => x.id === id)
    if (!p) return null
    try {
      const key = await openPeer(safeStorage, p, save)
      return { ...p, key }
    } catch {
      return null
    }
  },
  pending: () => pending,
  addPeer: async (p) => {
    const sealed = await sealPeer(safeStorage, p)
    const s = load()
    s.peers = [...s.peers.filter((x) => x.id !== p.id), sealed]
    save()
    pending = null
    pendingQr = null
    broadcastStatus()
  },
  touchPeer: (id, at) => {
    const p = load().peers.find((x) => x.id === id)
    if (!p) return
    p.lastSync = at
    save()
    broadcastStatus()
  },
  // Off the request path: the phone's next batch shouldn't wait for re-indexing.
  // Bursts (several apply batches in one sync) become one reindex + one log row.
  changed: (rels, peerId) => queueChanged(rels, peerId),
  note: (msg) => {
    appendSyncLog({ at: Date.now(), peer: '', kind: 'error', message: msg })
    broadcastStatus()
  }
})

export function startSync(): void {
  if (server || !vaultConfigured()) return
  const s = load()
  migratePeerKeys()
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 70 * 1024 * 1024) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => {
      const url = (req.url ?? '/').split('?')[0] ?? '/'
      const peer = req.headers[PEER_HEADER]
      const peerId = typeof peer === 'string' ? peer : null
      const after = trackRequest(peerId, url)
      const meta = { protocol: req.headers[PROTOCOL_HEADER], minPeer: req.headers[MIN_PEER_HEADER] }
      handler(req.method ?? 'GET', url, peerId, Buffer.concat(chunks).toString('utf8'), meta)
        .then((r) => {
          after(r.status, r.type === 'text/plain' && r.status !== 200 ? r.body : '')
          res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' })
          res.end(r.body)
        })
        .catch((err: unknown) => {
          console.error('[sync] request failed', err)
          after(500, err instanceof Error ? err.message : 'error')
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('error')
        })
    })
  })
  const listen = (port: number, retry: boolean): void => {
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (retry && err.code === 'EADDRINUSE') {
        listen(0, false)
        return
      }
      listenError = err.message
      server = null
      broadcastStatus()
    })
    srv.listen(port, '0.0.0.0', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object' && addr.port !== s.port) {
        s.port = addr.port
        save()
      }
      listenError = null
      server = srv
      console.log(`[inkfish] sync listening on ${hosts().join(', ')}:${s.port}`)
      broadcastStatus()
    })
  }
  listen(s.port, true)
}

export function stopSync(): void {
  if (changedTimer) {
    clearTimeout(changedTimer)
    flushChanged()
  }
  server?.close()
  server = null
  if (badgeTimer) clearTimeout(badgeTimer)
  if (expiryTimer) clearTimeout(expiryTimer)
  badgeTimer = expiryTimer = null
}

export function syncStatus(): SyncStatus {
  const s = load()
  if (pendingQr && pendingQr.exp < Date.now()) {
    pending = null
    pendingQr = null
  }
  return {
    running: !!server,
    error: listenError,
    deviceName: s.deviceName,
    hosts: hosts(),
    port: s.port,
    peers: s.peers.map((p) => ({ id: p.id, name: p.name, pairedAt: p.pairedAt, lastSync: p.lastSync ?? null })),
    pairing: pendingQr,
    badge: currentBadge()
  }
}

/** Show a fresh pairing QR (replaces any previous one). */
export async function startPairing(): Promise<SyncStatus> {
  startSync()
  const s = load()
  const key = new Uint8Array(randomBytes(32))
  const exp = Date.now() + PAIR_TTL_MS
  const uri = encodePairUri({ v: 1, id: s.deviceId, name: s.deviceName, key: toBase64(key, true), hosts: hosts(), port: s.port, exp })
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  pending = { key, exp }
  pendingQr = { svg, uri, exp }
  return syncStatus()
}

export function cancelPairing(): SyncStatus {
  pending = null
  pendingQr = null
  return syncStatus()
}

export function unpair(id: string): SyncStatus {
  const s = load()
  s.peers = s.peers.filter((p) => p.id !== id)
  activity.delete(id)
  save()
  scheduleBadge()
  return syncStatus()
}

export function renameDevice(name: string): SyncStatus {
  const s = load()
  s.deviceName = name.trim().slice(0, 40) || s.deviceName
  save()
  scheduleBadge()
  return syncStatus()
}
