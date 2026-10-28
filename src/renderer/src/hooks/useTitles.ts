import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { NoteDoc, NoteEntry } from '../../../shared/types'
import { displayTitle } from '../text'
import {
  autoRenameTarget,
  createTitleSync,
  isTitleSyncPath,
  isUntitledName,
  matchesName,
  sanitizeFileTitle,
  stemOf,
  titleFromMarkdown,
  type TitleSyncScheduler
} from '../../../shared/title-sync'
import type { Prefs } from '../theme'
import type { Selection } from '../shell/types'

export interface TitlesInput {
  prefs: Prefs
  titles: Record<string, string>
  setTitles: Dispatch<SetStateAction<Record<string, string>>>
  titleNamedRef: MutableRefObject<Set<string>>
  notify: (msg: string) => void
  allNotesRef: MutableRefObject<NoteEntry[]>
  docRef: MutableRefObject<NoteDoc | null>
  draftsRef: MutableRefObject<Record<string, string>>
  selRef: MutableRefObject<Selection>
  sel: Selection
  doc: NoteDoc | null
}

/**
 * Filename follows title: the title→filename sync scheduler, display titles,
 * and the rename entry points. The actual file rename lives in useFileActions
 * (it writes pending text first); this hook hands it over via renameNoteFileRef.
 */
export function useTitles(input: TitlesInput) {
  const { prefs, titles, setTitles, titleNamedRef, notify, allNotesRef, docRef, draftsRef, selRef, sel, doc } = input

  // --- filename follows title (Settings → Notes → Name files from title) ----------------------
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  /** Per note: the title its file name was last synced from (or its saved title when first edited). */
  const baseTitlesRef = useRef(new Map<string, string>())
  /** Notes with a title rename in flight. */
  const titleRenamingRef = useRef(new Set<string>())
  /** Edits the editor sends under the old id between a rename landing and it re-rendering. */
  const renamedAliasRef = useRef<{ from: string; to: string; doc: NoteDoc | null } | null>(null)
  const titleSyncRunRef = useRef<(id: string, markdown: string) => void>(() => undefined)
  const titleSyncRef = useRef<TitleSyncScheduler | null>(null)
  if (!titleSyncRef.current)
    titleSyncRef.current = createTitleSync({ run: (id, md) => titleSyncRunRef.current(id, md) })
  const titleSync = titleSyncRef.current
  /** Set once renameNoteFile exists (it's declared further down, after followPathChange). */
  const renameNoteFileRef = useRef<
    (id: string, path: string, title: string, opts: { baseAfter: string; toast?: boolean }) => Promise<string>
  >(async (_id, path) => path)
  const renameNote = useCallback(
    (id: string, title: string) => {
      // Name files from title: the header title IS the file name — rename the file.
      const d = docRef.current
      if (
        prefsRef.current.nameFromTitle &&
        d &&
        d.id === id &&
        selRef.current?.origin === 'note' &&
        isTitleSyncPath(d.path) &&
        title.trim()
      ) {
        const text = draftsRef.current[id] ?? d.markdown
        renameNoteFileRef
          .current(id, d.path, title.trim(), { baseAfter: titleFromMarkdown(text), toast: true })
          .catch((err: unknown) => {
            notify(`Rename failed: ${err instanceof Error ? err.message : String(err)}`)
            window.api.notes.titles().then(setTitles).catch(console.error)
          })
        return
      }
      window.api.notes
        .setTitle(id, title)
        .then((all) => {
          setTitles(all)
          notify(title.trim() ? 'Title saved ✓' : 'Title reset to filename')
        })
        .catch((err: unknown) => notify(`Rename failed: ${String(err)}`))
    },
    [notify, docRef, selRef, draftsRef, setTitles]
  )

  const titleOf = useCallback((e: { id: string; path: string; title: string }) => displayTitle(e, titles), [titles])

  // A note named `Untitled…` that got a custom header title before this setting existed (the old
  // ✎ rename only stored a display title): give the file that name when it's opened.
  const openDocId = sel?.origin === 'note' ? (doc?.id ?? null) : null
  useEffect(() => {
    const d = docRef.current
    if (!prefs.nameFromTitle || !openDocId || !d || d.id !== openDocId) return
    const override = titles[d.id]?.trim()
    if (!override || !isTitleSyncPath(d.path) || !isUntitledName(stemOf(d.path))) return
    renameNoteFileRef
      .current(d.id, d.path, override, {
        baseAfter: titleFromMarkdown(draftsRef.current[d.id] ?? d.markdown)
      })
      .catch((err: unknown) => console.error('[title-sync] untitled migration failed:', err))
  }, [openDocId, titles, prefs.nameFromTitle, docRef, draftsRef])
  /** The debounced title→filename check (see shared/title-sync for the rule). */
  titleSyncRunRef.current = (id: string, markdown: string): void => {
    if (!prefsRef.current.nameFromTitle) return
    if (titleRenamingRef.current.has(id)) {
      // A rename is landing — look again once it has.
      titleSync.schedule(id, markdown)
      return
    }
    const path =
      allNotesRef.current.find((n) => n.id === id)?.path ?? (docRef.current?.id === id ? docRef.current.path : null)
    if (!path) return
    const title = titleFromMarkdown(markdown)
    const base = baseTitlesRef.current.get(id) ?? title
    const target = autoRenameTarget(path, base, title, {
      inkfishNamed: titleNamedRef.current.has(path),
      headingNamed: prefsRef.current.renameHeadingNamed
    })
    if (!target) {
      // Name and title agree (typed back to it, or renamed to match): it follows from here on.
      if (title && matchesName(stemOf(path), sanitizeFileTitle(title))) baseTitlesRef.current.set(id, title)
      return
    }
    renameNoteFileRef
      .current(id, path, title, { baseAfter: title })
      .catch((err: unknown) => console.error('[title-sync] rename failed:', err))
  }

  return {
    prefsRef,
    baseTitlesRef,
    titleRenamingRef,
    renamedAliasRef,
    titleSync,
    renameNoteFileRef,
    renameNote,
    titleOf
  }
}
