import { useEffect, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { NoteEntry } from '../../../shared/types'
import type { KindFilter } from '../views/FolderTree'
import { applyPrefs, loadPrefs, type Prefs } from '../theme'
import {
  SIDE_COLLAPSED_KEY,
  isSidebarToggleKey,
  parseSideCollapsed,
  serializeSideCollapsed
} from '../../../shared/sidebar'
import { matchesTags, parseTagQuery } from '../../../shared/tags'
import type { Scope } from '../shell/types'

/**
 * Shell-only UI state: which page is showing, the sidebar and its search box,
 * appearance prefs, settings navigation and the meetings pane. Nothing here
 * knows about notes or files.
 */
export function useShellUi({ allNotesRef }: { allNotesRef: MutableRefObject<NoteEntry[]> }): {
  scope: Scope
  setScope: Dispatch<SetStateAction<Scope>>
  settingsOpen: boolean
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  settingsReturn: Scope
  settingsNonce: number
  kind: KindFilter
  setKind: Dispatch<SetStateAction<KindFilter>>
  targetDir: string
  setTargetDir: Dispatch<SetStateAction<string>>
  revealDir: string | null
  setRevealDir: Dispatch<SetStateAction<string | null>>
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  results: NoteEntry[] | null
  showMeeting: boolean
  setShowMeeting: Dispatch<SetStateAction<boolean>>
  meetingLive: boolean
  setMeetingLive: Dispatch<SetStateAction<boolean>>
  prefs: Prefs
  setPrefs: Dispatch<SetStateAction<Prefs>>
  updateBadge: boolean
  sideCollapsed: boolean
  setSideCollapsed: Dispatch<SetStateAction<boolean>>
  pickDir: (rel: string) => void
  openSettings: () => void
  openSettingsAt: (tab: string) => void
  leaveSettings: () => void
} {
  const [scope, setScope] = useState<Scope>('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsReturn, setSettingsReturn] = useState<Scope>('home')
  const [kind, setKind] = useState<KindFilter>('all')
  /** Dir new files/folders land in ('' = vault root). Set by clicking a folder. */
  const [targetDir, setTargetDir] = useState('')
  const [revealDir, setRevealDir] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NoteEntry[] | null>(null)
  const [showMeeting, setShowMeeting] = useState(false)
  /** A capture is running — keep the Meetings page mounted while you browse. */
  const [meetingLive, setMeetingLive] = useState(false)
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
  /** Collapsible core sidebar (Blobfish-style) — persisted; toggled from the sidebar header,
   *  the collapsed rail, ⌘\ or the palette. */
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(() => {
    try {
      return parseSideCollapsed(localStorage.getItem(SIDE_COLLAPSED_KEY))
    } catch {
      return false
    }
  })
  /** Bumped to remount Settings on a specific section picked from the palette. */
  const [settingsNonce, setSettingsNonce] = useState(0)
  const [updateBadge, setUpdateBadge] = useState(false)

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
        window.api.notes
          .search(tq.text)
          .then((r) => setResults(r.filter((n) => ok.has(n.id))))
          .catch(console.error)
        return
      }
      window.api.notes.search(query.trim()).then(setResults).catch(console.error)
    }, 180)
    return () => window.clearTimeout(t)
  }, [query, allNotesRef])

  // Update notifications: dot on the Settings button; a notification click opens About & updates.
  useEffect(() => {
    void window.api.updates
      .get()
      .then((u) => setUpdateBadge(u.showBadge))
      .catch(() => undefined)
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

  const pickDir = (rel: string): void => {
    setTargetDir(rel)
    setRevealDir(rel)
  }

  const openSettings = (): void => {
    setSettingsReturn(scope)
    setSettingsOpen(true)
  }

  const openSettingsAt = (tab: string): void => {
    sessionStorage.setItem('inkfish.settingsTab', tab)
    setSettingsNonce((n) => n + 1)
    if (!settingsOpen) openSettings()
  }

  const leaveSettings = (): void => {
    if (settingsOpen) setSettingsOpen(false)
  }

  return {
    scope,
    setScope,
    settingsOpen,
    setSettingsOpen,
    settingsReturn,
    settingsNonce,
    kind,
    setKind,
    targetDir,
    setTargetDir,
    revealDir,
    setRevealDir,
    query,
    setQuery,
    results,
    showMeeting,
    setShowMeeting,
    meetingLive,
    setMeetingLive,
    prefs,
    setPrefs,
    updateBadge,
    sideCollapsed,
    setSideCollapsed,
    pickDir,
    openSettings,
    openSettingsAt,
    leaveSettings
  }
}
