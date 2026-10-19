import { ignored, type Manifest } from './plan'

/**
 * Phone-side manifest walk, platform-free so it can be benchmarked under bun.
 * Android plugs in expo-file-system; every call there crosses the RN bridge
 * (~1–5 ms each), so the walk is what makes an idle sync slow on a big vault.
 *
 * - one stat per entry (the old walk stat'ed every file twice, plus a third
 *   time in the case-heal pass), run with bounded concurrency;
 * - a size+mtime hash cache, so only new/changed files are read and hashed;
 * - reports whether any folder holds case-duplicate names, so the caller
 *   runs the (full-tree) case-heal only when there's something to heal.
 */

export interface WalkIo {
  readDir(uri: string): Promise<string[]>
  stat(uri: string): Promise<{ exists: boolean; isDirectory: boolean; size: number; mtime: number }>
  /** sha256 hex of the file's bytes. */
  hash(uri: string): Promise<string>
}

export type HashCache = Record<string, { size: number; mtime: number; hash: string }>

export interface WalkRoot {
  /** Directory uri with trailing slash. */
  uri: string
  /** Rel prefix ('' for the vault, 'inbox' / 'daily' for staging). */
  prefix: string
  /** Recurse into subfolders (staging roots are flat). */
  deep: boolean
  /** Top-level names to skip in this root. */
  skip?: string[]
}

export interface WalkResult {
  manifest: Manifest
  cache: HashCache
  /** Anything new/changed was hashed or dropped (the cache needs saving). */
  dirty: boolean
  /** Some folder holds names that differ only by case. */
  caseDupes: boolean
  stats: number
  hashed: number
}

export const MAX_SYNC_FILE = 200 * 1024 * 1024

export async function walkManifest(io: WalkIo, roots: WalkRoot[], cache: HashCache, concurrency = 8): Promise<WalkResult> {
  const manifest: Manifest = {}
  const next: HashCache = {}
  let stats = 0
  let hashed = 0
  let caseDupes = false
  let queue: Array<{ uri: string; rel: string; root: WalkRoot; top: boolean }> = roots.map((r) => ({ uri: r.uri, rel: r.prefix, root: r, top: true }))
  const files: Array<{ uri: string; rel: string; size: number; mtime: number }> = []

  // Pass 1: directories → names → one stat each.
  while (queue.length) {
    const dirs = queue
    queue = []
    await mapLimit(dirs, concurrency, async (d) => {
      let names: string[]
      try {
        names = await io.readDir(d.uri)
      } catch {
        return
      }
      const folds = new Set<string>()
      const visible = names.filter((n) => !n.startsWith('.') && !(d.top && d.root.skip?.includes(n)))
      for (const n of visible) {
        const f = n.toLowerCase()
        if (folds.has(f)) caseDupes = true
        folds.add(f)
      }
      await mapLimit(visible, concurrency, async (n) => {
        const uri = `${d.uri}${n}`
        const rel = d.rel ? `${d.rel}/${n}` : n
        let st
        try {
          st = await io.stat(uri)
          stats++
        } catch {
          return
        }
        if (!st.exists) return
        if (st.isDirectory) {
          if (d.root.deep) queue.push({ uri: `${uri}/`, rel, root: d.root, top: false })
          return
        }
        if (ignored(rel) || st.size > MAX_SYNC_FILE) return
        files.push({ uri, rel, size: st.size, mtime: st.mtime })
      })
    })
  }

  // Pass 2: hash only what's new or changed since the cache.
  await mapLimit(files, Math.max(2, concurrency >> 1), async (f) => {
    const c = cache[f.rel]
    let hash: string
    if (c && c.size === f.size && c.mtime === f.mtime) hash = c.hash
    else {
      try {
        hash = await io.hash(f.uri)
      } catch {
        return
      }
      hashed++
    }
    next[f.rel] = { size: f.size, mtime: f.mtime, hash }
    manifest[f.rel] = { hash, size: f.size, mtime: f.mtime * 1000 }
  })
  const dirty = hashed > 0 || Object.keys(cache).length !== Object.keys(next).length
  return { manifest, cache: next, dirty, caseDupes, stats, hashed }
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, f: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const k = i++
      out[k] = await f(items[k]!, k)
    }
  }
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker))
  return out
}
