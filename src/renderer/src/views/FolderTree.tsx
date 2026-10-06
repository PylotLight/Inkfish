import { memo, useEffect, useMemo, useState } from 'react'
import type { NoteEntry, NoteKind } from '../../../shared/types'
import { fmtBytes, timeAgo } from '../text'

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
export function buildTree(notes: NoteEntry[], titleOf: (n: NoteEntry) => string): TreeData {
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

  const freeze = (m: Mutable): TreeNode => {
    const children = [...m.kids.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(freeze)
    return {
      name: m.name,
      rel: m.rel,
      files: [...m.files].sort(byTitle(titleOf)),
      children,
      total: m.files.length + children.reduce((a, c) => a + c.total, 0)
    }
  }
  const roots = [...top.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(freeze)
  rootFiles.sort(byTitle(titleOf))
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
  onOpenFile, onPickDir, onMenu
}: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

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
  const tree = useMemo(() => buildTree(visible, titleOf), [visible, titleOf])

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
          />
        ))}
      </div>
    )
  }

  return (
    <div className="ftree" aria-label="Folders">
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
        />
      ))}
      {tree.roots.length === 0 && tree.rootFiles.length === 0 && (
        <p className="muted small pad">Nothing here yet — ⌥Space to capture.</p>
      )}
    </div>
  )
}

function Node({
  node, titleOf, selectedId, collapsed, onToggle, onPickDir, onOpenFile, onMenu
}: {
  node: TreeNode
  titleOf: (n: NoteEntry) => string
  selectedId: string | null
  collapsed: Set<string>
  onToggle: (rel: string) => void
  onPickDir: (rel: string) => void
  onOpenFile: (id: string) => void
  onMenu: (target: TreeTarget, x: number, y: number) => void
}): React.JSX.Element {
  const open = !collapsed.has(node.rel)
  return (
    <div className="fnode">
      <div className="frow">
        <button
          className="caret"
          onClick={() => onToggle(node.rel)}
          aria-label={open ? `Collapse ${node.rel}` : `Expand ${node.rel}`}
        >
          {open ? '▾' : '▸'}
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
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export function FileRow({
  entry, title, selected, bare, onOpen, onMenu
}: {
  entry: NoteEntry
  title: string
  selected: boolean
  /** Bare text row for the folder tree (no icon, no meta). Search keeps chrome. */
  bare?: boolean
  onOpen: () => void
  onMenu: (x: number, y: number) => void
}): React.JSX.Element {
  const tip = `${entry.path}\n${entry.size > 0 ? `${fmtBytes(entry.size)} · ` : ''}edited ${timeAgo(entry.updatedAt)} · created ${new Date(entry.createdAt).toLocaleDateString()}`
  // Slim meta for search rows: parent folder + relative time.
  const parent = entry.path.includes('/') ? (entry.path.split('/').slice(0, -1).pop() ?? '') : ''
  const meta = parent ? `${parent} · ${timeAgo(entry.updatedAt)}` : timeAgo(entry.updatedAt)
  return (
    <button
      className={`filerow${selected ? ' on' : ''}${bare ? ' bare' : ''}`}
      onClick={onOpen}
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
  )
}

export default memo(FolderTree)
