import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseOf, dirOf, hasMarkdownLink, isWithin, joinRel, remapPath, rewriteLinks, uniqueName } from '../shared/note-move'
import { rewriteWikiLinks, sanitizeFileTitle, stemOf } from '../shared/title-sync'
import { movePath, type VaultPaths } from './vault'

export interface MoveEntryResult {
  /** New vault rel of the moved file/dir (same as input when nothing moved). */
  rel: string
  /** Picked a `Name 2` because the destination already had the name. */
  renamed: boolean
  /** Old → new vault rel of every markdown note that moved (one, or a folder's worth). */
  moved: Array<{ from: string; to: string }>
  /** Notes whose links were rewritten (new vault rels, moved notes included). */
  rewritten: string[]
}

const SKIP_DIRS = new Set(['node_modules', 'assets'])

/** Every `.md` under `dirRel` (vault rel), skipping dot dirs and `assets/`. */
export function listMarkdown(root: string, dirRel = ''): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    let entries
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!rel && SKIP_DIRS.has(e.name)) continue
        walk(child)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(child)
    }
  }
  walk(dirRel)
  return out
}

/**
 * Move a note or folder into `destDirRel` with Obsidian-style care: a plain fs rename (atomic, never
 * overwrites — a taken name becomes `Name 2.md`), then relative links fixed up — the moved notes'
 * own `./pic.png` / `../x.md` refs, and other notes' relative links INTO what moved. Vault-root
 * refs (`assets/…`, how captured images are written) never need touching.
 */
export function moveEntry(rel: string, destDirRel: string, paths: VaultPaths): MoveEntryResult {
  const root = paths.root
  const isDir = statSync(join(root, rel)).isDirectory()
  const next = movePath(rel, destDirRel, paths, { onConflict: 'rename' })
  const result: MoveEntryResult = { rel: next, renamed: baseOf(next) !== baseOf(rel), moved: [], rewritten: [] }
  if (next === rel) return result

  if (isDir) {
    for (const to of listMarkdown(root, next)) result.moved.push({ from: rel + to.slice(next.length), to })
  } else if (next.toLowerCase().endsWith('.md')) {
    result.moved.push({ from: rel, to: next })
  }

  const remap = (p: string): string | null => remapPath(p, rel, next)
  const exists = (p: string): boolean => existsSync(join(root, p))
  const rewrite = (fileRel: string, oldNotePath: string): void => {
    const abs = join(root, fileRel)
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      return
    }
    if (!hasMarkdownLink(text)) return
    const r = rewriteLinks(text, { oldNotePath, newNotePath: fileRel, remap, exists })
    if (r.changed > 0 && r.text !== text) {
      writeFileSync(abs, r.text, 'utf8')
      result.rewritten.push(fileRel)
    }
  }

  // 1. The moved notes' own relative links.
  for (const m of result.moved) rewrite(m.to, m.from)

  // 2. Other notes linking into what moved (cheap name pre-filter before parsing).
  const name = baseOf(rel)
  const needles = [name, encodeURIComponent(name), name.replace(/ /g, '%20')]
  const movedSet = new Set(result.moved.map((m) => m.to))
  for (const other of listMarkdown(root)) {
    if (movedSet.has(other) || (isDir && isWithin(other, next))) continue
    let text: string
    try {
      text = readFileSync(join(root, other), 'utf8')
    } catch {
      continue
    }
    if (!needles.some((n) => text.includes(n))) continue
    rewrite(other, other)
  }
  return result
}

export interface TitleRenameResult {
  /** New vault rel (same as input when the name already fit). */
  rel: string
  /** Notes whose links were rewritten (relative markdown links and [[wikilinks]]). */
  rewritten: string[]
}

/**
 * Rename note `rel` (in place, same folder) to the file name for `title`: sanitized, `.md` kept, a
 * taken name becomes `Title 2.md` (case-insensitive, like APFS — but a case-only change of the
 * note's own name is allowed). Then every other note's relative links and `[[wikilinks]]` into it
 * are pointed at the new name. Empty / unusable title → no-op.
 */
export function renameToTitle(rel: string, title: string, paths: VaultPaths): TitleRenameResult {
  const root = paths.root
  const stem = sanitizeFileTitle(title)
  const res: TitleRenameResult = { rel, rewritten: [] }
  if (!stem || !rel.toLowerCase().endsWith('.md')) return res
  const abs = join(root, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${rel} not found`)
  const dir = dirOf(rel)
  const own = baseOf(rel).toLowerCase()
  const want = `${stem}.md`
  if (want === baseOf(rel)) return res
  const taken = new Set(readdirSync(join(root, dir)).map((n) => n.toLowerCase()).filter((n) => n !== own))
  const name = uniqueName(want, (n) => taken.has(n.toLowerCase()))
  if (name === baseOf(rel)) return res
  const next = joinRel(dir, name)
  // Never overwrite: re-check right before the atomic rename (case-only renames hit the same inode).
  if (name.toLowerCase() !== own && existsSync(join(root, next))) throw new Error(`${name} already exists`)
  renameSync(abs, join(root, next))
  res.rel = next

  const remap = (p: string): string | null => remapPath(p, rel, next)
  const exists = (p: string): boolean => existsSync(join(root, p))
  const all = listMarkdown(root)
  const oldStem = stemOf(rel).toLowerCase()
  // Bare [[Old]] only when no other note shares the old name (else it may mean that one).
  const bareUnique = !all.some((p) => p !== next && stemOf(p).toLowerCase() === oldStem)
  const needles = [baseOf(rel), encodeURIComponent(baseOf(rel)), baseOf(rel).replace(/ /g, '%20'), stemOf(rel)]
  for (const other of all) {
    if (other === next) continue
    let text: string
    try {
      text = readFileSync(join(root, other), 'utf8')
    } catch {
      continue
    }
    if (!needles.some((n) => text.includes(n))) continue
    let out = text
    if (hasMarkdownLink(out)) out = rewriteLinks(out, { oldNotePath: other, newNotePath: other, remap, exists }).text
    out = rewriteWikiLinks(out, rel, next, bareUnique).text
    if (out !== text) {
      writeFileSync(join(root, other), out, 'utf8')
      res.rewritten.push(other)
    }
  }
  return res
}
