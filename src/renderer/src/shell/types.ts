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
  /** Group this tab belongs to (a pinned tab renders in the pinned section regardless). */
  group?: string
}

/** A named, coloured, collapsible run of tabs (Obsidian-style: "Work", "Personal", …). */
export interface TabGroup {
  id: string
  name: string
  /** Index into GROUP_COLORS. */
  color: number
  collapsed: boolean
}

/** Group accent colours (same family as the project colours). */
export const GROUP_COLORS = ['#6ea8fe', '#7ee2a8', '#e5a56e', '#c79bfe', '#e5636f', '#6ed3e5']

export const TABS_KEY = 'inkfish.tabs.v1'

export interface TabSession {
  tabs: Tab[]
  activeId: string | null
  groups: TabGroup[]
}

export function loadTabs(): TabSession {
  const empty = { tabs: [] as Tab[], activeId: null, groups: [] as TabGroup[] }
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return empty
    const data = JSON.parse(raw) as {
      tabs?: Tab[]
      activeId?: unknown
      groups?: Array<{ id?: unknown; name?: unknown; color?: unknown; collapsed?: unknown }>
    }
    // Restored sessions: pinned tabs always, plus the ones actually worked on —
    // the strip doesn't refill with every file that was ever glanced at.
    const tabs = Array.isArray(data.tabs)
      ? data.tabs
          .filter((t) => t && typeof t.id === 'string' && typeof t.path === 'string')
          .map((t) => ({
            id: t.id,
            path: t.path,
            pinned: t.pinned === true,
            edited: t.edited === true,
            ...(typeof t.group === 'string' && t.group ? { group: t.group } : {})
          }))
          .filter((t) => t.pinned || t.edited)
          .slice(0, 30)
      : []
    const rawGroups = Array.isArray(data.groups) ? data.groups : []
    const groups = rawGroups
      .filter(
        (g): g is { id: string; name: string; color: number; collapsed: boolean } =>
          g != null && typeof g.id === 'string' && typeof g.name === 'string'
      )
      .map((g) => ({
        id: g.id,
        name: g.name,
        color: typeof g.color === 'number' ? g.color % GROUP_COLORS.length : 0,
        collapsed: g.collapsed === true
      }))
      .slice(0, 24)
    // A group with no surviving member is gone; a tab pointing at a gone group is free.
    const live = groups.filter((g) => tabs.some((t) => t.group === g.id))
    const liveId = new Set(live.map((g) => g.id))
    for (const t of tabs) if (t.group && !liveId.has(t.group)) delete t.group
    return { tabs, activeId: typeof data.activeId === 'string' ? data.activeId : null, groups: live }
  } catch {
    return empty
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
  target: MenuTarget
}

/** A right-clicked tab, the open note, a tree row, or a tab group header. */
export type MenuTarget =
  TreeTarget | { kind: 'open-note' } | { kind: 'tab'; id: string } | { kind: 'group'; id: string }
