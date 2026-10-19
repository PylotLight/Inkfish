import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { baseOf, dirOf, joinRel, normalizeRel, remapPath, uniqueName } from '../shared/note-move'
import { applyLinkMove, linkNeedles, movedNotes, type LinkMove } from '../shared/link-moves'
import { isTitleSyncPath, sanitizeFileTitle } from '../shared/title-sync'
import { movePath, renamePath, type VaultPaths } from './vault'

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
 * Who might link to what's moving, from the index: every vault note's rel BEFORE the move and the
 * notes whose text mentions any needle (a superset is fine). Called before the fs op.
 */
export interface LinkLookup {
  notes: string[]
  candidates: string[]
}
export type LookupFn = (needles: string[]) => LinkLookup

/**
 * Fallback lookup with no index (tests, first boot): walks the vault and reads every note. The app
 * passes `db.linkLookup` instead, so a rename never reads the whole vault on the main thread.
 */
export function scanLookup(root: string): LookupFn {
  return (needles) => {
    const notes = listMarkdown(root)
    const lower = needles.map((n) => n.toLowerCase())
    const candidates = notes.filter((rel) => {
      try {
        const text = readFileSync(join(root, rel), 'utf8').toLowerCase()
        return lower.some((n) => text.includes(n))
      } catch {
        return false
      }
    })
    return { notes, candidates }
  }
}

export interface LinkFixResult {
  /** Notes whose links were rewritten (vault rels after the move). */
  rewritten: string[]
  /** The move as applied, for merging windows' unsaved text later (see shared/link-moves). */
  move: LinkMove
}

/**
 * The one shared link fix-up after `from` → `to` moved on disk (hand rename, Move to…, title
 * rename): relative markdown links and `[[wikilinks]]` into what moved, plus the moved notes'
 * own relative links. Only `lookup`'s candidates and the moved notes are read — async, so a big
 * vault never blocks the main process.
 */
export async function fixLinksAfterMove(
  root: string,
  from: string,
  to: string,
  moved: ReadonlyArray<{ from: string; to: string }>,
  lookup: LinkLookup
): Promise<LinkFixResult> {
  const move: LinkMove = { from, to, notes: movedNotes(lookup.notes, from, to, moved) }
  const result: LinkFixResult = { rewritten: [], move }
  const exists = (p: string): boolean => existsSync(join(root, p))
  const ownFrom = new Map(moved.map((m) => [m.to, m.from]))
  const targets = new Set<string>(moved.map((m) => m.to))
  for (const c of lookup.candidates) targets.add(remapPath(c, from, to) ?? c)
  await Promise.all(
    [...targets].map(async (rel) => {
      const abs = join(root, rel)
      let text: string
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        return
      }
      const out = applyLinkMove(text, rel, ownFrom.get(rel) ?? null, move, exists)
      if (out === text) return
      await writeFile(abs, out, 'utf8')
      result.rewritten.push(rel)
    })
  )
  result.rewritten.sort()
  return result
}

export interface MoveEntryResult {
  /** New vault rel of the moved file/dir (same as input when nothing moved). */
  rel: string
  /** Picked a `Name 2` because the destination already had the name. */
  renamed: boolean
  /** Old → new vault rel of every markdown note that moved (one, or a folder's worth). */
  moved: Array<{ from: string; to: string }>
  /** Notes whose links were rewritten (new vault rels, moved notes included). */
  rewritten: string[]
  /** The applied move (null when nothing moved) — the save path merges it into stale text. */
  move: LinkMove | null
}

/** Old → new rel of every note a move of `rel` (file or folder) to `next` carried. */
function notesMoved(root: string, rel: string, next: string, isDir: boolean): Array<{ from: string; to: string }> {
  if (isDir) return listMarkdown(root, next).map((to) => ({ from: rel + to.slice(next.length), to }))
  return next.toLowerCase().endsWith('.md') ? [{ from: rel, to: next }] : []
}

/**
 * Move a note or folder into `destDirRel` with Obsidian-style care: a plain fs rename (atomic, never
 * overwrites — a taken name becomes `Name 2.md`), then links fixed up (fixLinksAfterMove): the moved
 * notes' own `./pic.png` / `../x.md` refs, and other notes' relative links and `[[dir/Note]]`
 * wikilinks into what moved. Vault-root refs (`assets/…`) never need touching.
 */
export async function moveEntry(rel: string, destDirRel: string, paths: VaultPaths, lookup: LookupFn = scanLookup(paths.root)): Promise<MoveEntryResult> {
  const root = paths.root
  const isDir = statSync(join(root, rel)).isDirectory()
  const links = lookup(linkNeedles(rel, isDir))
  const next = movePath(rel, destDirRel, paths, { onConflict: 'rename' })
  const result: MoveEntryResult = { rel: next, renamed: baseOf(next) !== baseOf(rel), moved: [], rewritten: [], move: null }
  if (next === rel) return result
  result.moved = notesMoved(root, rel, next, isDir)
  const fix = await fixLinksAfterMove(root, rel, next, result.moved, links)
  result.rewritten = fix.rewritten
  result.move = fix.move
  return result
}

/**
 * Hand rename (sidebar inline rename, Rename… prompt) of a note or folder, in place — then the same
 * link fix-up as a title rename or a move, so `[[Old]]` and `[x](Old.md)` follow the new name.
 */
export async function renameEntry(rel: string, newName: string, paths: VaultPaths, lookup: LookupFn = scanLookup(paths.root)): Promise<MoveEntryResult> {
  const root = paths.root
  const isDir = statSync(join(root, rel)).isDirectory()
  const links = lookup(linkNeedles(rel, isDir))
  const next = renamePath(rel, newName, paths)
  const result: MoveEntryResult = { rel: next, renamed: false, moved: [], rewritten: [], move: null }
  if (next === rel) return result
  result.moved = notesMoved(root, rel, next, isDir)
  const fix = await fixLinksAfterMove(root, rel, next, result.moved, links)
  result.rewritten = fix.rewritten
  result.move = fix.move
  return result
}

export interface TitleRenameResult {
  /** New vault rel (same as input when the name already fit). */
  rel: string
  /** Notes whose links were rewritten (relative markdown links and [[wikilinks]]). */
  rewritten: string[]
  /** The applied move (null when the name already fit). */
  move?: LinkMove | null
}

/**
 * Rename note `rel` (in place, same folder) to the file name for `title`: sanitized, `.md` kept, a
 * taken name becomes `Title 2.md` (case-insensitive, like APFS — but a case-only change of the
 * note's own name is allowed). Then links into it are pointed at the new name (fixLinksAfterMove,
 * candidates from the index). Empty / unusable title → no-op.
 */
export async function renameToTitle(rel: string, title: string, paths: VaultPaths, lookup: LookupFn = scanLookup(paths.root)): Promise<TitleRenameResult> {
  const root = paths.root
  const stem = sanitizeFileTitle(title)
  const res: TitleRenameResult = { rel, rewritten: [], move: null }
  // Vault notes only: inbox/ and daily/ live in staging (not under root), and nothing may climb out.
  if (normalizeRel(rel) !== rel || !isTitleSyncPath(rel)) throw new Error(`can't rename ${rel} to its title`)
  if (!stem) return res
  const abs = join(root, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${rel} not found`)
  const dir = dirOf(rel)
  const ownName = baseOf(rel)
  const fold = (n: string): string => n.normalize('NFC').toLowerCase()
  const want = `${stem}.md`
  if (want.normalize('NFC') === ownName.normalize('NFC')) return res
  // Every OTHER entry in the folder is taken, compared case- and normalization-insensitively (APFS).
  // Only this file's own exact name is excluded: on a case-sensitive disk (Linux, a case-sensitive
  // APFS volume) a `Foo.md` beside our `foo.md` is a different file and must never be overwritten.
  const taken = new Set(readdirSync(join(root, dir)).filter((n) => n !== ownName).map(fold))
  const name = uniqueName(want, (n) => taken.has(fold(n)))
  if (name.normalize('NFC') === ownName.normalize('NFC')) return res
  const next = joinRel(dir, name)
  // Never overwrite: re-check right before the rename. A case/normalization-only change of our own
  // name resolves to this same file on a case-insensitive disk, so only that is let through.
  const nextAbs = join(root, next)
  if (existsSync(nextAbs) && !(fold(name) === fold(ownName) && sameInode(abs, nextAbs))) {
    throw new Error(`${name} already exists`)
  }
  const links = lookup(linkNeedles(rel, false))
  renameSync(abs, nextAbs)
  res.rel = next
  const fix = await fixLinksAfterMove(root, rel, next, [{ from: rel, to: next }], links)
  // The renamed note itself only counts when something besides it pointed at it.
  res.rewritten = fix.rewritten.filter((r) => r !== next)
  res.move = fix.move
  return res
}

/** Same file on disk (a case-only rename on a case-insensitive volume resolves both names to it). */
function sameInode(a: string, b: string): boolean {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}
