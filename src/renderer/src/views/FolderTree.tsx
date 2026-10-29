import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { NoteEntry, NoteKind } from '../../../shared/types'
import { canDropInto, dirOf, type MoveItem, type MoveKind } from '../../../shared/note-move'
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

/** Build a nested dir tree with files attached — Obsidian-style. `dirs` adds on-disk folders
 *  that no indexed note sits under (empty folders would otherwise be invisible and
 *  undroppable — a "broken" folder you created but can never reach). */
export function buildTree(
  notes: NoteEntry[],
  titleOf: (n: NoteEntry) => string,
  sort: TreeSort = 'name',
  dirs: readonly string[] = []
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

  // Folders on disk with no indexed note under them: create the node chain anyway.
  for (const rel of dirs) {
    let level = top
    let cur = ''
    for (const d of rel.split('/')) {
      cur = cur ? `${cur}/${d}` : d
      const node = level.get(d)
      if (!node) {
        level.set(d, { name: d, rel: cur, files: [], kids: new Map() })
      }
      level = level.get(d)!.kids
    }
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
  /** The quick capture shortcut as shown ("⌥Space"), '' when off. */
  captureKey?: string
  notes: NoteEntry[]
  /** Every folder on disk (vault-relative), empty included — keeps fresh folders visible + droppable. */
  dirs?: string[]
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
  /** Dropping a whole multi-selection: move every item into `destDir`. */
  onMoveMany?: (items: MoveItem[], destDir: string) => void
  /** The current row selection (⌘/ctrl-click, ⇧-range) — right-click / ⌘K menus act on it. */
  onSelectionChange?: (items: MoveItem[]) => void
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
  /** `rel` is the row grabbed; the handler decides how much of the selection it carries. */
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
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
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
  notes,
  dirs = [],
  kind,
  titleOf,
  selectedId,
  selectedPath,
  results,
  revealDir,
  onOpenFile,
  onPickDir,
  onMenu,
  onNewNote,
  onNewFolder,
  targetDir,
  filters,
  onMove,
  onMoveMany,
  onSelectionChange,
  rowActions,
  captureKey = '⌥Space'
}: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [sort, setSort] = useState<TreeSort>(loadSort)
  // --- drag & drop (notes + folders onto folders / the vault root) ---------------------------
  const treeRef = useRef<HTMLDivElement>(null)
  /** The items a drag carries: one row, or the whole selection when the row is selected. */
  const dragRef = useRef<MoveItem[] | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const expandTimer = useRef<{ rel: string; t: number } | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Number of items in the in-flight drag (the root drop hint says so). */
  const [dragN, setDragN] = useState(0)
  // --- multi-select (⌘/ctrl-click toggles, ⇧-click ranges, Esc / blank click clears) --------
  const [sel, setSel] = useState<Map<string, MoveKind>>(new Map())
  /** The row a ⇧-range extends from (the last plainly- or ⌘-clicked row). */
  const anchorRef = useRef<string | null>(null)

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

  const visible = useMemo(() => (kind === 'all' ? notes : notes.filter((n) => n.kind === kind)), [notes, kind])
  // On-disk folders added beyond what notes imply. Under a kind filter only
  // folders that still hold a matching note stay — an empty folder has no content to match.
  const extraDirs = useMemo(() => {
    if (kind === 'all' || dirs.length === 0) return dirs
    const hasNote = new Set<string>()
    for (const n of visible) {
      const parts = n.path.split('/')
      for (let i = 1; i < parts.length; i++) hasNote.add(parts.slice(0, i).join('/'))
    }
    return dirs.filter((d) => hasNote.has(d))
  }, [visible, kind, dirs])
  const tree = useMemo(() => buildTree(visible, titleOf, sort, extraDirs), [visible, titleOf, sort, extraDirs])
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

  // --- multi-select ----------------------------------------------------------------------------
  /** Rows in DOM order (folders, then expanded children, then files) — ⇧-ranges walk this. */
  const visibleRows = useMemo(() => {
    if (results !== null) return []
    const out: MoveItem[] = []
    const walk = (n: TreeNode): void => {
      out.push({ rel: n.rel, kind: 'dir' })
      if (collapsed.has(n.rel)) return
      n.children.forEach(walk)
      for (const f of n.files) out.push({ rel: f.path, kind: 'file' })
    }
    tree.roots.forEach(walk)
    for (const f of tree.rootFiles) out.push({ rel: f.path, kind: 'file' })
    return out
  }, [tree, collapsed, results])

  const toggleSelect = useCallback((rel: string, kind: MoveKind): void => {
    anchorRef.current = rel
    setSel((prev) => {
      const next = new Map(prev)
      if (next.has(rel)) next.delete(rel)
      else next.set(rel, kind)
      return next
    })
  }, [])

  /** ⇧-click: the anchor…clicked span. The anchor stays where it was. */
  const rangeSelect = useCallback(
    (rel: string, kind: MoveKind, additive: boolean): void => {
      const anchor = anchorRef.current
      const a = anchor ? visibleRows.findIndex((r) => r.rel === anchor) : -1
      const b = visibleRows.findIndex((r) => r.rel === rel)
      if (a === -1 || b === -1) {
        toggleSelect(rel, kind)
        return
      }
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSel((prev) => {
        const next = additive ? new Map(prev) : new Map<string, MoveKind>()
        for (let i = lo; i <= hi; i++) {
          const r = visibleRows[i]!
          next.set(r.rel, r.kind)
        }
        return next
      })
    },
    [visibleRows, toggleSelect]
  )

  /** Plain click: this row becomes the whole selection (and it opens, as before). */
  const selectOnly = useCallback((rel: string, kind: MoveKind): void => {
    anchorRef.current = rel
    setSel(new Map([[rel, kind]]))
  }, [])

  const clearSel = useCallback((): void => {
    anchorRef.current = null
    setSel((prev) => (prev.size === 0 ? prev : new Map()))
  }, [])

  // One handler for all three gestures; rows pass the click event through.
  const onRowSel = useCallback(
    (rel: string, kind: MoveKind, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void => {
      if (e.metaKey || e.ctrlKey) toggleSelect(rel, kind)
      else if (e.shiftKey) rangeSelect(rel, kind, e.metaKey || e.ctrlKey)
      else selectOnly(rel, kind)
    },
    [toggleSelect, rangeSelect, selectOnly]
  )

  // Report the selection upward (menus / ⌘K act on it) and prune rows that left the vault.
  const selItems = useCallback(() => [...sel.entries()].map(([rel, kind]) => ({ rel, kind })), [sel])
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  useEffect(() => {
    onSelectionChangeRef.current?.(selItems())
  }, [selItems])
  useEffect(() => {
    setSel((prev) => {
      if (prev.size === 0) return prev
      const live = new Set<string>(dirs)
      for (const n of notes) live.add(n.path)
      let changed = false
      const next = new Map<string, MoveKind>()
      for (const [rel, kind] of prev) {
        if (live.has(rel)) next.set(rel, kind)
        else changed = true
      }
      if (changed && next.size === 0) anchorRef.current = null
      return changed ? next : prev
    })
  }, [notes, dirs])

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
  const endDrag = useCallback((): void => {
    dragRef.current = null
    scrollRef.current = null
    clearExpand()
    setDropDir(null)
    setDragging(false)
    setDragN(0)
  }, [])
  // Esc mid-drag: Chromium cancels the native drag and fires dragend (→ endDrag). Belt and braces
  // for a cancelled drag that never reports back.
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endDrag()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dragging, endDrag])

  const dnd: Dnd | null = onMove
    ? {
        dropDir,
        start: (e, rel, kind) => {
          // A selected row drags the whole selection; an unselected one drags itself only.
          const items = sel.size > 0 && sel.has(rel) ? selItems() : [{ rel, kind }]
          e.dataTransfer.setData(TREE_DRAG_TYPE, JSON.stringify(items))
          e.dataTransfer.effectAllowed = 'move'
          dragRef.current = items
          scrollRef.current = scrollParent(treeRef.current)
          // Defer the re-render: touching the DOM inside dragstart can abort the native drag.
          window.setTimeout(() => {
            if (dragRef.current) {
              setDragging(true)
              setDragN(items.length)
            }
          }, 0)
        },
        over: (e, destDir, expand) => {
          const d = dragRef.current
          if (!d) return // not ours (e.g. files from Finder)
          e.stopPropagation()
          if (!d.some((it) => canDropInto(it.rel, it.kind, destDir))) {
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
          clearSel()
          const valid = d.filter((it) => canDropInto(it.rel, it.kind, destDir))
          const first = valid[0]
          if (!first) return
          // Without a multi-move handler, a multi-selection still moves its first item.
          if (valid.length === 1 || !onMoveMany) onMove?.(first.rel, first.kind, destDir)
          else onMoveMany(valid, destDir)
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
        onDragLeave={
          dnd
            ? (e) => {
                if (!treeRef.current?.contains(e.relatedTarget as Node | null)) setDropDir(null)
              }
            : undefined
        }
        onClick={
          // A click on blank tree space (not a row) clears the selection.
          sel.size > 0
            ? (e) => {
                if (!(e.target as HTMLElement).closest('.filerow, .frow')) clearSel()
              }
            : undefined
        }
        onKeyDown={
          sel.size > 0
            ? (e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  clearSel()
                }
              }
            : undefined
        }
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
            sel={sel}
            onRowSel={onRowSel}
            onSelectOnly={selectOnly}
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
            sel={sel}
            onRowSel={onRowSel}
            onSelectOnly={selectOnly}
            actions={rowActions}
          />
        ))}
        {dragging && (
          <div className="ftree-root-drop" aria-hidden>
            {dragN > 1 ? `Drop ${dragN} here to move to the vault root` : 'Drop here to move to the vault root'}
          </div>
        )}
        {tree.roots.length === 0 && tree.rootFiles.length === 0 && (
          <p className="muted small pad">
            Nothing here yet — {captureKey ? `${captureKey} to capture.` : 'capture from the menu bar icon.'}
          </p>
        )}
      </div>
    </>
  )
}

function Node({
  node,
  titleOf,
  selectedId,
  collapsed,
  onToggle,
  onPickDir,
  onOpenFile,
  onMenu,
  dnd,
  sel,
  onRowSel,
  onSelectOnly,
  rowActions
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
  sel?: Map<string, MoveKind>
  onRowSel?: (rel: string, kind: MoveKind, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void
  onSelectOnly?: (rel: string, kind: MoveKind) => void
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
        className={`frow${open ? ' open' : ''}${sel?.has(node.rel) ? ' sel' : ''}`}
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
          onClick={(e) => {
            // ⌘/⇧-click selects (with the range anchor), plain click selects + toggles + targets.
            if (onRowSel && (e.metaKey || e.ctrlKey || e.shiftKey)) {
              e.preventDefault()
              onRowSel(node.rel, 'dir', e)
              return
            }
            onSelectOnly?.(node.rel, 'dir')
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
          <span className="fcount" title={`${node.total} notes in subtree`}>
            {node.total}
          </span>
        </button>
      </div>
      {open && (
        <div className="fkids">
          {node.children.length === 0 && node.files.length === 0 && (
            <div className="frow fempty">
              <span className="caret" aria-hidden />
              <span className="fname fempty-text">empty — drop notes here</span>
            </div>
          )}
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
              sel={sel}
              onRowSel={onRowSel}
              onSelectOnly={onSelectOnly}
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
                sel={sel}
                onRowSel={onRowSel}
                onSelectOnly={onSelectOnly}
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
  entry,
  title,
  selected,
  bare,
  onOpen,
  onMenu,
  dnd,
  sel,
  onRowSel,
  onSelectOnly,
  actions
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
  /** Multi-select: is this row selected. */
  sel?: Map<string, MoveKind>
  /** ⌘/ctrl-click toggles, ⇧-click ranges, plain-click selects-only (see FolderTree). */
  onRowSel?: (rel: string, kind: MoveKind, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void
  onSelectOnly?: (rel: string, kind: MoveKind) => void
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
            <span className="ficon" aria-hidden>
              <KindGlyph kind={entry.kind} />
            </span>
          )}
          <InlineRename rel={entry.path} onDone={(v) => actions.endRename(entry, v)} />
        </div>
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      className={`filerow-wrap${selected ? ' on' : ''}${actions ? ' has-acts' : ''}`}
      data-note-id={entry.id}
    >
      <button
        className={`filerow${selected ? ' on' : ''}${bare ? ' bare' : ''}${sel?.has(entry.path) ? ' sel' : ''}`}
        onClick={(e) => {
          // ⌥-click deletes (⌥⇧ skips the confirm), as before.
          if (e.altKey && actions) {
            e.preventDefault()
            actions.remove(entry, rowRect(), e.shiftKey)
            return
          }
          // ⌘/ctrl-click toggles the selection, ⇧-click ranges from the anchor — neither opens.
          if (onRowSel && (e.metaKey || e.ctrlKey || e.shiftKey)) {
            e.preventDefault()
            onRowSel(entry.path, 'file', e)
            return
          }
          onSelectOnly?.(entry.path, 'file')
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
        onDoubleClick={(e) => {
          // The quick path to rename: the first click opens, the double starts the inline field.
          if (!actions) return
          e.preventDefault()
          e.stopPropagation()
          actions.startRename(entry)
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
          <span className="ficon" aria-hidden>
            <KindGlyph kind={entry.kind} />
          </span>
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
            title="Rename (double-click / F2)"
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
