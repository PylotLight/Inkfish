import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { InboxItem, NoteEntry, Project, SysInfo, VaultInfo } from '../../../shared/types'
import { shortcutLabel, type AppProfileInfo } from '../../../shared/profile'
import { loadPrefs } from '../theme'

/**
 * Everything the main process owns: notes, inbox, projects, titles, the vault
 * pointer, the app profile, and the refresh calls that pull them again.
 * Owning it in one hook keeps the shell from re-deriving "what changed".
 */
export function useVaultData(): {
  sys: SysInfo | null
  profile: AppProfileInfo | null
  isMacUi: boolean
  captureKey: string
  projects: Project[]
  allNotes: NoteEntry[]
  allNotesRef: React.MutableRefObject<NoteEntry[]>
  inbox: InboxItem[]
  vaultInfo: VaultInfo | null
  backend: string
  setBackend: Dispatch<SetStateAction<string>>
  titles: Record<string, string>
  setTitles: Dispatch<SetStateAction<Record<string, string>>>
  setAllNotes: Dispatch<SetStateAction<NoteEntry[]>>
  titleNamedRef: React.MutableRefObject<Set<string>>
  refreshTitleNamed: () => void
  notify: (msg: string) => void
  toast: string | null
  refreshInbox: () => void
  refreshProjects: () => void
  refreshNotes: () => void
  refreshAll: () => void
  showOnboarding: boolean
  setShowOnboarding: Dispatch<SetStateAction<boolean>>
  ostep: number
  setOstep: Dispatch<SetStateAction<number>>
  onVaultReady: (v: VaultInfo) => void
} {
  const [sys, setSys] = useState<SysInfo | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [allNotes, setAllNotes] = useState<NoteEntry[]>([])
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [ostep, setOstep] = useState(0)
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [backend, setBackend] = useState('…')
  const [titles, setTitles] = useState<Record<string, string>>({})

  // Refs so tab callbacks stay stable without re-creating per keystroke.
  const allNotesRef = useRef<NoteEntry[]>([])
  allNotesRef.current = allNotes
  /** Notes Inkfish named from their title (main keeps the list): they keep following it. */
  const titleNamedRef = useRef(new Set<string>())

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }, [])

  const refreshTitleNamed = useCallback(() => {
    window.api.notes
      .titleNamed()
      .then((list) => {
        titleNamedRef.current = new Set(list)
      })
      .catch(console.error)
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
      setProfile((p) =>
        p
          ? {
              ...p,
              captureShortcut: s.disabled ? '' : s.settings.capture,
              dailyShortcut: s.disabled ? '' : s.settings.daily
            }
          : p
      )
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

  const onVaultReady = useCallback(
    (v: VaultInfo) => {
      setVaultInfo(v)
      window.api.vault.backend().then(setBackend).catch(console.error)
      refreshAll()
    },
    [refreshAll]
  )

  useEffect(() => window.api.onVaultChanged(() => refreshAll()), [refreshAll])

  return {
    sys,
    profile,
    isMacUi,
    captureKey,
    projects,
    allNotes,
    allNotesRef,
    inbox,
    vaultInfo,
    backend,
    setBackend,
    titles,
    setTitles,
    setAllNotes,
    titleNamedRef,
    refreshTitleNamed,
    notify,
    toast,
    refreshInbox,
    refreshProjects,
    refreshNotes,
    refreshAll,
    showOnboarding,
    setShowOnboarding,
    ostep,
    setOstep,
    onVaultReady
  }
}
