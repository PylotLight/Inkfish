import { useRef, useState } from 'react'
import type { NoteEntry } from '../../../shared/types'
import { tabDragPhase } from '../../../shared/mini-window-tear'
import PopOutIcon from '../views/PopOutIcon'
import type { Tab } from './types'

/** Obsidian-style tab strip: pinned files stay, × closes, right-click for more, drag out → mini window. */
export default function TabBar({
  tabs,
  activeId,
  allNotes,
  titleOf,
  onActivate,
  onClose,
  onTogglePin,
  onMenu,
  onNew,
  onPopOut,
  onTearOut,
  popTitle
}: {
  tabs: Tab[]
  activeId: string | null
  allNotes: NoteEntry[]
  titles: Record<string, string>
  titleOf: (e: { id: string; path: string; title: string }) => string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onTogglePin: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
  onNew: () => void
  onPopOut: (id: string) => void
  onTearOut: (id: string) => void
  popTitle: string
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)
  /** A press on a tab that may become a tear-off drag (pointer captured, so it tracks outside the window). */
  const dragRef = useRef<{ id: string; pointerId: number; start: { x: number; y: number }; moved: boolean } | null>(
    null
  )
  /** Swallow the click that follows a drag. */
  const suppressClick = useRef(false)
  const [tearing, setTearing] = useState<{ id: string; x: number; y: number; label: string } | null>(null)
  const byId = new Map(allNotes.map((n) => [n.id, n]))
  const ordered = [...tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  if (ordered.length === 0) return <div className="tabbar empty" aria-hidden />

  const phaseAt = (x: number, y: number): ReturnType<typeof tabDragPhase> => {
    const d = dragRef.current
    const r = barRef.current?.getBoundingClientRect()
    if (!d || !r) return 'press'
    return tabDragPhase(d.start, { x, y }, r, { width: window.innerWidth, height: window.innerHeight })
  }

  return (
    <div className="tabbar" role="tablist" aria-label="Open notes" ref={barRef}>
      {ordered.map((t) => {
        const entry = byId.get(t.id)
        const label = titleOf({ id: t.id, path: entry?.path ?? t.path, title: entry?.title ?? '' })
        const isActive = t.id === activeId
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            className={`tab${isActive ? ' on' : ''}${t.pinned ? ' pinned' : ''}${tearing?.id === t.id ? ' tearing' : ''}`}
            title={`${entry?.path ?? t.path}\nDrag out of the tab bar to pop into a mini window`}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              onActivate(t.id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onActivate(t.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu(t.id, e.clientX, e.clientY)
            }}
            onMouseUp={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(t.id)
              }
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
              dragRef.current = {
                id: t.id,
                pointerId: e.pointerId,
                start: { x: e.clientX, y: e.clientY },
                moved: false
              }
              suppressClick.current = false
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                // no capture: the drag just ends at the window edge
              }
            }}
            onPointerMove={(e) => {
              const d = dragRef.current
              if (!d || d.pointerId !== e.pointerId) return
              const phase = phaseAt(e.clientX, e.clientY)
              if (phase !== 'press') d.moved = true
              if (phase === 'tear') setTearing({ id: t.id, x: e.clientX, y: e.clientY, label })
              else setTearing((prev) => (prev ? null : prev))
            }}
            onPointerUp={(e) => {
              const d = dragRef.current
              if (!d || d.pointerId !== e.pointerId) return
              const phase = phaseAt(e.clientX, e.clientY)
              dragRef.current = null
              setTearing(null)
              if (!d.moved) return
              suppressClick.current = true
              if (phase === 'tear') onTearOut(d.id)
            }}
            onPointerCancel={() => {
              dragRef.current = null
              setTearing(null)
            }}
          >
            {t.pinned && (
              <button
                className="tab-pin on"
                title="Unpin tab"
                aria-label="Unpin tab"
                onClick={(e) => {
                  e.stopPropagation()
                  onTogglePin(t.id)
                }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M9.5 1.5l5 5-2 .5-2.5 5.5-2.5 2.5-.7-2.8-3.3-3.3-2.8-.7 2.5-2.5L8 2z" />
                </svg>
              </button>
            )}
            <span className="tab-label">{label}</span>
            <button
              className="tab-pop"
              title={popTitle}
              aria-label={`Pop ${label} out to a mini window`}
              onClick={(e) => {
                e.stopPropagation()
                onPopOut(t.id)
              }}
            >
              <PopOutIcon />
            </button>
            <button
              className="tab-x"
              title="Close tab"
              aria-label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <button className="tab-new" onClick={onNew} title="New note" aria-label="New note">
        +
      </button>
      {tearing && (
        <div className="tab-tear-ghost glass" style={{ left: tearing.x + 12, top: tearing.y + 10 }} aria-hidden>
          <PopOutIcon />
          <span>{tearing.label}</span>
          <span className="muted">→ mini window</span>
        </div>
      )}
    </div>
  )
}
