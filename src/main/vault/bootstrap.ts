import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, type Dirent } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { undoneDir } from './appdata'
import { uniqueFile } from './fs'
import { vaultConfigured, vaultPaths } from './paths'
import type { VaultPaths } from './types'

/** One-time move: legacy `projects/<name>/` container → top-level `<name>/`
 * folders. A "project" is just the folder name now, not an app dir.
 * Merges into existing same-named folders (collisions get `name 2.md`);
 * old dotfile residue (`.<f>.undone`) goes to app-data undone. */
export function migrateProjects(paths: VaultPaths = vaultPaths()): { moved: number; skipped: number } {
  const legacy = join(paths.root, 'projects')
  if (!existsSync(legacy)) return { moved: 0, skipped: 0 }
  let moved = 0
  let skipped = 0
  const moveOne = (from: string, toDir: string, name: string): void => {
    mkdirSync(toDir, { recursive: true })
    const ext = extname(name)
    const base = ext ? name.slice(0, -ext.length) : name
    const target = join(toDir, uniqueFile(toDir, base || 'untitled', ext || '.md'))
    try {
      renameSync(from, target)
      moved++
    } catch {
      skipped++
    }
  }
  const walk = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        walk(abs)
        continue
      }
      if (e.name.startsWith('.')) {
        // Old app residue — relocate to app-data undone, never left in vault.
        try {
          moveOne(abs, undoneDir(), e.name.replace(/^\.+/, ''))
        } catch {
          skipped++
        }
        continue
      }
      const rel = relative(legacy, abs)
      const first = rel.split('/')[0]
      if (!first || !e.name.endsWith('.md')) {
        skipped++
        continue
      }
      // rel already starts with the project dir — re-root it onto the vault.
      moveOne(abs, join(paths.root, dirname(rel)), e.name)
    }
  }
  walk(legacy)
  // Remove emptied dirs bottom-up (deepest first).
  const rmdirs = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) if (e.isDirectory()) rmdirs(join(dir, e.name))
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
    } catch {
      // leave leftovers alone
    }
  }
  rmdirs(legacy)
  if (moved > 0 || skipped > 0) console.log(`[inkfish] projects migration: ${moved} moved, ${skipped} skipped`)
  return { moved, skipped }
}

/** Throw unless a notes home is established — write paths must not
 * implicitly create directories before the user picks a location. */
export function requireNotes(): VaultPaths {
  if (!vaultConfigured()) throw new Error('notes folder not chosen yet')
  return ensureVault()
}
/** One-time move: legacy `inbox/` + `daily/` inside the vault → staging in
 * app data. Moves files only (never deletes); skips on name collision. */
export function migrateStaging(paths: VaultPaths = vaultPaths()): { moved: number; skipped: number } {
  let moved = 0
  let skipped = 0
  for (const [legacy, dest] of [
    [join(paths.root, 'inbox'), paths.inboxDir],
    [join(paths.root, 'daily'), paths.dailyDir]
  ] as Array<[string, string]>) {
    if (!existsSync(legacy)) continue
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(legacy, { withFileTypes: true })
    } catch {
      continue
    }
    mkdirSync(dest, { recursive: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) {
        skipped++
        continue
      }
      const from = join(legacy, e.name)
      const to = join(dest, e.name)
      if (existsSync(to)) {
        skipped++
        continue
      }
      try {
        renameSync(from, to)
        moved++
      } catch {
        skipped++
      }
    }
    try {
      if (readdirSync(legacy).length === 0) rmSync(legacy, { recursive: true })
    } catch {
      // leave leftovers alone
    }
  }
  if (moved > 0 || skipped > 0) console.log(`[inkfish] staging migration: ${moved} moved, ${skipped} skipped`)
  return { moved, skipped }
}
export function ensureVault(paths: VaultPaths = vaultPaths()): VaultPaths {
  // Vault: finalised outputs only (plain files/folders + attachments).
  // Staging (inbox/daily) lives in app data.
  mkdirSync(paths.assetsDir, { recursive: true })
  mkdirSync(paths.inboxDir, { recursive: true })
  mkdirSync(paths.dailyDir, { recursive: true })
  migrateStaging(paths)
  migrateProjects(paths)
  return paths
}
