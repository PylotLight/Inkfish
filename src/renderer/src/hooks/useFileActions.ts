import { useCallback, useMemo } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { NoteDoc, NoteEntry } from '../../../shared/types'
import { baseOf, dirOf, remapPath, type MoveKind } from '../../../shared/note-move'
import { deleteNeedsConfirm, previewLines, renameCommit } from '../../../shared/note-delete'
import type { Autosave } from '../../../shared/autosave'
import type { TitleSyncScheduler } from '../../../shared/title-sync'
import type { RowActions } from '../views/FolderTree'
import type { Anchor } from '../views/DeletePopover'
import type { Selection, Tab } from '../shell/types'

export interface FileActionsInput {
  sel: Selection
  setSel: Dispatch<SetStateAction<Selection>>
  doc: NoteDoc | null
  setDoc: Dispatch<SetStateAction<NoteDoc | null>>
  tabs: Tab[]
  setTabs: Dispatch<SetStateAction<Tab[]>>
  tabsRef: MutableRefObject<Tab[]>
  selRef: MutableRefObject<Selection>
  docsCache: Record<string, NoteDoc>
  setDocsCache: Dispatch<SetStateAction<Record<string, NoteDoc>>>
  docsCacheRef: MutableRefObject<Record<string, NoteDoc>>
  drafts: Record<string, string>
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>
  draftsRef: MutableRefObject<Record<string, string>>
  autosave: Autosave
  renameInflightRef: MutableRefObject<Map<string, Promise<string>>>
  openEntry: (id: string, origin: 'inbox' | 'note') => void
  selectNote: (id: string) => void
  setAllNotes: Dispatch<SetStateAction<NoteEntry[]>>
  allNotesRef: MutableRefObject<NoteEntry[]>
  refreshNotes: () => void
  refreshInbox: () => void
  refreshProjects: () => void
  refreshTitleNamed: () => void
  titleNamedRef: MutableRefObject<Set<string>>
  setTitles: Dispatch<SetStateAction<Record<string, string>>>
  notify: (msg: string) => void
  targetDir: string
  setTargetDir: Dispatch<SetStateAction<string>>
  revealDir: string | null
  setRevealDir: Dispatch<SetStateAction<string | null>>
  setPrompt: (
    prompt: {
      title: string
      initial: string
      confirm: string
      onSubmit: (v: string) => void
    } | null
  ) => void
  setConfirm: (
    confirm: {
      title: string
      body: string
      confirm: string
      onConfirm: () => void
    } | null
  ) => void
  setMovePick: (m: { rel: string; kind: MoveKind; name: string; x: number; y: number } | null) => void
  treeRename: string | null
  setTreeRename: Dispatch<SetStateAction<string | null>>
  setDelAsk: (d: { entry: NoteEntry; title: string; lines: string[]; anchor: Anchor } | null) => void
  setUndoDel: (
    u: {
      key: number
      message: string
      trashId: string
      rel: string
      wasOpen: boolean
    } | null
  ) => void
  docRef: MutableRefObject<NoteDoc | null>
  baseTitlesRef: MutableRefObject<Map<string, string>>
  titleRenamingRef: MutableRefObject<Set<string>>
  renamedAliasRef: MutableRefObject<{ from: string; to: string; doc: NoteDoc | null } | null>
  titleSync: TitleSyncScheduler
  renameNoteFileRef: MutableRefObject<
    (id: string, path: string, title: string, opts: { baseAfter: string; toast?: boolean }) => Promise<string>
  >
  titleOf: (e: { id: string; path: string; title: string }) => string
}

/**
 * Every file operation: create, rename, move, tags, trash + undo, and the
 * sidebar row actions. Pending text is written before anything touches disk.
 */
export function useFileActions(input: FileActionsInput) {
  const {
    sel,
    setSel,
    doc,
    setDoc,
    tabs,
    setTabs,
    tabsRef,
    selRef,
    docsCache,
    setDocsCache,
    docsCacheRef,
    drafts,
    setDrafts,
    draftsRef,
    autosave,
    renameInflightRef,
    openEntry,
    selectNote,
    setAllNotes,
    allNotesRef,
    refreshNotes,
    refreshInbox,
    refreshProjects,
    refreshTitleNamed,
    titleNamedRef,
    setTitles,
    notify,
    targetDir,
    setTargetDir,
    revealDir,
    setRevealDir,
    setPrompt,
    setConfirm,
    setMovePick,
    treeRename,
    setTreeRename,
    setDelAsk,
    setUndoDel,
    docRef,
    baseTitlesRef,
    titleRenamingRef,
    renamedAliasRef,
    titleSync,
    renameNoteFileRef,
    titleOf
  } = input

  // --- file CRUD ---------------------------------------------------------------
  /** File ops act on disk: write pending text first so a rename/trash never strands an edit. */
  const flushBeforeFileOp = (): void => {
    void autosave.flushAll()
  }

  const doCreateFile = useCallback(
    (dirRel: string) => {
      // New note: the one you were typing in is written before the new tab opens.
      void autosave.flushAll()
      window.api.files
        .create(dirRel)
        .then((rel) => {
          notify(`Created ${rel.split('/').pop()}`)
          window.api.notes
            .list(null)
            .then((all) => {
              setAllNotes(all)
              const found = all.find((n) => n.path === rel)
              if (found) selectNote(found.id)
            })
            .catch(console.error)
          refreshInbox()
          refreshProjects()
        })
        .catch((err: unknown) => notify(`Create failed: ${err instanceof Error ? err.message : String(err)}`))
    },
    [notify, refreshInbox, refreshProjects, selectNote, autosave]
  )

  const doCreateFolder = useCallback(() => {
    setPrompt({
      title: `New folder in ${targetDir || '/'}`,
      initial: '',
      confirm: 'Create',
      onSubmit: (v) => {
        const name = v.trim()
        if (!name) return
        window.api.files
          .mkdir(targetDir, name)
          .then((rel) => {
            setRevealDir(rel)
            notify(`Folder ${name} ✓`)
            refreshNotes()
          })
          .catch((err: unknown) => notify(`Failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    })
  }, [targetDir, notify, refreshNotes])

  /**
   * A file/folder moved `rel` → `newRel` on disk (rename, drag & drop, Move to…): ids are paths by
   * default, so every open tab, the open note, cached docs/drafts and the new-note target follow.
   */
  const followPathChange = useCallback(
    (rel: string, newRel: string, all: NoteEntry[], openPath: string | null) => {
      // Marks follow moves (and a hand rename drops one) in main — pick that up.
      refreshTitleNamed()
      const byPath = new Map(all.map((n) => [n.path, n]))
      const idMoves = new Map<string, string>()
      setTabs((prev) =>
        prev.map((t) => {
          const movedPath = remapPath(t.path, rel, newRel)
          if (movedPath === null) return t
          const found = byPath.get(movedPath)
          if (!found) return t
          if (found.id !== t.id) idMoves.set(t.id, found.id)
          return { ...t, id: found.id, path: movedPath }
        })
      )
      const rekey = <T>(prev: Record<string, T>): Record<string, T> => {
        let changed = false
        const next: Record<string, T> = {}
        for (const [k, v] of Object.entries(prev)) {
          const m = remapPath(k, rel, newRel)
          const nk = m !== null && byPath.has(m) ? byPath.get(m)!.id : k
          if (nk !== k) changed = true
          next[nk] = v
        }
        return changed ? next : prev
      }
      setDrafts(rekey)
      setDocsCache(rekey)
      setTargetDir((cur) => remapPath(cur, rel, newRel) ?? cur)
      if (openPath && remapPath(openPath, rel, newRel) !== null) {
        const movedPath = remapPath(openPath, rel, newRel)!
        const found = byPath.get(movedPath)
        if (found) {
          const oldId = selRef.current?.id
          if (oldId && oldId !== found.id) autosave.rename(oldId, found.id)
          setSel({ id: found.id, origin: 'note' })
          setTargetDir(dirOf(movedPath))
          window.api.notes
            .get(found.id)
            .then((fresh) => {
              if (fresh) {
                autosave.noteSaved(fresh.id, fresh.markdown)
                setDocsCache((prev) => ({ ...prev, [found.id]: fresh }))
                setDoc(fresh)
              }
            })
            .catch(console.error)
        } else {
          setSel(null)
          setDoc(null)
        }
      }
    },
    [autosave, refreshTitleNamed]
  )

  /**
   * Rename note `id` (at `path`) in place to `title`'s file name — header inline title and the
   * auto title→filename sync. Pending text is written first; tabs, the open note, drafts, mini
   * windows and links into it follow. `baseAfter` = the title the new name counts as synced from.
   * Resolves to the new path (same path = nothing to do).
   */
  const renameNoteFile = useCallback(
    async (id: string, path: string, title: string, opts: { baseAfter: string; toast?: boolean }): Promise<string> => {
      if (titleRenamingRef.current.has(id)) return path
      titleRenamingRef.current.add(id)
      let landed: (to: string) => void = () => undefined
      try {
        await autosave.flush(id)
        const openPath =
          selRef.current?.origin === 'note'
            ? (docRef.current?.path ?? allNotesRef.current.find((n) => n.id === selRef.current?.id)?.path ?? null)
            : null
        // From here until it lands, saves for `id` wait and then go to the new id.
        renameInflightRef.current.set(id, new Promise<string>((resolve) => (landed = resolve)))
        let res: { rel: string; rewritten: string[] }
        try {
          res = await window.api.files.renameToTitle(path, title)
        } catch (err) {
          landed(id)
          throw err
        }
        if (res.rel === path) {
          landed(id)
          baseTitlesRef.current.set(id, opts.baseAfter)
          // Main may have cleared a display-title override; this also re-renders the header so an
          // inline title that didn't change the name snaps back to it.
          window.api.notes.titles().then(setTitles).catch(console.error)
          return path
        }
        const all = await window.api.notes.list(null)
        setAllNotes(all)
        window.api.notes.titles().then(setTitles).catch(console.error)
        const newId = all.find((n) => n.path === res.rel)?.id ?? res.rel
        landed(newId)
        titleNamedRef.current.delete(path)
        titleNamedRef.current.add(res.rel)
        baseTitlesRef.current.delete(id)
        baseTitlesRef.current.set(newId, opts.baseAfter)
        titleSync.rename(id, newId)
        if (openPath === path) renamedAliasRef.current = { from: id, to: newId, doc: docRef.current }
        followPathChange(path, res.rel, all, openPath)
        // Text typed while the rename was in flight: carry it over and write it to the new path
        // right away (it used to sit unsaved until the next blur).
        autosave.rename(id, newId)
        if (autosave.pending(newId) !== undefined) void autosave.flush(newId)
        if (opts.toast || res.rewritten.length > 0) {
          const links = res.rewritten.length
            ? ` · ${res.rewritten.length} link${res.rewritten.length === 1 ? '' : 's'} updated`
            : ''
          notify(`Renamed → ${baseOf(res.rel)}${links}`)
        }
        return res.rel
      } finally {
        landed(id) // no-op once resolved
        renameInflightRef.current.delete(id)
        titleRenamingRef.current.delete(id)
      }
    },
    [autosave, titleSync, followPathChange, notify]
  )
  renameNoteFileRef.current = renameNoteFile

  /** Move a note/folder into `destDir` ('' = vault root): drag & drop and the folder picker. */
  const doMove = useCallback(
    async (rel: string, kind: MoveKind, destDir: string) => {
      // Pending text first, so the rename never strands an edit at the old path.
      await autosave.flushAll()
      const openPath =
        selRef.current?.origin === 'note'
          ? (docRef.current?.path ?? allNotesRef.current.find((n) => n.id === selRef.current?.id)?.path ?? null)
          : null
      try {
        const res = await window.api.files.moveTo(rel, destDir)
        if (res.rel === rel) return
        const where = destDir || 'vault root'
        const extra = [
          res.renamed ? `as ${baseOf(res.rel)}` : '',
          res.rewritten.length ? `${res.rewritten.length} link${res.rewritten.length === 1 ? '' : 's'} updated` : ''
        ]
          .filter(Boolean)
          .join(' · ')
        notify(`Moved ${baseOf(rel).replace(/\.md$/, '')} → ${where}${extra ? ` (${extra})` : ''}`)
        const all = await window.api.notes.list(null)
        setAllNotes(all)
        window.api.notes.titles().then(setTitles).catch(console.error)
        followPathChange(rel, res.rel, all, openPath)
        setRevealDir(kind === 'dir' ? res.rel : destDir || null)
        refreshInbox()
        refreshProjects()
      } catch (err) {
        notify(`Move failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [autosave, notify, followPathChange, refreshInbox, refreshProjects]
  )

  /** Open the "Move to…" picker for a tree target / the open note (centred under the top bar by default). */
  const openMovePicker = useCallback((rel: string, kind: MoveKind, name: string, x?: number, y?: number) => {
    setMovePick({ rel, kind, name, x: x ?? Math.round(window.innerWidth / 2 - 160), y: y ?? 96 })
  }, [])

  /** Header tag chips → front matter `tags:` (body untouched; pending text written first). */
  const setNoteTags = useCallback(
    async (tags: string[]) => {
      const d = docRef.current
      if (!d || selRef.current?.origin !== 'note') return
      await autosave.flushAll()
      try {
        const saved = await window.api.notes.setTags(d.id, tags)
        if (!saved) {
          notify("Couldn't save tags")
          return
        }
        autosave.noteSaved(saved.id, saved.markdown)
        setDocsCache((prev) => ({ ...prev, [saved.id]: saved }))
        if (docRef.current?.id === d.id) setDoc(saved)
        refreshNotes()
      } catch (err) {
        notify(`Tags failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [autosave, notify, refreshNotes]
  )

  /** Path of the open note (to follow it across a rename/move). */
  const openNotePath = (): string | null =>
    selRef.current?.origin === 'note'
      ? (docRef.current?.path ?? allNotesRef.current.find((n) => n.id === selRef.current?.id)?.path ?? null)
      : null

  /** A hand rename wins over a pending title→filename sync (and ends it: name ≠ title now). */
  const cancelTitleSyncUnder = useCallback(
    (rel: string) => {
      for (const n of allNotesRef.current) if (n.path === rel || n.path.startsWith(`${rel}/`)) titleSync.cancel(n.id)
    },
    [titleSync]
  )

  /**
   * Rename `rel` on disk to `name` and follow it everywhere (tabs, open note, titles). Every hand
   * rename (prompt + sidebar inline) lands here, so it always cancels a pending auto-rename.
   */
  const applyRename = useCallback(
    (rel: string, name: string, openPath: string | null) => {
      cancelTitleSyncUnder(rel)
      window.api.files
        .rename(rel, name)
        .then(({ rel: newRel, rewritten }) => {
          const links = rewritten.length
            ? ` · ${rewritten.length} link${rewritten.length === 1 ? '' : 's'} updated`
            : ''
          notify(`Renamed → ${newRel.split('/').pop()}${links}`)
          window.api.notes
            .list(null)
            .then((all) => {
              setAllNotes(all)
              window.api.notes.titles().then(setTitles).catch(console.error)
              followPathChange(rel, newRel, all, openPath)
            })
            .catch(console.error)
          refreshInbox()
          refreshProjects()
        })
        .catch((err: unknown) => notify(`Rename failed: ${err instanceof Error ? err.message : String(err)}`))
    },
    [notify, refreshInbox, refreshProjects, followPathChange, cancelTitleSyncUnder]
  )

  const doRename = useCallback(
    (rel: string, isDir: boolean) => {
      flushBeforeFileOp()
      // Stop a pending auto-rename from moving the file while the prompt is open.
      cancelTitleSyncUnder(rel)
      const current = rel.split('/').pop() ?? rel
      // Path of the open note before the rename (to follow it across).
      const openPath = openNotePath()
      setPrompt({
        title: isDir ? 'Rename folder' : 'Rename file',
        initial: isDir ? current : current.replace(/\.md$/, ''),
        confirm: 'Rename',
        onSubmit: (v) => applyRename(rel, v, openPath)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyRename, cancelTitleSyncUnder]
  )

  /**
   * Move `rel` to Inkfish's Trash and tidy up: tabs under it close (the open one hands off to a
   * neighbour), the center clears if the open note went. Resolves with the trash entry (for Undo).
   */
  const performTrash = useCallback(
    async (rel: string): Promise<{ id: string; wasOpen: boolean } | null> => {
      // A pending title→filename sync would otherwise try to rename the trashed (or Undo-restored) file.
      cancelTitleSyncUnder(rel)
      await autosave.flushAll()
      const active = selRef.current
      const wasOpen =
        active?.origin === 'note' &&
        (() => {
          const p = openNotePath()
          return p !== null && (p === rel || p.startsWith(`${rel}/`))
        })()
      try {
        const entry = await window.api.files.trash(rel)
        setTreeRename(null)
        // Drop tabs under the trashed path; follow with a neighbor.
        setTabs((prev) => {
          const remaining = prev.filter((t) => t.path !== rel && !t.path.startsWith(`${rel}/`))
          if (remaining.length !== prev.length && active?.origin === 'note') {
            const gone =
              !remaining.some((t) => t.id === active.id) &&
              prev.some((t) => t.id === active.id && (t.path === rel || t.path.startsWith(`${rel}/`)))
            if (gone) {
              const next = remaining[remaining.length - 1]
              if (next) openEntry(next.id, 'note')
              else {
                setSel(null)
                setDoc(null)
              }
            }
          }
          return remaining
        })
        // Clear the center if the open note is gone.
        const all = await window.api.notes.list(null)
        setAllNotes(all)
        const cur = selRef.current
        if (cur?.origin === 'note' && !all.some((n) => n.id === cur.id)) {
          setSel(null)
          setDoc(null)
          setDrafts((d) => {
            if (d[cur.id] === undefined) return d
            const next = { ...d }
            delete next[cur.id]
            return next
          })
        }
        refreshInbox()
        refreshProjects()
        window.api.notes.titles().then(setTitles).catch(console.error)
        return { id: entry.id, wasOpen }
      } catch (err) {
        notify(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autosave, notify, refreshInbox, refreshProjects, openEntry, cancelTitleSyncUnder]
  )

  /** Trash + Undo toast (every delete path ends here). */
  const trashWithUndo = useCallback(
    async (rel: string, name: string) => {
      const res = await performTrash(rel)
      if (!res) return
      setUndoDel({ key: Date.now(), message: `Trashed ${name}`, trashId: res.id, rel, wasOpen: res.wasOpen })
    },
    [performTrash]
  )

  /** Undo: restore the trash entry; reopen it if it was the open note. */
  const undoTrash = useCallback(
    async (u: { trashId: string; rel: string; wasOpen: boolean }) => {
      try {
        const [restored] = await window.api.files.restoreTrash([u.trashId])
        const all = await window.api.notes.list(null)
        setAllNotes(all)
        window.api.notes.titles().then(setTitles).catch(console.error)
        refreshInbox()
        refreshProjects()
        const back = restored ?? u.rel
        notify(`Restored ${back.split('/').pop()?.replace(/\.md$/, '')}`)
        if (u.wasOpen) {
          const found = all.find((n) => n.path === back)
          if (found) selectNote(found.id)
        }
      } catch (err) {
        notify(`Undo failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [notify, refreshInbox, refreshProjects, selectNote]
  )

  const closeUndo = useCallback(() => setUndoDel(null), [])

  /** Folders (and anything that isn't a single note): the modal confirm, then Trash + Undo. */
  const doTrash = useCallback(
    (rel: string, name: string) => {
      flushBeforeFileOp()
      setConfirm({
        title: `Delete ${name}?`,
        body: 'It moves to Trash for 7 days. Restore it any time from Settings › Trash.',
        confirm: 'Move to Trash',
        onConfirm: () => void trashWithUndo(rel, name)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trashWithUndo]
  )

  /** The sidebar row for a note, if it's on screen (anchor for the glance, inline rename target). */
  const rowEl = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.ftree [data-note-id="${CSS.escape(id)}"]`)

  /**
   * Smart note delete: (near-)empty notes go straight to Trash with Undo; real content gets the
   * glance confirm anchored to its row. `skipConfirm` (⇧ / second ⌘⌫) always goes straight through.
   */
  const deleteNote = useCallback(
    async (entry: NoteEntry, anchor: Anchor | null, skipConfirm: boolean) => {
      const name = titleOf(entry)
      if (skipConfirm) {
        setDelAsk(null)
        await trashWithUndo(entry.path, name)
        return
      }
      await autosave.flushAll()
      let md: string | null = null
      try {
        md = (await window.api.notes.get(entry.id))?.markdown ?? null
      } catch {
        md = null
      }
      // Unreadable → treat as content (ask) rather than silently deleting.
      if (md !== null && !deleteNeedsConfirm(md)) {
        await trashWithUndo(entry.path, name)
        return
      }
      const r = anchor ?? rowEl(entry.id)?.getBoundingClientRect() ?? null
      // No row on screen (sidebar hidden / filtered): centred under the top bar.
      const fallback: Anchor = { top: 80, bottom: 80, left: window.innerWidth / 2 - 150, right: window.innerWidth }
      setDelAsk({
        entry,
        title: name,
        lines: md ? previewLines(md) : [],
        anchor: r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : fallback
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [titleOf, autosave, trashWithUndo]
  )

  /** Rename a note: inline in its sidebar row when it's visible, the dialog otherwise. */
  const startNoteRename = useCallback(
    (entry: NoteEntry) => {
      if (rowEl(entry.id)) {
        flushBeforeFileOp()
        cancelTitleSyncUnder(entry.path)
        setTreeRename(entry.id)
      } else doRename(entry.path, false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doRename, cancelTitleSyncUnder]
  )

  const rowActions = useMemo<RowActions>(
    () => ({
      renamingId: treeRename,
      startRename: (entry) => {
        flushBeforeFileOp()
        // Same as the prompt: no auto-rename moving the file under the inline editor.
        cancelTitleSyncUnder(entry.path)
        setTreeRename(entry.id)
      },
      endRename: (entry, value) => {
        setTreeRename(null)
        const name = value === null ? null : renameCommit(entry.path, value)
        if (name) applyRename(entry.path, name, openNotePath())
        // Hand focus back to the row so F2 / ⌘⌫ keep working from the keyboard.
        window.setTimeout(() => rowEl(entry.id)?.querySelector<HTMLButtonElement>('.filerow')?.focus(), 0)
      },
      remove: (entry, anchor, skip) => void deleteNote(entry, anchor, skip)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeRename, applyRename, deleteNote, cancelTitleSyncUnder]
  )

  return {
    flushBeforeFileOp,
    doCreateFile,
    doCreateFolder,
    followPathChange,
    renameNoteFile,
    doMove,
    openMovePicker,
    setNoteTags,
    openNotePath,
    cancelTitleSyncUnder,
    applyRename,
    doRename,
    performTrash,
    trashWithUndo,
    undoTrash,
    closeUndo,
    doTrash,
    rowEl,
    deleteNote,
    startNoteRename,
    rowActions
  }
}
