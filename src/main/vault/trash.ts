import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { appDataDir } from './appdata'
import { assertInside } from './fs'
import { vaultPaths } from './paths'
import type { TrashEntry, TrashScope, VaultPaths } from './types'

// --- app trash (7-day sweep; hook for the future scheduler) -----------------------
const TRASH_RETENTION_MS = 7 * 24 * 3600 * 1000

function trashDir(): string | null {
  const data = appDataDir()
  if (!data) return null
  return join(data, 'trash')
}

function trashManifest(dir: string): TrashEntry[] {
  try {
    const f = join(dir, 'manifest.json')
    if (!existsSync(f)) return []
    const data = JSON.parse(readFileSync(f, 'utf8')) as unknown
    return Array.isArray(data) ? (data as TrashEntry[]) : []
  } catch {
    return []
  }
}

function writeManifest(dir: string, entries: TrashEntry[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entries, null, 2))
}

/** Move a file/dir to app trash (recoverable until the sweep). Returns entry. */
export function trashPath(rel: string, paths: VaultPaths = vaultPaths(), scope: TrashScope = 'vault'): TrashEntry {
  const dir = trashDir()
  if (!dir) throw new Error('app data dir unavailable')
  // A vault-scope rel may still name a staging file (`inbox/…`, `daily/…`); those live in app
  // data, not the notes home. Explicit non-vault scopes arrive with `paths.root` already set to
  // the staging dir (sync's remove), so only the default is resolved here.
  const effective: TrashScope =
    scope === 'vault' ? (rel.startsWith('inbox/') ? 'inbox' : rel.startsWith('daily/') ? 'daily' : 'vault') : scope
  const root = effective === 'inbox' ? paths.inboxDir : effective === 'daily' ? paths.dailyDir : paths.root
  const relToRoot = effective === 'vault' ? rel : rel.replace(/^(inbox|daily)\//, '')
  const abs = join(root, relToRoot)
  assertInside(root, abs, rel)
  const st = statSync(abs)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `${stamp}-${basename(abs)}`)
  try {
    renameSync(abs, dest)
  } catch {
    // Cross-volume: copy + remove.
    cpSync(abs, dest, { recursive: true })
    rmSync(abs, { recursive: true, force: true })
  }
  const entry: TrashEntry = {
    id: basename(dest),
    originalRel: relToRoot,
    name: basename(abs),
    isDir: st.isDirectory(),
    deletedAt: Date.now(),
    scope: effective
  }
  writeManifest(dir, [...trashManifest(dir), entry])
  return entry
}

/** Trash entries still on disk, newest first. */
export function listTrash(): TrashEntry[] {
  const dir = trashDir()
  if (!dir || !existsSync(dir)) return []
  return trashManifest(dir)
    .filter((e) => existsSync(join(dir, e.id)))
    .map((e) => ({ ...e, scope: entryScope(e) }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Old entries have no scope; staging files that sync trashed are bare `in-…` / `YYYY-MM-DD` names. */
function entryScope(e: TrashEntry): TrashScope {
  if (e.scope) return e.scope
  if (/^in-\d{4}-\d{2}-\d{2}-[0-9a-f]+\.md$/.test(e.originalRel)) return 'inbox'
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(e.originalRel)) return 'daily'
  return 'vault'
}

function scopeRoot(e: TrashEntry, paths: VaultPaths): string {
  const scope = entryScope(e)
  if (scope === 'inbox') return paths.inboxDir
  if (scope === 'daily') return paths.dailyDir
  return paths.root
}

/** "a/b.md" taken → "a/b (restored).md", then "(restored 2)"… */
function freeName(abs: string): string {
  if (!existsSync(abs)) return abs
  const ext = extname(abs)
  const stem = ext ? abs.slice(0, -ext.length) : abs
  for (let i = 1; ; i++) {
    const next = `${stem} (restored${i > 1 ? ` ${i}` : ''})${ext}`
    if (!existsSync(next)) return next
  }
}

/**
 * Put trash entries back where they were (recreating folders). A path that's
 * been taken since gets a "(restored)" name instead of overwriting. Returns
 * the restored paths, relative to their root.
 */
export function restoreTrash(ids: string[] | 'all', paths: VaultPaths = vaultPaths()): string[] {
  return restoreTrashEntries(ids, paths).map((r) => r.rel)
}

/** `restoreTrash` with where each one went (scope + folder or file) — for a targeted reindex. */
export function restoreTrashEntries(
  ids: string[] | 'all',
  paths: VaultPaths = vaultPaths()
): Array<{ rel: string; scope: TrashScope; isDir: boolean }> {
  const dir = trashDir()
  if (!dir || !existsSync(dir)) return []
  const want = ids === 'all' ? null : new Set(ids)
  const keep: TrashEntry[] = []
  const done: Array<{ rel: string; scope: TrashScope; isDir: boolean }> = []
  for (const e of trashManifest(dir)) {
    const src = join(dir, e.id)
    if (want && !want.has(e.id)) {
      keep.push(e)
      continue
    }
    if (!existsSync(src)) continue
    const root = scopeRoot(e, paths)
    const dest = freeName(join(root, e.originalRel))
    assertInside(root, dest, e.originalRel)
    mkdirSync(dirname(dest), { recursive: true })
    try {
      renameSync(src, dest)
    } catch {
      cpSync(src, dest, { recursive: true })
      rmSync(src, { recursive: true, force: true })
    }
    done.push({ rel: relative(root, dest), scope: entryScope(e), isDir: e.isDir })
  }
  writeManifest(dir, keep)
  return done
}

/** Permanently delete trash entries now. */
export function deleteTrash(ids: string[] | 'all'): number {
  const dir = trashDir()
  if (!dir || !existsSync(dir)) return 0
  const want = ids === 'all' ? null : new Set(ids)
  const keep: TrashEntry[] = []
  let n = 0
  for (const e of trashManifest(dir)) {
    if (want && !want.has(e.id)) {
      keep.push(e)
      continue
    }
    rmSync(join(dir, e.id), { recursive: true, force: true })
    n++
  }
  writeManifest(dir, keep)
  return n
}

/** Permanently delete trash entries older than 7d. Returns purged count. */
export function purgeTrash(): number {
  const dir = trashDir()
  if (!dir || !existsSync(dir)) return 0
  const cutoff = Date.now() - TRASH_RETENTION_MS
  const keep: TrashEntry[] = []
  let purged = 0
  for (const e of trashManifest(dir)) {
    if (e.deletedAt < cutoff) {
      rmSync(join(dir, e.id), { recursive: true, force: true })
      purged++
    } else keep.push(e)
  }
  writeManifest(dir, keep)
  return purged
}
