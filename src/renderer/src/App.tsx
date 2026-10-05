import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_NAME } from '../../shared/config'
import type { InboxItem, NoteDoc, NoteEntry, NoteKind, Project, SysInfo, VaultInfo } from '../../shared/types'
import { applyPrefs, loadPrefs, type Prefs } from './theme'
import { displayTitle, plain } from './text'
import Capture from './views/Capture'
import FolderTree from './views/FolderTree'
import Home from './views/Home'
import InboxQueue from './views/InboxQueue'
import NoteEditor from './views/NoteEditor'
import Onboarding from './views/Onboarding'
import MeetingImport from './views/MeetingImport'
import SettingsView from './views/Settings'

/** Popover windows load the same bundle with `#capture` — render capture only. */
export function isCaptureWindow(): boolean {
  return typeof window !== 'undefined' && window.location.hash === '#capture'
}

type Selection = { id: string; origin: 'inbox' | 'note' } | null
type Scope = 'home' | 'notes' | 'inbox'
type KindFilter = 'all' | NoteKind

const KINDS: Array<{ id: KindFilter; name: string }> = [
  { id: 'all', name: 'All' },
  { id: 'text', name: 'Text' },
  { id: 'voice', name: 'Voice' },
  { id: 'image', name: 'Image' },
  { id: 'meeting', name: 'Meeting' }
]

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
  /** null = all folders; '' = top-level files; else dir prefix. */
  const [folder, setFolder] = useState<string | null>(null)
  const [kind, setKind] = useState<KindFilter>('all')
  const [sel, setSel] = useState<Selection>(null)
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NoteEntry[] | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [ostep, setOstep] = useState(0)
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null)
  const [showMeeting, setShowMeeting] = useState(false)
  const [newProject, setNewProject] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [backend, setBackend] = useState('…')
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
  /** Custom display titles (app config) — filename otherwise. */
  const [titles, setTitles] = useState<Record<string, string>>({})

  useEffect(() => {
    applyPrefs(prefs)
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

  // One fetch for every note — filtering is client-side so navigating
  // folders/search never round-trips through IPC.
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
        // Restore blur preference (main resets to default on launch).
        if (!loadPrefs().blur) window.api.glass.set(null).catch(() => undefined)
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

  const selectNote = useCallback(
    (id: string) => {
      setScope('notes')
      openEntry(id, 'note')
    },
    [openEntry]
  )

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

  // --- derived: filtered list ----------------------------------------------------
  const kindCounts = useMemo(() => {
    const m = new Map<NoteKind, number>()
    for (const n of allNotes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1)
    return m
  }, [allNotes])

  const filtered = useMemo(() => {
    let base = results ?? allNotes
    if (!results && folder !== null) {
      base = folder === ''
        ? base.filter((n) => !n.path.includes('/'))
        : base.filter((n) => n.path === folder || n.path.startsWith(`${folder}/`))
    }
    if (kind !== 'all') base = base.filter((n) => n.kind === kind)
    return base
  }, [results, allNotes, folder, kind])

  const listTitle = results
    ? `Results (${results.length})`
    : folder === null
      ? `All notes (${filtered.length})`
      : folder === ''
        ? `Top level (${filtered.length})`
        : `${folder} (${filtered.length})`

  const pickScope = (s: Scope): void => {
    setScope(s)
    if (s === 'home') {
      setSel(null)
      setDoc(null)
      setDirty(false)
    }
  }

  const pickFolder = (rel: string | null): void => {
    setFolder(rel)
    setScope('notes')
  }

  const openSettings = (): void => {
    setSettingsReturn(scope)
    setSettingsOpen(true)
  }

  const createProject = (): void => {
    const name = newProject.trim()
    if (!name) return
    window.api.projects
      .create(name)
      .then(() => {
        setNewProject('')
        refreshProjects()
        notify(`Folder ${name} ✓`)
      })
      .catch((err: unknown) => notify(`Failed: ${String(err)}`))
  }

  const pendingCount = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length
  const activeItem = scope === 'inbox' ? inbox.find((i) => i.id === sel?.id) ?? null : null

  return (
    <div className="shell" data-platform={sys?.platform ?? 'unknown'}>
      {/* Core sidebar: search, scopes, folder tree, kind filters, notes list, inbox. */}
      <aside className="sidebar core">
        <div className="traffic-spacer" aria-hidden />
        <div className="brand-row">
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
            <FolderTree notes={allNotes} selected={folder} onSelect={pickFolder} />
            <div className="chips kinds" aria-label="Filter by kind">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  className={kind === k.id ? 'on' : ''}
                  onClick={() => {
                    setKind(k.id)
                    setScope('notes')
                  }}
                  title={k.id === 'all' ? `${allNotes.length} notes` : `${kindCounts.get(k.id as NoteKind) ?? 0} ${k.name.toLowerCase()} notes`}
                >
                  {k.name}
                  {k.id !== 'all' && <span className="count">{kindCounts.get(k.id as NoteKind) ?? 0}</span>}
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
              <h2>{listTitle}</h2>
            </div>
            {filtered.length === 0 && <p className="muted small pad">Nothing here yet — ⌥Space to capture.</p>}
            <ul className="nlist">
              {filtered.map((n) => (
                <li key={n.id}>
                  <button
                    className={sel?.id === n.id && sel.origin === 'note' ? 'sel' : ''}
                    onClick={() => selectNote(n.id)}
                  >
                    <span className="ntitle">{titleOf(n).slice(0, 90)}</span>
                    <span className="muted small">{plain(n.snippet).slice(0, 110)}</span>
                  </button>
                </li>
              ))}
            </ul>
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
        ) : (
          <>
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

            {scope === 'home' ? (
              <main className="view-scroll" aria-label="Home">
                <Home
                  notes={allNotes}
                  inbox={inbox}
                  titleOf={titleOf}
                  onOpenNote={selectNote}
                  onOpenInbox={() => pickScope('inbox')}
                  onOpenFolder={pickFolder}
                  onCaptureHint={() => notify('Hit ⌥Space anywhere to capture')}
                  onMeeting={() => setShowMeeting(true)}
                />
              </main>
            ) : (
              <main className="note-stage" aria-label="Note">
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
                  onDirty={setDirty}
                  onSave={saveDoc}
                  onRename={(t) => {
                    if (doc) renameNote(doc.id, t)
                  }}
                />
              </main>
            )}
          </>
        )}
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
