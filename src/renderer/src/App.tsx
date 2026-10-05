import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_NAME } from '../../shared/config'
import type { InboxItem, NoteDoc, NoteEntry, Project, SysInfo, VaultInfo } from '../../shared/types'
import { applyTheme, loadTheme, type ThemeState } from './theme'
import Capture from './views/Capture'
import InboxQueue from './views/InboxQueue'
import NoteEditor from './views/NoteEditor'
import Onboarding from './views/Onboarding'
import MeetingImport from './views/MeetingImport'
import Settings from './views/Settings'

/** Popover windows load the same bundle with `#capture` — render capture only. */
export function isCaptureWindow(): boolean {
  return typeof window !== 'undefined' && window.location.hash === '#capture'
}

type Selection = { id: string; origin: 'inbox' | 'note' } | null
type Scope = 'notes' | 'inbox'

/** Strip markdown chrome for list rows (titles/snippets stay readable). */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
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
  const [scope, setScope] = useState<Scope>('notes')
  const [activeProject, setActiveProject] = useState<string | null>(null)
  const [sel, setSel] = useState<Selection>(null)
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NoteEntry[] | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [ostep, setOstep] = useState(0)
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null)
  const [showMeeting, setShowMeeting] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [newProject, setNewProject] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [backend, setBackend] = useState('…')
  const [prefs, setPrefs] = useState<ThemeState>(() => loadTheme())

  useEffect(() => {
    applyTheme(prefs)
  }, [prefs])

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

  // One fetch for every note — filtering is client-side so switching
  // folders/search never round-trips through IPC.
  const refreshNotes = useCallback(() => {
    window.api.notes.list(null).then(setAllNotes).catch(console.error)
  }, [])

  const refreshAll = useCallback(() => {
    refreshInbox()
    refreshNotes()
    refreshProjects()
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
        // Restore blur preference (main resets to default on launch).
        const blur = loadTheme().blur
        if (!blur) window.api.glass.set(null).catch(() => undefined)
        if (!localStorage.getItem('inkfish.onboarded')) {
          setOstep(0)
          setShowOnboarding(true)
        }
      })
      .catch(console.error)
  }, [refreshInbox, refreshNotes, refreshProjects])

  // Search-as-you-type lives in the sidebar; results replace the notes list.
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
      setDirty(false)
      if (origin === 'note') {
        window.api.notes.get(id).then(setDoc).catch(console.error)
      } else {
        const item = inbox.find((i) => i.id === id)
        setDoc(
          item
            ? {
                id: item.id, path: `inbox/${item.id}.md`, title: plain(item.raw).slice(0, 80) || item.id,
                kind: item.kind, status: item.status, projectId: null, inboxId: item.id,
                tags: [], snippet: item.raw.slice(0, 220), createdAt: item.createdAt,
                updatedAt: item.createdAt, markdown: item.raw
              }
            : null
        )
      }
    },
    [inbox]
  )

  const saveDoc = useCallback(
    (id: string, markdown: string) => {
      window.api.notes
        .save(id, markdown)
        .then((saved) => {
          if (saved) {
            setDoc(saved)
            setDirty(false)
            if (sel?.origin === 'note') refreshNotes()
            else refreshAll()
            notify('Saved ✓')
          }
        })
        .catch((err: unknown) => notify(`Save failed: ${String(err)}`))
    },
    [sel, refreshNotes, refreshAll, notify]
  )

  const onVaultReady = useCallback(
    (v: VaultInfo) => {
      setVaultInfo(v)
      window.api.vault.backend().then(setBackend).catch(console.error)
      refreshAll()
    },
    [refreshAll]
  )

  const selectInbox = useCallback((id: string) => openEntry(id, 'inbox'), [openEntry])
  const selectNote = useCallback((id: string) => openEntry(id, 'note'), [openEntry])

  // --- derived: counts, filtered list -------------------------------------------
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of allNotes) {
      if (n.projectId) m.set(n.projectId, (m.get(n.projectId) ?? 0) + 1)
    }
    return m
  }, [allNotes])

  const filtered = useMemo(() => {
    const base = results ?? allNotes
    if (results) return base
    if (!activeProject) return base
    return base.filter((n) => n.projectId === activeProject)
  }, [results, allNotes, activeProject])

  // Keep something open in the center: first row wins whenever the current
  // selection isn't in view (project/scope switch, first load).
  useEffect(() => {
    if (!vaultInfo?.configured) return
    if (scope === 'notes') {
      if (filtered.length === 0) return
      if (!sel || sel.origin !== 'note' || !filtered.some((n) => n.id === sel.id)) {
        openEntry(filtered[0]?.id ?? '', 'note')
      }
    } else {
      if (inbox.length === 0) {
        setSel(null)
        setDoc(null)
        return
      }
      if (!sel || sel.origin !== 'inbox' || !inbox.some((i) => i.id === sel.id)) {
        openEntry(inbox[0]?.id ?? '', 'inbox')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, filtered, inbox, vaultInfo?.configured])

  const pickScope = (s: Scope): void => {
    setScope(s)
    setSel(null)
    setDoc(null)
    setDirty(false)
  }

  const pickProject = (id: string | null): void => {
    setActiveProject(id)
    setResults(null)
    if (scope !== 'notes') setScope('notes')
    setSel(null)
    setDoc(null)
    setDirty(false)
  }

  const createProject = (): void => {
    const name = newProject.trim()
    if (!name) return
    window.api.projects
      .create(name)
      .then(() => {
        setNewProject('')
        refreshProjects()
        notify(`Project ${name} ✓`)
      })
      .catch((err: unknown) => notify(`Failed: ${String(err)}`))
  }

  const pendingCount = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length
  const activeItem = scope === 'inbox' ? inbox.find((i) => i.id === sel?.id) ?? null : null

  return (
    <div className="shell" data-platform={sys?.platform ?? 'unknown'}>
      {/* Core sidebar: search, folders, notes list, inbox. Center is the note. */}
      <aside className="sidebar core">
        <div className="traffic-spacer" aria-hidden />
        <div className="brand-row">
          <div className="brand">
            <h1>{APP_NAME}</h1>
          </div>
          <button
            className="btn ghost sm icon"
            title="Settings — themes, accents, vault"
            onClick={() => setShowSettings(true)}
            aria-label="Open settings"
          >
            ⚙
          </button>
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
          <button
            role="tab"
            aria-selected={scope === 'notes'}
            className={scope === 'notes' ? 'on' : ''}
            onClick={() => pickScope('notes')}
          >
            Notes
          </button>
          <button
            role="tab"
            aria-selected={scope === 'inbox'}
            className={scope === 'inbox' ? 'on' : ''}
            onClick={() => pickScope('inbox')}
          >
            Inbox {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
        </div>

        {scope === 'notes' ? (
          <div className="side-scroll">
            <div className="chips" aria-label="Filter by folder">
              <button className={activeProject === null ? 'on' : ''} onClick={() => pickProject(null)}>
                All
              </button>
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={activeProject === p.id ? 'on' : ''}
                  onClick={() => pickProject(p.id)}
                  title={`${p.name} · ${counts.get(p.id) ?? 0}`}
                >
                  <span className="dot" style={{ background: p.color ?? '#888' }} aria-hidden />
                  {p.name}
                  <span className="count">{counts.get(p.id) ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="add-row mini">
              <input
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createProject()}
                placeholder="New folder…"
                aria-label="New folder name"
              />
              <button className="btn mint sm" onClick={createProject} disabled={!newProject.trim()} aria-label="Create folder">
                +
              </button>
            </div>
            <div className="pane-head">
              <h2>{results ? `Results (${results.length})` : activeProject ? projects.find((p) => p.id === activeProject)?.name ?? '' : `All notes (${allNotes.length})`}</h2>
            </div>
            {filtered.length === 0 && <p className="muted small pad">Nothing here yet — ⌥Space to capture.</p>}
            <ul className="nlist">
              {filtered.map((n) => (
                <li key={n.id}>
                  <button
                    className={sel?.id === n.id && sel.origin === 'note' ? 'sel' : ''}
                    onClick={() => selectNote(n.id)}
                  >
                    <span className="ntitle">{plain(n.title).slice(0, 90) || 'Untitled'}</span>
                    <span className="muted small">{plain(n.snippet).slice(0, 110)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="side-scroll">
            <InboxQueue
              items={inbox}
              projects={projects}
              selectedId={sel?.origin === 'inbox' ? sel.id : null}
              onSelect={selectInbox}
              onRefresh={refreshAll}
              notify={notify}
            />
          </div>
        )}

        <div className="side-foot">
          <span className="status-sub" title={vaultInfo?.root ?? ''}>
            {(vaultInfo ? vaultInfo.root.replace(/.*\//, '…/') : '…') || '…'}
          </span>
        </div>
      </aside>

      {/* Center: the actual note. */}
      <div className="content inkfish center">
        <header className="topbar">
          <button className="btn ghost sm" title="Quick capture (⌥Space)" onClick={() => notify('Hit ⌥Space anywhere to capture')}>
            ✒ Capture
          </button>
          <button className="btn ghost sm" onClick={() => setShowMeeting(true)}>
            🎙 Meeting
          </button>
          <span className="flex-sp" />
          {dirty && <span className="pill dirty-static">unsaved</span>}
        </header>

        <main className="note-stage" aria-label="Note">
          {sel?.origin === 'inbox' && activeItem && (
            <InboxBar
              item={activeItem}
              projects={projects}
              onDone={(noteId) => {
                refreshAll()
                if (noteId) {
                  pickScope('notes')
                  pickProject(null)
                  selectNote(noteId)
                }
              }}
              notify={notify}
            />
          )}
          <NoteEditor
            doc={doc}
            dirty={dirty}
            defaultMode={prefs.mode}
            onDirty={setDirty}
            onSave={saveDoc}
          />
        </main>
      </div>

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
      {showMeeting && (
        <MeetingImport
          onClose={() => setShowMeeting(false)}
          onImported={refreshAll}
          notify={notify}
        />
      )}
      {showSettings && (
        <Settings
          prefs={prefs}
          onChange={setPrefs}
          vault={vaultInfo}
          sys={sys}
          backend={backend}
          onClose={() => setShowSettings(false)}
          onPickVault={() => {
            setShowSettings(false)
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
      )}
      {toast && <div className="toast glass">{toast}</div>}
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
