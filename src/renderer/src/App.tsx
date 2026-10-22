import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APP_NAME } from '../../shared/config'
import logoUrl from './assets/logo.png'
import type { InboxItem, NoteDoc, NoteEntry, NoteKind, Project, SysInfo, VaultInfo } from '../../shared/types'
import { applyPrefs, loadPrefs, type Prefs } from './theme'
import { displayTitle, plain } from './text'
import { dailyTitle, dayOfPath, localDay } from '../../shared/daily'
import Capture from './views/Capture'
import FolderTree, { type KindFilter, type RowActions, type TreeTarget } from './views/FolderTree'
import { DeletePopover, UndoToast, type Anchor } from './views/DeletePopover'
import { deleteNeedsConfirm, previewLines, renameCommit } from '../../shared/note-delete'
import Home from './views/Home'
import Journal from './views/Journal'
import { dailyRefs } from '../../shared/journal'
import InboxQueue from './views/InboxQueue'
import NoteEditor from './views/NoteEditor'
import Onboarding from './views/Onboarding'
import Meetings from './views/Meetings'
import CommandPalette, { type RunnableCommand } from './views/CommandPalette'
import { sendAiCommand } from './nativeAi'
import type { PaletteMode } from '../../shared/command-palette'
import MiniNote, { isMiniWindow } from './views/MiniNote'
import PopOutIcon from './views/PopOutIcon'
import { isPopKey } from '../../shared/mini-window'
import { popOutTitle, tabDragPhase } from '../../shared/mini-window-tear'
import { createAutosave, draftForEditor, type Autosave } from '../../shared/autosave'
import { autoRenameTarget, createTitleSync, isTitleSyncPath, isUntitledName, matchesName, sanitizeFileTitle, stemOf, titleFromMarkdown, type TitleSyncScheduler } from '../../shared/title-sync'
import { shortcutLabel, type AppProfileInfo } from '../../shared/profile'
import { SIDE_COLLAPSED_KEY, isSidebarToggleKey, parseSideCollapsed, serializeSideCollapsed, vaultLabel, vaultTooltip } from '../../shared/sidebar'
import SettingsView from './views/Settings'
import { ConfirmModal, CtxMenu, PromptModal, type MenuItem } from './views/Dialogs'
import { BrandEasterEgg, useBrandTripleClick } from './views/easter-egg/BrandEasterEgg'
import { Icon } from './views/icons'
import SyncBadge from './views/SyncBadge'
import FolderPicker from './views/FolderPicker'
import { baseOf, dirOf, foldersOf, remapPath, type MoveKind } from '../../shared/note-move'
import { matchesTags, parseTagQuery } from '../../shared/tags'

/** Popover windows load the same bundle with `#capture` — render capture only. */
export function isCaptureWindow(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.location.hash === '#capture' || window.location.hash === '#capture-daily')
  )
}

type Selection = { id: string; origin: 'inbox' | 'note' } | null
type Scope = 'home' | 'notes' | 'inbox' | 'journal'

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
  if (isMiniWindow()) return <MiniNote />
  return <Main />
}

function Main(): React.JSX.Element {
  const [sys, setSys] = useState<SysInfo | null>(null)
  const brandEgg = useBrandTripleClick()
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
  /** Per-note text not yet confirmed on disk (autosave clears each entry once written). */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** Saved docs by id — tab switches are instant, no IPC per click. */
  const [docsCache, setDocsCache] = useState<Record<string, NoteDoc>>({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NoteEntry[] | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [ostep, setOstep] = useState(0)
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null)
  const [showMeeting, setShowMeeting] = useState(false)
  /** A capture is running — keep the Meetings page mounted while you browse. */
  const [meetingLive, setMeetingLive] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [backend, setBackend] = useState('…')
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
  /** Custom display titles (app config) — filename otherwise. */
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** "Move to…" folder picker (header breadcrumb, ⌘K, right-click). */
  const [movePick, setMovePick] = useState<{ rel: string; kind: MoveKind; name: string; x: number; y: number } | null>(null)
  const [prompt, setPrompt] = useState<{ title: string; initial: string; confirm: string; onSubmit: (v: string) => void } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; confirm: string; onConfirm: () => void } | null>(null)
  /** Sidebar: note id whose row is in inline-rename mode. */
  const [treeRename, setTreeRename] = useState<string | null>(null)
  /** Sidebar: delete glance for a note with real content. */
  const [delAsk, setDelAsk] = useState<{ entry: NoteEntry; title: string; lines: string[]; anchor: Anchor } | null>(null)
  /** Undo toast after a delete (restores the trash entry). */
  const [undoDel, setUndoDel] = useState<{ key: number; message: string; trashId: string; rel: string; wasOpen: boolean } | null>(null)
  /** Collapsible core sidebar (Blobfish-style) — persisted; toggled from the sidebar header,
   *  the collapsed rail, ⌘\ or the palette. */
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(() => {
    try {
      return parseSideCollapsed(localStorage.getItem(SIDE_COLLAPSED_KEY))
    } catch {
      return false
    }
  })

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

  // --- filename follows title (Settings → Notes → Name files from title) ----------------------
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  /** Per note: the title its file name was last synced from (or its saved title when first edited). */
  const baseTitlesRef = useRef(new Map<string, string>())
  /** Notes with a title rename in flight. */
  const titleRenamingRef = useRef(new Set<string>())
  /** Notes Inkfish named from their title (main keeps the list): they keep following it. */
  const titleNamedRef = useRef(new Set<string>())
  const refreshTitleNamed = useCallback(() => {
    window.api.notes
      .titleNamed()
      .then((list) => {
        titleNamedRef.current = new Set(list)
      })
      .catch(console.error)
  }, [])
  /** Edits the editor sends under the old id between a rename landing and it re-rendering. */
  const renamedAliasRef = useRef<{ from: string; to: string; doc: NoteDoc | null } | null>(null)
  const titleSyncRunRef = useRef<(id: string, markdown: string) => void>(() => undefined)
  const titleSyncRef = useRef<TitleSyncScheduler | null>(null)
  if (!titleSyncRef.current) titleSyncRef.current = createTitleSync({ run: (id, md) => titleSyncRunRef.current(id, md) })
  const titleSync = titleSyncRef.current
  /** Write every pending note now (tab switch, new note, close, blur, quit, ⌘S). */
  const flushAll = useCallback((): Promise<void> => autosave.flushAll(), [autosave])

  useEffect(() => {
    applyPrefs(prefs)
  }, [prefs])

  useEffect(() => {
    try {
      localStorage.setItem(SIDE_COLLAPSED_KEY, serializeSideCollapsed(sideCollapsed))
    } catch {
      // ignore
    }
  }, [sideCollapsed])

  // ⌘\ toggles the sidebar (Obsidian/Blobfish-style). Capture phase so a focused editor or
  // input can't swallow it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isSidebarToggleKey(e)) return
      e.preventDefault()
      e.stopPropagation()
      setSideCollapsed((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
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
    refreshTitleNamed()
  }, [refreshInbox, refreshNotes, refreshProjects, refreshTitleNamed])

  // Release vs dev profile ("Inkfish Dev"): brand pill, window title, shortcut hints.
  const [profile, setProfile] = useState<AppProfileInfo | null>(null)
  useEffect(() => {
    window.api.app
      .profile()
      .then((p) => {
        setProfile(p)
        document.title = p.name
      })
      .catch(console.error)
    // Settings › Shortcuts changed: keep the hints in step.
    return window.api.shortcuts.onChanged((s) =>
      setProfile((p) => (p ? { ...p, captureShortcut: s.disabled ? '' : s.settings.capture, dailyShortcut: s.disabled ? '' : s.settings.daily } : p))
    )
  }, [])
  const isMacUi = sys?.platform === 'darwin'
  const captureKey = profile ? shortcutLabel(profile.captureShortcut, isMacUi) : '⌥Space'

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
        refreshTitleNamed()
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
  }, [refreshInbox, refreshNotes, refreshProjects, notify, refreshTitleNamed])

  // Search-as-you-type lives in the sidebar; results replace the tree.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null)
      return
    }
    const t = window.setTimeout(() => {
      // `#tag` / `tag:foo` tokens filter by front matter tags; any other words still full-text.
      const tq = parseTagQuery(query)
      if (tq) {
        const tagged = allNotesRef.current.filter(
          (n) => !n.path.startsWith('inbox/') && !n.path.startsWith('daily/') && matchesTags(n.tags, tq.tags)
        )
        if (!tq.text) {
          setResults(tagged)
          return
        }
        const ok = new Set(tagged.map((n) => n.id))
        window.api.notes.search(tq.text).then((r) => setResults(r.filter((n) => ok.has(n.id)))).catch(console.error)
        return
      }
      window.api.notes.search(query.trim()).then(setResults).catch(console.error)
    }, 180)
    return () => window.clearTimeout(t)
  }, [query])

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
    // Autosave: closing writes the tab's text — there is nothing to discard or confirm.
    void autosave.flush(id)
    removeTab(id)
  }, [removeTab, autosave])

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)))
  }, [])

  /** Close a set of tabs (their pending text is written first). */
  const closeTabsGuarded = useCallback((ids: string[], what: string) => {
    for (const id of ids) void autosave.flush(id)
    const keep = new Set(ids)
    const remaining = tabsRef.current.filter((t) => !keep.has(t.id))
    setTabs(remaining)
    const active = selRef.current
    if (active && keep.has(active.id)) activateNeighbor(active.id, remaining)
    notify(what)
  }, [activateNeighbor, notify, autosave])

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

  // A paired phone synced: re-read lists (main already re-indexed the files).
  useEffect(() => window.api.onVaultChanged(() => refreshAll()), [refreshAll])

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
  useEffect(() => window.api.mini?.onOpenNote((id) => {
    setSettingsOpen(false)
    selectNote(id)
  }), [selectNote])

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
    const sub = (window as unknown as { api?: { onOpenToday?: (cb: () => void) => () => void } }).api
      ?.onOpenToday
    if (!sub) return
    return sub(() => {
      void openToday()
    })
  }, [openToday])

  /** Set once renameNoteFile exists (it's declared further down, after followPathChange). */
  const renameNoteFileRef = useRef<(id: string, path: string, title: string, opts: { baseAfter: string; toast?: boolean }) => Promise<string>>(
    async (_id, path) => path
  )
  const renameNote = useCallback(
    (id: string, title: string) => {
      // Name files from title: the header title IS the file name — rename the file.
      const d = docRef.current
      if (prefsRef.current.nameFromTitle && d && d.id === id && selRef.current?.origin === 'note' && isTitleSyncPath(d.path) && title.trim()) {
        const text = draftsRef.current[id] ?? d.markdown
        renameNoteFileRef.current(id, d.path, title.trim(), { baseAfter: titleFromMarkdown(text), toast: true })
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
    [notify]
  )

  const titleOf = useCallback(
    (e: { id: string; path: string; title: string }) => displayTitle(e, titles),
    [titles]
  )

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
  const followPathChange = useCallback((rel: string, newRel: string, all: NoteEntry[], openPath: string | null) => {
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
    const rekey = <T,>(prev: Record<string, T>): Record<string, T> => {
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
        window.api.notes.get(found.id).then((fresh) => {
          if (fresh) {
            autosave.noteSaved(fresh.id, fresh.markdown)
            setDocsCache((prev) => ({ ...prev, [found.id]: fresh }))
            setDoc(fresh)
          }
        }).catch(console.error)
      } else {
        setSel(null)
        setDoc(null)
      }
    }
  }, [autosave, refreshTitleNamed])

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
        const openPath = selRef.current?.origin === 'note'
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
          const links = res.rewritten.length ? ` · ${res.rewritten.length} link${res.rewritten.length === 1 ? '' : 's'} updated` : ''
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

  // A note named `Untitled…` that got a custom header title before this setting existed (the old
  // ✎ rename only stored a display title): give the file that name when it's opened.
  const openDocId = sel?.origin === 'note' ? (doc?.id ?? null) : null
  useEffect(() => {
    const d = docRef.current
    if (!prefs.nameFromTitle || !openDocId || !d || d.id !== openDocId) return
    const override = titles[d.id]?.trim()
    if (!override || !isTitleSyncPath(d.path) || !isUntitledName(stemOf(d.path))) return
    renameNoteFile(d.id, d.path, override, { baseAfter: titleFromMarkdown(draftsRef.current[d.id] ?? d.markdown) })
      .catch((err: unknown) => console.error('[title-sync] untitled migration failed:', err))
  }, [openDocId, titles, prefs.nameFromTitle, renameNoteFile])

  /** The debounced title→filename check (see shared/title-sync for the rule). */
  titleSyncRunRef.current = (id: string, markdown: string): void => {
    if (!prefsRef.current.nameFromTitle) return
    if (titleRenamingRef.current.has(id)) {
      // A rename is landing — look again once it has.
      titleSync.schedule(id, markdown)
      return
    }
    const path = allNotesRef.current.find((n) => n.id === id)?.path ?? (docRef.current?.id === id ? docRef.current.path : null)
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
    renameNoteFile(id, path, title, { baseAfter: title }).catch((err: unknown) =>
      console.error('[title-sync] rename failed:', err)
    )
  }

  /** Move a note/folder into `destDir` ('' = vault root): drag & drop and the folder picker. */
  const doMove = useCallback(
    async (rel: string, kind: MoveKind, destDir: string) => {
      // Pending text first, so the rename never strands an edit at the old path.
      await autosave.flushAll()
      const openPath = selRef.current?.origin === 'note'
        ? (docRef.current?.path ?? allNotesRef.current.find((n) => n.id === selRef.current?.id)?.path ?? null)
        : null
      try {
        const res = await window.api.files.moveTo(rel, destDir)
        if (res.rel === rel) return
        const where = destDir || 'vault root'
        const extra = [
          res.renamed ? `as ${baseOf(res.rel)}` : '',
          res.rewritten.length ? `${res.rewritten.length} link${res.rewritten.length === 1 ? '' : 's'} updated` : ''
        ].filter(Boolean).join(' · ')
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
          const links = rewritten.length ? ` · ${rewritten.length} link${rewritten.length === 1 ? '' : 's'} updated` : ''
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
      const wasOpen = active?.origin === 'note' && (() => {
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

  /** Context menu items for a tree target, the open note, or a tab. */
  const menuItems = useCallback(
    (target: TreeTarget | { kind: 'open-note' } | { kind: 'tab'; id: string }): MenuItem[] => {
      if (target.kind === 'tab') {
        const tab = tabsRef.current.find((t) => t.id === target.id)
        if (!tab) return []
        return [
          { label: 'Pop out to Mini Window  ⌘⇧M', action: () => popOut(tab.id) },
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
          { label: 'Pop out to Mini Window  ⌘⇧M', action: () => popOut(doc.id) },
          { label: 'Raw / Processed view  ⇧⌥P', action: () => sendAiCommand('toggle-view') },
          { label: 'Process selection…  ⇧⌥S', action: () => sendAiCommand('process-selection') },
          { label: 'Reveal in Finder', action: () => void window.api.files.reveal(rel) },
          { label: 'Move to…', action: () => openMovePicker(rel, 'file', name, menu?.x, menu?.y) },
          { label: 'Rename…', action: () => startNoteRename(doc) },
          { label: `Delete “${name.slice(0, 32)}”…`, danger: true, action: () => void deleteNote(doc, null, false) }
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
          { label: 'Move to…', action: () => openMovePicker(target.rel, 'dir', name, menu?.x, menu?.y) },
          { label: 'Rename…', action: () => doRename(target.rel, true) },
          { label: `Delete “${name}”…`, danger: true, action: () => doTrash(target.rel, name) }
        ]
      }
      const name = target.name
      const entry = allNotesRef.current.find((n) => n.id === target.id) ?? allNotesRef.current.find((n) => n.path === target.rel)
      return [
        { label: 'Rename  F2', action: () => (entry ? startNoteRename(entry) : doRename(target.rel, false)) },
        { label: 'Reveal in Finder', action: () => void window.api.files.reveal(target.rel) },
        ...(entry ? [{ label: 'Open in Mini Window', action: () => popOut(entry.id) }] : []),
        { label: 'Move to…', action: () => openMovePicker(target.rel, 'file', name, menu?.x, menu?.y) },
        {
          label: `Delete “${name.slice(0, 32)}”  ⌘⌫`,
          danger: true,
          action: () => (entry ? void deleteNote(entry, null, false) : doTrash(target.rel, name))
        }
      ]
    },
    [doc, sel, titleOf, doCreateFile, doRename, doTrash, startNoteRename, deleteNote, notify, refreshNotes, togglePin, closeTab, closeOthers, closeUnpinned, popOut, openMovePicker, menu]
  )

  // --- derived -------------------------------------------------------------------
  // Staging (inbox/daily working state) lives in app data and is surfaced via
  // the Inbox tab + Today — never as folders in the vault tree or Home.
  const finalNotes = useMemo(
    () => allNotes.filter((n) => !n.path.startsWith('inbox/') && !n.path.startsWith('daily/')),
    [allNotes]
  )
  /** Folder picker choices: every folder holding a note. */
  const folderList = useMemo(() => foldersOf(finalNotes.map((n) => n.path)), [finalNotes])
  /** Tag chip autocomplete: every tag in the vault, A→Z. */
  const allTags = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of finalNotes) for (const t of n.tags) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t)
    return [...m.values()].sort((a, b) => a.localeCompare(b))
  }, [finalNotes])
  const kindCounts = useMemo(() => {
    const m = new Map<NoteKind, number>()
    for (const n of finalNotes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1)
    return m
  }, [finalNotes])
  const kindsPresent = kindCounts.size

  /** Today's day-log index entry, if one exists yet (staging `daily/…`, not the tree). */
  const todayEntry = useMemo(() => {
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return allNotes.find((n) => n.path === `daily/${day}.md`) ?? null
  }, [allNotes])

  /** Every daily note, newest day first — Home's Daily cards + the Journal (index rows only). */
  const journalDays = useMemo(() => dailyRefs(allNotes), [allNotes])

  /** Day notes that exist, oldest first (`YYYY-MM-DD` → entry). */
  const dayNotes = useMemo(() => {
    const out: Array<{ day: string; entry: NoteEntry }> = []
    for (const n of allNotes) {
      const day = dayOfPath(n.path)
      if (day) out.push({ day, entry: n })
    }
    return out.sort((a, b) => a.day.localeCompare(b.day))
  }, [allNotes])
  /** Previous / next existing day note around the open one (skips days with no note). Stepping
   *  forward past the last one onto today opens (and creates) today's note. */
  const openDay = dayOfPath(doc?.path ?? '')
  const dayNav = useMemo(() => {
    if (!openDay) return null
    const today = localDay()
    const prev = [...dayNotes].reverse().find((d) => d.day < openDay) ?? null
    const next = dayNotes.find((d) => d.day > openDay) ?? null
    const toToday = !next && openDay < today
    return {
      prev,
      next,
      toToday,
      onPrev: prev ? () => { selectNote(prev.entry.id); focusEndOn(prev.entry.id) } : null,
      onNext: next
        ? () => { selectNote(next.entry.id); focusEndOn(next.entry.id) }
        : toToday
          ? () => void openToday()
          : null,
      prevLabel: prev ? dailyTitle(prev.day) : undefined,
      nextLabel: next ? dailyTitle(next.day) : toToday ? `${dailyTitle(today)} (today)` : undefined
    }
  }, [openDay, dayNotes, selectNote, openToday, focusEndOn])

  const pickScope = (s: Scope): void => {
    setScope(s)
    if (s === 'home' || s === 'journal') {
      void autosave.flushAll()
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

  // Update notifications: dot on the Settings button; a notification click opens About & updates.
  const [updateBadge, setUpdateBadge] = useState(false)
  useEffect(() => {
    void window.api.updates.get().then((u) => setUpdateBadge(u.showBadge)).catch(() => undefined)
    return window.api.updates.onChanged((u) => setUpdateBadge(u.showBadge))
  }, [])
  useEffect(
    () =>
      window.api.updates.onReveal(() => {
        sessionStorage.setItem('inkfish.settingsTab', 'about')
        setSettingsOpen(true)
      }),
    []
  )

  const pendingCount = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length
  const activeItem = scope === 'inbox' ? inbox.find((i) => i.id === sel?.id) ?? null : null
  const openPath = sel?.origin === 'note' ? doc?.path ?? allNotes.find((n) => n.id === sel.id)?.path ?? null : null

  // --- ⌘K command palette / ⌘O note switcher (ported from Surffish) -------------------
  const [palette, setPalette] = useState<PaletteMode | null>(null)
  /** Bumped to remount Settings on a specific section picked from the palette. */
  const [settingsNonce, setSettingsNonce] = useState(0)
  const openSettingsAt = (tab: string): void => {
    sessionStorage.setItem('inkfish.settingsTab', tab)
    setSettingsNonce((n) => n + 1)
    if (!settingsOpen) openSettings()
  }
  const leaveSettings = (): void => {
    if (settingsOpen) setSettingsOpen(false)
  }
  /** The Journal: every daily note as one timeline (sidebar button, ribbon, Home → Daily, ⌘⇧J). */
  const openJournal = (): void => {
    leaveSettings()
    setShowMeeting(false)
    pickScope('journal')
  }
  const activeTab = activeNoteId ? tabs.find((t) => t.id === activeNoteId) ?? null : null
  const paletteCommands: RunnableCommand[] = [
    { id: 'new-note', title: 'New Note', section: 'Notes', keywords: ['create', 'file', 'add'], run: () => { leaveSettings(); doCreateFile(targetDir) } },
    { id: 'new-folder', title: 'New Folder', section: 'Notes', keywords: ['create', 'directory'], run: () => { leaveSettings(); doCreateFolder() } },
    { id: 'today', title: "Open Today's Note", section: 'Notes', accelerator: 'CmdOrCtrl+Shift+D', keywords: ['daily', 'journal', 'day-log', 'today'], run: () => { leaveSettings(); void openToday() } },
    { id: 'journal', title: 'Open Journal', section: 'Notes', accelerator: 'CmdOrCtrl+Shift+J', keywords: ['daily', 'journal', 'days', 'diary', 'log', 'calendar', 'history'], run: () => openJournal() },
    { id: 'day-prev', title: 'Previous Day Note', section: 'Notes', keywords: ['daily', 'yesterday', 'journal', 'back'], enabled: !!dayNav?.onPrev, run: () => { leaveSettings(); dayNav?.onPrev?.() } },
    { id: 'day-next', title: 'Next Day Note', section: 'Notes', keywords: ['daily', 'tomorrow', 'journal', 'forward'], enabled: !!dayNav?.onNext, run: () => { leaveSettings(); dayNav?.onNext?.() } },
    { id: 'search-text', title: 'Search Note Text…', section: 'Notes', keywords: ['find', 'full text'], run: () => {
      leaveSettings()
      setSideCollapsed(false)
      setTimeout(() => document.querySelector<HTMLInputElement>('.side-search')?.focus(), 0)
    } },
    { id: 'rename-note', title: 'Rename Note…', section: 'Notes', enabled: !!openPath, run: () => openPath && doRename(openPath, false) },
    { id: 'move-note', title: 'Move Note to…', section: 'Notes', keywords: ['folder', 'file', 'relocate', 'organize'], enabled: !!openPath && !openPath.startsWith('inbox/') && !openPath.startsWith('daily/'), run: () => {
      leaveSettings()
      if (openPath && doc) openMovePicker(openPath, 'file', titleOf(doc))
    } },
    { id: 'tag-search', title: 'Search by Tag…', section: 'Notes', keywords: ['tags', '#', 'filter'], run: () => {
      leaveSettings()
      setSideCollapsed(false)
      setQuery('#')
      setTimeout(() => document.querySelector<HTMLInputElement>('.side-search')?.focus(), 0)
    } },
    { id: 'rescan', title: 'Rescan Vault', section: 'Notes', keywords: ['reindex', 'refresh'], run: () => {
      window.api.vault
        .reindex()
        .then((r) => {
          setBackend(r.backend)
          refreshAll()
          notify(`Re-indexed ${r.indexed} notes`)
        })
        .catch((err: unknown) => notify(`Reindex failed: ${String(err)}`))
    } },
    { id: 'go-home', title: 'Go to Home', section: 'Navigate', keywords: ['dashboard'], run: () => { leaveSettings(); pickScope('home') } },
    { id: 'go-notes', title: 'Go to Notes', section: 'Navigate', keywords: ['files', 'tree'], run: () => { leaveSettings(); pickScope('notes') } },
    { id: 'go-inbox', title: 'Go to Inbox', section: 'Navigate', keywords: ['captures', 'queue'], run: () => { leaveSettings(); pickScope('inbox') } },
    { id: 'meetings', title: meetingLive ? 'Meetings (recording)' : 'Meetings', section: 'Navigate', keywords: ['record', 'transcribe', 'capture', 'call', 'zoom', 'teams'], run: () => { leaveSettings(); setShowMeeting(true) } },
    { id: 'meeting-record', title: meetingLive ? 'Go to Live Meeting Recording' : 'Record a Meeting…', section: 'Meetings', keywords: ['start', 'capture', 'transcribe', 'mic'], run: () => { leaveSettings(); setShowMeeting(true) } },
    { id: 'meeting-close', title: 'Close Meetings', section: 'Meetings', enabled: showMeeting, keywords: ['back', 'exit'], run: () => setShowMeeting(false) },
    { id: 'ai-toggle-view', title: 'AI: Raw / Processed View', section: 'AI', accelerator: 'Shift+Alt+P', keywords: ['format', 'tidy', 'processed', 'raw', 'llm'], enabled: !!doc, run: () => { leaveSettings(); sendAiCommand('toggle-view') } },
    { id: 'ai-process-note', title: 'AI: Process Note', section: 'AI', keywords: ['format', 'tidy', 'summarise', 'summarize', 'checklist', 'typos'], enabled: !!doc, run: () => { leaveSettings(); sendAiCommand('process-note') } },
    { id: 'ai-process-selection', title: 'AI: Process Selection…', section: 'AI', accelerator: 'Shift+Alt+S', keywords: ['format', 'rewrite', 'fix', 'selected'], enabled: !!doc, run: () => { leaveSettings(); sendAiCommand('process-selection') } },
    { id: 'toggle-sidebar', title: 'Toggle Sidebar', section: 'View', accelerator: 'CmdOrCtrl+\\', keywords: ['collapse', 'hide'], run: () => setSideCollapsed((v) => !v) },
    { id: 'pop-out', title: 'Pop Out to Mini Window', section: 'Window', accelerator: 'CmdOrCtrl+Shift+M', keywords: ['float', 'pin', 'mini', 'detach', 'tear off', 'always on top', 'side tab', 'tuck'], enabled: !!activeNoteId, run: () => popOut(activeNoteId) },
    { id: 'close-tab', title: 'Close Tab', section: 'Tabs', enabled: !!activeTab, run: () => activeTab && closeTab(activeTab.id) },
    { id: 'close-other-tabs', title: 'Close Other Tabs', section: 'Tabs', enabled: !!activeTab && tabs.length > 1, run: () => activeTab && closeOthers(activeTab.id) },
    { id: 'pin-tab', title: activeTab?.pinned ? 'Unpin Tab' : 'Pin Tab', section: 'Tabs', enabled: !!activeTab, run: () => activeTab && togglePin(activeTab.id) },
    { id: 'settings', title: 'Open Settings', section: 'Settings', keywords: ['preferences', 'options'], accelerator: 'CmdOrCtrl+,', run: () => openSettingsAt(sessionStorage.getItem('inkfish.settingsTab') ?? 'appearance') },
    ...([
      ['appearance', 'Appearance', ['theme', 'font', 'accent', 'density', 'menu bar', 'tray']],
      ['mini-window', 'Mini Window', ['float', 'dock', 'tuck']],
      ['notes', 'Notes Location', ['vault', 'folder', 'move']],
      ['sync', 'Sync', ['phone', 'android', 'pair', 'lan']],
      ['trash', 'Trash', ['deleted', 'restore']],
      ['audio', 'Audio', ['microphone', 'input']],
      ['voice', 'Voice Engine', ['speech', 'transcription', 'stt', 'whisper', 'parakeet']],
      ['ai', 'AI Provider', ['openai', 'anthropic', 'api key', 'llm', 'model', 'connect']],
      ['apple-intelligence', 'Apple Intelligence', ['ai', 'summarize', 'classify']]
    ] as Array<[string, string, string[]]>).map(([tab, label, keywords]): RunnableCommand => ({
      id: `settings-${tab}`,
      title: `Settings: ${label}`,
      section: 'Settings',
      keywords,
      run: () => openSettingsAt(tab)
    })),
    { id: 'hide-window', title: 'Hide Inkfish', section: 'App', run: () => void window.api.win.hide() },
    { id: 'quit', title: 'Quit Inkfish', section: 'App', keywords: ['exit', 'close app'], run: () => void window.api.app.quit() }
  ]
  const paletteNotes = useMemo(
    () => allNotes.map((n) => ({ id: n.id, title: titleOf(n), path: n.path, tags: n.tags, updatedAt: n.updatedAt })),
    [allNotes, titleOf]
  )

  // ⌘K palette, ⌘O notes only, ⇧⌘P commands only, ⌘, settings. Capture phase so the editor
  // can't swallow them; pressing the same shortcut again closes the palette.
  const paletteRef = useRef<PaletteMode | null>(null)
  paletteRef.current = palette
  const openSettingsRef = useRef(openSettings)
  openSettingsRef.current = openSettings
  // "Open Settings › AI" from an AI error in the editor.
  const openSettingsAtRef = useRef(openSettingsAt)
  openSettingsAtRef.current = openSettingsAt
  useEffect(() => {
    const onOpen = (e: Event): void => openSettingsAtRef.current(String((e as CustomEvent<string>).detail || 'ai'))
    window.addEventListener('inkfish:open-settings', onOpen)
    return () => window.removeEventListener('inkfish:open-settings', onOpen)
  }, [])
  const openJournalRef = useRef<() => void>(() => undefined)
  const openTodayRef = useRef(() => {
    leaveSettings()
    void openToday()
  })
  openTodayRef.current = () => {
    leaveSettings()
    void openToday()
  }
  openJournalRef.current = () => openJournal()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      let mode: PaletteMode | null = null
      if (key === 'k' && !e.shiftKey) mode = 'all'
      else if (key === 'o' && !e.shiftKey) mode = 'notes'
      else if (key === 'p' && e.shiftKey) mode = 'commands'
      else if (key === ',' && !e.shiftKey) {
        e.preventDefault()
        openSettingsRef.current()
        return
      } else if (key === 'd' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        openTodayRef.current()
        return
      } else if (key === 'j' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        openJournalRef.current()
        return
      }
      if (!mode) return
      e.preventDefault()
      e.stopPropagation()
      setPalette(paletteRef.current === mode ? null : mode)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className={`shell${sideCollapsed ? ' side-collapsed' : ''}`} data-platform={sys?.platform ?? 'unknown'}>
      {/* Sidebar toggle (Obsidian-style): pinned in the titlebar strip right of the traffic lights,
          same spot whether the sidebar is open or collapsed. Fixed + no-drag (shared/sidebar.ts). */}
      <button
        className="side-toggle titlebar-toggle"
        onClick={() => setSideCollapsed((v) => !v)}
        title={`${sideCollapsed ? 'Show' : 'Hide'} sidebar (${isMacUi ? '⌘\\' : 'Ctrl+\\'})`}
        aria-label={sideCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-expanded={!sideCollapsed}
        aria-pressed={!sideCollapsed}
      >
        <Icon name="panel-left" size={18} />
      </button>

      {/* Collapsed: slim icon ribbon so the app stays navigable without the full sidebar. */}
      {sideCollapsed && (
        <nav className="side-ribbon" aria-label="Navigation">
          <button
            className="ribbon-btn"
            title={`Search notes (${isMacUi ? '⌘\\' : 'Ctrl+\\'} shows the sidebar)`}
            aria-label="Search notes"
            onClick={() => {
              setSideCollapsed(false)
              if (scope !== 'notes') setScope('notes')
              setTimeout(() => document.querySelector<HTMLInputElement>('.side-search')?.focus(), 0)
            }}
          >
            <Icon name="search" size={18} />
          </button>
          {(['home', 'notes', 'inbox'] as Scope[]).map((s) => {
            const on = scope === s && !settingsOpen && !showMeeting
            return (
              <button
                key={s}
                className={`ribbon-btn${on ? ' on' : ''}`}
                title={s === 'home' ? 'Home' : s === 'notes' ? 'Notes' : `Inbox${pendingCount > 0 ? ` (${pendingCount})` : ''}`}
                aria-label={s === 'home' ? 'Home' : s === 'notes' ? 'Notes' : 'Inbox'}
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  leaveSettings()
                  setShowMeeting(false)
                  pickScope(s)
                  // The inbox queue lives in the sidebar — bring it back to show it.
                  if (s === 'inbox') setSideCollapsed(false)
                }}
              >
                <Icon name={s} size={18} />
                {s === 'inbox' && pendingCount > 0 && <span className="ribbon-dot" aria-hidden />}
              </button>
            )
          })}
          <span className="ribbon-sep" aria-hidden />
          <button
            className="ribbon-btn"
            title={`Today's note (${isMacUi ? '⌘⇧D' : 'Ctrl+Shift+D'})`}
            aria-label="Today's note"
            onClick={() => {
              leaveSettings()
              void openToday()
            }}
          >
            <Icon name="sun" size={18} />
          </button>
          <button
            className={`ribbon-btn${scope === 'journal' && !settingsOpen && !showMeeting ? ' on' : ''}`}
            title={`Journal (${isMacUi ? '⌘⇧J' : 'Ctrl+Shift+J'})`}
            aria-label="Journal"
            aria-current={scope === 'journal' && !settingsOpen && !showMeeting ? 'page' : undefined}
            onClick={openJournal}
          >
            <Icon name="journal" size={18} />
          </button>
          <button
            className={`ribbon-btn${showMeeting && !settingsOpen ? ' on' : ''}${meetingLive ? ' rec-live' : ''}`}
            title={meetingLive ? 'Meeting recording — open it' : 'Meetings: record & transcribe a call'}
            aria-label={meetingLive ? 'Recording' : 'Meetings'}
            aria-pressed={showMeeting && !settingsOpen}
            onClick={() => {
              leaveSettings()
              setShowMeeting(true)
            }}
          >
            <Icon name={meetingLive ? 'record' : 'mic'} size={18} />
          </button>
          <span className="flex-sp" />
          <button
            className={`ribbon-btn${settingsOpen ? ' on' : ''}`}
            title="Settings"
            aria-label="Settings"
            onClick={openSettings}
          >
            <Icon name="settings" size={18} />
            {updateBadge && <span className="ribbon-dot" aria-label="Update available" />}
          </button>
        </nav>
      )}

      {/* Core sidebar: search, scopes, dir tree with files, kind filters. */}
      <aside className="sidebar core" inert={sideCollapsed} aria-hidden={sideCollapsed || undefined}>
        {/* Titlebar strip: window drag handle; the toggle floats over its left end. */}
        <div className="side-head">
          <span className="flex-sp" />
          {profile?.badge && (
            <span className="pill profile-pill" title={`Separate ${profile.name} profile — its own settings, notes folder and sync`}>
              {profile.badge}
            </span>
          )}
          {/* Psst: triple-click the logo (views/easter-egg). */}
          <div className="brand-logo-frame" onClick={brandEgg.onClick} title={APP_NAME}>
            <img src={logoUrl} alt={APP_NAME} className="brand-logo-img" draggable={false} />
          </div>
        </div>

        <div className="side-search-wrap">
          <Icon name="search" size={15} className="side-search-icon" />
          <input
            className="search side-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (scope !== 'notes') setScope('notes')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
            placeholder="Search notes…"
            aria-label="Search notes"
            spellCheck={false}
          />
        </div>

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

        {/* Day-log + meetings live here (not above the note) so the doc gets the full pane. */}
        <div className="side-actions" role="toolbar" aria-label="Quick actions">
          <button
            className="side-action"
            title={`Open today's note (${isMacUi ? '⌘⇧D' : 'Ctrl+Shift+D'}) · ${captureKey || 'quick capture'} → Today adds a timestamped line here`}
            onClick={() => {
              leaveSettings()
              void openToday()
            }}
          >
            <Icon name="sun" size={16} /> Today
          </button>
          <button
            className={`side-action${scope === 'journal' && !settingsOpen && !showMeeting ? ' on' : ''}`}
            title={`Journal: every daily note in one timeline (${isMacUi ? '⌘⇧J' : 'Ctrl+Shift+J'})`}
            aria-pressed={scope === 'journal' && !settingsOpen && !showMeeting}
            onClick={openJournal}
          >
            <Icon name="journal" size={16} /> Journal
          </button>
          <button
            className={`side-action${showMeeting && !settingsOpen ? ' on' : ''}${meetingLive ? ' rec-live' : ''}`}
            title={meetingLive ? 'Meeting recording — open it' : 'Meetings: record & transcribe a call'}
            aria-pressed={showMeeting && !settingsOpen}
            onClick={() => {
              leaveSettings()
              setShowMeeting(true)
            }}
          >
            <Icon name={meetingLive ? 'record' : 'mic'} size={16} /> {meetingLive ? 'Recording' : 'Meetings'}
          </button>
        </div>

        {scope === 'inbox' ? (
          <div className="side-scroll">
            <InboxQueue
              items={inbox}
              projects={projects}
              selectedId={sel !== null && sel.origin === 'inbox' ? sel.id : null}
              onSelect={selectInbox}
              onDelete={deleteInbox}
              onRefresh={refreshAll}
              notify={notify}
            />
          </div>
        ) : (
          <div className="side-scroll">
            <FolderTree
              captureKey={captureKey}
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
              onNewNote={() => doCreateFile(targetDir)}
              onNewFolder={doCreateFolder}
              targetDir={targetDir}
              onMove={(rel, k, dest) => void doMove(rel, k, dest)}
              rowActions={rowActions}
              filters={
                // Only worth a row when there is something to filter between (or a filter is on).
                kindsPresent > 1 || kind !== 'all' ? (
                  <div className="chips kinds" aria-label="Filter by kind">
                    {KINDS.filter((k) => k.id === 'all' || (kindCounts.get(k.id as NoteKind) ?? 0) > 0 || kind === k.id).map((k) => (
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
                        <span className="count">{k.id === 'all' ? finalNotes.length : (kindCounts.get(k.id as NoteKind) ?? 0)}</span>
                      </button>
                    ))}
                  </div>
                ) : null
              }
            />
          </div>
        )}

        {/* Obsidian-style bottom vault bar: vault chip left, equal icon buttons right. Version
            rides in the chip tooltip (and Settings › About) to keep the row quiet. */}
        <div className="side-foot">
          <button
            className="vault-chip"
            onClick={() => void window.api.vault.reveal()}
            title={vaultTooltip(vaultInfo?.root, sys?.appVersion)}
            aria-label={`Open vault folder ${vaultLabel(vaultInfo?.root)}`}
          >
            <Icon name="folder" size={14} />
            <span className="vault-name">{vaultLabel(vaultInfo?.root)}</span>
          </button>
          <div className="foot-actions">
            <SyncBadge onOpen={() => openSettingsAt('sync')} />
            <button
              className="foot-btn"
              onClick={openSettings}
              title={updateBadge ? 'Settings — update available' : 'Settings'}
              aria-label="Settings"
            >
              <Icon name="settings" size={16} />
              {updateBadge && <span className="update-dot" aria-label="Update available" />}
            </button>
            <button
              className="foot-btn quit"
              onClick={() => void window.api.app.quit()}
              title="Quit Inkfish"
              aria-label="Quit Inkfish"
            >
              <Icon name="power" size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Center: home dashboard, note stage, or full-page settings. */}
      <div className="content inkfish center">
        {/* Window drag strip along the top; while collapsed it also carries the live-recording
            chip (the toggle itself is the fixed .titlebar-toggle above). */}
        <div className="side-rail" aria-hidden={!sideCollapsed || undefined}>
          {sideCollapsed && meetingLive && !showMeeting && (
            <button className="side-toggle rail-chip rec-live" onClick={() => { leaveSettings(); setShowMeeting(true) }} title="Meeting recording — open it">
              <Icon name="record" size={12} /> Recording
            </button>
          )}
        </div>
        {settingsOpen ? (
          <main className="view-scroll" aria-label="Settings">
            <SettingsView
              key={settingsNonce}
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
        ) : showMeeting ? null : (
          <>

            {scope === 'home' ? (
              <main className="view-scroll" aria-label="Home">
                <Home
                  captureKey={captureKey}
                  notes={finalNotes}
                  inbox={inbox}
                  today={todayEntry}
                  days={journalDays}
                  onOpenJournal={openJournal}
                  titleOf={titleOf}
                  onOpenNote={selectNote}
                  onOpenInbox={() => pickScope('inbox')}
                  onOpenToday={() => void openToday()}
                  onTodayAppended={refreshAll}
                  onOpenFolder={(rel) => {
                    if (rel) {
                      setTargetDir(rel)
                      setRevealDir(rel)
                    }
                    setScope('notes')
                  }}
                  notify={notify}
                />
              </main>
            ) : scope === 'journal' ? (
              <main className="view-scroll" aria-label="Journal">
                <Journal
                  days={journalDays}
                  onOpen={(id) => {
                    selectNote(id)
                    focusEndOn(id)
                  }}
                  onOpenToday={() => void openToday()}
                />
              </main>
            ) : (
              <main className="note-stage" aria-label="Note">
                <TabBar
                  tabs={tabs}
                  activeId={sel?.origin === 'note' ? sel.id : null}
                  allNotes={allNotes}
                  titles={titles}
                  titleOf={titleOf}
                  onActivate={(id) => openEntry(id, 'note')}
                  onClose={closeTab}
                  onTogglePin={togglePin}
                  onMenu={(id, x, y) => setMenu({ x, y, target: { kind: 'tab', id } })}
                  onNew={() => doCreateFile(targetDir)}
                  onPopOut={(id) => popOut(id)}
                  onTearOut={(id) => popOut(id, { tear: true })}
                  popTitle={popTitle}
                />
                {sel?.origin === 'inbox' && activeItem && (
                  <InboxBar
                    item={activeItem}
                    projects={projects}
                    onDelete={() => deleteInbox(activeItem.id)}
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
                  draft={draftForEditor(doc, drafts)}
                  onDraft={handleDraft}
                  onFlush={() => void flushAll()}
                  onRename={(t) => {
                    if (doc) renameNote(doc.id, t)
                  }}
                  renameHint={
                    prefs.nameFromTitle && sel?.origin === 'note' && doc && isTitleSyncPath(doc.path)
                      ? 'Click to rename — renames the file'
                      : 'Click to rename (display title only, file untouched)'
                  }
                  onEditorBlur={() => titleSync.flush()}
                  {...(dayNav ? { dayNav: { onPrev: dayNav.onPrev, onNext: dayNav.onNext, prevLabel: dayNav.prevLabel, nextLabel: dayNav.nextLabel } } : {})}
                  focusEnd={focusEnd}
                  onMore={(x, y) => setMenu({ x, y, target: { kind: 'open-note' } })}
                  onPopOut={sel?.origin === 'note' ? () => popOut(sel.id) : undefined}
                  popOutTitle={popTitle}
                  {...(sel?.origin === 'note' && doc && !doc.path.startsWith('inbox/') && !doc.path.startsWith('daily/')
                    ? {
                        onMoveClick: (x: number, y: number) => openMovePicker(doc.path, 'file', titleOf(doc), x, y),
                        onSetTags: (t: string[]) => void setNoteTags(t),
                        onTagClick: (t: string) => {
                          setSideCollapsed(false)
                          setQuery(`#${t}`)
                        },
                        allTags
                      }
                    : {})}
                />
              </main>
            )}
          </>
        )}
        {(showMeeting || meetingLive) && (
          <main className="view-scroll" aria-label="Meetings" hidden={!showMeeting || settingsOpen}>
            <Meetings
              notes={finalNotes}
              titleOf={titleOf}
              onOpenNote={(id) => {
                setShowMeeting(false)
                selectNote(id)
              }}
              onRefresh={refreshAll}
              onClose={() => setShowMeeting(false)}
              onRecording={setMeetingLive}
              notify={notify}
            />
          </main>
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
      {palette && (
        <CommandPalette
          mode={palette}
          commands={paletteCommands}
          notes={paletteNotes}
          platform={sys?.platform ?? 'darwin'}
          onClose={() => setPalette(null)}
          onOpenNote={(id, pop) => {
            if (pop) popOut(id)
            else {
              leaveSettings()
              selectNote(id)
            }
          }}
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
          profile={profile}
          onVaultReady={onVaultReady}
          onDone={() => setShowOnboarding(false)}
          notify={notify}
        />
      )}
      {movePick && (
        <FolderPicker
          title={`Move “${movePick.name.slice(0, 40)}” to…`}
          folders={movePick.kind === 'dir' ? folderList.filter((f) => f !== movePick.rel && !f.startsWith(`${movePick.rel}/`)) : folderList}
          current={dirOf(movePick.rel)}
          x={movePick.x}
          y={movePick.y}
          onPick={(dir) => {
            const m = movePick
            setMovePick(null)
            void doMove(m.rel, m.kind, dir)
          }}
          onClose={() => setMovePick(null)}
        />
      )}
      {delAsk && (
        <DeletePopover
          anchor={delAsk.anchor}
          title={delAsk.title}
          path={delAsk.entry.path}
          lines={delAsk.lines}
          size={delAsk.entry.size}
          updatedAt={delAsk.entry.updatedAt}
          onConfirm={() => {
            const d = delAsk
            setDelAsk(null)
            void trashWithUndo(d.entry.path, d.title)
          }}
          onCancel={() => {
            const id = delAsk.entry.id
            setDelAsk(null)
            window.setTimeout(() => rowEl(id)?.querySelector<HTMLButtonElement>('.filerow')?.focus(), 0)
          }}
        />
      )}
      {undoDel && !toast && (
        <UndoToast
          key={undoDel.key}
          message={undoDel.message}
          onClose={closeUndo}
          onUndo={() => void undoTrash(undoDel)}
        />
      )}
      {toast && <div className="toast glass">{toast}</div>}
      {brandEgg.open && <BrandEasterEgg logoUrl={logoUrl} onClose={brandEgg.close} />}
    </div>
  )
}

/** Obsidian-style tab strip: pinned files stay, × closes, right-click for more, drag out → mini window. */
function TabBar({
  tabs, activeId, allNotes, titles, titleOf,
  onActivate, onClose, onTogglePin, onMenu, onNew, onPopOut, onTearOut, popTitle
}: {
  tabs: Tab[]
  activeId: string | null
  allNotes: NoteEntry[]
  titles: Record<string, string>
  titleOf: (e: { id: string; path: string; title: string }) => string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onTogglePin: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
  onNew: () => void
  onPopOut: (id: string) => void
  onTearOut: (id: string) => void
  popTitle: string
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)
  /** A press on a tab that may become a tear-off drag (pointer captured, so it tracks outside the window). */
  const dragRef = useRef<{ id: string; pointerId: number; start: { x: number; y: number }; moved: boolean } | null>(null)
  /** Swallow the click that follows a drag. */
  const suppressClick = useRef(false)
  const [tearing, setTearing] = useState<{ id: string; x: number; y: number; label: string } | null>(null)
  const byId = new Map(allNotes.map((n) => [n.id, n]))
  const ordered = [...tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  if (ordered.length === 0) return <div className="tabbar empty" aria-hidden />

  const phaseAt = (x: number, y: number): ReturnType<typeof tabDragPhase> => {
    const d = dragRef.current
    const r = barRef.current?.getBoundingClientRect()
    if (!d || !r) return 'press'
    return tabDragPhase(d.start, { x, y }, r, { width: window.innerWidth, height: window.innerHeight })
  }

  return (
    <div className="tabbar" role="tablist" aria-label="Open notes" ref={barRef}>
      {ordered.map((t) => {
        const entry = byId.get(t.id)
        const label = titleOf({ id: t.id, path: entry?.path ?? t.path, title: entry?.title ?? '' })
        const isActive = t.id === activeId
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            className={`tab${isActive ? ' on' : ''}${t.pinned ? ' pinned' : ''}${tearing?.id === t.id ? ' tearing' : ''}`}
            title={`${entry?.path ?? t.path}\nDrag out of the tab bar to pop into a mini window`}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              onActivate(t.id)
            }}
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
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
              dragRef.current = { id: t.id, pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, moved: false }
              suppressClick.current = false
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                // no capture: the drag just ends at the window edge
              }
            }}
            onPointerMove={(e) => {
              const d = dragRef.current
              if (!d || d.pointerId !== e.pointerId) return
              const phase = phaseAt(e.clientX, e.clientY)
              if (phase !== 'press') d.moved = true
              if (phase === 'tear') setTearing({ id: t.id, x: e.clientX, y: e.clientY, label })
              else setTearing((prev) => (prev ? null : prev))
            }}
            onPointerUp={(e) => {
              const d = dragRef.current
              if (!d || d.pointerId !== e.pointerId) return
              const phase = phaseAt(e.clientX, e.clientY)
              dragRef.current = null
              setTearing(null)
              if (!d.moved) return
              suppressClick.current = true
              if (phase === 'tear') onTearOut(d.id)
            }}
            onPointerCancel={() => {
              dragRef.current = null
              setTearing(null)
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
            <button
              className="tab-pop"
              title={popTitle}
              aria-label={`Pop ${label} out to a mini window`}
              onClick={(e) => {
                e.stopPropagation()
                onPopOut(t.id)
              }}
            >
              <PopOutIcon />
            </button>
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
      {tearing && (
        <div className="tab-tear-ghost glass" style={{ left: tearing.x + 12, top: tearing.y + 10 }} aria-hidden>
          <PopOutIcon />
          <span>{tearing.label}</span>
          <span className="muted">→ mini window</span>
        </div>
      )}
    </div>
  )
}

/** Action bar pinned above inbox docs: route / move / undo / delete without leaving the note. */
function InboxBar({
  item, projects, onDone, onDelete, notify
}: {
  item: InboxItem
  projects: Project[]
  onDone: (noteId?: string) => void
  onDelete: () => void
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
      <span className="qsub muted">{item.kind}{item.status === 'processing' ? ' · routing…' : item.status === 'ready' ? ' · ready ✓' : ''}</span>
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
      <button className="btn ghost sm danger-quiet" disabled={busy} onClick={onDelete} title="Delete permanently">
        Delete
      </button>
    </div>
  )
}
