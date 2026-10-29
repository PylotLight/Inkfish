import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { InboxItem, NoteDoc, NoteEntry } from '../../../shared/types'
import { plain } from '../text'
import { dirOf, type MoveItem } from '../../../shared/note-move'
import { createAutosave, type Autosave } from '../../../shared/autosave'
import { titleFromMarkdown } from '../../../shared/title-sync'
import { isPopKey } from '../../../shared/mini-window'
import { popOutTitle } from '../../../shared/mini-window-tear'
import type { Prefs } from '../theme'
import type { Anchor } from '../views/DeletePopover'
import { loadTabs, TABS_KEY, GROUP_COLORS, type Scope, type Selection, type Tab, type TabGroup } from '../shell/types'
import { useTitles } from './useTitles'
import { useFileActions } from './useFileActions'

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
  refreshDirs: () => void
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
    refreshDirs,
    refreshAll,
    notify,
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
  const [initialSession] = useState(() => loadTabs())
  /** Open tabs (notes only) — persisted so files stay open across launches. */
  const [tabs, setTabs] = useState<Tab[]>(initialSession.tabs)
  /** Unrestored active tab from storage — opened once notes load. */
  const [pendingActive] = useState<string | null>(initialSession.activeId)
  /** Named, coloured, collapsible tab groups (persisted with the tabs). */
  const [groups, setGroups] = useState<TabGroup[]>(initialSession.groups)
  const [restored, setRestored] = useState(false)
  /** Per-note text not yet confirmed on disk (autosave clears each entry once written). */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** Saved docs by id — tab switches are instant, no IPC per click. */
  const [docsCache, setDocsCache] = useState<Record<string, NoteDoc>>({})
  /** Custom display titles (app config) — filename otherwise. */
  /** "Move to…" folder picker (header breadcrumb, ⌘K, right-click; one or more items). */
  const [movePick, setMovePick] = useState<{ items: MoveItem[]; name: string; x: number; y: number } | null>(null)
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
            // Changed out from under us (a mini window or a phone sync): a worked-on tab.
            const before = docsCacheRef.current[id]
            if (before && fresh.markdown !== before.markdown) markEdited(id)
            autosave.noteSaved(id, fresh.markdown)
            setDocsCache((prev) => ({ ...prev, [id]: fresh }))
            if (selRef.current?.id === id) setDoc(fresh)
          })
          .catch(console.error)
        // Keep the file open as a tab (no duplicates).
        setTabs((prev) => {
          if (prev.some((t) => t.id === id)) return prev
          const path = prev.find((t) => t.id === id)?.path ?? allNotesRef.current.find((n) => n.id === id)?.path ?? id
          return [...prev, { id, path, pinned: false, edited: false }]
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

  /** Mark a tab's note as worked-on this session (persists it across restarts). */
  const markEdited = useCallback((id: string) => {
    setTabs((prev) =>
      prev.some((t) => t.id === id && !t.edited) ? prev.map((t) => (t.id === id ? { ...t, edited: true } : t)) : prev
    )
  }, [])

  /** An autosave landed: cache it, follow a moved id, and clear the draft it covered. */
  savedHandlerRef.current = (id: string, markdown: string, saved: NoteDoc): void => {
    // A draft pending for this id means its text changed since the last save. (Keyed by the
    // id the tab still carries — a rename-in-flight maps it to `saved.id` below.)
    if (draftsRef.current[id] !== undefined) markEdited(id)
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
  const liftDraft = useCallback(
    (id: string, markdown: string) => {
      const saved =
        docsCacheRef.current[id]?.markdown ?? (docRef.current?.id === id ? docRef.current.markdown : undefined)
      // Anything other than the saved text is a change: the tab becomes a "worked-on" tab.
      if (markdown !== saved) markEdited(id)
      setDrafts((prev) => {
        if (markdown === saved) {
          if (prev[id] === undefined) return prev
          const next = { ...prev }
          delete next[id]
          return next
        }
        return prev[id] === markdown ? prev : { ...prev, [id]: markdown }
      })
    },
    [markEdited]
  )

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
    [liftDraft, autosave, titleSync, baseTitlesRef, renamedAliasRef]
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
    [openEntry, setScope]
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
  }, [notify, selectNote, focusEndOn, setAllNotes])

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

  /**
   * Drag-reorder within one container: the pinned run, a group, or the free run.
   * `insertAt` is a position in the container's order with the dragged tab removed.
   */
  const reorderTab = useCallback((id: string, insertAt: number, container: string) => {
    setTabs((prev) => {
      const inContainer = (t: Tab): boolean =>
        container === 'pinned' ? t.pinned : container === 'free' ? !t.pinned && !t.group : t.group === container
      const members = prev.filter(inContainer)
      const from = members.findIndex((t) => t.id === id)
      if (from === -1) return prev
      const to = Math.min(Math.max(insertAt, 0), members.length - 1)
      // Inserting at `from` or `from+1` of the reduced list lands it where it already is.
      if (to === from || to === from + 1) return prev
      const nextMembers = [...members]
      const moved = nextMembers.splice(from, 1)[0]
      if (!moved) return prev
      nextMembers.splice(to, 0, moved)
      // Non-members keep their slots; member slots take the new member order.
      let mi = 0
      return prev.map((t) => (inContainer(t) ? nextMembers[mi++]! : t))
    })
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

  // --- tab groups (named, coloured, collapsible) ----------------------------------------------

  /**
   * A new group around one or more tabs. Named after their shared parent folder when there is
   * exactly one (Work / Personal / …), else "Group N"; a caller-provided name wins.
   */
  const createGroup = useCallback(
    (tabIds: string[], name?: string): string | null => {
      const live = tabsRef.current.filter((t) => tabIds.includes(t.id))
      if (live.length === 0) return null
      const gid = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      let gname = name?.trim()
      if (!gname) {
        const dirs = [...new Set(live.map((t) => dirOf(t.path)).filter(Boolean))]
        gname = dirs.length === 1 ? dirs[0]! : `Group ${groups.length + 1}`
      }
      setGroups((prev) => [
        ...prev,
        { id: gid, name: gname, color: prev.length % GROUP_COLORS.length, collapsed: false }
      ])
      setTabs((prev) => prev.map((t) => (tabIds.includes(t.id) ? { ...t, group: gid } : t)))
      return gid
    },
    [groups.length]
  )

  /** Move a tab into a group; `null` ungroups it. */
  const moveTabToGroup = useCallback((tabId: string, groupId: string | null) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, ...(groupId ? { group: groupId } : { group: undefined }) } : t))
    )
  }, [])

  const renameGroup = useCallback((groupId: string, name: string) => {
    const n = name.trim()
    if (!n) return
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: n } : g)))
  }, [])

  const toggleGroup = useCallback((groupId: string) => {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)))
  }, [])

  /**
   * Click a group header: a collapsed group expands; an expanded one focuses its active tab,
   * or its first tab when none of the group's is active.
   */
  const activateGroup = useCallback(
    (groupId: string) => {
      const g = groups.find((x) => x.id === groupId)
      if (!g) return
      if (g.collapsed) {
        toggleGroup(groupId)
        return
      }
      const members = tabsRef.current.filter((t) => t.group === groupId)
      if (members.length === 0) return
      const active = selRef.current
      if (active?.origin === 'note' && members.some((t) => t.id === active.id)) return
      openEntry(members[0]!.id, 'note')
    },
    [groups, openEntry, toggleGroup]
  )

  /** Remove the group; its tabs stay open, just ungrouped. */
  const removeGroup = useCallback((groupId: string) => {
    setGroups((prev) => prev.filter((g) => g.id !== groupId))
    setTabs((prev) => prev.map((t) => (t.group === groupId ? { ...t, group: undefined } : t)))
  }, [])

  /** Close every non-pinned tab in a group (their pending text is written first). */
  const closeGroupTabs = useCallback(
    (groupId: string) => {
      const name = groups.find((g) => g.id === groupId)?.name ?? 'group'
      const victimIds = tabsRef.current.filter((t) => t.group === groupId && !t.pinned).map((t) => t.id)
      if (victimIds.length === 0) {
        notify(`Nothing in “${name}” to close`)
        return
      }
      closeTabsGuarded(victimIds, `Closed ${victimIds.length} tabs in “${name}”`)
    },
    [closeTabsGuarded, notify, groups]
  )

  // Groups whose members all closed are gone (same pruning as on load).
  useEffect(() => {
    setGroups((prev) => {
      const next = prev.filter((g) => tabs.some((t) => t.group === g.id))
      return next.length === prev.length ? prev : next
    })
  }, [tabs])

  // Persist tabs + groups so files (and their groups) stay open across launches.
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeId: sel?.id ?? null, groups }))
    } catch {
      // ignore
    }
  }, [tabs, sel, groups])

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
    [selectNote, setSettingsOpen]
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

  const {
    flushBeforeFileOp,
    doCreateFile,
    doCreateFolder,
    followPathChange,
    renameNoteFile,
    doMove,
    doMoveMany,
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
  } = useFileActions({
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
    refreshDirs,
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
  })

  return {
    sel,
    setSel,
    doc,
    setDoc,
    tabs,
    setTabs,
    groups,
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
    reorderTab,
    createGroup,
    moveTabToGroup,
    renameGroup,
    toggleGroup,
    activateGroup,
    removeGroup,
    closeGroupTabs,
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
    doMoveMany,
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
