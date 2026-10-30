import { mergeKind, type Base, type Manifest, type Op } from './plan'

/**
 * Rename detection for notes whose content changed on the way.
 *
 * `plan()` already turns delete X + add Y of X's exact bytes into a move. A
 * Mac title rename (`# Untitled` → `# Groceries` renames the file to
 * `Groceries.md`) or an edit made right before a sidebar rename changes the
 * bytes too, so the planner sees "X gone, Y new". This pass pairs those back
 * up by looking at the note text: same front matter `id`, or the same body
 * once the title line is ignored.
 *
 * Paired ops become a move plus a pull/push/merge, so the phone keeps one
 * note (open editor, trash, links) instead of trashing X and adding Y. When
 * the side that kept X also edited it, the edit is three-way merged into Y
 * (or saved as a conflict copy), never dropped and never duplicated.
 *
 * The Mac server only sees ordinary `moves` + `writes` it already supports,
 * so this works against any Mac build, and the Mac never runs the planner.
 */

/** `local` = the phone's copy of the path is gone (the Mac renamed it); `remote` = the Mac's. */
type Side = 'local' | 'remote'

export interface Gone {
  path: string
  /** The side where `path` disappeared. */
  side: Side
  /** The other side edited `path` since the last sync (else it still holds the synced text). */
  edited: boolean
}

export interface Added {
  path: string
  /** The side the new path appeared on. */
  side: Side
  hash: string
}

/** Notes only (binary moves are exact-hash and already handled by `plan`). Inbox/day logs are app-named. */
function isNote(path: string): boolean {
  return mergeKind(path) === 'note' && !path.startsWith('inbox/') && !path.startsWith('daily/')
}

/** Candidates for rename pairing in a plan: X gone on one side, Y new on that same side. */
export function renameCandidates(
  ops: Op[],
  local: Manifest,
  remote: Manifest,
  base: Base
): { gone: Gone[]; added: Added[] } {
  const gone: Gone[] = []
  const added: Added[] = []
  for (const o of ops) {
    if (o.op === 'deleteLocal' && isNote(o.path)) gone.push({ path: o.path, side: 'remote', edited: false })
    else if (o.op === 'deleteRemote' && isNote(o.path)) gone.push({ path: o.path, side: 'local', edited: false })
    else if (o.op === 'push' && isNote(o.path)) {
      // Edited here, gone there (edit-beats-delete) — or brand new here.
      if (o.path in base && !remote[o.path]) gone.push({ path: o.path, side: 'remote', edited: true })
      else if (!(o.path in base) && !remote[o.path]) added.push({ path: o.path, side: 'local', hash: o.hash })
    } else if (o.op === 'pull' && isNote(o.path)) {
      if (o.path in base && !local[o.path]) gone.push({ path: o.path, side: 'local', edited: true })
      else if (!(o.path in base) && !local[o.path]) added.push({ path: o.path, side: 'remote', hash: o.hash })
    }
  }
  // X gone on the Mac pairs with Y new on the Mac, and the same on the phone.
  return {
    gone: gone.filter((g) => added.some((a) => a.side === g.side)),
    added: added.filter((a) => gone.some((g) => g.side === a.side))
  }
}

// --- text similarity ------------------------------------------------------------

function fmBlock(md: string): { fm: string; body: string } {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3)
    if (end >= 0) return { fm: md.slice(3, end), body: md.slice(end + 4) }
  }
  return { fm: '', body: md }
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, '$2').trim()
}

function frontId(md: string): string | null {
  const m = /^id:[ \t]*(.+?)[ \t]*$/m.exec(fmBlock(md).fm)
  return m?.[1] ? unquote(m[1]) || null : null
}

/** Body lines that identify a note: front matter, the title heading and blank lines dropped. */
function contentLines(md: string): string[] {
  const lines = fmBlock(md)
    .body.split('\n')
    .map((l) => l.trim())
  const first = lines.findIndex((l) => l !== '')
  if (first >= 0 && /^#\s/.test(lines[first]!)) lines.splice(first, 1)
  return lines.filter((l) => l !== '')
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function stemOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.(md|markdown|txt)$/i, '')
}

/** The note title the way Mac title sync reads it: front matter `title:`, else a leading `# H1`. */
function titleOf(md: string): string {
  const { fm, body } = fmBlock(md)
  const t = /^title:[ \t]*(.+?)[ \t]*$/m.exec(fm)?.[1]
  if (t && unquote(t)) return unquote(t)
  const line = body.split('\n').find((l) => l.trim())
  return /^#[ \t]+(.+)$/.exec(line ?? '')?.[1]?.trim() ?? ''
}

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Is `path`'s file name the note's title (Mac "filename follows title"), allowing a ` 2` suffix? */
function namedAfterTitle(path: string, md: string): boolean {
  const t = fold(titleOf(md))
  if (!t) return false
  const s = fold(stemOf(path))
  return s === t || (s.startsWith(`${t} `) && /^\d+$/.test(s.slice(t.length + 1)))
}

/**
 * How sure we are that `after` (at `toPath`) is `before` (at `fromPath`) renamed: 0 = no,
 * up to 1. A front matter `id` on both sides decides outright.
 */
export function renameScore(fromPath: string, before: string, toPath: string, after: string): number {
  const a = frontId(before),
    b = frontId(after)
  if (a && b) return a === b ? 1 : 0
  const x = contentLines(before),
    y = contentLines(after)
  const titleRename = dirOf(fromPath) === dirOf(toPath) && namedAfterTitle(toPath, after)
  if (!x.length || !y.length) {
    // Nothing but a title: only a same-folder rename to the new title counts, and only
    // when the old name was a placeholder (`Untitled 2`) or the old title.
    if (x.length || y.length > 2 || !titleRename) return 0
    const old = stemOf(fromPath)
    return /^untitled(?: \d+)*$/i.test(old) || namedAfterTitle(fromPath, before) ? 0.6 : 0
  }
  // Dice coefficient over the body lines (multiset).
  const count = new Map<string, number>()
  for (const l of x) count.set(l, (count.get(l) ?? 0) + 1)
  let common = 0
  for (const l of y) {
    const n = count.get(l) ?? 0
    if (n > 0) {
      common++
      count.set(l, n - 1)
    }
  }
  const dice = (2 * common) / (x.length + y.length)
  // Short notes need an exact body unless the new name is the new title.
  const need = Math.min(x.length, y.length) < 3 ? (titleRename ? 0.5 : 1) : titleRename ? 0.4 : 0.6
  return dice >= need ? Math.min(1, dice + (titleRename ? 0.2 : 0)) * 0.95 : 0
}

export interface RenamePair {
  gone: Gone
  added: Added
  score: number
}

/**
 * Best one-to-one pairing of gone notes with notes added on the same side. `text` gives
 * the content to compare: for a gone path its last synced text (or the surviving copy),
 * for an added path its new text. A note with two equally good matches stays unpaired.
 */
export function matchRenames(
  gone: Gone[],
  added: Added[],
  text: (path: string, which: 'gone' | 'added') => string | null
): RenamePair[] {
  const scored: RenamePair[] = []
  for (const g of gone) {
    const before = text(g.path, 'gone')
    if (before === null) continue
    for (const a of added) {
      if (a.side !== g.side) continue
      const after = text(a.path, 'added')
      if (after === null) continue
      const score = renameScore(g.path, before, a.path, after)
      if (score > 0) scored.push({ gone: g, added: a, score })
    }
  }
  const sameDir = (p: RenamePair): number => (dirOf(p.gone.path) === dirOf(p.added.path) ? 1 : 0)
  scored.sort((p, q) => q.score - p.score || sameDir(q) - sameDir(p))
  const out: RenamePair[] = []
  const usedG = new Set<string>()
  const usedA = new Set<string>()
  for (const p of scored) {
    if (usedG.has(p.gone.path) || usedA.has(p.added.path)) continue
    const tie = scored.some(
      (q) =>
        q !== p &&
        q.score === p.score &&
        sameDir(q) === sameDir(p) &&
        ((q.gone.path === p.gone.path && !usedA.has(q.added.path)) ||
          (q.added.path === p.added.path && !usedG.has(q.gone.path)))
    )
    usedG.add(p.gone.path)
    usedA.add(p.added.path)
    if (!tie) out.push(p)
  }
  return out
}

/**
 * Rewrite a plan so each pair is a move plus whatever content change is left:
 *
 * - Mac renamed X→Y, phone untouched:      moveLocal X→Y + pull Y
 * - Mac renamed X→Y, phone edited X:       moveLocal X→Y + merge Y (phone edit vs Mac text)
 * - phone renamed X→Y, Mac untouched:      moveRemote X→Y + push Y
 * - phone renamed X→Y, Mac edited X:       moveRemote X→Y + merge Y (Mac text read from X)
 *
 * Moves go first so the write/merge that follows lands on the moved file. A pull/push of
 * Y's exact old bytes never happens here (`plan` already made those plain moves).
 */
export function applyRenames(ops: Op[], pairs: RenamePair[], local: Manifest, remote: Manifest, base: Base): Op[] {
  if (!pairs.length) return ops
  const drop = new Set<string>()
  const moves: Op[] = []
  const after: Op[] = []
  for (const { gone: g, added: a } of pairs) {
    drop.add(g.path)
    drop.add(a.path)
    const b = base[g.path]
    if (g.side === 'remote') {
      // The Mac renamed it.
      moves.push({ op: 'moveLocal', from: g.path, to: a.path })
      if (!g.edited) after.push({ op: 'pull', path: a.path, hash: a.hash })
      else
        after.push({
          op: 'merge',
          path: a.path,
          kind: 'note',
          local: local[g.path]!.hash,
          remote: a.hash,
          base: b,
          localFrom: g.path
        })
    } else {
      // The phone renamed it.
      moves.push({ op: 'moveRemote', from: g.path, to: a.path })
      if (!g.edited) after.push({ op: 'push', path: a.path, hash: a.hash })
      else
        after.push({
          op: 'merge',
          path: a.path,
          kind: 'note',
          local: a.hash,
          remote: remote[g.path]!.hash,
          base: b,
          remoteFrom: g.path
        })
    }
  }
  const rest = ops.filter((o) => !('path' in o && drop.has(o.path)))
  return [...moves, ...rest, ...after]
}
