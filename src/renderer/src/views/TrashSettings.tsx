import { useCallback, useEffect, useState } from 'react'

type Item = Awaited<ReturnType<typeof window.api.files.trashList>>[number]

const DAY = 86400_000

function deletedWhen(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'deleted just now'
  if (s < 3600) return `deleted ${Math.round(s / 60)} min ago`
  if (s < 86400) return `deleted ${Math.round(s / 3600)} h ago`
  return `deleted ${new Date(ts).toLocaleDateString()}`
}

function where(e: Item): string {
  if (e.scope === 'inbox') return 'Inbox'
  if (e.scope === 'daily') return 'Daily'
  const parent = e.originalRel.includes('/') ? e.originalRel.slice(0, e.originalRel.lastIndexOf('/')) : ''
  return parent || 'Vault root'
}

/**
 * Settings › Trash: everything deleted in Inkfish, or by sync from the phone,
 * for 7 days. Restore puts it back where it was; synced phones pick it up.
 */
export default function TrashSettings(): React.JSX.Element {
  const [items, setItems] = useState<Item[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    window.api.files.trashList().then(setItems).catch(console.error)
  }, [])
  useEffect(load, [load])

  const restore = async (ids: string[] | 'all'): Promise<void> => {
    setBusy(true)
    try {
      const done = await window.api.files.restoreTrash(ids)
      setMsg(`Restored ${done.length} item${done.length === 1 ? '' : 's'}.`)
    } catch (e) {
      setMsg(`Couldn't restore: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      load()
    }
  }

  const remove = async (ids: string[] | 'all', label: string): Promise<void> => {
    if (!confirm(`Permanently delete ${label}? This can't be undone.`)) return
    setBusy(true)
    try {
      await window.api.files.deleteTrash(ids)
      setMsg('')
    } finally {
      setBusy(false)
      load()
    }
  }

  return (
    <section className="settings-group">
      <h4>Trash</h4>
      <div className="setting-row inline">
        <div className="setting-label">
          Deleted notes and folders
          <span className="muted small setting-hint">
            Kept for 7 days, including anything sync removed. Restoring puts it back in the same place, and your
            phone gets it on its next sync.
          </span>
        </div>
        {items && items.length > 1 ? (
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn ghost sm" disabled={busy} onClick={() => void restore('all')}>
              Restore all
            </button>
            <button className="btn ghost sm" disabled={busy} onClick={() => void remove('all', 'everything in Trash')}>
              Empty
            </button>
          </div>
        ) : null}
      </div>
      {msg && (
        <p className="muted small setting-hint" aria-live="polite">
          {msg}
        </p>
      )}
      {items === null ? null : items.length === 0 ? (
        <p className="muted small setting-hint">Trash is empty.</p>
      ) : (
        items.map((e) => {
          const left = Math.max(0, Math.ceil((e.deletedAt + 7 * DAY - Date.now()) / DAY))
          return (
            <div key={e.id} className="setting-row inline">
              <div className="setting-label">
                {e.isDir ? `${e.name}/` : e.name.replace(/\.md$/, '')}
                <span className="muted small setting-hint">
                  {where(e)} · {deletedWhen(e.deletedAt)} · {left} day{left === 1 ? '' : 's'} left
                </span>
              </div>
              <div className="row" style={{ marginTop: 0 }}>
                <button className="btn ghost sm" disabled={busy} onClick={() => void restore([e.id])}>
                  Restore
                </button>
                <button
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => void remove([e.id], e.name)}
                  aria-label={`Delete ${e.name} forever`}
                >
                  Delete
                </button>
              </div>
            </div>
          )
        })
      )}
    </section>
  )
}
