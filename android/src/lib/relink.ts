/**
 * After the phone renames a note, point other notes' links at the new name —
 * the same rewrite the Mac does in `renameToTitle` (src/main/move.ts), using
 * the shared helpers so both apps change the same links the same way:
 *  - `[[Old]]`, `[[Old|alias]]`, `[[Old#heading]]`, `[[dir/Old]]` (+ `.md`)
 *    via `rewriteWikiLinks`; bare `[[Old]]` only when no other note shares the
 *    old name (it might mean that one);
 *  - relative markdown links `[t](Old.md)` / `[t](../dir/Old%20name.md)` via `rewriteLinks`.
 * Pure (no RN / Expo) so it's tested under bun.
 */
import { stemOf, rewriteWikiLinks } from '../../../src/shared/title-sync'
import { hasMarkdownLink, remapPath, rewriteLinks } from '../../../src/shared/note-move'

export interface NoteText {
  path: string
  text: string
}

/**
 * Notes (other than the renamed one) whose text changes after renaming
 * `oldRel` → `newRel`. `notes` = every note in the vault after the rename;
 * `exists` = does a vault path exist now (attachments included).
 */
export function relinkAfterRename(
  notes: readonly NoteText[],
  oldRel: string,
  newRel: string,
  exists: (rel: string) => boolean
): NoteText[] {
  if (oldRel === newRel) return []
  const oldBase = oldRel.slice(oldRel.lastIndexOf('/') + 1)
  const oldStem = stemOf(oldRel).toLowerCase()
  const bareUnique = !notes.some((n) => n.path !== newRel && stemOf(n.path).toLowerCase() === oldStem)
  const needles = [oldBase, encodeURIComponent(oldBase), oldBase.replace(/ /g, '%20'), stemOf(oldRel)]
  const remap = (p: string): string | null => remapPath(p, oldRel, newRel)
  const out: NoteText[] = []
  for (const n of notes) {
    if (n.path === newRel || n.path === oldRel) continue
    if (!needles.some((s) => n.text.includes(s))) continue
    let next = n.text
    if (hasMarkdownLink(next))
      next = rewriteLinks(next, { oldNotePath: n.path, newNotePath: n.path, remap, exists }).text
    next = rewriteWikiLinks(next, oldRel, newRel, bareUnique).text
    if (next !== n.text) out.push({ path: n.path, text: next })
  }
  return out
}
