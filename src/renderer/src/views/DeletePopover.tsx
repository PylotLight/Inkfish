import { useEffect, useRef } from 'react'
import { fmtBytes, timeAgo } from '../text'
import './SidebarActions.css'

export interface Anchor {
  top: number
  bottom: number
  left: number
  right: number
}

const W = 300

/** Where the glance sits: right of the row (sidebar → editor side), else below it; kept on screen. */
export function popoverPos(a: Anchor, vw: number, vh: number, h = 240): { left: number; top: number } {
  let left = a.right + 8
  let top = a.top - 10
  if (left + W > vw - 8) {
    left = Math.max(8, Math.min(a.left, vw - W - 8))
    top = a.bottom + 6
  }
  top = Math.max(8, Math.min(top, vh - h - 8))
  return { left, top }
}

/**
 * Enter while a button inside the glance other than Delete has focus (Tab → Cancel, then Enter) must
 * press THAT button, not delete the note: 'native' leaves the key to the browser.
 */
export function popoverKeyAction(e: { key: string }, active: Element | null, pop: Element | null): 'native' | 'ours' {
  if (e.key !== 'Enter' || !active || !pop || !pop.contains(active)) return 'ours'
  return active.tagName === 'BUTTON' && !active.classList.contains('danger') ? 'native' : 'ours'
}

/**
 * Delete confirm for a note with real content: title, a few lines, size + edited time.
 * Enter / ⌘⌫ (again) confirms, Esc or click-away cancels.
 */
export function DeletePopover({ anchor, title, path, lines, size, updatedAt, onConfirm, onCancel }: {
  anchor: Anchor
  title: string
  path: string
  lines: string[]
  size: number
  updatedAt: number
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const act = useRef({ onConfirm, onCancel })
  act.current = { onConfirm, onCancel }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Tab → Cancel, Enter: press Cancel (the browser does), don't delete.
      if (popoverKeyAction(e, document.activeElement, ref.current) === 'native') return
      const confirm = e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete'))
      if (confirm) {
        e.preventDefault()
        e.stopPropagation()
        act.current.onConfirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        act.current.onCancel()
      }
    }
    // Capture: the row's own ⌘⌫ handler / the editor never see these while the glance is up.
    window.addEventListener('keydown', onKey, true)
    ref.current?.querySelector<HTMLButtonElement>('.btn.danger')?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const pos = popoverPos(anchor, window.innerWidth, window.innerHeight)
  const meta = [path, size > 0 ? fmtBytes(size) : '', `edited ${timeAgo(updatedAt)}`].filter(Boolean).join(' · ')
  return (
    <>
      <div className="del-scrim" onClick={onCancel} onContextMenu={(e) => e.preventDefault()} />
      <div ref={ref} className="del-pop" style={{ left: pos.left, top: pos.top }} role="alertdialog" aria-label={`Delete ${title}?`}>
        <h4 className="del-pop-title">Delete “{title}”?</h4>
        <div className="del-pop-meta" title={meta}>{meta}</div>
        {lines.length > 0 && (
          <div className="del-pop-preview" aria-label="Preview">
            {lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
        <div className="del-pop-actions">
          <span className="del-pop-hint" title="Enter deletes · Esc cancels · ⇧ skips this next time">↩ / esc</span>
          <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
          <button className="btn danger sm" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </>
  )
}

/** Bottom toast with an Undo button; auto-dismisses. */
export function UndoToast({ message, onUndo, onClose, ms = 6000 }: {
  message: string
  onUndo: () => void
  onClose: () => void
  ms?: number
}): React.JSX.Element {
  useEffect(() => {
    const t = window.setTimeout(onClose, ms)
    return () => window.clearTimeout(t)
  }, [message, onClose, ms])
  return (
    <div className="toast glass undo-toast" role="status">
      <span className="undo-msg">{message}</span>
      <button
        className="undo-btn"
        onClick={() => {
          onClose()
          onUndo()
        }}
      >
        Undo
      </button>
    </div>
  )
}
