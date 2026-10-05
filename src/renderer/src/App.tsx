import { useCallback, useEffect, useState } from 'react'
import { APP_NAME, APP_TAGLINE } from '../../shared/config'
import type { GlassState, InboxItem, NoteDoc, NoteEntry, Project, SysInfo, VaultInfo } from '../../shared/types'
import Capture from './views/Capture'
import InboxQueue from './views/InboxQueue'
import NoteEditor from './views/NoteEditor'
import Onboarding from './views/Onboarding'
import MeetingImport from './views/MeetingImport'

/** Popover windows load the same bundle with `#capture` — render capture only. */
export function isCaptureWindow(): boolean {
  return typeof window !== 'undefined' && window.location.hash === '#capture'
}

type Selection = { id: string; origin: 'inbox' | 'note' } | null

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
  const [glass, setGlass] = useState<GlassState | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [notes, setNotes] = useState<NoteEntry[]>([])
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
  const [newProject, setNewProject] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [backend, setBackend] = useState('…')

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

  const refreshNotes = useCallback(
    (projectId: string | null) => {
      window.api.notes.list(projectId).then(setNotes).catch(console.error)
    },
    []
  )

  useEffect(() => {
    window.api.sys.info().then(setSys).catch(console.error)
    window.api.glass.get().then(setGlass).catch(console.error)
    window.api.vault
      .info()
      .then((v) => {
        setVaultInfo(v)
        setBackend('…')
        if (!v.configured) {
          // First run: vault location first — no data loads until the user picks.
          setOstep(0)
          setShowOnboarding(true)
          return
        }
        window.api.vault.backend().then(setBackend).catch(console.error)
        refreshInbox()
        refreshProjects()
        refreshNotes(null)
        if (!localStorage.getItem('inkfish.onboarded')) {
          setOstep(0)
          setShowOnboarding(true)
        }
      })
      .catch(console.error)
  }, [refreshInbox, refreshNotes, refreshProjects])

  useEffect(() => {
    refreshNotes(activeProject)
  }, [activeProject, refreshNotes])

  // Global ⌘S guard + search-as-you-type (debounced lightly by length).
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
        // Inbox items aren't notes yet — show raw as a read-only doc until routed.
        const item = inbox.find((i) => i.id === id)
        window.api.notes
          .list(null)
          .then(() => {
            setDoc(
              item
                ? {
                    id: item.id, path: `inbox/${item.id}.md`, title: item.raw.split('\n')[0]?.slice(0, 80) || item.id,
                    kind: item.kind, status: item.status, projectId: null, inboxId: item.id,
                    tags: [], snippet: item.raw.slice(0, 220), createdAt: item.createdAt,
                    updatedAt: item.createdAt, markdown: item.raw
                  }
                : null
            )
          })
          .catch(console.error)
      }
    },
    [inbox]
  )

  const saveDoc = useCallback(() => {
    if (!doc || !sel) return
    window.api.notes
      .save(doc.id, doc.markdown)
      .then((saved) => {
        if (saved) {
          setDoc(saved)
          setDirty(false)
          // Inbox docs edit the raw file; notes refresh their project list.
          if (sel.origin === 'note') refreshNotes(activeProject)
          else refreshInbox()
          notify('Saved ✓')
        }
      })
      .catch((err: unknown) => notify(`Save failed: ${String(err)}`))
  }, [doc, sel, activeProject, refreshNotes, refreshInbox, notify])

  const onVaultReady = useCallback(
    (v: VaultInfo) => {
      setVaultInfo(v)
      window.api.vault.backend().then(setBackend).catch(console.error)
      refreshInbox()
      refreshProjects()
      refreshNotes(null)
    },
    [refreshInbox, refreshNotes, refreshProjects]
  )

  const pickProject = (id: string | null): void => {
    setActiveProject(id)
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

  const vibrancyOn = glass !== null && glass.vibrancy !== null
  const pendingCount = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length
  const shownNotes = results ?? notes

  return (
    <div className="shell" data-platform={sys?.platform ?? 'unknown'}>
      <aside className="sidebar">
        <div className="traffic-spacer" aria-hidden />
        <div className="brand">
          <h1>{APP_NAME}</h1>
          <p>{APP_TAGLINE}</p>
        </div>
        <div className="proj-list">
          <button className={activeProject === null ? 'active' : ''} onClick={() => pickProject(null)}>
            All notes
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className={activeProject === p.id ? 'active' : ''}
              onClick={() => pickProject(p.id)}
            >
              <span className="dot" style={{ background: p.color ?? '#888' }} aria-hidden />
              {p.name}
            </button>
          ))}
        </div>
        <div className="add-row">
          <input
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createProject()}
            placeholder="New project…"
            aria-label="New project name"
          />
          <button className="btn mint sm" onClick={createProject} disabled={!newProject.trim()}>
            +
          </button>
        </div>
        <div className="side-foot">
          <span className={`status-pill${vibrancyOn ? ' on' : ''}`}>
            {pendingCount > 0 ? `inbox ${pendingCount}` : 'inbox zero'} · {backend}
          </span>
          <span className="status-sub" title={vaultInfo?.root ?? ''}>
            {(vaultInfo ? vaultInfo.root.replace(/.*\//, '…/') : '…') || '…'}
          </span>
          <div className="row">
            <button
              className="btn ghost sm"
              title="Move the vault to a different folder"
              disabled={!vaultInfo?.configured || vaultInfo?.managed}
              onClick={() => {
                setOstep(0)
                setShowOnboarding(true)
              }}
            >
              Move vault…
            </button>
            <button
              className="btn ghost sm"
              title="Re-scan vault folder into the index (picks up externally added .md files)"
              disabled={!vaultInfo?.configured}
              onClick={() =>
                window.api.vault
                  .reindex()
                  .then((r) => {
                    setBackend(r.backend)
                    refreshInbox()
                    refreshNotes(activeProject)
                    notify(`Re-indexed ${r.indexed} notes`)
                  })
                  .catch((err: unknown) => notify(`Reindex failed: ${String(err)}`))
              }
            >
              Rescan vault
            </button>
          </div>
          <span className="status-sub">
            {sys ? `${sys.platform} · e${window.api.versions.electron()}` : '…'}
          </span>
        </div>
      </aside>

      <div className="content inkfish">
        <header className="topbar">
          <button className="btn ghost sm" title="Quick capture (⌥Space)" onClick={() => void window.api.inbox.list().then(() => notify('Hit ⌥Space anywhere to capture'))}>
            ✒ Capture
          </button>
          <button className="btn ghost sm" onClick={() => setShowMeeting(true)}>
            🎙 Meeting
          </button>
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes… (FTS)"
            aria-label="Search notes"
          />
        </header>

        <main className="ink-cols">
          <section className="notelist glass" aria-label="Notes">
            <div className="pane-head">
              <h2>{results ? `Results (${results.length})` : activeProject ? projects.find((p) => p.id === activeProject)?.name ?? '' : 'All notes'}</h2>
            </div>
            {shownNotes.length === 0 && <p className="muted small pad">Nothing here yet.</p>}
            <ul className="nlist">
              {shownNotes.map((n) => (
                <li key={n.id}>
                  <button
                    className={sel?.id === n.id && sel.origin === 'note' ? 'sel' : ''}
                    onClick={() => openEntry(n.id, 'note')}
                  >
                    <span className="ntitle">{n.title}</span>
                    <span className="muted small">{n.snippet.slice(0, 80)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="noteview glass" aria-label="Editor">
            <NoteEditor
              doc={doc}
              onChange={(markdown) => {
                if (doc) {
                  setDoc({ ...doc, markdown })
                  setDirty(true)
                }
              }}
              onSave={saveDoc}
            />
            {dirty && <span className="pill dirty">unsaved</span>}
          </section>

          <aside className="rail glass" aria-label="Inbox queue">
            <InboxQueue
              items={inbox}
              projects={projects}
              selectedId={sel?.origin === 'inbox' ? sel.id : null}
              onSelect={(id) => openEntry(id, 'inbox')}
              onRefresh={refreshInbox}
              notify={notify}
            />
          </aside>
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
          onImported={() => {
            refreshInbox()
            refreshNotes(activeProject)
          }}
          notify={notify}
        />
      )}
      {toast && <div className="toast glass">{toast}</div>}
    </div>
  )
}
