import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { InboxItem, MeetingSaveInput, NoteKind, NoteSource, NoteStatus, Project } from '../shared/types'
import { uniqueName } from '../shared/note-move'
import type { InboxRoute } from '../shared/routing'
import { appendToDailyFile, formatEntry, localDay as sharedLocalDay, migrateLegacyDaily } from '../shared/daily'

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

/** Legacy custom display titles (id → title), kept in app data; new explicit titles live in front matter. */
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
// --- notes Inkfish named from their title (app data `title-named.json`) ------------
// "Name files from title" follows Untitled notes and notes Inkfish itself renamed from their
// title — not every imported note that happens to be named after its # heading (that's opt-in).
// The mark is kept by vault rel and follows moves; a hand rename drops it.

function titleNamedPath(): string | null {
  if (!configDir) return null
  return join(configDir, 'title-named.json')
}

export function loadTitleNamed(): string[] {
  try {
    const p = titleNamedPath()
    if (!p || !existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveTitleNamed(list: string[]): string[] {
  const p = titleNamedPath()
  const out = [...new Set(list)].sort()
  if (p) {
    try {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(out, null, 2))
    } catch {
      // best effort: worst case the note stops following its title
    }
  }
  return out
}

/** Mark (or unmark) `rel` as named by Inkfish from its title. */
export function markTitleNamed(rel: string, named: boolean, from?: string): string[] {
  const list = loadTitleNamed().filter((r) => r !== rel && r !== from)
  if (named) list.push(rel)
  return saveTitleNamed(list)
}

/** Carry marks across a move (file or whole dir subtree); `drop` forgets them instead (hand rename of a file). */
export function migrateTitleNamed(oldRel: string, newRel: string, drop = false): string[] {
  const list = loadTitleNamed()
  let changed = false
  const out: string[] = []
  for (const r of list) {
    if (r === oldRel || r.startsWith(`${oldRel}/`)) {
      changed = true
      if (!drop) out.push(newRel + r.slice(oldRel.length))
    } else out.push(r)
  }
  return changed ? saveTitleNamed(out) : list
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

/** Case-fold for comparing names across filesystems. macOS APFS is usually
 * case-insensitive while Android/Linux ext4 is case-sensitive, so `Personal`
 * and `personal` are one dir on Mac but two on Android. The rule below must
 * stay identical to Android's fold — both sides converge on the same survivor. */
function foldName(s: string): string {
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
function childDirNamed(dir: string, name: string, includeHidden = false): string | null {
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
  const resolved = resolveDirRel(dirRel, paths)
  const dir = join(paths.root, resolved)
  assertInside(paths.root, join(paths.root, `${resolved}/x`), `folder ${resolved || '/'}`)
  mkdirSync(dir, { recursive: true })
  const name = uniqueFile(dir, 'Untitled', '.md')
  const abs = join(dir, name)
  writeFileSync(abs, '', 'utf8')
  return relative(paths.root, abs)
}

/** New subfolder. Returns vaultRel. Never forks a case-variant sibling
 * (`Personal` when `personal` exists) — it reuses the existing dir. */
export function createDir(parentRel: string, name: string, paths: VaultPaths = vaultPaths()): string {
  const clean = name
    .trim()
    .replace(/[/\\]+/g, '-')
    .slice(0, 80)
  if (!clean) throw new Error('folder name is empty')
  const parent = resolveDirRel(parentRel, paths)
  const parentAbs = join(paths.root, parent)
  assertInside(paths.root, join(parentAbs, 'x'), `folder ${parent || '/'}`)
  const existing = childDirNamed(parentAbs, clean)
  if (existing) return relative(paths.root, join(parentAbs, existing))
  const abs = join(parentAbs, clean)
  assertInside(paths.root, abs, `folder ${clean}`)
  mkdirSync(abs, { recursive: true })
  return relative(paths.root, abs)
}

/** Rename a file (keeps ext unless newName has one) or dir. Returns new vaultRel. */
export function renamePath(rel: string, newName: string, paths: VaultPaths = vaultPaths()): string {
  const clean = newName
    .trim()
    .replace(/[/\\]+/g, '-')
    .slice(0, 120)
  if (!clean) throw new Error('name is empty')
  const abs = join(paths.root, rel)
  assertInside(paths.root, abs, rel)
  const st = statSync(abs)
  const target = st.isDirectory() ? clean : extname(clean) ? clean : `${clean}.md`
  const dest = join(dirname(abs), target)
  assertInside(paths.root, dest, target)
  if (existsSync(dest)) {
    // A case-only change (`japan` → `Japan`, easy now with inline rename) on a case-insensitive
    // disk (APFS default) finds the file itself under the new spelling: a rename, not a collision.
    const d = statSync(dest)
    const caseOnly = basename(dest) !== basename(abs) && basename(dest).toLowerCase() === basename(abs).toLowerCase()
    if (!(caseOnly && d.ino === st.ino && d.dev === st.dev)) throw new Error(`${target} already exists`)
  }
  renameSync(abs, dest)
  return relative(paths.root, dest)
}

export interface MoveOptions {
  /** Name already taken in the destination: throw (default) or pick `Name 2.md`. */
  onConflict?: 'error' | 'rename'
}

/** Move a file or dir into another folder ('' = root). Returns new vaultRel. */
export function movePath(
  rel: string,
  destDirRel: string,
  paths: VaultPaths = vaultPaths(),
  opts: MoveOptions = {}
): string {
  const abs = join(paths.root, rel)
  assertInside(paths.root, abs, rel)
  if (!existsSync(abs)) throw new Error(`${rel} not found`)
  const resolved = resolveDirRel(destDirRel, paths)
  const destDir = join(paths.root, resolved)
  if (resolved) assertInside(paths.root, destDir, resolved)
  if (destDir === abs || destDir.startsWith(`${abs}/`)) throw new Error('cannot move a folder into itself')
  if (dirname(abs) === destDir) return rel
  mkdirSync(destDir, { recursive: true })
  let name = basename(abs)
  // Case-insensitive like APFS, so Linux/Android never end up with `Note.md` + `note.md`.
  const taken = new Set(readdirSync(destDir).map(foldName))
  if (taken.has(foldName(name))) {
    if (opts.onConflict !== 'rename') throw new Error(`${name} already exists in ${resolved || '/'}`)
    name = uniqueName(name, (n) => taken.has(foldName(n)), statSync(abs).isDirectory())
  }
  const dest = join(destDir, name)
  renameSync(abs, dest)
  return relative(paths.root, dest)
}

// --- case-duplicate healing ------------------------------------------------------
// `Personal` vs `personal`: one dir on case-insensitive APFS, two on
// case-sensitive Android/Linux — sync then fights itself and each side shows
// a different tree. Folding is by plain lowercase on both platforms so the
// merge converges to the same survivor everywhere.

/** Survivor for a case-duplicate group: the already-lowercase member when
 * there is one, else the code-unit-smallest (deterministic everywhere). */
function pickSurvivor(names: string[]): string {
  return names.find((n) => n === foldName(n)) ?? [...names].sort()[0]!
}

function sameBytes(a: string, b: string): boolean {
  try {
    const [x, y] = [readFileSync(a), readFileSync(b)]
    return x.length === y.length && x.equals(y)
  } catch {
    return false
  }
}

/** Move everything from srcDir into dstDir, folding nested case collisions
 * the same way (identical files dedupe, the rest bump to `name 2.md`).
 * Dot entries ride along so the loser vanishes completely. */
function mergeDirInto(srcDir: string, dstDir: string): { files: number } {
  let files = 0
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(srcDir, { withFileTypes: true })
  } catch {
    return { files }
  }
  for (const e of entries) {
    const from = join(srcDir, e.name)
    if (e.isDirectory()) {
      const hit = childDirNamed(dstDir, e.name, true)
      if (hit) {
        files += mergeDirInto(from, join(dstDir, hit)).files
        try {
          rmSync(from, { recursive: true, force: true })
        } catch {
          // keep going
        }
      } else {
        renameSync(from, join(dstDir, e.name))
      }
      continue
    }
    if (!e.isFile()) continue
    const dest = join(dstDir, e.name)
    const hit = existsSync(dest)
      ? e.name
      : ((): string | null => {
          // Case-variant of an existing file?
          let kids: Dirent<string>[]
          try {
            kids = readdirSync(dstDir, { withFileTypes: true })
          } catch {
            return null
          }
          return (
            kids.find((k) => k.isFile() && k.name !== e.name && foldName(k.name) === foldName(e.name))?.name ?? null
          )
        })()
    if (!hit) {
      renameSync(from, dest)
      files++
    } else if (sameBytes(from, join(dstDir, hit))) {
      unlinkSync(from)
    } else {
      const dot = e.name.lastIndexOf('.')
      const base = dot > 0 ? e.name.slice(0, dot) : e.name
      const ext = dot > 0 ? e.name.slice(dot) : ''
      renameSync(from, join(dstDir, uniqueFile(dstDir, base, ext)))
      files++
    }
  }
  return { files }
}

export interface CaseMergeReport {
  dirs: number
  files: number
}

/** Collapse sibling dirs/files that differ only by case, recursively.
 * Survivor spelling is the lowercase fold (or the already-lowercase member),
 * so macOS and Android always agree. Reserved top-level names are skipped.
 * Returns what moved. */
export function mergeCaseDuplicates(root: string): CaseMergeReport {
  const report: CaseMergeReport = { dirs: 0, files: 0 }
  const heal = (dir: string, top: boolean): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirGroups = new Map<string, string[]>()
    const fileGroups = new Map<string, string[]>()
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const key = foldName(e.name)
      if (e.isDirectory()) {
        if (top && RESERVED_DIRS.has(key)) continue
        const arr = dirGroups.get(key) ?? []
        arr.push(e.name)
        dirGroups.set(key, arr)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const arr = fileGroups.get(key) ?? []
        arr.push(e.name)
        fileGroups.set(key, arr)
      }
    }
    for (const [key, names] of dirGroups) {
      if (names.length > 1) {
        const survivor = pickSurvivor(names)
        if (survivor !== key) renameSync(join(dir, survivor), join(dir, key))
        for (const loser of names) {
          if (loser === survivor) continue
          report.files += mergeDirInto(join(dir, loser), join(dir, key)).files
          try {
            rmSync(join(dir, loser), { recursive: true, force: true })
          } catch {
            // keep going
          }
        }
        report.dirs++
      }
    }
    for (const [key, names] of fileGroups) {
      if (names.length < 2) continue
      const survivor = pickSurvivor(names)
      if (survivor !== key) renameSync(join(dir, survivor), join(dir, key))
      for (const loser of names) {
        if (loser === survivor) continue
        const from = join(dir, loser)
        const onto = join(dir, key)
        if (sameBytes(from, onto)) {
          unlinkSync(from)
        } else {
          const dot = loser.lastIndexOf('.')
          const base = dot > 0 ? loser.slice(0, dot) : loser
          const ext = dot > 0 ? loser.slice(dot) : ''
          renameSync(from, join(dir, uniqueFile(dir, base, ext)))
          report.files++
        }
      }
    }
    // Recurse into the surviving layout.
    let next: Dirent<string>[]
    try {
      next = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of next) {
      if (e.isDirectory() && !e.name.startsWith('.')) heal(join(dir, e.name), false)
    }
  }
  heal(root, true)
  return report
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

// Default notes-home folder under ~ (suggested in onboarding, adopted if it already exists).
// A dev profile sets "Inkfish Dev" so it never silently adopts the release app's ~/Inkfish;
// picking that folder in onboarding / Settings is still allowed, it just has to be explicit.
let defaultVaultName = 'Inkfish'

export function setDefaultVaultName(name: string): void {
  defaultVaultName = name.trim() || 'Inkfish'
}

export function defaultVaultRoot(): string {
  return join(homedir(), defaultVaultName)
}

export function resolveVaultRoot(): string {
  const override = process.env['INKFISH_VAULT']
  if (override && override.trim()) return resolve(override)
  return readStoredRoot() ?? defaultVaultRoot()
}

/** Has a vault home been established? Stored choice, env override, or a
 * pre-existing default vault (adopted from earlier versions) all count.
 * False only on true first run — the onboarding wizard must pick first. */
export function vaultConfigured(): boolean {
  if (envManaged()) return true
  if (readStoredRoot()) return true
  return existsSync(defaultVaultRoot())
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
export const localDay = sharedLocalDay

export function dailyFile(
  date: Date = new Date(),
  paths: VaultPaths = vaultPaths()
): { abs: string; vaultRel: string } {
  const day = localDay(date)
  const abs = join(paths.dailyDir, `${day}.md`)
  // Staging rel namespace (`daily/<day>.md`) — stable even though the file
  // lives in app data, so index rows, tree filters, and open-today all agree.
  return { abs, vaultRel: `daily/${day}.md` }
}

function dailyFrontmatter(source: NoteSource | undefined): string {
  return stringifyFrontmatter({ kind: 'daily', created: new Date().toISOString(), source: source ?? 'tray' })
}

/**
 * Make sure the day note exists (front matter only — an empty page, no title H1, no filler) and
 * quietly clean up the old generated body (`# <day>` + `## HH:MM` + `_Day started._`) when that
 * is EXACTLY all the file holds. Anything the user wrote is left alone.
 */
export function ensureDaily(
  date: Date = new Date(),
  paths: VaultPaths = vaultPaths(),
  source?: NoteSource
): { abs: string; vaultRel: string; created: boolean; migrated: boolean } {
  ensureVault(paths)
  const { abs, vaultRel } = dailyFile(date, paths)
  mkdirSync(dirname(abs), { recursive: true })
  if (!existsSync(abs)) {
    writeFileSync(abs, dailyFrontmatter(source), 'utf8')
    return { abs, vaultRel, created: true, migrated: false }
  }
  const migrated = migrateLegacyDaily(readFileSync(abs, 'utf8'), localDay(date))
  if (migrated !== null) {
    writeFileSync(abs, migrated, 'utf8')
    return { abs, vaultRel, created: false, migrated: true }
  }
  return { abs, vaultRel, created: false, migrated: false }
}

/** Append a compact `- HH:MM text` entry to today's day note. Creates the file on first use. */
export function appendDaily(
  raw: string,
  opts: { kind?: NoteKind; date?: Date; source?: NoteSource } = {},
  paths: VaultPaths = vaultPaths()
): { vaultRel: string; path: string } {
  const text = raw.trim()
  if (!text) throw new Error('daily note is empty')
  const at = opts.date ?? new Date()
  const { abs, vaultRel } = ensureDaily(at, paths, opts.source)
  writeFileSync(abs, appendToDailyFile(readFileSync(abs, 'utf8'), formatEntry(text, opts.kind ?? 'text', at)), 'utf8')
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
  return v.includes(':') || v.includes('#') || v.includes('"') ? `"${v.replace(/"/g, '\\"')}"` : v
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
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
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

/** Set or clear a portable display title while preserving other frontmatter and the body verbatim. */
export function setFrontmatterTitle(md: string, title: string): string {
  const value = title.trim()
  if (!md.startsWith('---')) return value ? `---\ntitle: ${JSON.stringify(value)}\n---\n${md}` : md
  const end = md.indexOf('\n---', 3)
  if (end === -1) return value ? `---\ntitle: ${JSON.stringify(value)}\n---\n${md}` : md
  const block = md.slice(0, end + 4).split('\n')
  const tail = md.slice(end + 4)
  let found = false
  const lines = block.flatMap((line) => {
    if (!/^title\s*:/i.test(line)) return [line]
    found = true
    return value ? [`title: ${JSON.stringify(value)}`] : []
  })
  if (value && !found) lines.splice(1, 0, `title: ${JSON.stringify(value)}`)
  if (!value && lines.slice(1, -1).every((line) => !line.trim())) return tail.replace(/^\n/, '')
  return `${lines.join('\n')}${tail}`
}

// --- inbox ---------------------------------------------------------------------

export interface InboxWriteInput {
  kind: NoteKind
  raw: string
  projectHint?: string
  source?: NoteSource
  assets?: string[]
  /** Route the capture popover previewed (`routeKey`), to flag a different outcome at filing. */
  previewed?: string
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
    assets: input.assets ?? [],
    ...(input.previewed ? { routePreview: input.previewed } : {})
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
      createdAt,
      ...(input.previewed ? { previewed: input.previewed } : {})
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
    createdAt: Number.isFinite(created) ? created : 0,
    route: readRoute(fm),
    ...(typeof fm['routePreview'] === 'string' && fm['routePreview'] ? { previewed: fm['routePreview'] } : {})
  }
}

export function setInboxStatus(id: string, status: NoteStatus, paths: VaultPaths = vaultPaths()): boolean {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return false
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  fm['status'] = status
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) flat[k] = v
  writeFileSync(file, `${stringifyFrontmatter(flat)}${body}`, 'utf8')
  return true
}

const ROUTE_KEYS = [
  'routeAction',
  'routeFolder',
  'routeRel',
  'routeReason',
  'routeConfidence',
  'routeProvider',
  'routeSuggested'
] as const

/** Record (or clear, with null) the router's result on the raw inbox capture. */
export function setInboxRoute(id: string, route: InboxRoute | null, paths: VaultPaths = vaultPaths()): boolean {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return false
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) if (!(ROUTE_KEYS as readonly string[]).includes(k)) flat[k] = v
  if (route) {
    flat['routeAction'] = route.action
    flat['routeFolder'] = route.folder
    flat['routeRel'] = route.rel
    flat['routeReason'] = route.reason.replace(/[\r\n]+/g, ' ').slice(0, 200)
    flat['routeConfidence'] = route.confidence.toFixed(2)
    flat['routeProvider'] = route.provider
    flat['routeSuggested'] = route.suggested ? 'true' : 'false'
  }
  writeFileSync(file, `${stringifyFrontmatter(flat)}${body}`, 'utf8')
  return true
}

function readRoute(fm: Record<string, string | string[]>): InboxRoute | undefined {
  const s = (k: string): string => (typeof fm[k] === 'string' ? (fm[k] as string) : '')
  const action = s('routeAction')
  if (action !== 'new' && action !== 'append' && action !== 'review') return undefined
  const conf = Number(s('routeConfidence'))
  return {
    action,
    folder: s('routeFolder'),
    rel: s('routeRel'),
    reason: s('routeReason'),
    confidence: Number.isFinite(conf) ? conf : 0,
    provider: s('routeProvider'),
    suggested: s('routeSuggested') === 'true'
  }
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

/** Dirs that are staging/app-owned, not projects. User folders are never
 * touched — only these reserved names stay out of the project list. */
const RESERVED_DIRS = new Set(['inbox', 'daily', 'assets'])

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
  // Empty folders count too.
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

/** Write the processed note into `<vault>/<folder>/`, link back to the inbox id. */
export function routeToProject(
  input: RouteInput,
  paths: VaultPaths = vaultPaths()
): { noteId: string; path: string; vaultRel: string } {
  ensureVault(paths)
  const folder = input.projectName.trim().replace(/^\/+|\/+$/g, '')
  if (!folder) throw new Error('no folder to file into')
  // Exact folder, else an existing case variant (Personal vs personal); a new one is created as named.
  const rel = existsSync(join(paths.root, folder)) ? folder : resolveDirRel(folder, paths)
  const dir = join(paths.root, rel)
  assertInside(paths.root, dir, folder)
  mkdirSync(dir, { recursive: true })
  const noteId = newId('n')
  const createdAt = Date.now()
  const file = join(dir, `${new Date(createdAt).toISOString().slice(0, 10)}-${slugify(input.title)}.md`)
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    project: slugToId(rel.split('/')[0] ?? rel),
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  })
  writeFileSync(file, `${fm}# ${input.title}\n\n${input.markdown.replace(/\s+$/, '')}\n`, 'utf8')
  return { noteId, path: file, vaultRel: relative(paths.root, file) }
}

/** Hidden markers around an appended capture, so undo/delete can strip just that section. */
export const appendMarker = (inboxId: string): { open: string; close: string } => ({
  open: `<!-- inkfish:inbox ${inboxId} -->`,
  close: `<!-- /inkfish:inbox ${inboxId} -->`
})

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `## 2026-10-23 14:02` in local time. */
export function appendHeading(at: Date): string {
  return `## ${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/**
 * Append a capture to an existing vault note as a dated section wrapped in hidden inbox markers.
 * Front matter and the rest of the note are left byte-for-byte.
 */
export function appendToNote(
  targetRel: string,
  input: { inboxId: string; markdown: string; at?: Date },
  paths: VaultPaths = vaultPaths()
): { path: string; vaultRel: string } {
  const abs = join(paths.root, targetRel)
  assertInside(paths.root, abs, targetRel)
  if (!existsSync(abs)) throw new Error(`${targetRel} not found`)
  const { open, close } = appendMarker(input.inboxId)
  const existing = readFileSync(abs, 'utf8')
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  const section = `${appendHeading(input.at ?? new Date())}\n${open}\n${input.markdown.replace(/\s+$/, '')}\n${close}\n`
  writeFileSync(abs, `${existing}${sep}${section}`, 'utf8')
  return { path: abs, vaultRel: relative(paths.root, abs) }
}

/**
 * Remove an appended section (heading + marked body) from `text`. Returns the stripped text and the
 * removed section, or null when the markers aren't there.
 */
export function stripAppended(text: string, inboxId: string): { text: string; removed: string } | null {
  const { open, close } = appendMarker(inboxId)
  const i = text.indexOf(open)
  if (i === -1) return null
  const j = text.indexOf(close, i)
  if (j === -1) return null
  let start = i
  // Take the dated heading line right above the marker with it.
  const before = text.slice(0, i)
  const m = /(^|\n)(## [^\n]*)\n$/.exec(before)
  if (m) start = before.length - m[2]!.length - 1
  let end = j + close.length
  if (text[end] === '\n') end++
  let head = text.slice(0, start)
  // Drop the blank line the append added in front.
  if (head.endsWith('\n\n')) head = head.slice(0, -1)
  return { text: head + text.slice(end), removed: text.slice(start, end) }
}

/** Undone routings land here (app data) — never as dotfiles inside the vault. */
function undoneDir(): string {
  const data = appDataDir()
  if (!data) throw new Error('app data dir unavailable')
  const dir = join(data, 'undone')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Undo a routing: inbox item back to `inbox`. A note created for it is moved aside (app data); a
 * section appended to an existing note is cut out of that note (and kept aside too). Vault rels it
 * changed are pushed onto `touched` when given (for a targeted reindex).
 */
export function undoRoute(inboxId: string, paths: VaultPaths = vaultPaths(), touched?: string[]): boolean {
  // Only routed notes carry an `inbox:` front matter ref, and only appended sections carry the
  // hidden marker, so walking the vault is safe — user files never match.
  let found = false
  if (!existsSync(paths.root)) return false
  const marker = appendMarker(inboxId).open
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.name.startsWith('.')) continue
      const p = join(dir, f.name)
      if (f.isDirectory()) {
        walk(p)
        continue
      }
      if (!f.name.endsWith('.md')) continue
      const text = readFileSync(p, 'utf8')
      const [fm] = parseFrontmatter(text)
      if (fm['inbox'] === inboxId) {
        const trashed = join(undoneDir(), `${inboxId}-${basename(p)}`)
        writeFileSync(trashed, text)
        // Remove the original (raw inbox .md is untouched — nothing lost).
        unlinkSync(p)
        touched?.push(relative(paths.root, p))
        found = true
      } else if (text.includes(marker)) {
        const cut = stripAppended(text, inboxId)
        if (!cut) continue
        writeFileSync(join(undoneDir(), `${inboxId}-appended-${basename(p)}`), cut.removed)
        writeFileSync(p, cut.text, 'utf8')
        touched?.push(relative(paths.root, p))
        found = true
      }
    }
  }
  walk(paths.root)
  setInboxStatus(inboxId, 'inbox', paths)
  setInboxRoute(inboxId, null, paths)
  return found
}

/** Permanently delete an inbox capture: routed outputs moved aside, raw removed. */
export function deleteInboxItem(inboxId: string, paths: VaultPaths = vaultPaths()): boolean {
  undoRoute(inboxId, paths)
  const file = join(paths.inboxDir, `${inboxId}.md`)
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}

// --- assets ---------------------------------------------------------------------

export function saveAsset(fileName: string, data: Buffer, paths: VaultPaths = vaultPaths()): string {
  ensureVault(paths)
  const now = new Date()
  const dir = join(paths.assetsDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'))
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
  const base = `${day} ${pad(started.getHours())}${pad(started.getMinutes())} ${title.replace(/[/\\:]+/g, '-')}`.slice(
    0,
    110
  )
  const prev = input.replaceRel ? join(paths.root, input.replaceRel) : null
  if (prev) assertInside(paths.root, prev, input.replaceRel as string)
  const name =
    prev && dirname(prev) === dir && basename(prev) === `${base}.md` ? `${base}.md` : uniqueFile(dir, base, '.md')
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
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) continue
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    const first = lines[0] ?? ''
    const at = timeIdx >= 0 ? ((lines[timeIdx] ?? '').split('-->')[0]?.trim() ?? '') : ''
    const content = (timeIdx >= 0 ? lines.slice(timeIdx + 1) : lines).join(' ')
    if (!content || /^NOTE/i.test(first)) continue
    const m = /^<v\s+([^>]+)>(.*)<\/v>\s*$/i.exec(content) ?? /^([^:]{1,40}):\s+(.*)$/.exec(content)
    out.push({
      at,
      speaker: m ? (m[1]?.trim() ?? '') : '',
      line: m ? (m[2] ?? '').trim() : content
    })
  }
  return out
}

export function meetingToMarkdown(cues: Array<{ at: string; speaker: string; line: string }>, title: string): string {
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
