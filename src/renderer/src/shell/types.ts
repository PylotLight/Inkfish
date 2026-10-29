import type { KindFilter, TreeTarget } from '../views/FolderTree'

export type Selection = { id: string; origin: 'inbox' | 'note' } | null
export type Scope = 'home' | 'notes' | 'inbox' | 'journal'

/** Open-note tab (notes only — inbox docs are ephemeral, never tabbed). */
export interface Tab {
  id: string
  path: string
  pinned: boolean
  /** Changed this session (text or title). Unedited, unpinned tabs drop out on restart. */
  edited: boolean
}

export const TABS_KEY = 'inkfish.tabs.v1'

export function loadTabs(): { tabs: Tab[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return { tabs: [], activeId: null }
    const data = JSON.parse(raw) as { tabs?: Tab[]; activeId?: unknown }
    // Restored sessions: pinned tabs always, plus the ones actually worked on —
    // the strip doesn't refill with every file that was ever glanced at.
    const tabs = Array.isArray(data.tabs)
      ? data.tabs
          .filter((t) => t && typeof t.id === 'string' && typeof t.path === 'string')
          .map((t) => ({ id: t.id, path: t.path, pinned: t.pinned === true, edited: t.edited === true }))
          .filter((t) => t.pinned || t.edited)
          .slice(0, 30)
      : []
    return { tabs, activeId: typeof data.activeId === 'string' ? data.activeId : null }
  } catch {
    return { tabs: [], activeId: null }
  }
}

export const KINDS: Array<{ id: KindFilter; name: string }> = [
  { id: 'all', name: 'All' },
  { id: 'text', name: 'Text' },
  { id: 'voice', name: 'Voice' },
  { id: 'image', name: 'Image' },
  { id: 'meeting', name: 'Meeting' }
]

export interface MenuState {
  x: number
  y: number
  target: TreeTarget | { kind: 'open-note' } | { kind: 'tab'; id: string }
}
