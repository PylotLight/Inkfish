import { useRef, useState } from 'react'
import type { NoteEntry } from '../../../shared/types'
import { tabDragPhase } from '../../../shared/mini-window-tear'
import PopOutIcon from '../views/PopOutIcon'
import { GROUP_COLORS, type Tab, type TabGroup } from './types'

/**
 * Obsidian-style tab strip: pinned files stay, × closes, right-click for more,
 * drag sideways to reorder, drag out of the bar → mini window.
 *
 * Groups: a named, coloured, collapsible run of tabs ("Work", "Personal", …).
 * Pinned tabs always render in the pinned run; a pinned member of a group re-joins
 * it when unpinned. Groups appear after the pinned run, in creation order.
 */
export default function TabBar({
  tabs,
  groups,
  activeId,
  allNotes,
  titleOf,
  onActivate,
  onClose,
  onTogglePin,
  onReorder,
  onMoveToGroup,
  onMenu,
  onGroupMenu,
  onGroupClick,
  onToggleGroup,
  onNew,
  onPopOut,
  onTearOut,
  popTitle
}: {
  tabs: Tab[]
  groups: TabGroup[]
  activeId: string | null
  allNotes: NoteEntry[]
  titles: Record<string, string>
  titleOf: (e: { id: string; path: string; title: string }) => string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onTogglePin: (id: string) => void
  /** Reorder within one container: 'pinned' run, a group id, or the 'free' run. */
  onReorder: (id: string, insertAt: number, container: string) => void
  /** The dragged tab lands in another group (dropped on its container). */
  onMoveToGroup: (tabId: string, groupId: string) => void
  onMenu: (id: string, x: number, y: number) => void
  onGroupMenu: (groupId: string, x: number, y: number) => void
  /** Header click: expand when collapsed, else focus the group's active/first tab. */
  onGroupClick: (groupId: string) => void
  onToggleGroup: (groupId: string) => void
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
  /** Tab element per id — hover position for sideways reordering. */
  const tabEls = useRef(new Map<string, HTMLDivElement>())
  /** Swallow the click that follows a drag. */
  const suppressClick = useRef(false)
  const [tearing, setTearing] = useState<{ id: string; x: number; y: number; label: string } | null>(null)
  /** Tab being reordered along the strip (the tear ghost covers the out-of-strip case). */
  const [reordering, setReordering] = useState<string | null>(null)
  /** Group container a reorder-drag currently hovers (its members get the drop tint). */
  const [overGroup, setOverGroup] = useState<string | null>(null)
  const byId = new Map(allNotes.map((n) => [n.id, n]))

  // Display layout: pinned run, then groups (creation order), then the free run —
  // each in the tabs array's own order.
  const pinned = tabs.filter((t) => t.pinned)
  const free = tabs.filter((t) => !t.pinned && !t.group)
  const membersOf = (g: TabGroup): Tab[] => tabs.filter((t) => t.group === g.id)
  const containerOf = (t: Tab): string => (t.pinned ? 'pinned' : (t.group ?? 'free'))

  if (tabs.length === 0) return <div className="tabbar empty" aria-hidden />

  /** The dragged tab only gets the group drop-tint when landing would change its group. */
  const draggedTab = reordering ? (tabs.find((t) => t.id === reordering) ?? null) : null
  const draggedContainer = draggedTab ? containerOf(draggedTab) : null

  const phaseAt = (x: number, y: number): ReturnType<typeof tabDragPhase> => {
    const d = dragRef.current
    const r = barRef.current?.getBoundingClientRect()
    if (!d || !r) return 'press'
    return tabDragPhase(d.start, { x, y }, r, { width: window.innerWidth, height: window.innerHeight })
  }

  /**
   * Insertion position for a sideways reorder: the index, in the dragged tab's container,
   * of the tab whose midpoint the pointer has just crossed left. The dragged tab is excluded.
   */
  const insertAt = (x: number, draggedId: string, container: string): number => {
    const dragged = tabs.find((t) => t.id === draggedId)
    if (!dragged) return 0
    const siblings = tabs.filter((t) => t.id !== draggedId && containerOf(t) === container)
    let at = 0
    for (const t of siblings) {
      const el = tabEls.current.get(t.id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (x > (r.left + r.right) / 2) at++
    }
    return at
  }

  /** Group container under a point (header or members), or null. */
  const groupAt = (x: number, y: number): string | null =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('.tabgroup')?.dataset.group ?? null

  const renderTab = (t: Tab, container: string): React.JSX.Element => {
    const entry = byId.get(t.id)
    const label = titleOf({ id: t.id, path: entry?.path ?? t.path, title: entry?.title ?? '' })
    const isActive = t.id === activeId
    return (
      <div
        key={t.id}
        ref={(el) => {
          if (el) tabEls.current.set(t.id, el)
          else tabEls.current.delete(t.id)
        }}
        role="tab"
        aria-selected={isActive}
        tabIndex={0}
        className={`tab${isActive ? ' on' : ''}${t.pinned ? ' pinned' : ''}${t.preview ? ' preview' : ''}${tearing?.id === t.id ? ' tearing' : ''}${
          reordering === t.id ? ' reordering' : ''
        }`}
        title={`${t.preview ? 'Temp tab — closes when you open anything else; editing or pinning keeps it\n' : ''}${entry?.path ?? t.path}\nDrag sideways to reorder · drag out of the tab bar to pop into a mini window`}
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
          if (phase === 'tear') {
            setTearing({ id: t.id, x: e.clientX, y: e.clientY, label })
            setReordering(null)
            setOverGroup(null)
          } else {
            setTearing((prev) => (prev ? null : prev))
            if (phase === 'drag') {
              setReordering(t.id)
              onReorder(t.id, insertAt(e.clientX, t.id, container), container)
              setOverGroup((prev) => {
                const g = groupAt(e.clientX, e.clientY)
                return prev === g ? prev : g
              })
              // Nudge the strip near its edges so off-screen tabs can be reached mid-drag.
              const bar = barRef.current
              if (bar) {
                const r = bar.getBoundingClientRect()
                if (e.clientX < r.left + 40) bar.scrollLeft = Math.max(0, bar.scrollLeft - 12)
                else if (e.clientX > r.right - 40) bar.scrollLeft += 12
              }
            } else {
              setOverGroup(null)
            }
          }
        }}
        onPointerUp={(e) => {
          const d = dragRef.current
          if (!d || d.pointerId !== e.pointerId) return
          const phase = phaseAt(e.clientX, e.clientY)
          const dropGroup = phase === 'drag' ? groupAt(e.clientX, e.clientY) : null
          dragRef.current = null
          setTearing(null)
          setReordering(null)
          setOverGroup(null)
          if (!d.moved) return
          suppressClick.current = true
          if (phase === 'tear') onTearOut(d.id)
          else if (dropGroup) {
            const dragged = tabs.find((t) => t.id === d.id)
            if (dragged && containerOf(dragged) !== dropGroup) onMoveToGroup(d.id, dropGroup)
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null
          setTearing(null)
          setReordering(null)
          setOverGroup(null)
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
        {!t.pinned && t.edited && (
          <span className="tab-dot" title="Edited this session — kept on restart" aria-hidden />
        )}
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
  }

  return (
    <div className="tabbar" role="tablist" aria-label="Open notes" ref={barRef}>
      {pinned.map((t) => renderTab(t, 'pinned'))}
      {groups
        .filter((g) => tabs.some((t) => t.group === g.id))
        .map((g) => {
          const members = membersOf(g)
          const hasActive = members.some((t) => t.id === activeId)
          const color = GROUP_COLORS[g.color % GROUP_COLORS.length]
          return (
            <div
              key={g.id}
              className={`tabgroup${g.collapsed ? ' collapsed' : ''}${
                overGroup === g.id && draggedContainer !== g.id ? ' drop-target' : ''
              }${hasActive ? ' has-active' : ''}`}
              data-group={g.id}
              style={{ '--gc': color } as React.CSSProperties}
            >
              <div
                className="tabgroup-head"
                role="tab"
                aria-selected={hasActive && g.collapsed}
                aria-expanded={!g.collapsed}
                tabIndex={0}
                title={`${g.name} — ${members.length} tab${members.length === 1 ? '' : 's'} · ${g.collapsed ? 'click to expand' : 'click to focus'} · ⇧-click to ${g.collapsed ? 'expand' : 'collapse'}`}
                onClick={(e) => {
                  if (e.shiftKey) onToggleGroup(g.id)
                  else onGroupClick(g.id)
                }}
                onDoubleClick={(e) => {
                  e.preventDefault()
                  onToggleGroup(g.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onGroupClick(g.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onGroupMenu(g.id, e.clientX, e.clientY)
                }}
              >
                <button
                  className="tabgroup-chev"
                  title={g.collapsed ? 'Expand group' : 'Collapse group'}
                  aria-label={g.collapsed ? `Expand ${g.name}` : `Collapse ${g.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleGroup(g.id)
                  }}
                >
                  {g.collapsed ? '▸' : '▾'}
                </button>
                <span className="tabgroup-name">{g.name}</span>
                {g.collapsed && members.length > 0 && (
                  <span className="tabgroup-count" title={`${members.length} tabs inside`}>
                    {members.length}
                  </span>
                )}
              </div>
              {!g.collapsed && (
                <div className="tabgroup-children" role="presentation">
                  {members.map((t) => renderTab(t, g.id))}
                </div>
              )}
            </div>
          )
        })}
      {free.map((t) => renderTab(t, 'free'))}
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
