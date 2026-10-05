import { memo, useMemo, useState } from 'react'
import type { NoteEntry } from '../../../shared/types'

export interface TreeNode {
  name: string
  /** Vault-relative dir, e.g. `history/diffs`; '' = top-level files. */
  rel: string
  /** Notes in this subtree. */
  count: number
  children: TreeNode[]
}

const EXPAND_KEY = 'inkfish.tree.collapsed.v1'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPAND_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

/** Build a nested dir tree from note vault paths. */
export function buildTree(notes: NoteEntry[]): { roots: TreeNode[]; rootFiles: number } {
  interface Mutable {
    name: string
    rel: string
    count: number
    kids: Map<string, Mutable>
  }
  const top = new Map<string, Mutable>()
  let rootFiles = 0

  for (const n of notes) {
    const parts = n.path.split('/')
    if (parts.length <= 1) {
      rootFiles++
      continue
    }
    let level = top
    let rel = ''
    for (const d of parts.slice(0, -1)) {
      rel = rel ? `${rel}/${d}` : d
      let node = level.get(d)
      if (!node) {
        node = { name: d, rel, count: 0, kids: new Map() }
        level.set(d, node)
      }
      node.count++
      level = node.kids
    }
  }

  const freeze = (m: Mutable): TreeNode => ({
    name: m.name,
    rel: m.rel,
    count: m.count,
    children: [...m.kids.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(freeze)
  })
  const roots = [...top.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(freeze)
  return { roots, rootFiles }
}

interface Props {
  notes: NoteEntry[]
  /** null = all notes; '' = top-level files; else dir prefix. */
  selected: string | null
  onSelect: (rel: string | null) => void
}

/** Collapsible directory tree — every level (incl. top) collapses. */
function FolderTree({ notes, selected, onSelect }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const { roots, rootFiles } = useMemo(() => buildTree(notes), [notes])

  const persist = (next: Set<string>): void => {
    try {
      localStorage.setItem(EXPAND_KEY, JSON.stringify([...next]))
    } catch {
      // ignore
    }
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

  const choose = (rel: string | null): void => {
    // Selecting a folder reveals its children.
    if (rel && rel !== '') {
      setCollapsed((prev) => {
        if (!prev.has(rel)) return prev
        const next = new Set(prev)
        next.delete(rel)
        persist(next)
        return next
      })
    }
    onSelect(rel)
  }

  const total = notes.length

  return (
    <div className="ftree" aria-label="Folders">
      <button
        className={`frow all${selected === null ? ' on' : ''}`}
        onClick={() => choose(null)}
      >
        <span className="ficon" aria-hidden>✦</span>
        <span className="fname">All notes</span>
        <span className="fcount">{total}</span>
      </button>
      {roots.map((n) => (
        <Node
          key={n.rel}
          node={n}
          depth={0}
          selected={selected}
          collapsed={collapsed}
          onToggle={toggle}
          onSelect={choose}
        />
      ))}
      {rootFiles > 0 && (
        <button
          className={`frow${selected === '' ? ' on' : ''}`}
          onClick={() => choose('')}
        >
          <span className="ficon" aria-hidden>○</span>
          <span className="fname">Top level</span>
          <span className="fcount">{rootFiles}</span>
        </button>
      )}
    </div>
  )
}

function Node({
  node, depth, selected, collapsed, onToggle, onSelect
}: {
  node: TreeNode
  depth: number
  selected: string | null
  collapsed: Set<string>
  onToggle: (rel: string) => void
  onSelect: (rel: string | null) => void
}): React.JSX.Element {
  const open = !collapsed.has(node.rel)
  const hasKids = node.children.length > 0
  return (
    <div className="fnode">
      <div className={`frow${selected === node.rel ? ' on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          className={`caret${hasKids ? '' : ' leaf'}`}
          onClick={() => hasKids && onToggle(node.rel)}
          aria-label={open ? `Collapse ${node.rel}` : `Expand ${node.rel}`}
          tabIndex={hasKids ? 0 : -1}
        >
          {hasKids ? (open ? '▾' : '▸') : '·'}
        </button>
        <button className="fmain" onClick={() => onSelect(node.rel)}>
          <span className="ficon" aria-hidden>{hasKids ? (open ? '📂' : '📁') : '📄'}</span>
          <span className="fname">{node.name}</span>
          <span className="fcount">{node.count}</span>
        </button>
      </div>
      {hasKids && open && (
        <div className="fkids">
          {node.children.map((c) => (
            <Node
              key={c.rel}
              node={c}
              depth={depth + 1}
              selected={selected}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default memo(FolderTree)
