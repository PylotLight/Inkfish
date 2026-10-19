/**
 * Link fix-ups for one rename / move, as pure text transforms shared by the main process (rewriting
 * the linking notes on disk) and the save path (merging a window's unsaved text that predates the
 * move, so e.g. a mini window's autosave can't put the old links back). Hand renames, Move to… and
 * title→filename renames all go through here.
 */

import { hasMarkdownLink, remapPath, rewriteLinks } from './note-move'
import { rewriteWikiLinks, stemOf } from './title-sync'

/** One moved markdown note and how bare `[[Name]]` links to it are treated. */
export interface MovedNote {
  from: string
  to: string
  /** No other note shares the old name, so a bare `[[Old]]` means this one. */
  bareUnique: boolean
  /** Another note already has the new name: rewritten bare links get the folder path. */
  newAmbiguous: boolean
}

/** A rename/move of `from` → `to` (a note or a folder) and the notes it carried. */
export interface LinkMove {
  from: string
  to: string
  notes: MovedNote[]
}

/**
 * Bare-link flags for each moved note. `before` = every vault note's rel BEFORE the move (the
 * index's view); the flags are judged against the vault after it.
 */
export function movedNotes(
  before: readonly string[],
  from: string,
  to: string,
  moved: ReadonlyArray<{ from: string; to: string }>
): MovedNote[] {
  const after = new Set(before.map((p) => remapPath(p, from, to) ?? p))
  for (const m of moved) after.add(m.to)
  const stems = new Map<string, number>()
  for (const p of after) {
    const k = stemOf(p).toLowerCase()
    stems.set(k, (stems.get(k) ?? 0) + 1)
  }
  return moved.map((m) => {
    const oldStem = stemOf(m.from).toLowerCase()
    const newStem = stemOf(m.to).toLowerCase()
    // The moved note itself is counted once, under its new name.
    const others = (stem: string): number => (stems.get(stem) ?? 0) - (stem === newStem ? 1 : 0)
    return { from: m.from, to: m.to, bareUnique: others(oldStem) === 0, newAmbiguous: others(newStem) > 0 }
  })
}

/** Lowercased strings any note linking into `rel` must contain (cheap index prefilter). */
export function linkNeedles(rel: string, isDir: boolean): string[] {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const out = [name, encodeURIComponent(name), name.replace(/ /g, '%20')]
  if (!isDir) out.push(stemOf(rel))
  return [...new Set(out.map((n) => n.toLowerCase()).filter(Boolean))]
}

/**
 * Apply `move` to the text of the note now at `notePath`. `ownFrom` = where this note lived
 * before the move when it is one of the moved notes (its own relative links move with it), else
 * null. `exists` answers for vault rels after the move. `keepResolving` = idempotent (merge).
 */
export function applyLinkMove(
  text: string,
  notePath: string,
  ownFrom: string | null,
  move: LinkMove,
  exists: (rel: string) => boolean,
  keepResolving = false
): string {
  let out = text
  const remap = (p: string): string | null => remapPath(p, move.from, move.to)
  if (hasMarkdownLink(out)) {
    out = rewriteLinks(out, { oldNotePath: ownFrom ?? notePath, newNotePath: notePath, remap, exists, keepResolving }).text
  }
  if (out.includes('[[')) {
    for (const n of move.notes) {
      if (n.from === n.to) continue
      out = rewriteWikiLinks(out, n.from, n.to, n.bareUnique, n.newAmbiguous).text
    }
  }
  return out
}

/**
 * Merge recent moves into text a window is saving for the note at `notePath`. Text typed before a
 * rename landed (or a mini window that hadn't picked up the rewrite yet) still has the old links,
 * and writing it as-is would undo the fix-up on disk. Idempotent: text that already has the new
 * links is left alone. A move whose old path exists again (a new note took that name) is skipped,
 * so a fresh link to that note is never redirected.
 */
export function mergeLinkMoves(
  text: string,
  notePath: string,
  moves: readonly LinkMove[],
  exists: (rel: string) => boolean
): string {
  let out = text
  for (const m of moves) {
    if (exists(m.from)) continue
    const own = m.notes.find((n) => n.to === notePath)
    out = applyLinkMove(out, notePath, own && own.from !== own.to ? own.from : null, m, exists, true)
  }
  return out
}

/** Recent moves, newest last, capped and aged out (the merge only matters for a short while). */
export function createMoveLog(opts: { max?: number; ttlMs?: number; now?: () => number } = {}): {
  add: (m: LinkMove) => void
  recent: () => LinkMove[]
} {
  const max = opts.max ?? 50
  const ttl = opts.ttlMs ?? 10 * 60_000
  const now = opts.now ?? Date.now
  let log: Array<{ at: number; move: LinkMove }> = []
  const prune = (): void => {
    const cut = now() - ttl
    log = log.filter((e) => e.at >= cut).slice(-max)
  }
  return {
    add(m) {
      if (m.from === m.to) return
      log.push({ at: now(), move: m })
      prune()
    },
    recent() {
      prune()
      return log.map((e) => e.move)
    }
  }
}
