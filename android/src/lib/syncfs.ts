import * as FileSystem from 'expo-file-system/legacy'
import { getRandomBytes } from 'expo-crypto'
import {
  fromBase64,
  ignored,
  safeRel,
  sha256,
  toBase64,
  toHex,
  walkManifest,
  type Base,
  type HashCache,
  type WalkIo,
  type WalkRoot,
  type MacPeer,
  type Manifest,
  type SyncFs,
  type SyncState
} from './sync'
import { syncRoots, mergeCaseDuplicates } from './vault'

/**
 * Android file system + state for the shared sync engine. Paths use the
 * Mac's namespace: vault-relative, plus `inbox/…` and `daily/…` for staging.
 * Deletes from sync go to `inkfish/trash/` (never hard-deleted).
 */

const R = syncRoots()
const SYNC_DIR = `${R.app}.sync/`
export const TRASH = `${R.app}trash/`
const B64 = { encoding: FileSystem.EncodingType.Base64 }
const UTF8 = { encoding: FileSystem.EncodingType.UTF8 }

export const random = (n: number): Uint8Array => getRandomBytes(n)

export function uriFor(rel: string): string {
  if (!safeRel(rel) || ignored(rel)) throw new Error(`refused path ${rel}`)
  if (rel.startsWith('inbox/')) return `${R.inbox}${rel.slice(6)}`
  if (rel.startsWith('daily/')) return `${R.daily}${rel.slice(6)}`
  return `${R.vault}${rel}`
}

async function mkdirp(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri)
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true })
}

function parentOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/') + 1)
}

async function readJson<T>(uri: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(uri, UTF8)) as T
  } catch {
    return fallback
  }
}

async function writeJson(uri: string, v: unknown): Promise<void> {
  await mkdirp(parentOf(uri))
  const tmp = `${uri}.tmp`
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(v), UTF8)
  await FileSystem.moveAsync({ from: tmp, to: uri })
}

// --- hash cache: path → size/mtime/hash, so unchanged files aren't re-read ---
const CACHE_URI = `${SYNC_DIR}hashes.json`
const partialUri = (key: string): string => `${SYNC_DIR}partial/${key.replace(/[^A-Za-z0-9]/g, '').slice(0, 80)}/`
/** Hashes of files sync just wrote (the engine knows them): folded into the cache on the next walk. */
let known: HashCache = {}

const phoneIo: WalkIo = {
  readDir: (uri) => FileSystem.readDirectoryAsync(uri),
  async stat(uri) {
    const info = await FileSystem.getInfoAsync(uri)
    if (!info.exists) return { exists: false, isDirectory: false, size: 0, mtime: 0 }
    return { exists: true, isDirectory: info.isDirectory, size: info.size ?? 0, mtime: info.modificationTime ?? 0 }
  },
  hash: async (uri) => sha256(fromBase64(await FileSystem.readAsStringAsync(uri, B64)))
}

const ROOTS: WalkRoot[] = [
  { uri: R.vault, prefix: '', deep: true, skip: ['inbox', 'daily'] }, // staging lives elsewhere
  { uri: R.inbox, prefix: 'inbox', deep: false },
  { uri: R.daily, prefix: 'daily', deep: false }
]

/** Remove now-empty folders from `uri`'s parent up to (not including) its sync root. */
async function pruneEmptyParents(uri: string): Promise<void> {
  const root = [R.vault, R.inbox, R.daily].find((r) => uri.startsWith(r))
  if (!root) return
  let dir = parentOf(uri)
  while (dir.length > root.length && dir.startsWith(root)) {
    try {
      if ((await FileSystem.readDirectoryAsync(dir)).length > 0) return
      await FileSystem.deleteAsync(dir, { idempotent: true })
    } catch {
      return
    }
    dir = parentOf(dir.slice(0, -1))
  }
}

export const androidFs: SyncFs = {
  async list(opts): Promise<Manifest> {
    const cache = opts?.fresh ? {} : { ...(await readJson<HashCache>(CACHE_URI, {})), ...known }
    known = {}
    let r = await walkManifest(phoneIo, ROOTS, cache)
    // Heal only when the walk saw case-duplicate names (the heal is a full
    // extra tree walk). Same rule as the Mac: a duplicate is never advertised.
    if (r.caseDupes) {
      try {
        await mergeCaseDuplicates()
        r = await walkManifest(phoneIo, ROOTS, r.cache)
      } catch {
        // best-effort; the manifest we have still works
      }
    }
    if (r.dirty || opts?.fresh) await writeJson(CACHE_URI, r.cache)
    return r.manifest
  },
  async read(rel) {
    return fromBase64(await FileSystem.readAsStringAsync(uriFor(rel), B64))
  },
  async write(rel, data, hash) {
    const uri = uriFor(rel)
    const parent = parentOf(uri)
    const payload = toBase64(data)
    const attempt = async (): Promise<void> => {
      await mkdirp(parent)
      const tmp = `${parent}.${toHex(random(4))}.inkfish-sync`
      await FileSystem.writeAsStringAsync(tmp, payload, B64)
      await FileSystem.deleteAsync(uri, { idempotent: true })
      await FileSystem.moveAsync({ from: tmp, to: uri })
    }
    try {
      await attempt()
    } catch (e) {
      // The parent can vanish mid-op (a heal or another sync won the race) —
      // recreate it and retry once before giving up.
      await mkdirp(parent)
      await attempt()
    }
    if (hash) {
      const info = await FileSystem.getInfoAsync(uri)
      if (info.exists && !info.isDirectory)
        known[rel] = { size: info.size ?? data.length, mtime: info.modificationTime ?? 0, hash }
    }
  },
  async remove(rel) {
    const uri = uriFor(rel)
    const info = await FileSystem.getInfoAsync(uri)
    if (!info.exists) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = `${TRASH}${stamp}/${rel}`
    await mkdirp(parentOf(dest))
    await FileSystem.moveAsync({ from: uri, to: dest })
    await pruneEmptyParents(uri)
  },
  async stat(rel) {
    try {
      const info = await FileSystem.getInfoAsync(uriFor(rel))
      if (!info.exists || info.isDirectory) return null
      return { size: info.size ?? 0, mtime: (info.modificationTime ?? 0) * 1000 }
    } catch {
      return null
    }
  },
  partial: {
    // Big downloads accumulate as numbered chunk files (expo-file-system has no append);
    // they survive the app being killed, so the next sync continues where this one stopped.
    async size(key) {
      const dir = partialUri(key)
      try {
        let n = 0
        for (const f of await FileSystem.readDirectoryAsync(dir)) {
          if (!/^\d+$/.test(f)) continue
          const info = await FileSystem.getInfoAsync(`${dir}${f}`)
          if (info.exists && !info.isDirectory) n += info.size ?? 0
        }
        return n
      } catch {
        return 0
      }
    },
    async append(key, data) {
      const dir = partialUri(key)
      await mkdirp(dir)
      const n = (await FileSystem.readDirectoryAsync(dir)).filter((x) => /^\d+$/.test(x)).length
      const tmp = `${dir}.${n}.tmp`
      await FileSystem.writeAsStringAsync(tmp, toBase64(data), B64)
      await FileSystem.moveAsync({ from: tmp, to: `${dir}${String(n).padStart(5, '0')}` })
    },
    async read(key) {
      const dir = partialUri(key)
      const parts: Uint8Array[] = []
      for (const f of (await FileSystem.readDirectoryAsync(dir)).filter((x) => /^\d+$/.test(x)).sort()) {
        parts.push(fromBase64(await FileSystem.readAsStringAsync(`${dir}${f}`, B64)))
      }
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let o = 0
      for (const p of parts) {
        out.set(p, o)
        o += p.length
      }
      return out
    },
    async drop(key) {
      await FileSystem.deleteAsync(partialUri(key), { idempotent: true })
    }
  },
  async move(from, to) {
    const a = uriFor(from)
    const b = uriFor(to)
    const info = await FileSystem.getInfoAsync(a)
    if (!info.exists) return
    await mkdirp(parentOf(b))
    await FileSystem.moveAsync({ from: a, to: b })
    // A case adoption (`work/x.md` → `Work/x.md`) must not leave an empty
    // `work/` behind, or the case-heal would fold `Work/` back into it.
    await pruneEmptyParents(a)
  }
}

// --- per-Mac state: base manifest + cached base texts ------------------------

export function stateFor(macId: string): SyncState {
  const dir = `${SYNC_DIR}${macId.replace(/[^A-Za-z0-9_-]/g, '')}/`
  const texts = `${dir}base/`
  return {
    loadBase: () => readJson<Base>(`${dir}base.json`, {}),
    saveBase: (b) => writeJson(`${dir}base.json`, b),
    async getText(hash) {
      try {
        return await FileSystem.readAsStringAsync(`${texts}${hash}`, UTF8)
      } catch {
        return null
      }
    },
    async putText(hash, text) {
      await mkdirp(texts)
      await FileSystem.writeAsStringAsync(`${texts}${hash}`, text, UTF8)
    },
    async pruneTexts(keep) {
      let names: string[] = []
      try {
        names = await FileSystem.readDirectoryAsync(texts)
      } catch {
        return
      }
      for (const n of names) if (!keep.has(n)) await FileSystem.deleteAsync(`${texts}${n}`, { idempotent: true })
    }
  }
}

// --- identity + paired Mac ----------------------------------------------------

interface Identity {
  id: string
  mac: MacPeer | null
}
const ID_URI = `${SYNC_DIR}identity.json`

export async function loadIdentity(): Promise<Identity> {
  const v = await readJson<Partial<Identity>>(ID_URI, {})
  if (v.id) return { id: v.id, mac: v.mac ?? null }
  const fresh: Identity = { id: `android-${toBase64(random(9), true)}`, mac: null }
  await writeJson(ID_URI, fresh)
  return fresh
}

export async function saveIdentity(v: Identity): Promise<void> {
  await writeJson(ID_URI, v)
}

/** Forget the Mac and its sync state (files stay). */
export async function forgetMac(v: Identity): Promise<Identity> {
  if (v.mac)
    await FileSystem.deleteAsync(`${SYNC_DIR}${v.mac.id.replace(/[^A-Za-z0-9_-]/g, '')}/`, { idempotent: true })
  const next = { ...v, mac: null }
  await saveIdentity(next)
  return next
}
