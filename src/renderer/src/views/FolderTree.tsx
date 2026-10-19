import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { NoteEntry, NoteKind } from '../../../shared/types'
import { canDropInto, dirOf, type MoveKind } from '../../../shared/note-move'
import { fmtBytes, timeAgo } from '../text'
import { Icon } from './icons'
import { renameCommit, renameStem, rowKeyAction } from '../../../shared/note-delete'
import './SidebarActions.css'

export interface TreeNode {
  name: string
  /** Vault-relative dir, e.g. `history/diffs`. */
  rel: string
  /** Files directly in this dir. */
  files: NoteEntry[]
  children: TreeNode[]
  /** Files in this subtree (recursive). */
  total: number
}

export interface TreeData {
  roots: TreeNode[]
  rootFiles: NoteEntry[]
}

const COLLAPSE_KEY = 'inkfish.tree.collapsed.v1'
const SORT_KEY = 'inkfish.tree.sort.v1'

/** Tree order: A→Z by name (default) or most recently edited first. */
export type TreeSort = 'name' | 'modified'

export function parseTreeSort(raw: string | null | undefined): TreeSort {
  return raw === 'modified' ? 'modified' : 'name'
}

function loadSort(): TreeSort {
  try {
    return parseTreeSort(localStorage.getItem(SORT_KEY))
  } catch {
    return 'name'
  }
}

/** Every dir rel in the tree — "collapse all" stores exactly these. */
export function allDirRels(tree: TreeData): string[] {
  const out: string[] = []
  const walk = (n: TreeNode): void => {
    out.push(n.rel)
    n.children.forEach(walk)
  }
  tree.roots.forEach(walk)
  return out
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

const byTitle = (titleOf: (n: NoteEntry) => string) => (a: NoteEntry, b: NoteEntry) =>
  titleOf(a).localeCompare(titleOf(b))

/** Build a nested dir tree with files attached — Obsidian-style. */
export function buildTree(
  notes: NoteEntry[],
  titleOf: (n: NoteEntry) => string,
  sort: TreeSort = 'name'
): TreeData {
  interface Mutable {
    name: string
    rel: string
    files: NoteEntry[]
    kids: Map<string, Mutable>
  }
  const top = new Map<string, Mutable>()
  const rootFiles: NoteEntry[] = []

  for (const n of notes) {
    const parts = n.path.split('/')
    if (parts.length <= 1) {
      rootFiles.push(n)
      continue
    }
    let level = top
    let rel = ''
    let node: Mutable | undefined
    for (const d of parts.slice(0, -1)) {
      rel = rel ? `${rel}/${d}` : d
      node = level.get(d)
      if (!node) {
        node = { name: d, rel, files: [], kids: new Map() }
        level.set(d, node)
      }
      level = node.kids
    }
    node?.files.push(n)
  }

  const fileCmp =
    sort === 'modified'
      ? (a: NoteEntry, b: NoteEntry) => b.updatedAt - a.updatedAt || byTitle(titleOf)(a, b)
      : byTitle(titleOf)
  interface Frozen extends TreeNode {
    newest: number
  }
  const dirCmp = (a: Frozen, b: Frozen): number =>
    sort === 'modified' ? b.newest - a.newest || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)
  const freeze = (m: Mutable): Frozen => {
    const children = [...m.kids.values()].map(freeze).sort(dirCmp)
    const newest = Math.max(0, ...m.files.map((f) => f.updatedAt), ...children.map((c) => c.newest))
    return {
      name: m.name,
      rel: m.rel,
      files: [...m.files].sort(fileCmp),
      children,
      total: m.files.length + children.reduce((a, c) => a + c.total, 0),
      newest
    }
  }
  const roots = [...top.values()].map(freeze).sort(dirCmp)
  rootFiles.sort(fileCmp)
  return { roots, rootFiles }
}

export type KindFilter = 'all' | NoteKind

export interface TreeTarget {
  kind: 'file' | 'dir'
  /** vaultRel of the file or dir. */
  rel: string
  /** note id when kind === 'file'. */
  id: string | null
  name: string
}

interface Props {
  notes: NoteEntry[]
  kind: KindFilter
  titleOf: (n: NoteEntry) => string
  /** Open note id (highlight). */
  selectedId: string | null
  /** Vault-rel path of the open note — ancestors auto-expand. */
  selectedPath: string | null
  /** Search results replace the tree with flat file rows. Null = tree. */
  results: NoteEntry[] | null
  /** Dir to reveal (expand ancestors). */
  revealDir: string | null
  onOpenFile: (id: string) => void
  onPickDir: (rel: string) => void
  onMenu: (target: TreeTarget, x: number, y: number) => void
  /** Toolbar: new note / new folder in the current target dir. */
  onNewNote: () => void
  onNewFolder: () => void
  /** Current target dir for new notes ('' = vault root). */
  targetDir: string
  /** Optional row under the toolbar (kind filter chips). */
  filters?: ReactNode
  /** Drag & drop: move a note/folder into `destDir` ('' = vault root). */
  onMove?: (rel: string, kind: MoveKind, destDir: string) => void
  /** Note row actions (hover buttons, F2 rename, ⌘⌫, ⌥-click; Enter opens). Absent = plain rows. */
  rowActions?: RowActions
}

/** Per-note row actions: inline rename + smart delete. */
export interface RowActions {
  /** Note id whose row shows the inline rename field. */
  renamingId: string | null
  startRename: (entry: NoteEntry) => void
  /** `value` null = cancelled (Esc). */
  endRename: (entry: NoteEntry, value: string | null) => void
  /** `anchor` = the row's rect (popover sits next to it); `skipConfirm` = ⇧ held / second ⌘⌫. */
  remove: (entry: NoteEntry, anchor: DOMRect, skipConfirm: boolean) => void
}

/** Private drag payload type — external drags (Finder files) never look like a tree move. */
export const TREE_DRAG_TYPE = 'application/x-inkfish-entry'
/** Hovering a collapsed folder this long while dragging opens it (Obsidian ≈ 600ms). */
export const DRAG_EXPAND_MS = 600
/** Edge band (px) of the scrolling sidebar that auto-scrolls during a drag. */
export const DRAG_SCROLL_EDGE = 36

/** Auto-scroll step for a pointer at `y` inside [top, bottom]: negative = up, 0 = none. */
export function dragScrollStep(y: number, top: number, bottom: number, edge = DRAG_SCROLL_EDGE): number {
  if (bottom - top < edge * 3) return 0
  if (y < top + edge) return -Math.ceil(((top + edge - y) / edge) * 14)
  if (y > bottom - edge) return Math.ceil(((y - (bottom - edge)) / edge) * 14)
  return 0
}

/** Drag & drop wiring handed down the tree. */
interface Dnd {
  /** Folder currently highlighted as the drop target (null = none, '' = vault root). */
  dropDir: string | null
  start: (e: DragEvent, rel: string, kind: MoveKind) => void
  /** dragover on something whose drop target is `destDir`; `expand` opens a collapsed folder. */
  over: (e: DragEvent, destDir: string, expand?: string) => void
  drop: (e: DragEvent, destDir: string) => void
  end: () => void
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return null
}

/** Minimal stroke icons — used in search results only. The folder tree
 *  itself is bare text (Obsidian-style): no per-file icons. */
function KindGlyph({ kind }: { kind: NoteKind }): React.JSX.Element {
  const common = {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round'
  } as const
  if (kind === 'voice') {
    return (
      <svg {...common} aria-hidden>
        <rect x="6" y="1.5" width="4" height="7" rx="2" />
        <path d="M4 7.5a4 4 0 0 0 8 0M8 11.5V14M6 14h4" />
      </svg>
    )
  }
  if (kind === 'image') {
    return (
      <svg {...common} aria-hidden>
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <circle cx="5.7" cy="6.6" r="1.1" />
        <path d="M2.5 11.3l3.3-2.8 2.4 1.9 1.9-1.4 3.1 2.3" />
      </svg>
    )
  }
  if (kind === 'meeting') {
    return (
      <svg {...common} aria-hidden>
        <rect x="4" y="2.8" width="8" height="11" rx="1.5" />
        <path d="M6.3 2.8V1.7h3.4v1.1M6.3 7.2h3.4M6.3 9.8h3.4" />
      </svg>
    )
  }
  return (
    <svg {...common} aria-hidden>
      <path d="M4 1.5h5.2l2.8 2.8v10.2H4z" />
      <path d="M9.2 1.5v2.8H12" />
    </svg>
  )
}

/** Directory tree with files — navigation mirrors the actual vault. */
function FolderTree({
  notes, kind, titleOf, selectedId, selectedPath, results, revealDir,
  onOpenFile, onPickDir, onMenu, onNewNote, onNewFolder, targetDir, filters, onMove, rowActions
}: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [sort, setSort] = useState<TreeSort>(loadSort)
  // --- drag & drop (notes + folders onto folders / the vault root) ---------------------------
  const treeRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ rel: string; kind: MoveKind } | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const expandTimer = useRef<{ rel: string; t: number } | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const persist = (next: Set<string>): void => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
    } catch {
      // ignore
    }
  }

  const expandAncestors = (rel: string): void => {
    const parts = rel.split('/')
    const prefixes: string[] = []
    for (let i = 1; i < parts.length; i++) {
      prefixes.push(parts.slice(0, i).join('/'))
    }
    if (prefixes.length === 0) return
    setCollapsed((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const p of prefixes) {
        if (next.delete(p)) changed = true
      }
      if (changed) persist(next)
      return changed ? next : prev
    })
  }

  // Opening a file/dir from elsewhere reveals it in the tree.
  useEffect(() => {
    if (selectedPath && selectedPath.includes('/')) {
      expandAncestors(selectedPath.slice(0, selectedPath.lastIndexOf('/')))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  useEffect(() => {
    if (revealDir) expandAncestors(revealDir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealDir])

  const visible = useMemo(
    () => (kind === 'all' ? notes : notes.filter((n) => n.kind === kind)),
    [notes, kind]
  )
  const tree = useMemo(() => buildTree(visible, titleOf, sort), [visible, titleOf, sort])
  const dirRels = useMemo(() => allDirRels(tree), [tree])
  const anyOpen = dirRels.some((r) => !collapsed.has(r))

  const setAllCollapsed = (collapse: boolean): void => {
    const next = collapse ? new Set(dirRels) : new Set<string>()
    persist(next)
    setCollapsed(next)
  }

  const flipSort = (): void => {
    const next: TreeSort = sort === 'name' ? 'modified' : 'name'
    try {
      localStorage.setItem(SORT_KEY, next)
    } catch {
      // ignore
    }
    setSort(next)
  }

  const where = targetDir || 'vault root'
  const toolbar = (
    <div className="tree-toolbar" role="toolbar" aria-label="Notes actions">
      <button className="tree-tool" onClick={onNewNote} title={`New note in ${where}`} aria-label="New note">
        <Icon name="note-new" size={16} />
      </button>
      <button className="tree-tool" onClick={onNewFolder} title={`New folder in ${where}`} aria-label="New folder">
        <Icon name="folder-new" size={16} />
      </button>
      <button
        className="tree-tool"
        onClick={flipSort}
        title={sort === 'name' ? 'Sorted A→Z — switch to recently edited' : 'Sorted by recently edited — switch to A→Z'}
        aria-label={sort === 'name' ? 'Sort by recently edited' : 'Sort by name'}
      >
        <Icon name={sort === 'name' ? 'sort-az' : 'sort-time'} size={16} />
      </button>
      <button
        className="tree-tool"
        onClick={() => setAllCollapsed(anyOpen)}
        disabled={dirRels.length === 0 || results !== null}
        title={anyOpen ? 'Collapse all folders' : 'Expand all folders'}
        aria-label={anyOpen ? 'Collapse all folders' : 'Expand all folders'}
      >
        <Icon name={anyOpen ? 'collapse-all' : 'expand-all'} size={16} />
      </button>
      {targetDir !== '' && (
        <span className="tree-target" title={`New notes go to ${targetDir}`}>
          {targetDir.split('/').pop()}
        </span>
      )}
    </div>
  )

  const clearExpand = (): void => {
    if (expandTimer.current) window.clearTimeout(expandTimer.current.t)
    expandTimer.current = null
  }
  const endDrag = (): void => {
    dragRef.current = null
    scrollRef.current = null
    clearExpand()
    setDropDir(null)
    setDragging(false)
  }
  // Esc mid-drag: Chromium cancels the native drag and fires dragend (→ endDrag). Belt and braces
  // for a cancelled drag that never reports back.
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endDrag()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dragging])

  const dnd: Dnd | null = onMove
    ? {
        dropDir,
        start: (e, rel, kind) => {
          e.dataTransfer.setData(TREE_DRAG_TYPE, JSON.stringify({ rel, kind }))
          e.dataTransfer.effectAllowed = 'move'
          dragRef.current = { rel, kind }
          scrollRef.current = scrollParent(treeRef.current)
          // Defer the re-render: touching the DOM inside dragstart can abort the native drag.
          window.setTimeout(() => {
            if (dragRef.current) setDragging(true)
          }, 0)
        },
        over: (e, destDir, expand) => {
          const d = dragRef.current
          if (!d) return // not ours (e.g. files from Finder)
          e.stopPropagation()
          if (!canDropInto(d.rel, d.kind, destDir)) {
            e.dataTransfer.dropEffect = 'none'
            clearExpand()
            setDropDir((cur) => (cur === null ? cur : null))
            return
          }
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropDir((cur) => (cur === destDir ? cur : destDir))
          if (expand && collapsed.has(expand)) {
            if (expandTimer.current?.rel !== expand) {
              clearExpand()
              const t = window.setTimeout(() => {
                expandTimer.current = null
                setCollapsed((prev) => {
                  if (!prev.has(expand)) return prev
                  const next = new Set(prev)
                  next.delete(expand)
                  persist(next)
                  return next
                })
              }, DRAG_EXPAND_MS)
              expandTimer.current = { rel: expand, t }
            }
          } else if (expandTimer.current && expandTimer.current.rel !== expand) clearExpand()
        },
        drop: (e, destDir) => {
          const d = dragRef.current
          if (!d) return
          e.preventDefault()
          e.stopPropagation()
          endDrag()
          if (canDropInto(d.rel, d.kind, destDir)) onMove?.(d.rel, d.kind, destDir)
        },
        end: endDrag
      }
    : null

  /** Auto-scroll the sidebar while dragging near its top/bottom edge (capture: rows stop bubbling). */
  const onDragScroll = (e: DragEvent): void => {
    const el = scrollRef.current
    if (!dragRef.current || !el) return
    const r = el.getBoundingClientRect()
    const step = dragScrollStep(e.clientY, r.top, r.bottom)
    if (step) el.scrollTop += step
  }

  const toggle = (rel: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      persist(next)
      return next
    })
  }

  if (results !== null) {
    return (
      <>
      {toolbar}
      {filters}
      <div className="ftree" aria-label="Search results">
        {results.length === 0 && <p className="muted small pad">No matches.</p>}
        {results.map((n) => (
          <FileRow
            key={n.id}
            entry={n}
            title={titleOf(n)}
            selected={selectedId === n.id}
            onOpen={() => onOpenFile(n.id)}
            onMenu={(x, y) => onMenu({ kind: 'file', rel: n.path, id: n.id, name: titleOf(n) }, x, y)}
            actions={rowActions}
          />
        ))}
      </div>
      </>
    )
  }

  return (
    <>
    {toolbar}
    {filters}
    <div
      ref={treeRef}
      className={`ftree${dragging ? ' dragging' : ''}${dropDir === '' ? ' drop-root' : ''}`}
      aria-label="Folders"
      onDragOverCapture={onDragScroll}
      onDragOver={dnd ? (e) => dnd.over(e, '') : undefined}
      onDrop={dnd ? (e) => dnd.drop(e, '') : undefined}
      onDragLeave={dnd ? (e) => {
        if (!treeRef.current?.contains(e.relatedTarget as Node | null)) setDropDir(null)
      } : undefined}
    >
      {tree.roots.map((n) => (
        <Node
          key={n.rel}
          node={n}
          titleOf={titleOf}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggle={toggle}
          onPickDir={onPickDir}
          onOpenFile={onOpenFile}
          onMenu={onMenu}
          dnd={dnd}
          rowActions={rowActions}
        />
      ))}
      {tree.rootFiles.map((n) => (
        <FileRow
          key={n.id}
          entry={n}
          title={titleOf(n)}
          selected={selectedId === n.id}
          bare
          onOpen={() => onOpenFile(n.id)}
          onMenu={(x, y) => onMenu({ kind: 'file', rel: n.path, id: n.id, name: titleOf(n) }, x, y)}
          dnd={dnd}
          actions={rowActions}
        />
      ))}
      {dragging && (
        <div className="ftree-root-drop" aria-hidden>
          Drop here to move to the vault root
        </div>
      )}
      {tree.roots.length === 0 && tree.rootFiles.length === 0 && (
        <p className="muted small pad">Nothing here yet — ⌥Space to capture.</p>
      )}
    </div>
    </>
  )
}

function Node({
  node, titleOf, selectedId, collapsed, onToggle, onPickDir, onOpenFile, onMenu, dnd, rowActions
}: {
  node: TreeNode
  titleOf: (n: NoteEntry) => string
  selectedId: string | null
  collapsed: Set<string>
  onToggle: (rel: string) => void
  onPickDir: (rel: string) => void
  onOpenFile: (id: string) => void
  onMenu: (target: TreeTarget, x: number, y: number) => void
  dnd: Dnd | null
  rowActions?: RowActions
}): React.JSX.Element {
  const open = !collapsed.has(node.rel)
  const isDrop = dnd?.dropDir === node.rel
  return (
    <div
      className={`fnode${isDrop ? ' drop-into' : ''}`}
      onDragOver={dnd ? (e) => dnd.over(e, node.rel) : undefined}
      onDrop={dnd ? (e) => dnd.drop(e, node.rel) : undefined}
    >
      <div
        className={`frow${open ? ' open' : ''}`}
        draggable={!!dnd}
        onDragStart={dnd ? (e) => dnd.start(e, node.rel, 'dir') : undefined}
        onDragEnd={dnd ? () => dnd.end() : undefined}
        onDragOver={dnd ? (e) => dnd.over(e, node.rel, node.rel) : undefined}
      >
        <button
          className="caret"
          onClick={() => onToggle(node.rel)}
          aria-label={open ? `Collapse ${node.rel}` : `Expand ${node.rel}`}
          aria-expanded={open}
        >
          <Icon name="chevron-right" size={14} strokeWidth={2} />
        </button>
        <button
          className="fmain"
          onClick={() => {
            onToggle(node.rel)
            onPickDir(node.rel)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            onMenu({ kind: 'dir', rel: node.rel, id: null, name: node.name }, e.clientX, e.clientY)
          }}
          title={`${node.rel} — toggle / set as target`}
        >
          <span className="fname">{node.name}</span>
          <span className="fcount" title={`${node.total} notes in subtree`}>{node.total}</span>
        </button>
      </div>
      {open && (
        <div className="fkids">
          {node.children.map((c) => (
            <Node
              key={c.rel}
              node={c}
              titleOf={titleOf}
              selectedId={selectedId}
              collapsed={collapsed}
              onToggle={onToggle}
              onPickDir={onPickDir}
              onOpenFile={onOpenFile}
              onMenu={onMenu}
              dnd={dnd}
              rowActions={rowActions}
            />
          ))}
          {node.files.map((f) => {
            const t = titleOf(f)
            return (
              <FileRow
                key={f.id}
                entry={f}
                title={t}
                selected={selectedId === f.id}
                bare
                onOpen={() => onOpenFile(f.id)}
                onMenu={(x, y) => onMenu({ kind: 'file', rel: f.path, id: f.id, name: t }, x, y)}
                dnd={dnd}
                actions={rowActions}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export function FileRow({
  entry, title, selected, bare, onOpen, onMenu, dnd, actions
}: {
  entry: NoteEntry
  title: string
  selected: boolean
  /** Bare text row for the folder tree (no icon, no meta). Search keeps chrome. */
  bare?: boolean
  onOpen: () => void
  onMenu: (x: number, y: number) => void
  /** Tree rows only: drag to move; hovering a note targets its folder. */
  dnd?: Dnd | null
  /** Hover buttons + keys (rename / delete / ⋯). */
  actions?: RowActions
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const tip = `${entry.path}\n${entry.size > 0 ? `${fmtBytes(entry.size)} · ` : ''}edited ${timeAgo(entry.updatedAt)} · created ${new Date(entry.createdAt).toLocaleDateString()}`
  // Slim meta for search rows: parent folder + relative time.
  const parent = entry.path.includes('/') ? (entry.path.split('/').slice(0, -1).pop() ?? '') : ''
  const meta = parent ? `${parent} · ${timeAgo(entry.updatedAt)}` : timeAgo(entry.updatedAt)
  const rowRect = (): DOMRect => (wrapRef.current ?? document.body).getBoundingClientRect()
  const renaming = actions?.renamingId === entry.id

  if (renaming && actions) {
    return (
      <div ref={wrapRef} className={`filerow-wrap renaming${selected ? ' on' : ''}`} data-note-id={entry.id}>
        <div className={`filerow${selected ? ' on' : ''}${bare ? ' bare' : ''}`}>
          {!bare && (
            <span className="ficon" aria-hidden><KindGlyph kind={entry.kind} /></span>
          )}
          <InlineRename rel={entry.path} onDone={(v) => actions.endRename(entry, v)} />
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className={`filerow-wrap${selected ? ' on' : ''}${actions ? ' has-acts' : ''}`} data-note-id={entry.id}>
      <button
        className={`filerow${selected ? ' on' : ''}${bare ? ' bare' : ''}`}
        onClick={(e) => {
          // ⌥-click deletes (⌥⇧ skips the confirm), as before.
          if (e.altKey && actions) {
            e.preventDefault()
            actions.remove(entry, rowRect(), e.shiftKey)
            return
          }
          onOpen()
        }}
        onKeyDown={(e) => {
          if (!actions) return
          const act = rowKeyAction(e)
          if (!act) return
          e.preventDefault()
          e.stopPropagation()
          if (act === 'rename') actions.startRename(entry)
          else actions.remove(entry, rowRect(), e.shiftKey)
        }}
        draggable={!!dnd}
        onDragStart={dnd ? (e) => dnd.start(e, entry.path, 'file') : undefined}
        onDragEnd={dnd ? () => dnd.end() : undefined}
        onDragOver={dnd ? (e) => dnd.over(e, dirOf(entry.path)) : undefined}
        onDrop={dnd ? (e) => dnd.drop(e, dirOf(entry.path)) : undefined}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(e.clientX, e.clientY)
        }}
        title={tip}
      >
        {!bare && (
          <span className="ficon" aria-hidden><KindGlyph kind={entry.kind} /></span>
        )}
        <span className="ftext">
          <span className="fname">{title}</span>
          {!bare && <span className="fmeta">{meta}</span>}
        </span>
      </button>
      {actions && (
        <span className="row-acts">
          <button
            className="row-act"
            tabIndex={-1}
            title="Rename (F2)"
            aria-label={`Rename ${title}`}
            onClick={(e) => {
              e.stopPropagation()
              actions.startRename(entry)
            }}
          >
            <Icon name="pencil" size={14} />
          </button>
          <button
            className="row-act danger"
            tabIndex={-1}
            title="Delete (⌘⌫) · ⇧-click skips the confirm"
            aria-label={`Delete ${title}`}
            onClick={(e) => {
              e.stopPropagation()
              actions.remove(entry, rowRect(), e.shiftKey)
            }}
          >
            <Icon name="trash" size={14} />
          </button>
          <button
            className="row-act"
            tabIndex={-1}
            title="More"
            aria-label={`More actions for ${title}`}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              onMenu(r.left, r.bottom + 4)
            }}
          >
            <Icon name="more" size={14} />
          </button>
        </span>
      )}
    </div>
  )
}

/** In-place file name field: Enter / blur commits, Esc cancels. Shows the name without `.md`. */
function InlineRename({ rel, onDone }: { rel: string; onDone: (value: string | null) => void }): React.JSX.Element {
  const [value, setValue] = useState(() => renameStem(rel))
  const done = useRef(false)
  const finish = (v: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(v === null ? null : renameCommit(rel, v) === null ? null : v.trim())
  }
  return (
    <input
      className="row-rename"
      value={value}
      autoFocus
      spellCheck={false}
      aria-label="Rename note"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(null)
        }
      }}
      onBlur={() => finish(value)}
    />
  )
}

export default memo(FolderTree)
