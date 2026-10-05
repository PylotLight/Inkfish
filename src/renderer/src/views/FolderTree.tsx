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

export function kindIcon(kind: NoteKind): string {
  switch (kind) {
    case 'voice': return '🎙'
    case 'image': return '🖼'
    case 'meeting': return '📋'
    default: return '📄'
  }
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
            showPath
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
          depth={0}
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
  node, depth, titleOf, selectedId, collapsed, onToggle, onPickDir, onOpenFile, onMenu
}: {
  node: TreeNode
  depth: number
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
      <div className="frow" style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          className="caret"
          onClick={() => onToggle(node.rel)}
          aria-label={open ? `Collapse ${node.rel}` : `Expand ${node.rel}`}
        >
          {open ? '▾' : '▸'}
        </button>
        <button
          className="fmain"
          onClick={() => onPickDir(node.rel)}
          onContextMenu={(e) => {
            e.preventDefault()
            onMenu({ kind: 'dir', rel: node.rel, id: null, name: node.name }, e.clientX, e.clientY)
          }}
          title={node.rel}
        >
          <span className="ficon" aria-hidden>{open ? '📂' : '📁'}</span>
          <span className="fname">{node.name}</span>
          <span className="fcount">{node.total}</span>
        </button>
      </div>
      {open && (
        <div className="fkids">
          {node.children.map((c) => (
            <Node
              key={c.rel}
              node={c}
              depth={depth + 1}
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
              <div key={f.id} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
                <FileRow
                  entry={f}
                  title={t}
                  selected={selectedId === f.id}
                  onOpen={() => onOpenFile(f.id)}
                  onMenu={(x, y) => onMenu({ kind: 'file', rel: f.path, id: f.id, name: t }, x, y)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function FileRow({
  entry, title, selected, showPath, onOpen, onMenu
}: {
  entry: NoteEntry
  title: string
  selected: boolean
  showPath?: boolean
  onOpen: () => void
  onMenu: (x: number, y: number) => void
}): React.JSX.Element {
  const tip = `${entry.path}\n${entry.size > 0 ? `${fmtBytes(entry.size)} · ` : ''}edited ${timeAgo(entry.updatedAt)} · created ${new Date(entry.createdAt).toLocaleDateString()}`
  return (
    <button
      className={`filerow${selected ? ' on' : ''}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      title={tip}
    >
      <span className="ficon" aria-hidden>{kindIcon(entry.kind)}</span>
      <span className="ftext">
        <span className="fname">{title}</span>
        <span className="muted small">
          {showPath ? `${entry.path} · ` : ''}edited {timeAgo(entry.updatedAt)}
          {entry.size > 0 ? ` · ${fmtBytes(entry.size)}` : ''}
        </span>
      </span>
    </button>
  )
}

export default memo(FolderTree)
