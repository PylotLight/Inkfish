import { memo, useEffect } from 'react'
import type { InboxItem, Project } from '../../../shared/types'

interface Props {
  items: InboxItem[]
  projects: Project[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRefresh: () => void
  notify: (msg: string) => void
}

/** Right rail: inbox queue with `inbox → processing → ready` status pills. */
function InboxQueue({ items, projects, selectedId, onSelect, onRefresh, notify }: Props): React.JSX.Element {
  useEffect(() => {
    const t = window.setInterval(onRefresh, 4000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (fn: () => Promise<unknown>, msg: string): Promise<void> => {
    try {
      await fn()
      onRefresh()
      if (msg) notify(msg)
    } catch (err) {
      notify(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="queue">
      <div className="pane-head">
        <h2>Inbox</h2>
        <span className="pill">{items.filter((i) => i.status === 'inbox' || i.status === 'processing').length}</span>
      </div>
      {items.length === 0 && (
        <div className="empty">
          <p className="muted">Inbox zero. Hit ⌥Space and capture something.</p>
        </div>
      )}
      <ul className="qlist">
        {items.map((item) => (
          <li key={item.id} className={selectedId === item.id ? 'sel' : ''}>
            <button className="qmain" onClick={() => onSelect(item.id)}>
              <span className="qkind">{item.kind}</span>
              <span className="qtext">{item.raw.split('\n')[0]?.slice(0, 90) || '(empty)'}</span>
            </button>
            <div className="qmeta">
              <span className={`status-pill st-${item.status}`}>
                {item.status === 'inbox' ? 'inbox' : item.status === 'processing' ? '…' : item.status}
              </span>
              <span className="muted small">{new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            </div>
            <div className="row wrap qactions">
              {item.status !== 'processing' && (
                <button
                  className="btn ghost sm"
                  title="Route now"
                  onClick={() => void act(() => window.api.inbox.process(item.id), 'Routed ✓')}
                >
                  Route
                </button>
              )}
              <select
                className="sm"
                defaultValue=""
                aria-label={`Reassign ${item.id}`}
                onChange={(e) => {
                  const v = e.target.value
                  if (v) void act(() => window.api.inbox.reassign(item.id, v), `Moved → ${v}`)
                  e.target.value = ''
                }}
              >
                <option value="">Move →</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              {item.status === 'ready' && (
                <button
                  className="btn ghost sm"
                  title="Undo routing (raw kept)"
                  onClick={() => void act(() => window.api.inbox.undo(item.id), 'Undone — raw kept')}
                >
                  Undo
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default memo(InboxQueue)
