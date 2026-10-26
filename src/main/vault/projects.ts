import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '../../shared/types'
import { slugify } from './frontmatter'
import { vaultPaths } from './paths'
import type { VaultPaths } from './types'

// --- projects ------------------------------------------------------------------

const PROJECT_COLORS = ['#6ea8fe', '#7ee2a8', '#e5a56e', '#c79bfe', '#e5636f', '#6ed3e5']

export function slugToId(slug: string): string {
  return slugify(slug, 32)
}

/** Dirs that are staging/app-owned, not projects. User folders are never
 * touched — only these reserved names stay out of the project list. */
export const RESERVED_DIRS = new Set(['inbox', 'daily', 'assets'])

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
