import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APP_NAME } from '../../shared/config'
import logoUrl from './assets/logo.png'
import type { InboxItem, NoteDoc, NoteEntry, NoteKind, Project, SysInfo, VaultInfo } from '../../shared/types'
import { applyPrefs, loadPrefs, type EditMode, type Prefs } from './theme'
import { displayTitle, plain } from './text'
import Capture from './views/Capture'
import FolderTree, { type KindFilter, type TreeTarget } from './views/FolderTree'
import Home from './views/Home'
import InboxQueue from './views/InboxQueue'
import NoteEditor from './views/NoteEditor'
import Onboarding from './views/Onboarding'
import MeetingImport from './views/MeetingImport'
import SettingsView from './views/Settings'
import { ConfirmModal, CtxMenu, PromptModal, type MenuItem } from './views/Dialogs'

/** Popover windows load the same bundle with `#capture` — render capture only. */
export function isCaptureWindow(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.location.hash === '#capture' || window.location.hash === '#capture-daily')
  )
}

type Selection = { id: string; origin: 'inbox' | 'note' } | null
type Scope = 'home' | 'notes' | 'inbox'

/** Open-note tab (notes only — inbox docs are ephemeral, never tabbed). */
interface Tab {
  id: string
  path: string
  pinned: boolean
}

const TABS_KEY = 'inkfish.tabs.v1'

function loadTabs(): { tabs: Tab[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return { tabs: [], activeId: null }
    const data = JSON.parse(raw) as { tabs?: Tab[]; activeId?: unknown }
    const tabs = Array.isArray(data.tabs)
      ? data.tabs
        .filter((t) => t && typeof t.id === 'string' && typeof t.path === 'string')
        .map((t) => ({ id: t.id, path: t.path, pinned: t.pinned === true }))
        .slice(0, 30)
      : []
    return { tabs, activeId: typeof data.activeId === 'string' ? data.activeId : null }
  } catch {
    return { tabs: [], activeId: null }
  }
}

const KINDS: Array<{ id: KindFilter; name: string }> = [
  { id: 'all', name: 'All' },
  { id: 'text', name: 'Text' },
  { id: 'voice', name: 'Voice' },
  { id: 'image', name: 'Image' },
  { id: 'meeting', name: 'Meeting' }
]

interface MenuState {
  x: number
  y: number
  target: TreeTarget | { kind: 'open-note' } | { kind: 'tab'; id: string }
}

export default function App(): React.JSX.Element {
  if (isCaptureWindow()) {
    return (
      <div className="capture-shell">
        <Capture />
      </div>
    )
  }
  return <Main />
}

function Main(): React.JSX.Element {
  const [sys, setSys] = useState<SysInfo | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [allNotes, setAllNotes] = useState<NoteEntry[]>([])
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [scope, setScope] = useState<Scope>('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsReturn, setSettingsReturn] = useState<Scope>('home')
  const [kind, setKind] = useState<KindFilter>('all')
  /** Dir new files/folders land in ('' = vault root). Set by clicking a folder. */
  const [targetDir, setTargetDir] = useState('')
  const [revealDir, setRevealDir] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection>(null)
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  /** Open tabs (notes only) — persisted so files stay open across launches. */
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs().tabs)
  /** Unrestored active tab from storage — opened once notes load. */
  const [pendingActive] = useState<string | null>(() => loadTabs().activeId)
  const [restored, setRestored] = useState(false)
  /** Unsaved per-tab edits — the source of dirtiness, survives tab switches. */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** Saved docs by id — tab switches are instant, no IPC per click. */
  const [docsCache, setDocsCache] = useState<Record<string, NoteDoc>>({})
  const [openMode, setOpenMode] = useState<{ id: string; mode: EditMode } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NoteEntry[] | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [ostep, setOstep] = useState(0)
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null)
  const [showMeeting, setShowMeeting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [backend, setBackend] = useState('…')
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
  /** Custom display titles (app config) — filename otherwise. */
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [prompt, setPrompt] = useState<{ title: string; initial: string; confirm: string; onSubmit: (v: string) => void } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; confirm: string; onConfirm: () => void } | null>(null)
  /** Collapsible core sidebar (Blobfish-style) — persisted, toggled from the topbar. */
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('inkfish.side.collapsed') === '1'
    } catch {
      return false
    }
  })

  // Dirtiness is derived from lifted drafts (per-tab, survives switches).
  const dirty = sel !== null && drafts[sel.id] !== undefined
  const dirtyCount = Object.keys(drafts).length

  // Refs so tab callbacks stay stable without re-creating per keystroke.
  const allNotesRef = useRef<NoteEntry[]>([])
  allNotesRef.current = allNotes
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

  useEffect(() => {
    applyPrefs(prefs)
  }, [prefs])

  useEffect(() => {
    try {
      localStorage.setItem('inkfish.side.collapsed', sideCollapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [sideCollapsed])

  // ⌘\ toggles the sidebar (Obsidian/Blobfish-style).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setSideCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Quick font size adjustment: Ctrl+Scroll / pinch inside the note stage
  // scales content type only (UI chrome untouched), like Obsidian.
  useEffect(() => {
    if (!prefs.quickZoom) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      const el = e.target as HTMLElement | null
      if (!el?.closest?.('.note-stage')) return
      e.preventDefault()
      setPrefs((prev) => {
        const delta = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0
        if (!delta) return prev
        const next = Math.min(28, Math.max(11, prev.fontSize + delta))
        return next === prev.fontSize ? prev : { ...prev, fontSize: next }
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [prefs.quickZoom])

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }, [])

  const refreshInbox = useCallback(() => {
    window.api.inbox
      .list()
      .then((items) => {
        setInbox(items)
        const pending = items.filter((i) => i.status === 'inbox' || i.status === 'processing').length
        void window.api.dock.setBadge(pending).catch(() => undefined)
      })
      .catch(console.error)
  }, [])

  const refreshProjects = useCallback(() => {
    window.api.projects.list().then(setProjects).catch(console.error)
  }, [])

  // One fetch for every note — navigation is client-side, no IPC per click.
  const refreshNotes = useCallback(() => {
    window.api.notes.list(null).then(setAllNotes).catch(console.error)
  }, [])

  const refreshAll = useCallback(() => {
    refreshInbox()
    refreshNotes()
    refreshProjects()
    window.api.notes.titles().then(setTitles).catch(console.error)
  }, [refreshInbox, refreshNotes, refreshProjects])

  useEffect(() => {
    window.api.sys.info().then(setSys).catch(console.error)
    window.api.vault
      .info()
      .then((v) => {
        setVaultInfo(v)
        setBackend('…')
        if (!v.configured) {
          setOstep(0)
          setShowOnboarding(true)
          return
        }
        window.api.vault.backend().then(setBackend).catch(console.error)
        refreshInbox()
        refreshProjects()
        refreshNotes()
        window.api.notes.titles().then(setTitles).catch(console.error)
        // 7-day trash sweep on launch (hook point for the future scheduler).
        window.api.files
          .purgeTrash()
          .then((n) => {
            if (n > 0) notify(`Trash swept — ${n} item${n === 1 ? '' : 's'} older than 7 days deleted`)
          })
          .catch(console.error)
        // Restore blur preference (main resets to default on launch).
        if (!loadPrefs().blur) window.api.glass.set(null).catch(() => undefined)
        if (!localStorage.getItem('inkfish.onboarded')) {
          setOstep(0)
          setShowOnboarding(true)
        }
      })
      .catch(console.error)
  }, [refreshInbox, refreshNotes, refreshProjects, notify])

  // Search-as-you-type lives in the sidebar; results replace the tree.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null)
      return
    }
    const t = window.setTimeout(() => {
      window.api.notes.search(query.trim()).then(setResults).catch(console.error)
    }, 180)
    return () => window.clearTimeout(t)
  }, [query])

  const openEntry = useCallback(
    (id: string, origin: 'inbox' | 'note') => {
      setSel({ id, origin })
      if (origin === 'note') {
        // Cache-first: tab switches are instant; refresh in background.
        const cached = docsCacheRef.current[id]
        if (cached) {
          setDoc(cached)
          window.api.notes
            .get(id)
            .then((fresh) => {
              if (fresh) {
                setDocsCache((prev) => ({ ...prev, [id]: fresh }))
                if (selRef.current?.id === id) setDoc(fresh)
              }
            })
            .catch(console.error)
        } else {
          window.api.notes
            .get(id)
            .then((fresh) => {
              if (fresh) {
                setDocsCache((prev) => ({ ...prev, [id]: fresh }))
                if (selRef.current?.id === id) setDoc(fresh)
              }
            })
            .catch(console.error)
        }
        // Keep the file open as a tab (no duplicates).
        setTabs((prev) => {
          if (prev.some((t) => t.id === id)) return prev
          const path =
            prev.find((t) => t.id === id)?.path ?? allNotesRef.current.find((n) => n.id === id)?.path ?? id
          return [...prev, { id, path, pinned: false }]
        })
      } else {
        const item = inbox.find((i) => i.id === id)
        setDoc(
          item
            ? {
                id: item.id, path: `inbox/${item.id}.md`, title: plain(item.raw).slice(0, 80) || item.id,
                kind: item.kind, status: item.status, projectId: null, inboxId: item.id,
                tags: [], snippet: item.raw.slice(0, 220), createdAt: item.createdAt,
                updatedAt: item.createdAt, size: item.raw.length, markdown: item.raw
              }
            : null
        )
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inbox]
  )

  const saveDoc = useCallback(
    (id: string, markdown: string) => {
      window.api.notes
        .save(id, markdown)
        .then((saved) => {
          if (saved) {
            setDocsCache((prev) => ({ ...prev, [saved.id]: saved }))
            // Renames (id = path by default) move the doc — follow it.
            if (saved.id !== id) {
              setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, id: saved.id, path: saved.path } : t)))
              setDrafts((prev) => {
                if (prev[id] === undefined) return prev
                const next = { ...prev }
                delete next[id]
                return next
              })
              setSel((cur) => (cur?.id === id ? { ...cur, id: saved.id } : cur))
            } else {
              setDrafts((prev) => {
                if (prev[id] === undefined) return prev
                const next = { ...prev }
                delete next[id]
                return next
              })
            }
            setDoc(saved)
            if (sel?.origin === 'note') refreshNotes()
            else refreshAll()
            notify('Saved ✓')
          }
        })
        .catch((err: unknown) => notify(`Save failed: ${String(err)}`))
    },
    [sel, refreshNotes, refreshAll, notify]
  )

  /** Lifted unsaved text per tab — typing never loses edits on switch. */
  const handleDraft = useCallback((id: string, markdown: string) => {
    const saved = docsCacheRef.current[id]?.markdown ?? (docRef.current?.id === id ? docRef.current.markdown : undefined)
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

  const onVaultReady = useCallback(
    (v: VaultInfo) => {
      setVaultInfo(v)
      window.api.vault.backend().then(setBackend).catch(console.error)
      refreshAll()
    },
    [refreshAll]
  )

  const selectInbox = useCallback((id: string) => openEntry(id, 'inbox'), [openEntry])

  const selectNote = useCallback(
    (id: string, mode?: EditMode) => {
      setScope('notes')
      if (mode) setOpenMode({ id, mode })
      openEntry(id, 'note')
    },
    [openEntry]
  )

  // --- tabs --------------------------------------------------------------------
  const activateNeighbor = useCallback((closedId: string, remaining: Tab[]) => {
    const active = selRef.current
    if (!active || active.id !== closedId) return
    const next = remaining[remaining.length - 1]
    if (next) {
      openEntry(next.id, 'note')
    } else {
      setSel(null)
      setDoc(null)
    }
  }, [openEntry])

  const removeTab = useCallback((id: string) => {
    const remaining = tabsRef.current.filter((t) => t.id !== id)
    setTabs(remaining)
    activateNeighbor(id, remaining)
  }, [activateNeighbor])

  const closeTab = useCallback((id: string) => {
    if (draftsRef.current[id] !== undefined) {
      setConfirm({
        title: 'Close without saving?',
        body: 'This tab has unsaved changes. They will be discarded.',
        confirm: 'Discard changes',
        onConfirm: () => {
          setDrafts((d) => {
            const next = { ...d }
            delete next[id]
            return next
          })
          removeTab(id)
        }
      })
      return
    }
    removeTab(id)
  }, [removeTab])

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)))
  }, [])

  /** Close a set of tabs; blocked when any of them is dirty (save first). */
  const closeTabsGuarded = useCallback((ids: string[], what: string) => {
    const dirtyClosing = ids.filter((id) => draftsRef.current[id] !== undefined)
    if (dirtyClosing.length > 0) {
      notify(`Unsaved changes in ${dirtyClosing.length} tab${dirtyClosing.length === 1 ? '' : 's'} — save first`)
      return
    }
    const keep = new Set(ids)
    const remaining = tabsRef.current.filter((t) => !keep.has(t.id))
    setTabs(remaining)
    const active = selRef.current
    if (active && keep.has(active.id)) activateNeighbor(active.id, remaining)
    notify(what)
  }, [activateNeighbor, notify])

  const closeOthers = useCallback((id: string) => {
    // Pinned tabs survive "close others" (Obsidian-style).
    const victimIds = tabsRef.current.filter((t) => t.id !== id && !t.pinned).map((t) => t.id)
    if (victimIds.length === 0) {
      notify('Nothing else to close')
      return
    }
    closeTabsGuarded(victimIds, `Closed ${victimIds.length} tab${victimIds.length === 1 ? '' : 's'}`)
  }, [closeTabsGuarded, notify])

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
    const target = (pendingActive && tabsRef.current.some((t) => t.id === pendingActive))
      ? pendingActive
      : tabsRef.current[tabsRef.current.length - 1]?.id
    if (target) {
      setScope('notes')
      openEntry(target, 'note')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNotes, restored])

  // Renderer-side open-today: tray → main → `inkfish:open-today` → open daily note.
  useEffect(() => {
    const sub = (window as unknown as { api?: { onOpenToday?: (cb: () => void) => () => void } }).api
      ?.onOpenToday
    if (!sub) return
    return sub(() => {
      window.api.daily
        .today()
        .then(({ vaultRel }) => {
          refreshNotes()
          window.api.notes
            .list(null)
            .then((all) => {
              const found = all.find((n) => n.path === vaultRel)
              if (found) selectNote(found.id)
              else notify('Today opened ✓')
            })
            .catch(console.error)
        })
        .catch((err: unknown) => notify(`Today failed: ${String(err)}`))
    })
  }, [notify, refreshNotes, selectNote])

  const renameNote = useCallback(
    (id: string, title: string) => {
      window.api.notes
        .setTitle(id, title)
        .then((all) => {
          setTitles(all)
          notify(title.trim() ? 'Title saved ✓' : 'Title reset to filename')
        })
        .catch((err: unknown) => notify(`Rename failed: ${String(err)}`))
    },
    [notify]
  )

  const titleOf = useCallback(
    (e: { id: string; path: string; title: string }) => displayTitle(e, titles),
    [titles]
  )

  // --- file CRUD ---------------------------------------------------------------
  const guardDirty = (): boolean => {
    if (dirtyCount > 0) {
      notify(`Unsaved changes in ${dirtyCount} tab${dirtyCount === 1 ? '' : 's'} — save first`)
      return true
    }
    return false
  }

  const doCreateFile = useCallback(
    (dirRel: string) => {
      window.api.files
        .create(dirRel)
        .then((rel) => {
          notify(`Created ${rel.split('/').pop()}`)
          window.api.notes
            .list(null)
            .then((all) => {
              setAllNotes(all)
              const found = all.find((n) => n.path === rel)
              if (found) selectNote(found.id, 'raw')
            })
            .catch(console.error)
          refreshInbox()
          refreshProjects()
        })
        .catch((err: unknown) => notify(`Create failed: ${err instanceof Error ? err.message : String(err)}`))
    },
    [notify, refreshInbox, refreshProjects, selectNote]
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

  const doRename = useCallback(
    (rel: string, isDir: boolean) => {
      if (guardDirty()) return
      const current = rel.split('/').pop() ?? rel
      // Path of the open note before the rename (to follow it across).
      const openPath = sel?.origin === 'note'
        ? (doc?.path ?? allNotes.find((n) => n.id === sel.id)?.path ?? null)
        : null
      setPrompt({
        title: isDir ? 'Rename folder' : 'Rename file',
        initial: isDir ? current : current.replace(/\.md$/, ''),
        confirm: 'Rename',
        onSubmit: (v) => {
          window.api.files
            .rename(rel, v)
            .then((newRel) => {
              notify(`Renamed → ${newRel.split('/').pop()}`)
              window.api.notes
                .list(null)
                .then((all) => {
                  setAllNotes(all)
                  window.api.notes.titles().then(setTitles).catch(console.error)
                  const byPath = new Map(all.map((n) => [n.path, n]))
                  // Follow every open tab across the rename (file or folder).
                  setTabs((prev) =>
                    prev.map((t) => {
                      if (t.path === rel || t.path.startsWith(`${rel}/`)) {
                        const movedPath = newRel + t.path.slice(rel.length)
                        const found = byPath.get(movedPath)
                        return found ? { ...t, id: found.id, path: movedPath } : t
                      }
                      return t
                    })
                  )
                  if (openPath && (openPath === rel || openPath.startsWith(`${rel}/`))) {
                    const movedPath = newRel + openPath.slice(rel.length)
                    const found = all.find((n) => n.path === movedPath)
                    if (found) {
                      setSel({ id: found.id, origin: 'note' })
                      window.api.notes.get(found.id).then((fresh) => {
                        if (fresh) {
                          setDocsCache((prev) => ({ ...prev, [found.id]: fresh }))
                          setDoc(fresh)
                        }
                      }).catch(console.error)
                    } else {
                      setSel(null)
                      setDoc(null)
                    }
                  }
                })
                .catch(console.error)
              refreshInbox()
              refreshProjects()
            })
            .catch((err: unknown) => notify(`Rename failed: ${err instanceof Error ? err.message : String(err)}`))
        }
      })
    },
    [sel, doc, allNotes, notify, refreshInbox, refreshProjects]
  )

  const doTrash = useCallback(
    (rel: string, name: string) => {
      if (guardDirty()) return
      setConfirm({
        title: `Delete ${name}?`,
        body: 'It moves to the app Trash and is permanently deleted after 7 days. This removes it from your notes folder now.',
        confirm: 'Move to Trash',
        onConfirm: () => {
          window.api.files
            .trash(rel)
            .then(() => {
              notify(`Trashed ${name}`)
              // Drop tabs under the trashed path; follow with a neighbor.
              setTabs((prev) => {
                const remaining = prev.filter((t) => t.path !== rel && !t.path.startsWith(`${rel}/`))
                if (remaining.length !== prev.length) {
                  const active = selRef.current
                  if (active?.origin === 'note' && (active.id === selRef.current?.id)) {
                    const gone = !remaining.some((t) => t.id === active.id) &&
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
                }
                return remaining
              })
              // Clear the center if the open note is gone.
              if (sel?.origin === 'note') {
                window.api.notes
                  .list(null)
                  .then((all) => {
                    setAllNotes(all)
                    if (!all.some((n) => n.id === sel.id)) {
                      setSel(null)
                      setDoc(null)
                      setDrafts((d) => {
                        if (d[sel.id] === undefined) return d
                        const next = { ...d }
                        delete next[sel.id]
                        return next
                      })
                    }
                  })
                  .catch(console.error)
              } else {
                refreshNotes()
              }
              refreshInbox()
              refreshProjects()
              window.api.notes.titles().then(setTitles).catch(console.error)
            })
            .catch((err: unknown) => notify(`Delete failed: ${err instanceof Error ? err.message : String(err)}`))
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel, notify, refreshNotes, refreshInbox, refreshProjects]
  )

  /** Context menu items for a tree target, the open note, or a tab. */
  const menuItems = useCallback(
    (target: TreeTarget | { kind: 'open-note' } | { kind: 'tab'; id: string }): MenuItem[] => {
      if (target.kind === 'tab') {
        const tab = tabsRef.current.find((t) => t.id === target.id)
        if (!tab) return []
        return [
          { label: tab.pinned ? 'Unpin tab' : 'Pin tab', action: () => togglePin(tab.id) },
          { label: 'Close tab', action: () => closeTab(tab.id) },
          { label: 'Close other tabs', action: () => closeOthers(tab.id) },
          { label: 'Close unpinned tabs', action: () => closeUnpinned() }
        ]
      }
      if (target.kind === 'open-note') {
        if (!doc || sel?.origin !== 'note') return []
        const rel = doc.path
        const name = titleOf(doc)
        return [
          { label: 'Reveal in Finder', action: () => void window.api.files.reveal(rel) },
          { label: 'Rename…', action: () => doRename(rel, false) },
          { label: `Delete “${name.slice(0, 32)}”…`, danger: true, action: () => doTrash(rel, name) }
        ]
      }
      if (target.kind === 'dir') {
        const name = target.name
        return [
          { label: 'New file here', action: () => doCreateFile(target.rel) },
          {
            label: 'New subfolder…',
            action: () =>
              setPrompt({
                title: `New folder in ${name}`,
                initial: '',
                confirm: 'Create',
                onSubmit: (v) => {
                  window.api.files
                    .mkdir(target.rel, v)
                    .then((rel) => {
                      setRevealDir(rel)
                      notify(`Folder ${v} ✓`)
                      refreshNotes()
                    })
                    .catch((err: unknown) => notify(`Failed: ${err instanceof Error ? err.message : String(err)}`))
                }
              })
          },
          { label: 'Reveal in Finder', action: () => void window.api.files.reveal(target.rel) },
          { label: 'Rename…', action: () => doRename(target.rel, true) },
          { label: `Delete “${name}”…`, danger: true, action: () => doTrash(target.rel, name) }
        ]
      }
      const name = target.name
      return [
        { label: 'Reveal in Finder', action: () => void window.api.files.reveal(target.rel) },
        { label: 'Rename…', action: () => doRename(target.rel, false) },
        { label: `Delete “${name.slice(0, 32)}”…`, danger: true, action: () => doTrash(target.rel, name) }
      ]
    },
    [doc, sel, titleOf, doCreateFile, doRename, doTrash, notify, refreshNotes, togglePin, closeTab, closeOthers, closeUnpinned]
  )

  // --- derived -------------------------------------------------------------------
  // Staging (inbox/daily working state) lives in app data and is surfaced via
  // the Inbox tab + Today — never as folders in the vault tree or Home.
  const finalNotes = useMemo(
    () => allNotes.filter((n) => !n.path.startsWith('inbox/') && !n.path.startsWith('daily/')),
    [allNotes]
  )
  const kindCounts = useMemo(() => {
    const m = new Map<NoteKind, number>()
    for (const n of finalNotes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1)
    return m
  }, [finalNotes])

  const pickScope = (s: Scope): void => {
    setScope(s)
    if (s === 'home') {
      // Tabs stay open (Obsidian-style) — just park the active selection.
      setSel(null)
      setDoc(null)
    } else if (s === 'notes' && !selRef.current && tabsRef.current.length > 0) {
      const last = tabsRef.current[tabsRef.current.length - 1]
      if (last) openEntry(last.id, 'note')
    }
  }

  const pickDir = (rel: string): void => {
    setTargetDir(rel)
    setRevealDir(rel)
  }

  const openSettings = (): void => {
    setSettingsReturn(scope)
    setSettingsOpen(true)
  }

  const pendingCount = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length
  const activeItem = scope === 'inbox' ? inbox.find((i) => i.id === sel?.id) ?? null : null
  const openPath = sel?.origin === 'note' ? doc?.path ?? allNotes.find((n) => n.id === sel.id)?.path ?? null : null

  return (
    <div className={`shell${sideCollapsed ? ' side-collapsed' : ''}`} data-platform={sys?.platform ?? 'unknown'}>
      {/* Core sidebar: search, scopes, dir tree with files, kind filters. */}
      <aside className="sidebar core">
        <div className="traffic-spacer" aria-hidden />
        <div className="brand-row">
          <div className="brand-logo-frame">
            <img src={logoUrl} alt="Inkfish" className="brand-logo-img" />
          </div>
          <div className="brand">
            <h1>{APP_NAME}</h1>
          </div>
        </div>

        <input
          className="search side-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            if (scope !== 'notes') setScope('notes')
          }}
          placeholder="Search notes… (FTS)"
          aria-label="Search notes"
        />

        <div className="scope-tabs" role="tablist" aria-label="Sidebar scope">
          {(['home', 'notes', 'inbox'] as Scope[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              className={scope === s ? 'on' : ''}
              onClick={() => pickScope(s)}
            >
              {s === 'home' ? 'Home' : s === 'notes' ? 'Notes' : 'Inbox'}
              {s === 'inbox' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
            </button>
          ))}
        </div>

        {scope === 'inbox' ? (
          <div className="side-scroll">
            <InboxQueue
              items={inbox}
              projects={projects}
              selectedId={sel !== null && sel.origin === 'inbox' ? sel.id : null}
              onSelect={selectInbox}
              onRefresh={refreshAll}
              notify={notify}
            />
          </div>
        ) : (
          <div className="side-scroll">
            <div className="tree-toolbar" role="toolbar" aria-label="Notes actions">
              <button className="tree-tool" onClick={() => doCreateFile(targetDir)} title={`New note in ${targetDir || '/'}`} aria-label="New note">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 1.5h5.2l2.8 2.8v10.2H4z" />
                  <path d="M9.2 1.5v2.8H12" />
                  <path d="M6.2 9.2h3.6M8 7.4v3.6" />
                </svg>
              </button>
              <button className="tree-tool" onClick={doCreateFolder} title={`New folder in ${targetDir || '/'}`} aria-label="New folder">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M1.8 4.7c0-.8.7-1.5 1.5-1.5h2.6l1.4 1.7h5.4c.8 0 1.5.7 1.5 1.5v5.1c0 .8-.7 1.5-1.5 1.5H3.3c-.8 0-1.5-.7-1.5-1.5z" />
                  <path d="M8 7.2v3.6M6.2 9h3.6" />
                </svg>
              </button>
              {targetDir !== '' && (
                <span className="tree-target" title={targetDir}>in {targetDir.split('/').pop()}</span>
              )}
            </div>
            <FolderTree
              notes={finalNotes}
              kind={kind}
              titleOf={titleOf}
              selectedId={sel?.origin === 'note' ? sel.id : null}
              selectedPath={openPath}
              results={results}
              revealDir={revealDir}
              onOpenFile={selectNote}
              onPickDir={pickDir}
              onMenu={(target, x, y) => setMenu({ x, y, target })}
            />
            <div className="chips kinds" aria-label="Filter by kind">
              {KINDS.filter((k) => k.id === 'all' || (kindCounts.get(k.id as NoteKind) ?? 0) > 0).map((k) => (
                <button
                  key={k.id}
                  className={kind === k.id ? 'on' : ''}
                  onClick={() => {
                    setKind(k.id)
                    setScope('notes')
                  }}
                  title={k.id === 'all' ? `${finalNotes.length} notes` : `${kindCounts.get(k.id as NoteKind) ?? 0} ${k.name.toLowerCase()} notes`}
                >
                  {k.name}
                  {k.id !== 'all' && <span className="count">{kindCounts.get(k.id as NoteKind) ?? 0}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="side-foot">
          <div className="side-foot-row">
            <button className="settings-btn" onClick={openSettings}>
              <span aria-hidden>⚙</span> Settings
            </button>
            <button
              className="quit-btn"
              onClick={() => void window.api.app.quit()}
              title="Quit Inkfish"
              aria-label="Quit Inkfish"
            >
              <span aria-hidden>⏻</span>
            </button>
          </div>
          <span className="status-sub" title={vaultInfo?.root ?? ''}>
            {(vaultInfo ? vaultInfo.root.replace(/.*\//, '…/') : '…') || '…'}
          </span>
        </div>
      </aside>

      {/* Center: home dashboard, note stage, or full-page settings. */}
      <div className="content inkfish center">
        {settingsOpen ? (
          <main className="view-scroll" aria-label="Settings">
            <SettingsView
              prefs={prefs}
              vibrancySupported={sys?.platform === 'darwin'}
              vault={vaultInfo}
              sys={sys}
              backend={backend}
              onChange={setPrefs}
              onBack={() => {
                setSettingsOpen(false)
                setScope(settingsReturn)
              }}
              onPickVault={() => {
                setSettingsOpen(false)
                setOstep(0)
                setShowOnboarding(true)
              }}
              onRescan={() =>
                window.api.vault
                  .reindex()
                  .then((r) => {
                    setBackend(r.backend)
                    refreshAll()
                    notify(`Re-indexed ${r.indexed} notes`)
                  })
                  .catch((err: unknown) => notify(`Reindex failed: ${String(err)}`))
              }
              notify={notify}
            />
          </main>
        ) : showMeeting ? (
          <main className="view-scroll" aria-label="Meeting notes">
            <MeetingImport
              page
              onClose={() => setShowMeeting(false)}
              onImported={refreshAll}
              notify={notify}
            />
          </main>
        ) : (
          <>
            <header className="topbar">
              <button
                className="side-toggle"
                onClick={() => setSideCollapsed((v) => !v)}
                title={sideCollapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
                aria-label={sideCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!sideCollapsed}
              >
                {sideCollapsed ? '»' : '«'}
              </button>
              <button className="btn ghost sm" title="Quick capture (⌥Space)" onClick={() => notify('Hit ⌥Space anywhere to capture')}>
                ✒ Capture
              </button>
              <button className="btn ghost sm" onClick={() => setShowMeeting(true)}>
                🎙 Meeting
              </button>
              <span className="flex-sp" />
              {dirty && <span className="pill dirty-static">unsaved</span>}
            </header>

            {scope === 'home' ? (
              <main className="view-scroll" aria-label="Home">
                <Home
                  notes={finalNotes}
                  inbox={inbox}
                  titleOf={titleOf}
                  onOpenNote={selectNote}
                  onOpenInbox={() => pickScope('inbox')}
                  onOpenFolder={(rel) => {
                    if (rel) {
                      setTargetDir(rel)
                      setRevealDir(rel)
                    }
                    setScope('notes')
                  }}
                  onCaptureHint={() => notify('Hit ⌥Space anywhere to capture')}
                  onMeeting={() => setShowMeeting(true)}
                />
              </main>
            ) : (
              <main className="note-stage" aria-label="Note">
                <TabBar
                  tabs={tabs}
                  activeId={sel?.origin === 'note' ? sel.id : null}
                  drafts={drafts}
                  allNotes={allNotes}
                  titles={titles}
                  titleOf={titleOf}
                  onActivate={(id) => openEntry(id, 'note')}
                  onClose={closeTab}
                  onTogglePin={togglePin}
                  onMenu={(id, x, y) => setMenu({ x, y, target: { kind: 'tab', id } })}
                  onNew={() => doCreateFile(targetDir)}
                />
                {sel?.origin === 'inbox' && activeItem && (
                  <InboxBar
                    item={activeItem}
                    projects={projects}
                    onDone={(noteId) => {
                      refreshAll()
                      if (noteId) selectNote(noteId)
                    }}
                    notify={notify}
                  />
                )}
                <NoteEditor
                  doc={doc}
                  title={doc ? titleOf(doc) : ''}
                  dirty={dirty}
                  defaultMode={prefs.mode}
                  openMode={openMode && doc && openMode.id === doc.id ? openMode.mode : null}
                  draft={sel ? drafts[sel.id] : undefined}
                  onDraft={handleDraft}
                  onDirty={() => undefined}
                  onSave={saveDoc}
                  onRename={(t) => {
                    if (doc) renameNote(doc.id, t)
                  }}
                  onMore={(x, y) => setMenu({ x, y, target: { kind: 'open-note' } })}
                />
              </main>
            )}
          </>
        )}
      </div>

      {menu && (
        <CtxMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
      {prompt && (
        <PromptModal
          title={prompt.title}
          initial={prompt.initial}
          placeholder={prompt.title}
          confirmLabel={prompt.confirm}
          onSubmit={prompt.onSubmit}
          onClose={() => setPrompt(null)}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirm}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {showOnboarding && (
        <Onboarding
          step={ostep}
          setStep={setOstep}
          vault={vaultInfo}
          onVaultReady={onVaultReady}
          onDone={() => setShowOnboarding(false)}
          notify={notify}
        />
      )}
      {toast && <div className="toast glass">{toast}</div>}
    </div>
  )
}

/** Obsidian-style tab strip: pinned files stay, × closes, right-click for more. */
function TabBar({
  tabs, activeId, drafts, allNotes, titles, titleOf,
  onActivate, onClose, onTogglePin, onMenu, onNew
}: {
  tabs: Tab[]
  activeId: string | null
  drafts: Record<string, string>
  allNotes: NoteEntry[]
  titles: Record<string, string>
  titleOf: (e: { id: string; path: string; title: string }) => string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onTogglePin: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
  onNew: () => void
}): React.JSX.Element {
  const byId = new Map(allNotes.map((n) => [n.id, n]))
  const ordered = [...tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  if (ordered.length === 0) return <div className="tabbar empty" aria-hidden />
  return (
    <div className="tabbar" role="tablist" aria-label="Open notes">
      {ordered.map((t) => {
        const entry = byId.get(t.id)
        const label = titleOf({ id: t.id, path: entry?.path ?? t.path, title: entry?.title ?? '' })
        const isActive = t.id === activeId
        const isDirty = drafts[t.id] !== undefined
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            className={`tab${isActive ? ' on' : ''}${t.pinned ? ' pinned' : ''}${isDirty ? ' dirty' : ''}`}
            title={`${entry?.path ?? t.path}${isDirty ? ' • unsaved' : ''}`}
            onClick={() => onActivate(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onActivate(t.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu(t.id, e.clientX, e.clientY)
            }}
            onMouseUp={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(t.id)
              }
            }}
          >
            {t.pinned && (
              <button
                className="tab-pin on"
                title="Unpin tab"
                aria-label="Unpin tab"
                onClick={(e) => {
                  e.stopPropagation()
                  onTogglePin(t.id)
                }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M9.5 1.5l5 5-2 .5-2.5 5.5-2.5 2.5-.7-2.8-3.3-3.3-2.8-.7 2.5-2.5L8 2z" />
                </svg>
              </button>
            )}
            <span className="tab-label">{label}</span>
            {isDirty && <span className="tab-dot" aria-label="Unsaved changes" />}
            <button
              className="tab-x"
              title="Close tab"
              aria-label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <button className="tab-new" onClick={onNew} title="New note" aria-label="New note">
        +
      </button>
    </div>
  )
}

/** Action bar pinned above inbox docs: route / move / undo without leaving the note. */
function InboxBar({
  item, projects, onDone, notify
}: {
  item: InboxItem
  projects: Project[]
  onDone: (noteId?: string) => void
  notify: (msg: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => void, failMsg: string): Promise<void> => {
    setBusy(true)
    try {
      ok(await fn())
    } catch (err) {
      notify(`${failMsg}: ${err instanceof Error ? err.message : String(err)}`)
      setBusy(false)
    }
  }

  return (
    <div className="inboxbar glass">
      <span className="qkind">{item.kind}</span>
      <span className={`status-pill st-${item.status}`}>
        {item.status === 'processing' ? 'routing…' : item.status}
      </span>
      <span className="flex-sp" />
      {item.status !== 'processing' && (
        <button
          className="btn mint sm"
          disabled={busy}
          onClick={() =>
            void run(
              () => window.api.inbox.process(item.id),
              (r) => {
                const res = r as { note?: NoteEntry } | { error?: string }
                if (res && 'note' in res && res.note) {
                  notify('Routed ✓')
                  onDone(res.note.id)
                } else {
                  notify(`Route issue: ${(res as { error?: string }).error ?? 'unknown'}`)
                  onDone()
                }
              },
              'Route failed'
            )
          }
        >
          Route now
        </button>
      )}
      <select
        className="sm"
        defaultValue=""
        disabled={busy}
        aria-label="Move to folder"
        onChange={(e) => {
          const v = e.target.value
          if (!v) return
          e.target.value = ''
          void run(
            () => window.api.inbox.reassign(item.id, v),
            (r) => {
              const res = r as { note?: string } | { error?: string }
              notify(`Moved → ${v}`)
              onDone(res && 'note' in res && typeof res.note === 'string' ? res.note : undefined)
            },
            'Move failed'
          )
        }}
      >
        <option value="">Move →</option>
        {projects.map((p) => (
          <option key={p.id} value={p.name}>{p.name}</option>
        ))}
      </select>
      {item.status === 'ready' && (
        <button
          className="btn ghost sm"
          disabled={busy}
          onClick={() =>
            void run(
              () => window.api.inbox.undo(item.id),
              () => {
                notify('Undone — raw kept')
                onDone()
              },
              'Undo failed'
            )
          }
        >
          Undo
        </button>
      )}
    </div>
  )
}
