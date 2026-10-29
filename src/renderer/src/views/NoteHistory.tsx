import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistorySummary } from '../../../shared/note-history'
import { fmtBytes, timeAgo } from '../text'
import type { Anchor } from './DeletePopover'

interface Props {
  docId: string
  /** The note's current raw text (saved as a snapshot before a restore lands). */
  currentText: () => string
  /** Write the restored text into the editor (one undo step). */
  onRestore: (markdown: string) => void
  anchor: Anchor
  onClose: () => void
  notify: (msg: string) => void
}

const W = 360

/**
 * Note history: the content snapshots taken before AI rewrites land (and before each
 * restore, so a restore is itself undoable). Open from the ↺ in the note header.
 */
export default function NoteHistory({ docId, currentText, onRestore, anchor, onClose, notify }: Props): React.JSX.Element {
  const [items, setItems] = useState<HistorySummary[] | null>(null)
  const [viewing, setViewing] = useState<{ id: string; markdown: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const act = useRef({ onClose, notify, onRestore, currentText })
  act.current = { onClose, notify, onRestore, currentText }

  const load = useCallback(() => {
    window.api.aiApi
      .historyList(docId)
      .then(setItems)
      .catch(() => setItems([]))
  }, [docId])

  useEffect(() => {
    setViewing(null)
    load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        act.current.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const view = (id: string): void => {
    if (viewing?.id === id) {
      setViewing(null)
      return
    }
    void window.api.aiApi
      .historyGet(docId, id)
      .then((s) => (s ? setViewing({ id, markdown: s.markdown }) : notify('That snapshot is gone')))
      .catch(() => notify('Couldn\u2019t read that snapshot'))
  }

  const restore = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.aiApi.historyRestore(docId, id, act.current.currentText())
      if (!r) {
        notify('The note already has that text — nothing to restore')
        return
      }
      setViewing(null)
      act.current.onRestore(r.markdown)
      load()
    } catch (err) {
      notify(`Restore failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await window.api.aiApi.historyDelete(docId, id)
      if (viewing?.id === id) setViewing(null)
      load()
    } catch (err) {
      notify(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const clearAll = async (): Promise<void> => {
    try {
      await window.api.aiApi.historyClear(docId)
      setViewing(null)
      load()
    } catch (err) {
      notify(`Clear failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Below the header button, kept on screen; the list scrolls, the popover doesn't.
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(8, Math.min(anchor.left, vw - W - 8))
  const top = Math.min(anchor.bottom + 6, vh - 240)

  return (
    <>
      <div className="del-scrim" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        ref={ref}
        className="nh-pop"
        style={{ left, top, width: W }}
        role="dialog"
        aria-label="Note history"
      >
        <div className="nh-head">
          <h4>History</h4>
          {items && items.length > 0 && (
            <button className="btn ghost sm" onClick={() => void clearAll()}>
              Clear all
            </button>
          )}
        </div>
        {items === null ? (
          <p className="muted small nh-empty">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted small nh-empty">
            No history yet. A snapshot of the note is saved before every AI rewrite, so the source is always
            recoverable here.
          </p>
        ) : (
          <div className="nh-list">
            {items.map((s) => (
              <div key={s.id} className={`nh-row${viewing?.id === s.id ? ' open' : ''}`}>
                <button className="nh-main" onClick={() => view(s.id)} title={s.preview}>
                  <span className="nh-label">{s.label}</span>
                  <span className="nh-meta muted">
                    {timeAgo(s.at)} · {fmtBytes(s.size)}
                  </span>
                </button>
                <div className="nh-acts">
                  <button className="btn ghost sm" disabled={busy} onClick={() => void restore(s.id)}>
                    Restore
                  </button>
                  <button className="btn ghost sm icon" aria-label="Delete snapshot" onClick={() => void remove(s.id)}>
                    ×
                  </button>
                </div>
                {viewing?.id === s.id && viewing.markdown !== '' && (
                  <pre className="nh-preview">{viewing.markdown}</pre>
                )}
                {viewing?.id === s.id && viewing.markdown === '' && (
                  <p className="muted small nh-preview">
                    (empty — the note was blank when this was saved)
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
