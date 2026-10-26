import * as FileSystem from 'expo-file-system/legacy'
import type { NoteEntry } from '../format'

export const DOC = FileSystem.documentDirectory ?? ''
export const APP = `${DOC}inkfish/`
export const VAULT = `${APP}vault/`
export const STAGING = `${APP}staging/`
export const INBOX = `${STAGING}inbox/`
export const DAILY = `${STAGING}daily/`
export const ASSETS = `${VAULT}assets/`
export const UNDONE = `${STAGING}undone/`

export const noteEntryCache = new Map<string, { size: number; mtime: number; entry: NoteEntry }>()
/** Note id → vault rel from the latest index, so opening a note is one file, not a vault scan. */
export const idToRel = new Map<string, string>()

export function rememberIds(entries: readonly NoteEntry[]): void {
  idToRel.clear()
  for (const e of entries) idToRel.set(e.id, e.path)
}

// --- moves this app knows about (sync renames, phone renames) --------------------
// Notes without a front matter `id` are identified by their path, so an open
// editor loses its note when sync (or the drawer) renames it. Remember recent
// moves so the editor and `saveNote` can follow them.

export const moved = new Map<string, string>()

export function recordMoves(moves: ReadonlyArray<{ from: string; to: string }>): void {
  for (const m of moves) {
    if (m.from === m.to) continue
    moved.set(m.from, m.to)
    moved.delete(m.to)
  }
  // Keep it small: only the latest few hundred matter for open views.
  while (moved.size > 500) moved.delete(moved.keys().next().value as string)
}

/** Where `path` lives now after any recorded moves (itself when it never moved). */
export function followMoves(path: string): string {
  let p = path
  for (let i = 0; i < 20 && moved.has(p); i++) p = moved.get(p)!
  return p
}
