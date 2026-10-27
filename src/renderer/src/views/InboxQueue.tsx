import { memo, useEffect } from 'react'
import type { InboxItem, Project } from '../../../shared/types'
import { routeSummary } from '../../../shared/routing'

interface Props {
  items: InboxItem[]
  projects: Project[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRefresh: () => void
  notify: (msg: string) => void
}

/**
 * Right rail: inbox queue. One quiet card per capture — kind + age on a
 * single muted line, preview text, then one action row (Route / Move / Delete
 * / Undo-when-ready). Status pills only appear for non-default states
 * (`routing…`, `ready ✓`) so the default `inbox` state stays silent.
 */
function InboxQueue({ items, projects, selectedId, onSelect, onDelete, onRefresh, notify }: Props): React.JSX.Element {
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

  const pending = items.filter((i) => i.status === 'inbox' || i.status === 'processing').length

  return (
    <div className="queue">
      <div className="pane-head">
        <h2>Inbox</h2>
        <span className="pill" title={`${pending} waiting`}>
          {pending}
        </span>
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
              <span className="qtext">{item.raw.split('\n')[0]?.slice(0, 90) || '(empty)'}</span>
              <span className="qsub muted">
                {item.kind} · {new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                {item.status === 'processing'
                  ? ' · routing…'
                  : item.route
                    ? ` · ${routeSummary(item.route, item.status)}${item.status === 'ready' ? ' ✓' : ''}`
                    : item.status === 'ready'
                      ? ' · ready ✓'
                      : ''}
              </span>
              {item.route && item.status !== 'processing' && (
                <span className="qsub muted small" title={`${item.route.provider} · ${item.route.reason}`}>
                  {item.route.reason}
                </span>
              )}
              {item.route?.suggested && item.route.action === 'new' && (
                <span className="qsub muted small">
                  Proposed: {item.route.title || 'New note'} · {item.route.rel || 'vault root'}
                  {item.route.tags?.length ? ` · tags: ${item.route.tags.join(', ')}` : ''}
                </span>
              )}
              {item.route?.suggested && item.route.markdown && (
                <span className="qsub muted small" title="Proposed note content">
                  Content: {item.route.markdown.replace(/\s+/g, ' ').trim().slice(0, 120)}
                </span>
              )}
            </button>
            <div className="row qactions">
              {item.status === 'inbox' && (
                <button
                  className="btn ghost sm"
                  title={item.route?.suggested ? 'File it where suggested' : 'Route now'}
                  onClick={() =>
                    void act(async () => {
                      const r = await window.api.inbox.process(item.id, {
                        approveSuggestion: item.route?.suggested === true
                      })
                      if ('error' in r) throw new Error(r.error)
                      notify(r.note ? `Routed ✓ ${routeSummary(r.route, 'ready')}` : `Left in inbox: ${r.route.reason}`)
                    }, '')
                  }
                >
                  {item.route?.suggested && item.status === 'inbox' ? 'File' : 'Route'}
                </button>
              )}
              <select
                className="sm qmove"
                defaultValue=""
                aria-label={`Move ${item.raw.slice(0, 30)} to folder`}
                disabled={item.status !== 'inbox'}
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
              <span className="flex-sp" />
              {item.status === 'ready' && (
                <button
                  className="btn ghost sm"
                  title="Undo routing (raw kept)"
                  onClick={() => void act(() => window.api.inbox.undo(item.id), 'Undone — raw kept')}
                >
                  Undo
                </button>
              )}
              <button
                className="btn ghost sm danger-quiet"
                title="Delete permanently"
                aria-label={`Delete inbox item ${item.raw.slice(0, 30)}`}
                onClick={() => onDelete(item.id)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default memo(InboxQueue)
