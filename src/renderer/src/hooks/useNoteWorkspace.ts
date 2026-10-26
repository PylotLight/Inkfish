import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { InboxItem, NoteDoc, NoteEntry } from '../../../shared/types'
import { plain } from '../text'
import { baseOf, dirOf, remapPath, type MoveKind } from '../../../shared/note-move'
import { deleteNeedsConfirm, previewLines, renameCommit } from '../../../shared/note-delete'
import { createAutosave, type Autosave } from '../../../shared/autosave'
import { titleFromMarkdown } from '../../../shared/title-sync'
import { isPopKey } from '../../../shared/mini-window'
import { popOutTitle } from '../../../shared/mini-window-tear'
import type { Prefs } from '../theme'
import type { RowActions } from '../views/FolderTree'
import type { Anchor } from '../views/DeletePopover'
import { loadTabs, TABS_KEY, type Scope, type Selection, type Tab } from '../shell/types'
import { useTitles } from './useTitles'
export interface NoteWorkspaceInput {
  allNotes: NoteEntry[]
  setAllNotes: Dispatch<SetStateAction<NoteEntry[]>>
  allNotesRef: MutableRefObject<NoteEntry[]>
  inbox: InboxItem[]
  titles: Record<string, string>
  setTitles: Dispatch<SetStateAction<Record<string, string>>>
  titleNamedRef: MutableRefObject<Set<string>>
  refreshTitleNamed: () => void
  refreshNotes: () => void
  refreshInbox: () => void
  refreshProjects: () => void
  refreshAll: () => void
  notify: (msg: string) => void
  scope: Scope
  setScope: Dispatch<SetStateAction<Scope>>
  targetDir: string
  setTargetDir: Dispatch<SetStateAction<string>>
  revealDir: string | null
  setRevealDir: Dispatch<SetStateAction<string | null>>
  prefs: Prefs
  settingsOpen: boolean
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
}

/**
 * The note workspace: open tabs, the selected doc, drafts and autosave, plus
 * the title-sync (useTitles) and file-operation (useFileActions) layers.
 * State stays here; the shell only passes data + prefs.
 */
export function useNoteWorkspace(input: NoteWorkspaceInput) {
  const {
    allNotes,
    setAllNotes,
    allNotesRef,
    inbox,
    titles,
    setTitles,
    titleNamedRef,
    refreshTitleNamed,
    refreshNotes,
    refreshInbox,
    refreshProjects,
    refreshAll,
    notify,
    scope,
    setScope,
    targetDir,
    setTargetDir,
    revealDir,
    setRevealDir,
    prefs,
    settingsOpen,
    setSettingsOpen
  } = input

  const [sel, setSel] = useState<Selection>(null)
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  /** Open tabs (notes only) — persisted so files stay open across launches. */
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs().tabs)
  /** Unrestored active tab from storage — opened once notes load. */
  const [pendingActive] = useState<string | null>(() => loadTabs().activeId)
  const [restored, setRestored] = useState(false)
  /** Per-note text not yet confirmed on disk (autosave clears each entry once written). */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** Saved docs by id — tab switches are instant, no IPC per click. */
  const [docsCache, setDocsCache] = useState<Record<string, NoteDoc>>({})
  /** Custom display titles (app config) — filename otherwise. */
  /** "Move to…" folder picker (header breadcrumb, ⌘K, right-click). */
  const [movePick, setMovePick] = useState<{ rel: string; kind: MoveKind; name: string; x: number; y: number } | null>(
    null
  )
  const [prompt, setPrompt] = useState<{
    title: string
    initial: string
    confirm: string
    onSubmit: (v: string) => void
  } | null>(null)
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    confirm: string
    onConfirm: () => void
  } | null>(null)
  /** Sidebar: note id whose row is in inline-rename mode. */
  const [treeRename, setTreeRename] = useState<string | null>(null)
  /** Sidebar: delete glance for a note with real content. */
  const [delAsk, setDelAsk] = useState<{ entry: NoteEntry; title: string; lines: string[]; anchor: Anchor } | null>(
    null
  )
  /** Undo toast after a delete (restores the trash entry). */
  const [undoDel, setUndoDel] = useState<{
    key: number
    message: string
    trashId: string
    rel: string
    wasOpen: boolean
  } | null>(null)
  // Refs so tab callbacks stay stable without re-creating per keystroke.
  const docRef = useRef<NoteDoc | null>(null)
  docRef.current = doc
  const docsCacheRef = useRef<Record<string, NoteDoc>>({})
  docsCacheRef.current = docsCache
  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  const selRef = useRef<Selection>(null)
  selRef.current = sel
  const draftsRef = useRef<Record<string, string>>({})
  draftsRef.current = drafts

  // --- autosave (Obsidian-style: no Save button, nothing is ever "unsaved") ------------------
  /** Set below once its deps exist; the controller calls through these refs. */
  const savedHandlerRef = useRef<(id: string, markdown: string, saved: NoteDoc) => void>(() => undefined)
  const saveErrorRef = useRef<(id: string, err: unknown) => void>(() => undefined)
  /** Title renames in flight: old id → the id it lands under. Saves for the old id wait for it. */
  const renameInflightRef = useRef(new Map<string, Promise<string>>())
  const autosaveRef = useRef<Autosave | null>(null)
  if (!autosaveRef.current) {
    autosaveRef.current = createAutosave<NoteDoc>({
      save: async (id, markdown) => {
        // Typed while this note's file is being renamed: write to where it lands, not the old
        // path (which is gone — that save would fail and the text would wait for the next blur).
        const moving = renameInflightRef.current.get(id)
        const target = moving ? await moving.catch(() => id) : id
        return window.api.notes.save(target, markdown)
      },
      onSaved: (id, markdown, saved) => savedHandlerRef.current(id, markdown, saved),
      onError: (id, err) => saveErrorRef.current(id, err)
    })
  }
  const autosave = autosaveRef.current
  const { baseTitlesRef, titleRenamingRef, renamedAliasRef, titleSync, renameNoteFileRef, renameNote, titleOf } =
    useTitles({
      prefs,
      titles,
      setTitles,
      titleNamedRef,
      notify,
      allNotesRef,
      docRef,
      draftsRef,
      selRef,
      sel,
      doc
    })

  /** Write every pending note now (tab switch, new note, close, blur, quit, ⌘S). */
  const flushAll = useCallback((): Promise<void> => autosave.flushAll(), [autosave])

  const openEntry = useCallback(
    (id: string, origin: 'inbox' | 'note') => {
      // Leaving a note (or re-opening one) writes everything pending first — title renames too.
      titleSync.flush()
      void autosave.flushAll()
      setSel({ id, origin })
      if (origin === 'note') {
        // New notes land next to the note you're in (Obsidian "same folder as current file").
        const p = tabsRef.current.find((t) => t.id === id)?.path ?? allNotesRef.current.find((n) => n.id === id)?.path
        if (p && !p.startsWith('inbox/') && !p.startsWith('daily/')) setTargetDir(dirOf(p))
        // Cache-first: tab switches are instant; refresh in background.
        const cached = docsCacheRef.current[id]
        if (cached) setDoc(cached)
        window.api.notes
          .get(id)
          .then((fresh) => {
            if (!fresh) return
            // A read that raced an autosave of this note is stale — the save result wins.
            if (autosave.pending(id) !== undefined) return
            autosave.noteSaved(id, fresh.markdown)
            setDocsCache((prev) => ({ ...prev, [id]: fresh }))
            if (selRef.current?.id === id) setDoc(fresh)
          })
          .catch(console.error)
        // Keep the file open as a tab (no duplicates).
        setTabs((prev) => {
          if (prev.some((t) => t.id === id)) return prev
          const path = prev.find((t) => t.id === id)?.path ?? allNotesRef.current.find((n) => n.id === id)?.path ?? id
          return [...prev, { id, path, pinned: false }]
        })
      } else {
        const item = inbox.find((i) => i.id === id)
        setDoc(
          item
            ? {
                id: item.id,
                path: `inbox/${item.id}.md`,
                title: plain(item.raw).slice(0, 80) || item.id,
                kind: item.kind,
                status: item.status,
                projectId: null,
                inboxId: item.id,
                tags: [],
                snippet: item.raw.slice(0, 220),
                createdAt: item.createdAt,
                updatedAt: item.createdAt,
                size: item.raw.length,
                markdown: item.raw
              }
            : null
        )
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inbox]
  )

  /** An autosave landed: cache it, follow a moved id, and clear the draft it covered. */
  savedHandlerRef.current = (id: string, markdown: string, saved: NoteDoc): void => {
    setDocsCache((prev) => ({ ...prev, [saved.id]: saved }))
    const dropCovered = (prev: Record<string, string>): Record<string, string> => {
      const cur = prev[id]
      if (cur === undefined) return prev
      const next = { ...prev }
      delete next[id]
      // Typed more while the save was in flight: keep the newer text (moved with the id).
      if (cur !== markdown) next[saved.id] = cur
      return next
    }
    if (saved.id !== id) {
      // Renames (id = path by default) move the doc — follow it.
      autosave.rename(id, saved.id)
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, id: saved.id, path: saved.path } : t)))
      setSel((cur) => (cur?.id === id ? { ...cur, id: saved.id } : cur))
    }
    setDrafts(dropCovered)
    // Only the note on screen — a background flush of the tab we just left must not replace it.
    const shown = docRef.current?.id
    if (shown === id || shown === saved.id) setDoc(saved)
    refreshNotes()
  }
  saveErrorRef.current = (id: string, err: unknown): void => {
    console.error(`[autosave] ${id}:`, err)
    notify(`Couldn't save ${id.split('/').pop() ?? id} — will retry`)
  }

  /** Lift `markdown` as `id`'s live text (shared across tabs and mini windows). */
  const liftDraft = useCallback((id: string, markdown: string) => {
    const saved =
      docsCacheRef.current[id]?.markdown ?? (docRef.current?.id === id ? docRef.current.markdown : undefined)
    setDrafts((prev) => {
      if (markdown === saved) {
        if (prev[id] === undefined) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      return prev[id] === markdown ? prev : { ...prev, [id]: markdown }
    })
  }, [])

  /** A local edit in this window's editor: lift it and autosave it. */
  const handleDraft = useCallback(
    (rawId: string, markdown: string) => {
      // A title rename just moved this note but the editor hasn't re-rendered yet: follow it.
      const alias = renamedAliasRef.current
      const id = alias && alias.from === rawId && docRef.current === alias.doc ? alias.to : rawId
      liftDraft(id, markdown)
      // Inbox captures are shown as their body only (no front matter) — writing that back
      // would strip the capture's metadata, so only vault notes autosave.
      if (selRef.current?.origin === 'note') {
        autosave.schedule(id, markdown)
        if (!baseTitlesRef.current.has(id)) {
          const saved = docsCacheRef.current[id]?.markdown ?? (docRef.current?.id === id ? docRef.current.markdown : '')
          baseTitlesRef.current.set(id, titleFromMarkdown(saved))
        }
        titleSync.schedule(id, markdown)
      }
    },
    [liftDraft, autosave, titleSync]
  )

  // Flush whenever the window stops being the place you type, and on quit/close.
  useEffect(() => {
    const onBlur = (): void => {
      titleSync.flush()
      void autosave.flushAll()
    }
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') void autosave.flushAll()
    }
    // Last chance (window closing / reloading): synchronous, so it can't be cut off.
    const onUnload = (): void => {
      const items = autosave.drain()
      if (items.length > 0) window.api.notes.saveSync(items)
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onUnload)
    const offFlush = window.api.onFlushRequest(() => autosave.flushAll())
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onUnload)
      offFlush()
    }
  }, [autosave, titleSync])

  const selectInbox = useCallback((id: string) => openEntry(id, 'inbox'), [openEntry])

  const selectNote = useCallback(
    (id: string) => {
      setScope('notes')
      openEntry(id, 'note')
    },
    [openEntry]
  )

  /** Set whenever a day note opens so the editor puts the caret at its end, ready to type. */
  const [focusEnd, setFocusEnd] = useState<{ id: string; token: number } | null>(null)
  const focusEndOn = useCallback((id: string) => setFocusEnd((f) => ({ id, token: (f?.token ?? 0) + 1 })), [])

  /** Open today's note (where capture → Today appends land). Creates an empty one on first use. */
  const openToday = useCallback(async (): Promise<void> => {
    try {
      const { vaultRel } = await window.api.daily.today()
      const all = await window.api.notes.list(null)
      setAllNotes(all)
      const found = all.find((n) => n.path === vaultRel)
      if (found) {
        selectNote(found.id)
        focusEndOn(found.id)
      } else {
        notify(`Couldn't find today's note (${vaultRel})`)
      }
    } catch (err: unknown) {
      notify(`Today failed: ${String(err)}`)
    }
  }, [notify, selectNote, focusEndOn])

  /** Delete an inbox capture permanently (routed outputs moved aside, raw removed). */
  const deleteInbox = useCallback(
    (id: string) => {
      const item = inbox.find((i) => i.id === id)
      const preview = item ? plain(item.raw).slice(0, 48) : id
      setConfirm({
        title: 'Delete this capture?',
        body: `“${preview}” will be permanently deleted (routed copies moved aside).`,
        confirm: 'Delete',
        onConfirm: () => {
          window.api.inbox
            .remove(id)
            .then(() => {
              if (sel?.id === id) {
                setSel(null)
                setDoc(null)
              }
              refreshAll()
              notify('Deleted ✓')
            })
            .catch((err: unknown) => notify(`Delete failed: ${String(err)}`))
        }
      })
    },
    [inbox, sel, refreshAll, notify]
  )

  // --- tabs --------------------------------------------------------------------
  const activateNeighbor = useCallback(
    (closedId: string, remaining: Tab[]) => {
      const active = selRef.current
      if (!active || active.id !== closedId) return
      const next = remaining[remaining.length - 1]
      if (next) {
        openEntry(next.id, 'note')
      } else {
        setSel(null)
        setDoc(null)
      }
    },
    [openEntry]
  )

  const removeTab = useCallback(
    (id: string) => {
      const remaining = tabsRef.current.filter((t) => t.id !== id)
      setTabs(remaining)
      activateNeighbor(id, remaining)
    },
    [activateNeighbor]
  )

  const closeTab = useCallback(
    (id: string) => {
      // Autosave: closing writes the tab's text — there is nothing to discard or confirm.
      void autosave.flush(id)
      removeTab(id)
    },
    [removeTab, autosave]
  )

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)))
  }, [])

  /** Close a set of tabs (their pending text is written first). */
  const closeTabsGuarded = useCallback(
    (ids: string[], what: string) => {
      for (const id of ids) void autosave.flush(id)
      const keep = new Set(ids)
      const remaining = tabsRef.current.filter((t) => !keep.has(t.id))
      setTabs(remaining)
      const active = selRef.current
      if (active && keep.has(active.id)) activateNeighbor(active.id, remaining)
      notify(what)
    },
    [activateNeighbor, notify, autosave]
  )

  const closeOthers = useCallback(
    (id: string) => {
      // Pinned tabs survive "close others" (Obsidian-style).
      const victimIds = tabsRef.current.filter((t) => t.id !== id && !t.pinned).map((t) => t.id)
      if (victimIds.length === 0) {
        notify('Nothing else to close')
        return
      }
      closeTabsGuarded(victimIds, `Closed ${victimIds.length} tab${victimIds.length === 1 ? '' : 's'}`)
    },
    [closeTabsGuarded, notify]
  )

  const closeUnpinned = useCallback(() => {
    const victimIds = tabsRef.current.filter((t) => !t.pinned).map((t) => t.id)
    if (victimIds.length === 0) {
      notify('No unpinned tabs')
      return
    }
    closeTabsGuarded(victimIds, `Closed ${victimIds.length} tab${victimIds.length === 1 ? '' : 's'}`)
  }, [closeTabsGuarded, notify])

  // Persist tabs so files stay open across launches.
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeId: sel?.id ?? null }))
    } catch {
      // ignore
    }
  }, [tabs, sel])

  // Reconcile tabs against the note index: follow renames by path, drop gone.
  useEffect(() => {
    if (allNotes.length === 0) return
    setTabs((prev) => {
      if (prev.length === 0) return prev
      const byId = new Map(allNotes.map((n) => [n.id, n]))
      const byPath = new Map(allNotes.map((n) => [n.path, n]))
      let changed = false
      const next: Tab[] = []
      for (const t of prev) {
        const byIdMatch = byId.get(t.id)
        if (byIdMatch) {
          if (byIdMatch.path !== t.path) {
            next.push({ ...t, path: byIdMatch.path })
            changed = true
          } else {
            next.push(t)
          }
          continue
        }
        const byPathMatch = byPath.get(t.path)
        if (byPathMatch) {
          next.push({ ...t, id: byPathMatch.id })
          changed = true
          continue
        }
        changed = true // dropped — file gone
      }
      return changed ? next : prev
    })
  }, [allNotes])

  // Restore the pre-restart session once notes load.
  useEffect(() => {
    if (restored || allNotes.length === 0) return
    setRestored(true)
    if (selRef.current || tabsRef.current.length === 0) return
    const target =
      pendingActive && tabsRef.current.some((t) => t.id === pendingActive)
        ? pendingActive
        : tabsRef.current[tabsRef.current.length - 1]?.id
    if (target) {
      setScope('notes')
      openEntry(target, 'note')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNotes, restored])

  // A paired phone synced: re-read lists (main already re-indexed the files).
  // --- mini windows ------------------------------------------------------------
  // Main tracks the open note so the global mini toggle can pop it out.
  const activeNoteId = sel?.origin === 'note' ? sel.id : null
  useEffect(() => {
    window.api.mini?.setActive(activeNoteId)
  }, [activeNoteId])

  /**
   * Pop a note out to a mini window. Pending text is autosaved (flushed) first so the mini opens on exactly what
   * the tab showed (nothing lost). `tear`: the tab was dragged out of the strip — open it under the
   * pointer and move the tab out of this window (Surffish behaviour); the mini's ⤢ brings it back.
   */
  const popOut = useCallback(
    (id: string | null, opts?: { tear?: boolean }) => {
      if (!id) {
        notify('Open a note to pop it out')
        return
      }
      const run = async (): Promise<void> => {
        // Autosave flush first so the mini opens on exactly what the tab showed (nothing lost).
        await autosave.flush(id)
        if (autosave.pending(id) !== undefined) {
          notify("Couldn't save this note yet, so it stays here — try again in a moment")
          return
        }
        const ok = opts?.tear ? await window.api.mini.tearOut(id) : await window.api.mini.open(id)
        if (!ok) {
          notify('Too many mini windows open — close one first')
          return
        }
        if (opts?.tear) removeTab(id)
      }
      run().catch((err: unknown) => notify(`Mini window failed: ${String(err)}`))
    },
    [notify, removeTab, autosave]
  )
  /** The global show/hide toggle (Settings → Mini Window), for the pop-out tooltips. */
  const [miniShortcut, setMiniShortcut] = useState<string | null>(null)
  useEffect(() => {
    window.api.mini
      ?.settings()
      .then((st) => setMiniShortcut(st.settings.shortcut || null))
      .catch(() => undefined)
  }, [settingsOpen])
  const popTitle = popOutTitle(miniShortcut, navigator.platform.toUpperCase().includes('MAC'))

  // ⌘⇧M pops the open note out to a mini window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPopKey(e)) return
      e.preventDefault()
      popOut(activeNoteId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeNoteId, popOut])

  // A mini handed its note back (⌘⇧M / ⤢ in the mini).
  useEffect(
    () =>
      window.api.mini?.onOpenNote((id) => {
        setSettingsOpen(false)
        selectNote(id)
      }),
    [selectNote]
  )

  // Live sync: text typed in a mini shows up in this note's tab. The mini that typed it owns
  // the save, so any older pending text of ours is dropped rather than written over it.
  useEffect(
    () =>
      window.api.mini?.onDraft(({ id, markdown }) => {
        autosave.cancel(id)
        if (tabsRef.current.some((t) => t.id === id) || selRef.current?.id === id) liftDraft(id, markdown)
      }),
    [liftDraft, autosave]
  )
  // A mini saved: refresh the cached doc and drop the matching draft.
  useEffect(
    () =>
      window.api.mini?.onSaved((saved) => {
        autosave.noteSaved(saved.id, saved.markdown)
        setDocsCache((prev) => (prev[saved.id] ? { ...prev, [saved.id]: saved } : prev))
        if (selRef.current?.id === saved.id) setDoc(saved)
        setDrafts((prev) => {
          if (prev[saved.id] !== saved.markdown) return prev
          const next = { ...prev }
          delete next[saved.id]
          return next
        })
        refreshNotes()
      }),
    [refreshNotes, autosave]
  )

  // Renderer-side open-today: tray → main → `inkfish:open-today` → open daily note.
  useEffect(() => {
    const sub = (window as unknown as { api?: { onOpenToday?: (cb: () => void) => () => void } }).api?.onOpenToday
    if (!sub) return
    return sub(() => {
      void openToday()
    })
  }, [openToday])

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
    sel,
    setSel,
    doc,
    setDoc,
    tabs,
    setTabs,
    pendingActive,
    restored,
    setRestored,
    drafts,
    setDrafts,
    docsCache,
    setDocsCache,
    movePick,
    setMovePick,
    prompt,
    setPrompt,
    confirm,
    setConfirm,
    treeRename,
    setTreeRename,
    delAsk,
    setDelAsk,
    undoDel,
    setUndoDel,
    docRef,
    docsCacheRef,
    tabsRef,
    selRef,
    draftsRef,
    autosave,
    titleSync,
    flushAll,
    openEntry,
    liftDraft,
    handleDraft,
    selectInbox,
    selectNote,
    focusEnd,
    setFocusEnd,
    focusEndOn,
    openToday,
    deleteInbox,
    activateNeighbor,
    removeTab,
    closeTab,
    togglePin,
    closeTabsGuarded,
    closeOthers,
    closeUnpinned,
    activeNoteId,
    popOut,
    popTitle,
    renameNote,
    titleOf,
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
