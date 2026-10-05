import { useEffect, useState } from 'react'

export interface MenuItem {
  label: string
  danger?: boolean
  action: () => void
}

/** Floating right-click / ⋯ menu. Closes on click-away or Escape. */
export function CtxMenu({ x, y, items, onClose }: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const px = Math.min(x, window.innerWidth - 220)
  const py = Math.min(y, window.innerHeight - items.length * 36 - 24)
  return (
    <>
      <div className="ctx-scrim" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div className="ctxmenu glass strong" style={{ left: px, top: py }} role="menu">
        {items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            className={`ctxitem${it.danger ? ' danger' : ''}`}
            onClick={() => {
              onClose()
              it.action()
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </>
  )
}

/** Small confirm dialog (delete). */
export function ConfirmModal({ title, body, confirmLabel, onConfirm, onClose }: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass strong confirm" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label={title}>
        <h3>{title}</h3>
        <p className="muted">{body}</p>
        <div className="row end">
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button
            className="btn danger sm"
            autoFocus
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Small text-input dialog (rename). */
export function PromptModal({ title, initial, placeholder, confirmLabel, onSubmit, onClose }: {
  title: string
  initial: string
  placeholder: string
  confirmLabel: string
  onSubmit: (value: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const submit = (): void => {
    if (!value.trim()) return
    onClose()
    onSubmit(value.trim())
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass strong confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <input
          value={value}
          autoFocus
          placeholder={placeholder}
          aria-label={title}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
          onFocus={(e) => e.target.select()}
        />
        <div className="row end">
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn mint sm" disabled={!value.trim()} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
