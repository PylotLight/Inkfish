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
  DEFAULT_PORT,
  encodePairUri,
  ignored,
  appendCapped,
  PAIR_TTL_MS,
  PEER_HEADER,
  safeRel,
  toBase64,
  type Entry,
  type Manifest,
  type PeerRecord,
  type PendingPair,
  type SyncFs,
  type SyncLogEntry
} from '../shared/sync'
import { indexFile } from './db'
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
}

interface Stored {
  deviceId: string
  deviceName: string
  port: number
  /** key field holds safeStorage-encrypted base64 when `enc` is true */
  peers: Array<PeerRecord & { enc?: boolean }>
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
    deviceName: s.deviceName ?? (hostname().replace(/\.local$/, '') || 'Mac'),
    port: s.port ?? DEFAULT_PORT,
    peers: s.peers ?? []
  }
  if (!s.deviceId) save()
  return store
}

function save(): void {
  const p = storePath()
  if (!p || !store) return
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}

function peerKey(p: PeerRecord & { enc?: boolean }): string {
  if (!p.enc) return p.key
  return safeStorage.decryptString(Buffer.from(p.key, 'base64'))
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
    writeFileSync(p, JSON.stringify(appendCapped(log, e)))
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

// --- server -------------------------------------------------------------------

const handler = createHandler({
  get device() {
    const s = load()
    return { id: s.deviceId, name: s.deviceName }
  },
  fs: macFs,
  random: (n) => new Uint8Array(randomBytes(n)),
  getPeer: (id) => {
    const p = load().peers.find((x) => x.id === id)
    if (!p) return null
    try {
      return { ...p, key: peerKey(p) }
    } catch {
      return null
    }
  },
  pending: () => pending,
  addPeer: (p) => {
    const s = load()
    const enc = safeStorage.isEncryptionAvailable()
    const key = enc ? safeStorage.encryptString(p.key).toString('base64') : p.key
    s.peers = [...s.peers.filter((x) => x.id !== p.id), { ...p, key, enc }]
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
  changed: (rels, peerId) => {
    // A synced drop can introduce a case-variant dir (Personal vs personal) —
    // fold it before indexing so both sides converge.
    let merged = { dirs: 0, files: 0 }
    try {
      merged = mergeCaseDuplicates(vaultPaths().root)
    } catch (err) {
      console.warn('[sync] case-merge failed', err instanceof Error ? err.message : String(err))
    }
    for (const rel of new Set(rels)) {
      if (!rel.endsWith('.md')) continue
      try {
        indexFile(resolveNoteAbs(rel), rel)
      } catch (err) {
        console.warn('[sync] reindex failed', rel, err)
      }
    }
    const name = peerId ? peerName(peerId) : 'phone'
    if (merged.dirs > 0 || merged.files > 0) {
      appendSyncLog({
        at: Date.now(),
        peer: '',
        kind: 'heal',
        message: `merged ${merged.dirs} folder(s), ${merged.files} file(s) with case-duplicate names`
      })
    }
    appendSyncLog({
      at: Date.now(),
      peer: name,
      kind: 'apply',
      message: `${rels.length} file change(s) from ${name}`
    })
    broadcastChanged()
    broadcastStatus()
  },
  note: (msg) => {
    appendSyncLog({ at: Date.now(), peer: '', kind: 'error', message: msg })
    broadcastStatus()
  }
})

export function startSync(): void {
  if (server || !vaultConfigured()) return
  const s = load()
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
      handler(req.method ?? 'GET', url, typeof peer === 'string' ? peer : null, Buffer.concat(chunks).toString('utf8'))
        .then((r) => {
          res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' })
          res.end(r.body)
        })
        .catch((err: unknown) => {
          console.error('[sync] request failed', err)
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
  server?.close()
  server = null
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
    pairing: pendingQr
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
  save()
  return syncStatus()
}

export function renameDevice(name: string): SyncStatus {
  const s = load()
  s.deviceName = name.trim().slice(0, 40) || s.deviceName
  save()
  return syncStatus()
}
