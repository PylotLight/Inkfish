/**
 * How an editor save lands on disk. Pure (no RN / Expo imports) so it's unit
 * tested under bun (`android/test/notesave.test.ts`).
 *
 * Two rules, both about living next to the Mac over sync:
 *
 * 1. Front matter is kept byte-for-byte (same as Mac `keepFrontmatter` in
 *    `src/shared/autosave.ts`). The old save re-serialised it, which dropped
 *    YAML block lists (`tags:\n  - a`), re-quoted values and added an empty
 *    `---\n---` block to every plain note.
 * 2. The editor saves against the text it opened (`base`). If sync changed the
 *    file underneath (a Mac edit pulled while the note was open), the edit is
 *    three-way merged instead of overwriting the Mac's change; a real overlap
 *    keeps the phone's text at the path and the disk version as a conflict
 *    copy, so nothing is lost either way.
 */
import { conflictPath, mergeText } from './sync'

/** Raw front matter block of a file (`---\n…\n---`), '' when it has none. Same detection as `parseFrontmatter`. */
export function frontmatterHead(file: string): string {
  if (!file.startsWith('---')) return ''
  const end = file.indexOf('\n---', 3)
  return end === -1 ? '' : file.slice(0, end + 4)
}

/** Body of a file (front matter removed), matching `parseFrontmatter`'s body. */
export function bodyOf(file: string): string {
  const head = frontmatterHead(file)
  return head ? file.slice(head.length).replace(/^\n/, '') : file
}

/** Normalised body as the editor writes it: trailing whitespace → one newline. */
function tidy(body: string): string {
  return `${body.replace(/\s+$/, '')}\n`
}

/** File text for `body` under `head` (a raw front matter block, or ''). */
export function withHead(head: string, body: string): string {
  return head ? `${head}\n${tidy(body)}` : tidy(body)
}

/** Set a note's display title in its front matter without touching its body or other metadata. */
export function withTitle(head: string, title: string): string {
  const line = `title: ${JSON.stringify(title.trim())}`
  if (!head) return `---\n${line}\n---`
  const lines = head.split('\n')
  let found = false
  const next = lines.map((raw) => {
    if (/^title\s*:/.test(raw)) {
      found = true
      return line
    }
    return raw
  })
  if (!found) next.splice(1, 0, line)
  return next.join('\n')
}

/** New file text for an editor save of `body`, keeping `existing`'s front matter verbatim. */
export function withBody(existing: string, body: string): string {
  return withHead(frontmatterHead(existing), body)
}

function same(a: string, b: string): boolean {
  return a.replace(/\s+$/, '') === b.replace(/\s+$/, '')
}

export interface SavePlan {
  /** Full text to write at the note's path. */
  file: string
  /** The body now in the file (differs from `next` after a merge). */
  body: string
  /** Sync changed the note while it was open and the edits merged cleanly. */
  merged: boolean
  /** Overlapping edits: write `conflict.text` (the disk version) at `conflict.path`. */
  conflict?: { path: string; text: string }
}

/**
 * Plan an editor save. `disk` = the file as it is now, `base` = the body the
 * editor opened (or last saved), `next` = the editor's body.
 */
export function planSave(opts: { path: string; disk: string; base: string; next: string; at?: Date }): SavePlan {
  const { path, disk, base, next } = opts
  const theirs = bodyOf(disk)
  if (same(theirs, base) || same(theirs, next)) {
    return { file: withBody(disk, next), body: next, merged: false }
  }
  const m = mergeText(base, next, theirs)
  if (m.clean) return { file: withBody(disk, m.text), body: m.text, merged: true }
  return {
    file: withBody(disk, next),
    body: next,
    merged: false,
    conflict: { path: conflictPath(path, 'synced copy', opts.at), text: disk }
  }
}

/**
 * The open note vanished from its path (sync moved or deleted it). Where to
 * save: a file whose body is still exactly what the editor opened (a move is
 * a pure rename, content unchanged), else back at the old path (an edit beats
 * a delete, the same rule the sync engine uses).
 */
export function relocate(candidates: Array<{ path: string; body: string }>, base: string, oldPath: string): string {
  if (base.trim()) {
    const hits = candidates.filter((c) => same(c.body, base))
    if (hits.length === 1) return hits[0]!.path
  }
  return oldPath
}
