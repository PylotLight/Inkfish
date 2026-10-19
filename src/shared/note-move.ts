/**
 * Moving notes/folders around the vault: pure path logic shared by the main process (fs move +
 * link rewrite) and the renderer (sidebar drag & drop, folder picker). Vault-relative paths use
 * `/` and never start with one; `''` is the vault root.
 */

import { fuzzyScore } from './command-palette'

export type MoveKind = 'file' | 'dir'

/** Parent dir of a vault rel (`''` for root-level entries). */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/** Last path segment. */
export function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** Is `path` `root` itself or inside it? (`root === ''` contains everything.) */
export function isWithin(path: string, root: string): boolean {
  if (root === '') return true
  return path === root || path.startsWith(`${root}/`)
}

/**
 * Can `src` (a file or dir) be dropped into `destDir`? False for a no-op (already there) and for a
 * folder into itself or one of its own subfolders.
 */
export function canDropInto(src: string, kind: MoveKind, destDir: string): boolean {
  if (!src) return false
  if (dirOf(src) === destDir) return false
  if (kind === 'dir' && isWithin(destDir, src)) return false
  return true
}

/**
 * First free name for `name` given `taken` (case-insensitive, like APFS): `Note.md` → `Note 2.md`
 * → `Note 3.md`; folders `Work` → `Work 2`. Matches the vault's `uniqueFile` convention.
 */
export function uniqueName(name: string, taken: (candidate: string) => boolean, isDir = false): string {
  if (!taken(name)) return name
  const dot = isDir ? -1 : name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 10_000; i++) {
    const next = `${base} ${i}${ext}`
    if (!taken(next)) return next
  }
  return `${base} ${Date.now()}${ext}`
}

/** `path` after moving `oldRel` → `newRel` (file or whole subtree), or null when unaffected. */
export function remapPath(path: string, oldRel: string, newRel: string): string | null {
  if (path === oldRel) return newRel
  if (oldRel && path.startsWith(`${oldRel}/`)) return newRel + path.slice(oldRel.length)
  return null
}

/** Collapse `.`/`..` segments. Null when it climbs out of the vault. */
export function normalizeRel(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

/** Relative path from dir `fromDir` to vault rel `to` (POSIX `path.relative`, vault-scoped). */
export function relativeRel(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split('/') : []
  const b = to ? to.split('/') : []
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const ups = a.slice(i).map(() => '..')
  return [...ups, ...b.slice(i)].join('/')
}

/**
 * Clean a typed folder path for the picker's "new folder" (`Work / Images/` → `Work/Images`).
 * Null when empty or it tries to escape (`..`) / hide (`.git`).
 */
export function cleanFolderPath(input: string): string | null {
  const segs = input
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segs.length === 0) return null
  if (segs.some((s) => s === '.' || s === '..' || s.startsWith('.'))) return null
  return segs.map((s) => s.slice(0, 80)).join('/')
}

/** Every folder that contains a note (ancestors included), sorted. */
export function foldersOf(paths: readonly string[]): string[] {
  const set = new Set<string>()
  for (const p of paths) {
    let d = dirOf(p)
    while (d && !set.has(d)) {
      set.add(d)
      d = dirOf(d)
    }
  }
  return [...set].sort((x, y) => x.localeCompare(y))
}

/**
 * Folder picker ranking: empty query → all folders A→Z; otherwise fuzzy over the full path and
 * the folder's own name (name weighted higher).
 */
export function rankFolders(query: string, folders: readonly string[], limit = 50): string[] {
  const q = query.trim()
  if (!q) return folders.slice(0, limit)
  const scored: Array<{ f: string; s: number }> = []
  for (const f of folders) {
    const byName = fuzzyScore(q, baseOf(f))
    const byPath = fuzzyScore(q, f)
    const s = Math.max(byName === null ? -Infinity : byName * 1.2, byPath ?? -Infinity)
    if (s > -Infinity) scored.push({ f, s })
  }
  return scored.sort((a, b) => b.s - a.s || a.f.localeCompare(b.f)).slice(0, limit).map((x) => x.f)
}

/** Breadcrumb segments for a note's folder: `Work/Images` → [{name:'Work',rel:'Work'}, …]. */
export function breadcrumb(notePath: string): Array<{ name: string; rel: string }> {
  const dir = dirOf(notePath)
  if (!dir) return []
  const parts = dir.split('/')
  return parts.map((name, i) => ({ name, rel: parts.slice(0, i + 1).join('/') }))
}

// --- link rewriting -------------------------------------------------------------------------

export interface LinkRewriteContext {
  /** Where the note lived when its links were written. */
  oldNotePath: string
  /** Where it lives now (same as old for notes that link INTO a moved file). */
  newNotePath: string
  /** Old vault rel → new vault rel for everything that moved (null = didn't move). */
  remap: (oldRel: string) => string | null
  /** Does this vault rel exist now (after the move)? */
  exists: (rel: string) => boolean
  /**
   * Leave a relative link alone when it already resolves from the note's NEW folder (written
   * there, or fixed already). Makes re-applying a move idempotent — used when merging a window's
   * unsaved text that may or may not predate the move.
   */
  keepResolving?: boolean
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
// `[text](dest "title")` / `![alt](<dest with spaces>)`. Dest allows one level of balanced parens.
const LINK_RE = /(!?\[(?:[^\]\\\n]|\\.)*\])\((\s*)(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*)\)/g

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** New destination for one link, or null to leave it untouched. */
function rewriteDest(rawDest: string, ctx: LinkRewriteContext): string | null {
  const angle = rawDest.startsWith('<') && rawDest.endsWith('>')
  const dest = angle ? rawDest.slice(1, -1) : rawDest
  if (!dest || dest.startsWith('#') || dest.startsWith('/') || SCHEME_RE.test(dest)) return null
  const cut = dest.search(/[?#]/)
  const pathPart = cut < 0 ? dest : dest.slice(0, cut)
  const suffix = cut < 0 ? '' : dest.slice(cut)
  if (!pathPart) return null
  const decoded = safeDecode(pathPart)
  const encoded = decoded !== pathPart
  const dotted = decoded.startsWith('./') || decoded.startsWith('../')
  const oldDir = dirOf(ctx.oldNotePath)
  const newDir = dirOf(ctx.newNotePath)

  let next: string | null = null
  // Bare `assets/x.png` resolves vault-root first (see images.ts imageCandidates).
  if (!dotted) {
    const rooted = normalizeRel(decoded)
    if (rooted !== null && (ctx.remap(rooted) !== null || ctx.exists(rooted))) {
      const moved = ctx.remap(rooted)
      if (moved === null || moved === rooted) return null
      next = moved
    }
  }
  if (next === null) {
    if (ctx.keepResolving && oldDir !== newDir) {
      const here = normalizeRel(`${newDir}/${decoded}`)
      if (here !== null && ctx.remap(here) === null && ctx.exists(here)) return null
    }
    const target = normalizeRel(`${oldDir}/${decoded}`)
    if (target === null) return null
    const newTarget = ctx.remap(target) ?? target
    if (!ctx.exists(newTarget)) return null
    let rel = relativeRel(newDir, newTarget)
    if (dotted && decoded.startsWith('./') && !rel.startsWith('../')) rel = `./${rel}`
    if (!rel) return null
    next = rel
  }
  if (next === decoded) return null
  let out = next
  if (angle) return `<${out}${suffix}>`
  if (encoded) out = out.split('/').map((s) => encodeURIComponent(s)).join('/')
  else if (/\s/.test(out)) out = out.replace(/ /g, '%20')
  return out + suffix
}

/**
 * Rewrite relative markdown links/images (`[t](../x.md)`, `![](./pic.png)`, bare `assets/…`)
 * that a move broke, so they point at the same files from the note's new location. Links inside
 * fenced code blocks, URLs, anchors and vault-absolute `/…` paths are left alone, as are links
 * to files that don't exist (we never guess). Returns the new text and how many links changed.
 */
export function rewriteLinks(md: string, ctx: LinkRewriteContext): { text: string; changed: number } {
  let changed = 0
  const parts = md.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part // fenced code
    return part.replace(LINK_RE, (whole, label: string, lead: string, dest: string, tail: string) => {
      const next = rewriteDest(dest, ctx)
      if (next === null) return whole
      changed++
      return `${label}(${lead}${next}${tail})`
    })
  })
  return { text: out.join(''), changed }
}

/** Does the text contain any markdown link at all? Cheap pre-filter before a full rewrite. */
export function hasMarkdownLink(md: string): boolean {
  return /\]\(/.test(md)
}
