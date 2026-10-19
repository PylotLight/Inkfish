import { useEffect, useState } from 'react'
import { ago, freshLabel, type BadgePeerRow, type SyncBadge as Badge } from '../../../shared/sync-badge'
import { Icon } from './icons'

/**
 * Sidebar-footer sync badge. Hidden until a phone is paired. State is pushed
 * from main on real sync events (`sync:badge`, throttled) — nothing here polls;
 * the "x ago" text is only computed when the popover opens.
 */

const PEER_LABEL: Record<BadgePeerRow['state'], string> = {
  syncing: 'syncing',
  synced: 'connected',
  offline: 'not seen recently',
  error: 'error'
}

export default function SyncBadge({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const [b, setB] = useState<Badge | null>(null)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    void window.api.sync
      .badge()
      .then((x) => alive && setB(x))
      .catch(() => undefined)
    const off = window.api.sync.onBadge(setB)
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!b || b.state === 'none') return null

  const show = (): void => {
    setNow(Date.now())
    setOpen(true)
  }
  // Recompute the summary's "ago" at hover time (main only pushes on state changes).
  const label = freshLabel(b, now)

  return (
    <div className="sync-badge-wrap" onMouseEnter={show} onMouseLeave={() => setOpen(false)} onFocus={show} onBlur={() => setOpen(false)}>
      <button
        className={`foot-btn sync-badge s-${b.state}`}
        onClick={onOpen}
        aria-label={`Sync: ${label}. Open sync settings`}
        data-state={b.state}
      >
        <Icon name="sync" size={16} className="sync-badge-icon" />
        <span className="sync-badge-dot" aria-hidden="true" />
      </button>
      {open && (
        <div className="sync-pop" role="tooltip">
          <div className="sync-pop-head">{label}</div>
          {b.peers.map((p) => (
            <div key={p.id} className={`sync-pop-row s-${p.state}`}>
              <span className="sync-badge-dot" aria-hidden="true" />
              <span className="sync-pop-name">{p.name}</span>
              <span className="sync-pop-meta">
                {PEER_LABEL[p.state]}
                {p.inFlight > 0 ? ` · ${p.inFlight} in flight` : ''}
                {' · '}seen {ago(p.lastSeen, now)} · synced {ago(p.lastSync, now)}
              </span>
              {p.error && <span className="sync-pop-err">{p.error}</span>}
            </div>
          ))}
          <div className="sync-pop-foot">Click for sync settings</div>
        </div>
      )}
    </div>
  )
}
