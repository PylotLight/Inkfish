import { useEffect, useState } from 'react'
import { ago, freshLabel, type BadgePeerRow, type SyncBadge as Badge } from '../../../shared/sync-badge'
import { percent, progressLine, runLine } from '../../../shared/sync/progress'
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
  error: 'error',
  outdated: 'can’t sync'
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
              {p.progress && (
                <span className="sync-pop-progress">
                  <span className="sync-pop-bar" aria-hidden="true">
                    <span style={{ width: `${percent(p.progress) ?? 0}%` }} />
                  </span>
                  <span className="sync-pop-meta">{progressLine(p.progress, now)}</span>
                  {p.progress.current && <span className="sync-pop-meta sync-pop-file">{p.progress.current}</span>}
                </span>
              )}
              {(p.ip || p.protocol) && (
                <span className="sync-pop-meta">
                  {[p.ip, p.protocol ? `protocol v${p.protocol}` : null].filter(Boolean).join(' · ')}
                </span>
              )}
              {p.runs.length > 0 && (
                <span className="sync-pop-runs">
                  {[...p.runs]
                    .reverse()
                    .slice(0, 5)
                    .map((r) => (
                      <span key={r.at} className={`sync-pop-meta${r.error ? ' sync-pop-err' : ''}`}>
                        {ago(r.at, now)} · {runLine(r)}
                      </span>
                    ))}
                </span>
              )}
              {p.update && <span className="sync-pop-err">{p.update === 'mac' ? 'update Mac — this phone needs a newer Inkfish here' : 'update phone — its Inkfish is too old for this Mac'}</span>}
              {p.error && <span className="sync-pop-err">{p.error}</span>}
            </div>
          ))}
          <div className="sync-pop-foot">Click for sync settings</div>
        </div>
      )}
    </div>
  )
}
