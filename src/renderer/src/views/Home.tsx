import { useMemo } from 'react'
import type { InboxItem, NoteEntry } from '../../../shared/types'
import { plain } from '../text'

interface Props {
  notes: NoteEntry[]
  inbox: InboxItem[]
  onOpenNote: (id: string) => void
  onOpenInbox: () => void
  onOpenFolder: (rel: string | null) => void
  onCaptureHint: () => void
  onMeeting: () => void
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Launch default: stats, latest notes, inbox attention, top folders. */
export default function Home({
  notes, inbox, onOpenNote, onOpenInbox, onOpenFolder, onCaptureHint, onMeeting
}: Props): React.JSX.Element {
  const latest = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 7),
    [notes]
  )
  const pending = useMemo(
    () => inbox.filter((i) => i.status === 'inbox' || i.status === 'processing'),
    [inbox]
  )
  const topFolders = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of notes) {
      const top = n.path.split('/')[0]
      if (top && n.path.includes('/')) m.set(top, (m.get(top) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [notes])

  return (
    <div className="home">
      <div className="home-head">
        <div>
          <h2>Home</h2>
          <p className="muted">
            {notes.length} notes · {pending.length > 0 ? `${pending.length} waiting in inbox` : 'inbox zero'}
          </p>
        </div>
        <div className="row" style={{ marginTop: 0 }}>
          <button className="btn ghost sm" onClick={onCaptureHint}>✒ Capture</button>
          <button className="btn ghost sm" onClick={onMeeting}>🎙 Meeting</button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat glass">
          <span className="stat-label">Notes</span>
          <span className="stat-value">{notes.length}</span>
        </div>
        <div className="stat glass">
          <span className="stat-label">Folders</span>
          <span className="stat-value">{topFolders.length}</span>
        </div>
        <button className="stat glass as-btn" onClick={onOpenInbox}>
          <span className="stat-label">Inbox</span>
          <span className="stat-value">{pending.length}</span>
        </button>
      </div>

      <div className="home-cols">
        <section className="glass home-card" aria-label="Latest notes">
          <div className="pane-head"><h2>Latest</h2></div>
          {latest.length === 0 && <p className="muted small pad">Nothing yet — ⌥Space to capture.</p>}
          <ul className="nlist">
            {latest.map((n) => (
              <li key={n.id}>
                <button onClick={() => onOpenNote(n.id)}>
                  <span className="ntitle">{plain(n.title).slice(0, 90) || 'Untitled'}</span>
                  <span className="muted small">{n.path} · {timeAgo(n.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="glass home-card" aria-label="Needs attention">
          <div className="pane-head"><h2>Needs attention</h2></div>
          {pending.length === 0 && <p className="muted small pad">Inbox zero. Nicely done.</p>}
          <ul className="nlist">
            {pending.slice(0, 5).map((i) => (
              <li key={i.id}>
                <button onClick={onOpenInbox}>
                  <span className="ntitle">{plain(i.raw).slice(0, 90) || '(empty)'}</span>
                  <span className="muted small">{i.kind} · {i.status === 'processing' ? 'routing…' : 'waiting'} · {timeAgo(i.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {pending.length > 5 && (
            <button className="btn ghost sm" onClick={onOpenInbox}>
              Open inbox ({pending.length})
            </button>
          )}
        </section>
      </div>

      {topFolders.length > 0 && (
        <section className="glass home-card" aria-label="Top folders">
          <div className="pane-head"><h2>Folders</h2></div>
          <div className="chips">
            {topFolders.map(([name, count]) => (
              <button key={name} onClick={() => onOpenFolder(name)}>
                📁 {name}
                <span className="count">{count}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
