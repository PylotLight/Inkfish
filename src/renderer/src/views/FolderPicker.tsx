import { useEffect, useMemo, useRef, useState } from 'react'
import { baseOf, cleanFolderPath, dirOf, rankFolders } from '../../../shared/note-move'
import { Icon } from './icons'

type Row =
  | { kind: 'root' }
  | { kind: 'folder'; rel: string }
  | { kind: 'create'; rel: string }
  | { kind: 'new' }

/**
 * "Move to…" popover: fuzzy search over the vault's folders, the vault root, and "New folder…"
 * (type a path like `Work/Images` — it's created on move). ↑↓ / ↵ / Esc. Used by the note header
 * breadcrumb, the ⌘K palette and the tree's right-click menu.
 */
export default function FolderPicker({
  title, folders, current, x, y, onPick, onClose
}: {
  /** What's moving, for the header (`Move “Groceries” to…`). */
  title: string
  folders: readonly string[]
  /** Folder it's in now ('' = root) — shown, not pickable. */
  current: string
  /** Anchor (viewport px) — the popover clamps itself on screen. */
  x: number
  y: number
  onPick: (dir: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const rows = useMemo<Row[]>(() => {
    if (creating) {
      const clean = cleanFolderPath(query)
      return clean ? [{ kind: 'create', rel: clean }] : []
    }
    const q = query.trim()
    const out: Row[] = []
    if (!q || 'vault root'.includes(q.toLowerCase()) || q === '/') out.push({ kind: 'root' })
    for (const rel of rankFolders(q, folders)) out.push({ kind: 'folder', rel })
    const clean = cleanFolderPath(q)
    if (clean && !folders.some((f) => f.toLowerCase() === clean.toLowerCase())) out.push({ kind: 'create', rel: clean })
    if (!q) out.push({ kind: 'new' })
    return out
  }, [query, folders, creating])

  useEffect(() => setHi(0), [query, creating])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const disabled = (r: Row): boolean =>
    (r.kind === 'root' && current === '') || (r.kind === 'folder' && r.rel === current)

  const choose = (r: Row | undefined): void => {
    if (!r || disabled(r)) return
    if (r.kind === 'new') {
      setCreating(true)
      setQuery('')
      inputRef.current?.focus()
      return
    }
    onPick(r.kind === 'root' ? '' : r.rel)
  }

  const W = 320
  const left = Math.max(8, Math.min(x, window.innerWidth - W - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - 380))

  return (
    <>
      <div className="ctx-scrim" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        className="ctxmenu glass strong folder-picker"
        style={{ left, top, width: W }}
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (creating) {
              setCreating(false)
              setQuery('')
            } else onClose()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => Math.min(rows.length - 1, h + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => Math.max(0, h - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(rows[hi])
          }
        }}
      >
        <div className="fp-title muted small">{creating ? 'New folder — path from the vault root' : title}</div>
        <input
          ref={inputRef}
          className="fp-input"
          value={query}
          autoFocus
          spellCheck={false}
          placeholder={creating ? 'e.g. Work/Images' : 'Search folders…'}
          aria-label={creating ? 'New folder path' : 'Search folders'}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="fp-list" ref={listRef} role="listbox">
          {rows.length === 0 && <p className="muted small fp-empty">{creating ? 'Type a folder name' : 'No folders match'}</p>}
          {rows.map((r, i) => {
            const off = disabled(r)
            const label =
              r.kind === 'root' ? 'Vault root'
                : r.kind === 'folder' ? baseOf(r.rel)
                  : r.kind === 'create' ? `Create “${r.rel}”`
                    : 'New folder…'
            const sub = r.kind === 'folder' ? dirOf(r.rel) : ''
            return (
              <button
                key={`${r.kind}:${r.kind === 'folder' || r.kind === 'create' ? r.rel : ''}`}
                data-i={i}
                role="option"
                aria-selected={i === hi}
                aria-disabled={off}
                className={`ctxitem fp-row${i === hi ? ' hi' : ''}${off ? ' off' : ''}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => choose(r)}
                title={r.kind === 'folder' ? r.rel : undefined}
              >
                <Icon name={r.kind === 'create' || r.kind === 'new' ? 'folder-new' : 'folder'} size={14} />
                <span className="fp-name">{label}</span>
                {sub && <span className="fp-sub">{sub}</span>}
                {off && <span className="fp-sub">current</span>}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
