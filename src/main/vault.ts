import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { InboxItem, MeetingSaveInput, NoteKind, NoteSource, NoteStatus, Project } from '../shared/types'

/**
 * Vault writer (main process only). Plain `.md` files are the source of
 * truth; sqlite (`db.ts`) is just an index.
 *
 * Layout rule: the notes home (vault) holds ONLY finalised outputs — plain
 * note files and folders (a routed note lands in `<vault>/<project>/`, a
 * "project" is just the top-level folder name, no app container dir).
 * Everything working-state lives in the hidden app-data dir: raw inbox
 * captures, day-log scratch, trash, undone routings, index.
 * Never deletes raw inbox files.
 */

export interface VaultPaths {
  /** User-visible notes home: finalised outputs only. */
  root: string
  /** Staging in app data: raw captures, never in the vault. */
  inboxDir: string
  /** Staging in app data: day-log scratch, never in the vault. */
  dailyDir: string
  /** Final attachments in the vault (embedded by finalised notes). */
  assetsDir: string
  /** App-managed index in the hidden app-data dir — never in the notes home. */
  dbPath: string
}

// --- homes: app data (hidden) vs notes (user-visible) ------------------------------
// App data (config, sqlite index, models) lives in the platform app-data dir
// (`app.getPath('userData')` — ~/.config/<app> on Linux, ~/Library/… on mac).
// Override with INKFISH_DATA for dev/tests. The notes home is chosen by the
// user in onboarding (or INKFISH_VAULT) and holds only plain .md + assets.

let configDir: string | null = null

export function setConfigDir(dir: string): void {
  configDir = dir
}

export function appDataDir(): string | null {
  const override = process.env['INKFISH_DATA']
  if (override && override.trim()) return resolve(override)
  return configDir
}

// --- notes home: env > stored choice > default ----------------------------------
// The user's choice persists in the app-data dir (`inkfish.json`).
// Main startup calls `setConfigDir(app.getPath('userData'))` once; everything
// else resolves dynamically so a mid-session move just works.

function configPath(): string | null {
  if (!configDir) return null
  return join(configDir, 'inkfish.json')
}

export function readStoredRoot(): string | null {
  try {
    const p = configPath()
    if (!p || !existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as { vaultRoot?: unknown }
    return typeof data.vaultRoot === 'string' && data.vaultRoot ? data.vaultRoot : null
  } catch {
    return null
  }
}

export function storeRoot(root: string): void {
  const p = configPath()
  if (!p) return
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ vaultRoot: root }, null, 2))
}

// --- profiles: named vault roots (work / personal), all state in app data --------

export interface NoteProfile {
  id: string
  name: string
  root: string
}

function profilesPath(): string | null {
  if (!configDir) return null
  return join(configDir, 'profiles.json')
}

/** All known profiles. The stored `vaultRoot` is the active one. */
export function listProfiles(): NoteProfile[] {
  try {
    const p = profilesPath()
    if (!p || !existsSync(p)) {
      const root = readStoredRoot()
      return root ? [{ id: 'default', name: 'default', root }] : []
    }
    const data = JSON.parse(readFileSync(p, 'utf8')) as { profiles?: NoteProfile[] }
    return Array.isArray(data.profiles) ? data.profiles.filter((x) => x && x.root) : []
  } catch {
    return []
  }
}

export function saveProfile(name: string, root: string): NoteProfile[] {
  const p = profilesPath()
  const id = slugify(name, 32) || 'profile'
  const next = [...listProfiles().filter((x) => x.id !== id), { id, name: name.trim().slice(0, 80), root }]
  if (p) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ profiles: next }, null, 2))
  }
  return next
}

/** Switch the active vault root (persists choice, caller re-opens DB + rescans). */
export function switchProfile(id: string): string {
  const found = listProfiles().find((x) => x.id === id)
  if (!found) throw new Error(`profile ${id} not found`)
  storeRoot(found.root)
  return found.root
}

/** Custom display titles (id → title), kept in app data — never in the notes. */
export function titlesPath(): string | null {
  if (!configDir) return null
  return join(configDir, 'titles.json')
}

export function loadTitles(): Record<string, string> {
  try {
    const p = titlesPath()
    if (!p || !existsSync(p)) return {}
    const data = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (typeof data !== 'object' || data === null) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200)
    }
    return out
  } catch {
    return {}
  }
}

export function setTitleOverride(id: string, title: string): Record<string, string> {
  const p = titlesPath()
  const all = loadTitles()
  if (title.trim()) all[id] = title.trim().slice(0, 200)
  else delete all[id]
  if (p) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(all, null, 2))
  }
  return all
}

/** Move overrides for a renamed path (file or whole dir subtree). */
export function migrateTitles(oldRel: string, newRel: string): Record<string, string> {
  const p = titlesPath()
  const titles = loadTitles()
  const moved: Record<string, string> = {}
  for (const [id, t] of Object.entries(titles)) {
    if (id === oldRel || id.startsWith(`${oldRel}/`)) moved[newRel + id.slice(oldRel.length)] = t
    else moved[id] = t
  }
  if (p) {
    try {
      writeFileSync(p, JSON.stringify(moved, null, 2))
    } catch {
      // ignore
    }
  }
  return moved
}
export function envManaged(): boolean {
  return !!process.env['INKFISH_VAULT']?.trim()
}

// --- file management (Obsidian-style tree CRUD) ---------------------------------
// All rels are vault-relative (`a/b.md`, `a/b`). Throws on missing/outside-root.

function assertInside(root: string, abs: string, what: string): void {
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..')) throw new Error(`${what} is outside the notes home`)
}

function uniqueFile(dir: string, base: string, ext: string): string {
  let name = `${base}${ext}`
  let i = 1
  while (existsSync(join(dir, name))) {
    i++
    name = `${base} ${i}${ext}`
  }
  return name
}

/** New `Untitled.md` (numbered) in dirRel ('' = vault root). Returns vaultRel. */
export function createNoteFile(dirRel: string, paths: VaultPaths = vaultPaths()): string {
  const dir = join(paths.root, dirRel)
  assertInside(paths.root, join(paths.root, `${dirRel}/x`), `folder ${dirRel || '/'}`)
  mkdirSync(dir, { recursive: true })
  const name = uniqueFile(dir, 'Untitled', '.md')
  const abs = join(dir, name)
  writeFileSync(abs, '', 'utf8')
  return relative(paths.root, abs)
}

/** New subfolder. Returns vaultRel. */
export function createDir(parentRel: string, name: string, paths: VaultPaths = vaultPaths()): string {
  const clean = name.trim().replace(/[/\\]+/g, '-').slice(0, 80)
  if (!clean) throw new Error('folder name is empty')
  const abs = join(paths.root, parentRel, clean)
  assertInside(paths.root, abs, `folder ${clean}`)
  mkdirSync(abs, { recursive: true })
  return relative(paths.root, abs)
}

/** Rename a file (keeps ext unless newName has one) or dir. Returns new vaultRel. */
export function renamePath(rel: string, newName: string, paths: VaultPaths = vaultPaths()): string {
  const clean = newName.trim().replace(/[/\\]+/g, '-').slice(0, 120)
  if (!clean) throw new Error('name is empty')
  const abs = join(paths.root, rel)
  assertInside(paths.root, abs, rel)
  const st = statSync(abs)
  const target = st.isDirectory()
    ? clean
    : extname(clean) ? clean : `${clean}.md`
  const dest = join(dirname(abs), target)
  assertInside(paths.root, dest, target)
  if (existsSync(dest)) throw new Error(`${target} already exists`)
  renameSync(abs, dest)
  return relative(paths.root, dest)
}

/** Move a file or dir into another folder ('' = root). Returns new vaultRel. */
export function movePath(rel: string, destDirRel: string, paths: VaultPaths = vaultPaths()): string {
  const abs = join(paths.root, rel)
  assertInside(paths.root, abs, rel)
  if (!existsSync(abs)) throw new Error(`${rel} not found`)
  const destDir = join(paths.root, destDirRel)
  if (destDirRel) assertInside(paths.root, destDir, destDirRel)
  if (destDir === abs || destDir.startsWith(`${abs}/`)) throw new Error('cannot move a folder into itself')
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(abs))
  if (dest === abs) return rel
  if (existsSync(dest)) throw new Error(`${basename(abs)} already exists in ${destDirRel || '/'}`)
  renameSync(abs, dest)
  return relative(paths.root, dest)
}

// --- app trash (7-day sweep; hook for the future scheduler) -----------------------
export interface TrashEntry {
  id: string
  originalRel: string
  name: string
  isDir: boolean
  deletedAt: number
  /** Which root originalRel is relative to. Missing on old entries = vault. */
  scope?: TrashScope
}

export type TrashScope = 'vault' | 'inbox' | 'daily'

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
  const abs = join(paths.root, rel)
  assertInside(paths.root, abs, rel)
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
    originalRel: rel,
    name: basename(abs),
    isDir: st.isDirectory(),
    deletedAt: Date.now(),
    scope
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
  const dir = trashDir()
  if (!dir || !existsSync(dir)) return []
  const want = ids === 'all' ? null : new Set(ids)
  const keep: TrashEntry[] = []
  const done: string[] = []
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
    done.push(relative(root, dest))
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

export function resolveVaultRoot(): string {
  const override = process.env['INKFISH_VAULT']
  if (override && override.trim()) return resolve(override)
  return readStoredRoot() ?? join(homedir(), 'Inkfish')
}

/** Has a vault home been established? Stored choice, env override, or a
 * pre-existing default vault (adopted from earlier versions) all count.
 * False only on true first run — the onboarding wizard must pick first. */
export function vaultConfigured(): boolean {
  if (envManaged()) return true
  if (readStoredRoot()) return true
  return existsSync(join(homedir(), 'Inkfish'))
}

export function vaultPaths(root: string = resolveVaultRoot()): VaultPaths {
  const data = appDataDir()
  // Staging + index must never live inside the notes home (it would pollute
  // sync, Obsidian, and git). Fail loud instead of falling back into the vault.
  if (!data) throw new Error('app data dir unavailable — refusing to place index inside notes home')
  const staging = join(data, 'staging')
  return {
    root,
    inboxDir: join(staging, 'inbox'),
    dailyDir: join(staging, 'daily'),
    assetsDir: join(root, 'assets'),
    dbPath: join(data, 'inkfish.db')
  }
}

/** Resolve a note rel to an absolute path — staging rels (`inbox/`, `daily/`) live in app data. */
export function resolveNoteAbs(rel: string, paths: VaultPaths = vaultPaths()): string {
  if (rel === 'inbox' || rel.startsWith('inbox/')) return join(paths.inboxDir, rel.slice('inbox/'.length))
  if (rel === 'daily' || rel.startsWith('daily/')) return join(paths.dailyDir, rel.slice('daily/'.length))
  return join(paths.root, rel)
}

/** True for staging rels (working state) vs finalised vault content. */
export function isStagingRel(rel: string): boolean {
  return rel === 'inbox' || rel.startsWith('inbox/') || rel === 'daily' || rel.startsWith('daily/')
}

/** Local calendar day (YYYY-MM-DD). A day log follows the wall clock, not UTC —
 *  in Melbourne `toISOString()` filed everything before 11am under yesterday. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dailyFile(date: Date = new Date(), paths: VaultPaths = vaultPaths()): { abs: string; vaultRel: string } {
  const day = localDay(date)
  const abs = join(paths.dailyDir, `${day}.md`)
  // Staging rel namespace (`daily/<day>.md`) — stable even though the file
  // lives in app data, so index rows, tree filters, and open-today all agree.
  return { abs, vaultRel: `daily/${day}.md` }
}

/** Append a timestamped section to today's day-log. Creates the file on first use. */
export function appendDaily(
  raw: string,
  opts: { kind?: NoteKind; date?: Date; source?: NoteSource } = {},
  paths: VaultPaths = vaultPaths()
): { vaultRel: string; path: string } {
  ensureVault(paths)
  const text = raw.trim()
  if (!text) throw new Error('daily note is empty')
  const { abs, vaultRel } = dailyFile(opts.date ?? new Date(), paths)
  mkdirSync(dirname(abs), { recursive: true })
  const stamp = (opts.date ?? new Date()).toTimeString().slice(0, 5)
  const kind = opts.kind ?? 'text'
  const header = `# ${localDay(opts.date ?? new Date())}\n\n`
  const section = `## ${stamp}${kind !== 'text' ? ` · ${kind}` : ''}\n\n${text}\n\n`
  if (!existsSync(abs)) {
    const fm = stringifyFrontmatter({ kind: 'daily', created: new Date().toISOString(), source: opts.source ?? 'tray' })
    writeFileSync(abs, `${fm}${header}${section}`, 'utf8')
  } else {
    const prev = readFileSync(abs, 'utf8')
    writeFileSync(abs, `${prev.replace(/\s+$/, '')}\n\n${section}`, 'utf8')
  }
  return { vaultRel, path: abs }
}

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

export function newId(prefix = ''): string {
  const rand = Math.random().toString(16).slice(2, 8)
  const stamp = new Date().toISOString().slice(0, 10)
  return prefix ? `${prefix}-${stamp}-${rand}` : `${stamp}-${rand}`
}

export function slugify(s: string, max = 48): string {
  const slug =
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  return slug.slice(0, max).replace(/-+$/, '') || 'untitled'
}

// --- frontmatter ---------------------------------------------------------------

function fmEscape(v: string): string {
  return v.includes(':') || v.includes('#') || v.includes('"')
    ? `"${v.replace(/"/g, '\\"')}"`
    : v
}

export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => fmEscape(String(x))).join(', ')}]`)
    } else {
      lines.push(`${k}: ${fmEscape(String(v))}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n')
}

function unquote(s: string): string {
  s = s.trim()
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"')
  return s
}

function parseList(s: string): string[] {
  s = s.trim()
  if (!s.startsWith('[') || !s.endsWith(']')) return s ? [unquote(s)] : []
  const inner = s.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map((x) => unquote(x.trim()))
}

/** Minimal `---\nkey: value\n---\nbody` parser. Returns [data, body]. */
export function parseFrontmatter(md: string): [Record<string, string | string[]>, string] {
  if (!md.startsWith('---')) return [{}, md]
  const end = md.indexOf('\n---', 3)
  if (end === -1) return [{}, md]
  const data: Record<string, string | string[]> = {}
  for (const line of md.slice(3, end).split('\n')) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (!key) continue
    data[key] = val.startsWith('[') ? parseList(val) : unquote(val)
  }
  return [data, md.slice(end + 4).replace(/^\n/, '')]
}

// --- inbox ---------------------------------------------------------------------

export interface InboxWriteInput {
  kind: NoteKind
  raw: string
  projectHint?: string
  source?: NoteSource
  assets?: string[]
}

export function writeInboxItem(
  input: InboxWriteInput,
  paths: VaultPaths = vaultPaths()
): { item: InboxItem; path: string } {
  ensureVault(paths)
  const id = newId('in')
  const createdAt = Date.now()
  const status: NoteStatus = 'inbox'
  const source: NoteSource = input.source ?? 'tray'
  const fm = stringifyFrontmatter({
    id,
    kind: input.kind,
    status,
    created: new Date(createdAt).toISOString(),
    source,
    projectHint: input.projectHint ?? 'auto',
    assets: input.assets ?? []
  })
  const file = join(paths.inboxDir, `${id}.md`)
  writeFileSync(file, `${fm}${input.raw.replace(/\s+$/, '')}\n`, 'utf8')
  return {
    item: {
      id,
      kind: input.kind,
      raw: input.raw,
      assets: input.assets ?? [],
      status,
      projectHint: input.projectHint ?? 'auto',
      createdAt
    },
    path: file
  }
}

export function readInboxItem(id: string, paths: VaultPaths = vaultPaths()): InboxItem | null {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return null
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  const created = typeof fm['created'] === 'string' ? Date.parse(fm['created']) : NaN
  const assets = fm['assets']
  return {
    id: String(fm['id'] ?? id),
    kind: (fm['kind'] as NoteKind) ?? 'text',
    raw: body.replace(/\s+$/, ''),
    assets: Array.isArray(assets) ? assets : [],
    status: (fm['status'] as NoteStatus) ?? 'inbox',
    projectHint: typeof fm['projectHint'] === 'string' ? fm['projectHint'] : 'auto',
    createdAt: Number.isFinite(created) ? created : 0
  }
}

export function setInboxStatus(
  id: string,
  status: NoteStatus,
  paths: VaultPaths = vaultPaths()
): boolean {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return false
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  fm['status'] = status
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) flat[k] = v
  writeFileSync(file, `${stringifyFrontmatter(flat)}${body}`, 'utf8')
  return true
}

export function listInbox(paths: VaultPaths = vaultPaths()): InboxItem[] {
  if (!existsSync(paths.inboxDir)) return []
  const items: InboxItem[] = []
  for (const f of readdirSync(paths.inboxDir)) {
    if (!f.endsWith('.md')) continue
    const item = readInboxItem(basename(f, '.md'), paths)
    if (item) items.push(item)
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

// --- projects ------------------------------------------------------------------

const PROJECT_COLORS = ['#6ea8fe', '#7ee2a8', '#e5a56e', '#c79bfe', '#e5636f', '#6ed3e5']

export function slugToId(slug: string): string {
  return slugify(slug, 32)
}

/** Seed starter folders on first run so the picker + router have somewhere
 * to go. Only for fresh vaults (no .md yet) — adopted vaults keep exactly
 * the folders they already have. */
export function ensureSeedProjects(paths: VaultPaths = vaultPaths()): Project[] {
  ensureVault(paths)
  if (!dirHasMd(paths.root)) {
    for (const name of ['personal', 'work', 'reading']) {
      mkdirSync(join(paths.root, name), { recursive: true })
    }
  }
  return listProjects(paths)
}

/** Dirs that are staging/app-owned, not projects. User folders are never
 * touched — only these reserved names stay out of the project list. */
const RESERVED_DIRS = new Set(['inbox', 'daily', 'assets'])

/** Does this dir tree contain any .md (one level lookahead, skips hidden)? */
function dirHasMd(dir: string): boolean {
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    const n = e.name
    if (n.startsWith('.')) continue
    if (e.isFile() && n.endsWith('.md')) return true
    if (e.isDirectory()) {
      if (dirHasMd(join(dir, n))) return true
    }
  }
  return false
}

export function listProjects(paths: VaultPaths = vaultPaths()): Project[] {
  const found: Project[] = []
  const seen = new Set<string>()
  const push = (name: string, dir: string): void => {
    const id = slugToId(name)
    if (seen.has(id)) return
    seen.add(id)
    found.push({ id, name, dir, color: PROJECT_COLORS[found.length % PROJECT_COLORS.length] })
  }
  // A "project" is just a top-level folder — ours or imported. No app
  // container dir: routed notes land in `<vault>/<name>/` directly.
  // Empty folders count too (fresh seeds start empty).
  if (existsSync(paths.root)) {
    for (const f of readdirSync(paths.root, { withFileTypes: true })) {
      if (!f.isDirectory() || f.name.startsWith('.') || RESERVED_DIRS.has(f.name)) continue
      push(f.name, f.name)
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

export function createProject(name: string, paths: VaultPaths = vaultPaths()): Project {
  const slug = slugify(name, 32)
  if (!slug || slug === 'untitled') throw new Error('project name is empty')
  const dir = join(paths.root, slug)
  mkdirSync(dir, { recursive: true })
  return { id: slugToId(slug), name: slug, dir: slug }
}

// --- processed notes ------------------------------------------------------------

export interface RouteInput {
  inboxId: string
  projectName: string
  title: string
  tags: string[]
  markdown: string
  kind: NoteKind
}

/** Write the processed note into `<vault>/<project>/`, link back to the inbox id. */
export function routeToProject(
  input: RouteInput,
  paths: VaultPaths = vaultPaths()
): { noteId: string; path: string; vaultRel: string } {
  ensureVault(paths)
  const slug = slugify(input.projectName, 32)
  const dir = join(paths.root, slug)
  mkdirSync(dir, { recursive: true })
  const noteId = newId('n')
  const createdAt = Date.now()
  const file = join(dir, `${new Date(createdAt).toISOString().slice(0, 10)}-${slugify(input.title)}.md`)
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    project: slug,
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  })
  writeFileSync(file, `${fm}# ${input.title}\n\n${input.markdown.replace(/\s+$/, '')}\n`, 'utf8')
  return { noteId, path: file, vaultRel: relative(paths.root, file) }
}

/** Undone routings land here (app data) — never as dotfiles inside the vault. */
function undoneDir(): string {
  const data = appDataDir()
  if (!data) throw new Error('app data dir unavailable')
  const dir = join(data, 'undone')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Undo a routing: inbox item back to `inbox`, processed file moved aside. */
export function undoRoute(inboxId: string, paths: VaultPaths = vaultPaths()): boolean {
  // Find processed notes pointing at this inbox id and archive them.
  // Only routed notes carry an `inbox:` frontmatter ref, so walking the
  // vault is safe — user files never match.
  let found = false
  if (!existsSync(paths.root)) return false
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name)
      if (f.isDirectory()) {
        walk(p)
        continue
      }
      if (!f.name.endsWith('.md')) continue
      const [fm] = parseFrontmatter(readFileSync(p, 'utf8'))
      if (fm['inbox'] === inboxId) {
        const trashed = join(undoneDir(), `${inboxId}-${basename(p)}`)
        writeFileSync(trashed, readFileSync(p))
        // Remove the original (raw inbox .md is untouched — nothing lost).
        unlinkSync(p)
        found = true
      }
    }
  }
  walk(paths.root)
  setInboxStatus(inboxId, 'inbox', paths)
  return found
}

// --- assets ---------------------------------------------------------------------

export function saveAsset(
  fileName: string,
  data: Buffer,
  paths: VaultPaths = vaultPaths()
): string {
  ensureVault(paths)
  const now = new Date()
  const dir = join(
    paths.assetsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0')
  )
  mkdirSync(dir, { recursive: true })
  const safe = `${newId('a')}${extname(fileName) || '.bin'}`
  writeFileSync(join(dir, safe), data)
  return relative(paths.root, join(dir, safe))
}

export function resolveAsset(vaultRel: string, paths: VaultPaths = vaultPaths()): string {
  return join(paths.root, vaultRel)
}

// --- live meeting notes ---------------------------------------------------------

const fmtDuration = (sec: number): string => {
  const m = Math.round(sec / 60)
  return m < 1 ? `${Math.round(sec)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * Write a captured meeting as its own note: `<vault>/<folder>/YYYY-MM-DD HHmm Title.md`
 * with `kind: meeting`. Re-saving with `replaceRel` re-titles / re-files it.
 */
export function writeMeetingNote(input: MeetingSaveInput, paths: VaultPaths = vaultPaths()): string {
  ensureVault(paths)
  const folder = input.folder.trim().replace(/^\/+|\/+$/g, '')
  const dir = join(paths.root, folder)
  if (folder) assertInside(paths.root, dir, folder)
  mkdirSync(dir, { recursive: true })
  const started = new Date(input.startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`
  const title = input.title.trim() || 'Meeting'
  const base = `${day} ${pad(started.getHours())}${pad(started.getMinutes())} ${title.replace(/[/\\:]+/g, '-')}`.slice(0, 110)
  const prev = input.replaceRel ? join(paths.root, input.replaceRel) : null
  if (prev) assertInside(paths.root, prev, input.replaceRel as string)
  const name = prev && dirname(prev) === dir && basename(prev) === `${base}.md` ? `${base}.md` : uniqueFile(dir, base, '.md')
  const abs = join(dir, name)
  const fm = stringifyFrontmatter({
    kind: 'meeting',
    created: started.toISOString(),
    duration: fmtDuration(input.durationSec),
    speakers: input.speakers,
    tags: input.tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
  })
  const when = started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const audio = input.audioRel ? `\n![](${input.audioRel})\n` : ''
  const body =
    `# ${title}\n\n> ${when} · ${fmtDuration(input.durationSec)} · ${input.speakers.join(', ')}\n${audio}\n` +
    `## Notes\n\n- \n\n## Actions\n\n- [ ] \n\n## Transcript\n\n${input.transcript.trim() || '_Nothing was transcribed._'}\n`
  writeFileSync(abs, `${fm}${body}`, 'utf8')
  if (prev && prev !== abs && existsSync(prev)) unlinkSync(prev)
  return relative(paths.root, abs)
}

// --- meeting import --------------------------------------------------------------

/** Parse a Teams-exported `.vtt` (or plain transcript) into timestamped lines. */
export function parseVtt(text: string): Array<{ at: string; speaker: string; line: string }> {
  const out: Array<{ at: string; speaker: string; line: string }> = []
  // Drop WEBVTT header + NOTE blocks, then cue blocks.
  const body = text
    .replace(/^WEBVTT.*$/m, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  for (const block of body) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    const first = lines[0] ?? ''
    const at = timeIdx >= 0 ? (lines[timeIdx] ?? '').split('-->')[0]?.trim() ?? '' : ''
    const content = (timeIdx >= 0 ? lines.slice(timeIdx + 1) : lines).join(' ')
    if (!content || /^NOTE/i.test(first)) continue
    const m = /^<v\s+([^>]+)>(.*)<\/v>\s*$/i.exec(content) ?? /^([^:]{1,40}):\s+(.*)$/.exec(content)
    out.push({
      at,
      speaker: m ? m[1]?.trim() ?? '' : '',
      line: m ? (m[2] ?? '').trim() : content
    })
  }
  return out
}

export function meetingToMarkdown(
  cues: Array<{ at: string; speaker: string; line: string }>,
  title: string
): string {
  const attendees = [...new Set(cues.map((c) => c.speaker).filter(Boolean))]
  const transcript = cues
    .map((c) => `- ${c.at ? `**${c.at}** ` : ''}${c.speaker ? `**${c.speaker}:** ` : ''}${c.line}`)
    .join('\n')
  return (
    `> ${title} — captured transcript. Fill in decisions + actions below.\n\n` +
    `## Attendees\n\n${attendees.length > 0 ? attendees.map((a) => `- ${a}`).join('\n') : '- '}\n\n` +
    `## Decisions\n\n- \n\n## Actions\n\n- [ ] \n\n## Transcript\n\n${transcript || '- '}\n`
  )
}
