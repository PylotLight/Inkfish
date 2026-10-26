import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import { vaultPaths } from './paths'
import type { VaultPaths } from './types'

// --- file management (Obsidian-style tree CRUD) ---------------------------------
// All rels are vault-relative (`a/b.md`, `a/b`). Throws on missing/outside-root.

export function assertInside(root: string, abs: string, what: string): void {
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..')) throw new Error(`${what} is outside the notes home`)
}

/** Case-fold for comparing names across filesystems. macOS APFS is usually
 * case-insensitive while Android/Linux ext4 is case-sensitive, so `Personal`
 * and `personal` are one dir on Mac but two on Android. The rule below must
 * stay identical to Android's fold — both sides converge on the same survivor. */
export function foldName(s: string): string {
  return s.toLowerCase()
}

/** Resolve each segment of dirRel to its on-disk spelling when a
 * case-insensitive match exists (e.g. `Personal/x` → `personal/x`).
 * Segments without a match pass through for the caller to create. */
export function resolveDirRel(dirRel: string, paths: VaultPaths = vaultPaths()): string {
  if (!dirRel) return ''
  const out: string[] = []
  let cur = paths.root
  for (const seg of dirRel.split('/')) {
    if (!seg || seg === '.') continue
    let use = seg
    try {
      const hit = readdirSync(cur, { withFileTypes: true }).find(
        (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== seg && foldName(e.name) === foldName(seg)
      )
      if (hit) use = hit.name
    } catch {
      // unreadable/missing — caller creates it
    }
    out.push(use)
    cur = join(cur, use)
  }
  return out.join('/')
}

/** Find a direct child dir of `dir` matching `name` case-insensitively.
 * Returns the on-disk spelling, or null. Hidden dirs never match by default. */
export function childDirNamed(dir: string, name: string, includeHidden = false): string | null {
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const want = foldName(name)
  for (const e of entries) {
    if (!includeHidden && e.name.startsWith('.')) continue
    if (e.isDirectory() && foldName(e.name) === want) return e.name
  }
  return null
}

export function uniqueFile(dir: string, base: string, ext: string): string {
  let name = `${base}${ext}`
  let i = 1
  while (existsSync(join(dir, name))) {
    i++
    name = `${base} ${i}${ext}`
  }
  return name
}
