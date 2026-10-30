import { sendAiCommand } from '../nativeAi'
import { sendNoteAction } from '../noteAction'
import type { NoteDoc, NoteEntry } from '../../../shared/types'
import { dirOf, type MoveItem } from '../../../shared/note-move'
import type { Anchor } from '../views/DeletePopover'
import type { MenuItem } from '../views/Dialogs'
import type { Selection, Tab, TabGroup, MenuTarget } from './types'

export interface CtxMenuContext {
  tabsRef: React.MutableRefObject<Tab[]>
  allNotesRef: React.MutableRefObject<NoteEntry[]>
  doc: NoteDoc | null
  sel: Selection
  menu?: { x: number; y: number } | null
  titleOf: (e: { id: string; path: string; title: string }) => string
  doCreateFile: (dir: string) => void
  doRename: (rel: string, isDir: boolean) => void
  doTrash: (rel: string, name: string) => void
  startNoteRename: (entry: NoteEntry) => void
  deleteNote: (entry: NoteEntry, anchor: Anchor | null, skipConfirm: boolean) => void
  notify: (msg: string) => void
  refreshNotes: () => void
  togglePin: (id: string) => void
  closeTab: (id: string) => void
  closeOthers: (id: string) => void
  closeUnpinned: () => void
  /** Tab groups: the current groups plus the operations the tab / group-header menus run. */
  groups: TabGroup[]
  createGroup: (tabIds: string[], name?: string) => string | null
  moveTabToGroup: (tabId: string, groupId: string | null) => void
  renameGroup: (groupId: string, name: string) => void
  removeGroup: (groupId: string) => void
  toggleGroup: (groupId: string) => void
  closeGroupTabs: (groupId: string) => void
  popOut: (id: string | null, opts?: { tear?: boolean }) => void
  openMovePicker: (items: MoveItem[], name: string, x?: number, y?: number) => void
  /** The current tree row selection — a menu on a selected row acts on all of it. */
  treeSel: MoveItem[]
  setPrompt: (
    prompt: {
      title: string
      initial: string
      confirm: string
      onSubmit: (v: string) => void
    } | null
  ) => void
  setRevealDir: (dir: string | null) => void
}

/** Right-click menu items for a tree row, the open note, a tab, or a tab group. */
export function buildMenuItems(ctx: CtxMenuContext): (target: MenuTarget) => MenuItem[] {
  const {
    tabsRef,
    allNotesRef,
    doc,
    sel,
    menu,
    titleOf,
    doCreateFile,
    doRename,
    doTrash,
    startNoteRename,
    deleteNote,
    notify,
    refreshNotes,
    togglePin,
    closeTab,
    closeOthers,
    closeUnpinned,
    groups,
    createGroup,
    moveTabToGroup,
    renameGroup,
    removeGroup,
    toggleGroup,
    closeGroupTabs,
    popOut,
    openMovePicker,
    treeSel,
    setPrompt,
    setRevealDir
  } = ctx
  /** A right-click on a row that is part of a multi-selection moves the whole selection. */
  const selItems = (rel: string): MoveItem[] | null =>
    treeSel.length > 1 && treeSel.some((i) => i.rel === rel) ? treeSel : null
  return (target: MenuTarget): MenuItem[] => {
    if (target.kind === 'tab') {
      const tab = tabsRef.current.find((t) => t.id === target.id)
      if (!tab) return []
      const group = tab.group ? groups.find((g) => g.id === tab.group) : undefined
      const suggested = dirOf(tab.path) || `Group ${groups.length + 1}`
      const groupItems: MenuItem[] = [
        {
          label: group ? 'Move to a new group…' : 'New group from this tab…',
          action: () =>
            setPrompt({
              title: group ? `New group (from “${group.name}”)` : 'New group',
              initial: suggested,
              confirm: 'Create',
              onSubmit: (v) => createGroup([tab.id], v || undefined)
            })
        },
        ...groups
          .filter((g) => g.id !== tab.group)
          .map((g): MenuItem => ({ label: `Move to “${g.name}”`, action: () => moveTabToGroup(tab.id, g.id) })),
        ...(group ? [{ label: 'Remove from group', action: () => moveTabToGroup(tab.id, null) }] : [])
      ]
      return [
        { label: 'Pop out to Mini Window  ⌘⇧M', action: () => popOut(tab.id) },
        { label: tab.pinned ? 'Unpin tab' : 'Pin tab', action: () => togglePin(tab.id) },
        { label: 'Close tab', action: () => closeTab(tab.id) },
        { label: 'Close other tabs', action: () => closeOthers(tab.id) },
        { label: 'Close unpinned tabs', action: () => closeUnpinned() },
        ...groupItems
      ]
    }
    if (target.kind === 'group') {
      const group = groups.find((g) => g.id === target.id)
      if (!group) return []
      const memberCount = tabsRef.current.filter((t) => t.group === group.id).length
      return [
        {
          label: `Rename “${group.name}”…`,
          action: () =>
            setPrompt({
              title: 'Rename group',
              initial: group.name,
              confirm: 'Rename',
              onSubmit: (v) => renameGroup(group.id, v)
            })
        },
        { label: group.collapsed ? 'Expand group' : 'Collapse group', action: () => toggleGroup(group.id) },
        ...(memberCount > 0
          ? [{ label: `Close ${memberCount} tabs in group`, action: () => closeGroupTabs(group.id) }]
          : []),
        { label: `Remove group (tabs stay open)`, danger: true, action: () => removeGroup(group.id) }
      ]
    }
    if (target.kind === 'open-note') {
      if (!doc) return []
      // Editor-level actions for any open note; file-level ones for vault notes only.
      const items: MenuItem[] = [
        { label: 'Find in note  ⌘F', action: () => sendNoteAction('find') },
        { label: 'Note history', action: () => sendNoteAction('history') },
        { label: 'Raw / Processed view  ⇧⌥P', action: () => sendAiCommand('toggle-view') },
        { label: 'Process selection…  ⇧⌥S', action: () => sendAiCommand('process-selection') }
      ]
      if (sel?.origin === 'note') {
        const rel = doc.path
        const name = titleOf(doc)
        items.push(
          { label: 'Pop out to Mini Window  ⌘⇧M', action: () => popOut(doc.id) },
          { label: 'Reveal in Finder', action: () => void window.api.files.reveal(rel) },
          { label: 'Move to…', action: () => openMovePicker([{ rel, kind: 'file' }], name, menu?.x, menu?.y) },
          { label: 'Rename…', action: () => startNoteRename(doc) },
          { label: `Delete “${name.slice(0, 32)}”…`, danger: true, action: () => void deleteNote(doc, null, false) }
        )
      }
      return items
    }
    if (target.kind === 'dir') {
      const name = target.name
      const many = selItems(target.rel)
      return [
        { label: 'New file here', action: () => doCreateFile(target.rel) },
        {
          label: 'New subfolder…',
          action: () =>
            setPrompt({
              title: `New folder in ${name}`,
              initial: '',
              confirm: 'Create',
              onSubmit: (v) => {
                window.api.files
                  .mkdir(target.rel, v)
                  .then((rel) => {
                    setRevealDir(rel)
                    notify(`Folder ${v} ✓`)
                    refreshNotes()
                  })
                  .catch((err: unknown) => notify(`Failed: ${err instanceof Error ? err.message : String(err)}`))
              }
            })
        },
        { label: 'Reveal in Finder', action: () => void window.api.files.reveal(target.rel) },
        {
          label: many ? `Move (${many.length}) to…` : 'Move to…',
          action: () => openMovePicker(many ?? [{ rel: target.rel, kind: 'dir' }], name, menu?.x, menu?.y)
        },
        { label: 'Rename…', action: () => doRename(target.rel, true) },
        { label: `Delete “${name}”…`, danger: true, action: () => doTrash(target.rel, name) }
      ]
    }
    const name = target.name
    const many = selItems(target.rel)
    const entry =
      allNotesRef.current.find((n) => n.id === target.id) ?? allNotesRef.current.find((n) => n.path === target.rel)
    return [
      { label: 'Rename  F2', action: () => (entry ? startNoteRename(entry) : doRename(target.rel, false)) },
      { label: 'Reveal in Finder', action: () => void window.api.files.reveal(target.rel) },
      ...(entry ? [{ label: 'Open in Mini Window', action: () => popOut(entry.id) }] : []),
      {
        label: many ? `Move (${many.length}) to…` : 'Move to…',
        action: () => openMovePicker(many ?? [{ rel: target.rel, kind: 'file' }], name, menu?.x, menu?.y)
      },
      {
        label: `Delete “${name.slice(0, 32)}”  ⌘⌫`,
        danger: true,
        action: () => (entry ? void deleteNote(entry, null, false) : doTrash(target.rel, name))
      }
    ]
  }
}
