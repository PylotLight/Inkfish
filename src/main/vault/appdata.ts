import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { slugify } from './frontmatter'
import type { NoteProfile } from './types'

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

export function undoneDir(): string {
  const data = appDataDir()
  if (!data) throw new Error('app data dir unavailable')
  const dir = join(data, 'undone')
  mkdirSync(dir, { recursive: true })
  return dir
}
