import { sendAiCommand } from '../nativeAi'
import type { NoteDoc, NoteEntry } from '../../../shared/types'
import type { MoveKind } from '../../../shared/note-move'
import type { Anchor } from '../views/DeletePopover'
import type { MenuItem } from '../views/Dialogs'
import type { TreeTarget } from '../views/FolderTree'
import type { Selection, Tab } from './types'

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
  popOut: (id: string | null, opts?: { tear?: boolean }) => void
  openMovePicker: (rel: string, kind: MoveKind, name: string, x?: number, y?: number) => void
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

/** Right-click menu items for a tree row, the open note, or a tab. */
export function buildMenuItems(
  ctx: CtxMenuContext
): (target: TreeTarget | { kind: 'open-note' } | { kind: 'tab'; id: string }) => MenuItem[] {
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
    popOut,
    openMovePicker,
    setPrompt,
    setRevealDir
  } = ctx
  return (target: TreeTarget | { kind: 'open-note' } | { kind: 'tab'; id: string }): MenuItem[] => {
    if (target.kind === 'tab') {
      const tab = tabsRef.current.find((t) => t.id === target.id)
      if (!tab) return []
      return [
        { label: 'Pop out to Mini Window  ⌘⇧M', action: () => popOut(tab.id) },
        { label: tab.pinned ? 'Unpin tab' : 'Pin tab', action: () => togglePin(tab.id) },
        { label: 'Close tab', action: () => closeTab(tab.id) },
        { label: 'Close other tabs', action: () => closeOthers(tab.id) },
        { label: 'Close unpinned tabs', action: () => closeUnpinned() }
      ]
    }
    if (target.kind === 'open-note') {
      if (!doc || sel?.origin !== 'note') return []
      const rel = doc.path
      const name = titleOf(doc)
      return [
        { label: 'Pop out to Mini Window  ⌘⇧M', action: () => popOut(doc.id) },
        { label: 'Raw / Processed view  ⇧⌥P', action: () => sendAiCommand('toggle-view') },
        { label: 'Process selection…  ⇧⌥S', action: () => sendAiCommand('process-selection') },
        { label: 'Reveal in Finder', action: () => void window.api.files.reveal(rel) },
        { label: 'Move to…', action: () => openMovePicker(rel, 'file', name, menu?.x, menu?.y) },
        { label: 'Rename…', action: () => startNoteRename(doc) },
        { label: `Delete “${name.slice(0, 32)}”…`, danger: true, action: () => void deleteNote(doc, null, false) }
      ]
    }
    if (target.kind === 'dir') {
      const name = target.name
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
        { label: 'Move to…', action: () => openMovePicker(target.rel, 'dir', name, menu?.x, menu?.y) },
        { label: 'Rename…', action: () => doRename(target.rel, true) },
        { label: `Delete “${name}”…`, danger: true, action: () => doTrash(target.rel, name) }
      ]
    }
    const name = target.name
    const entry =
      allNotesRef.current.find((n) => n.id === target.id) ?? allNotesRef.current.find((n) => n.path === target.rel)
    return [
      { label: 'Rename  F2', action: () => (entry ? startNoteRename(entry) : doRename(target.rel, false)) },
      { label: 'Reveal in Finder', action: () => void window.api.files.reveal(target.rel) },
      ...(entry ? [{ label: 'Open in Mini Window', action: () => popOut(entry.id) }] : []),
      { label: 'Move to…', action: () => openMovePicker(target.rel, 'file', name, menu?.x, menu?.y) },
      {
        label: `Delete “${name.slice(0, 32)}”  ⌘⌫`,
        danger: true,
        action: () => (entry ? void deleteNote(entry, null, false) : doTrash(target.rel, name))
      }
    ]
  }
}
