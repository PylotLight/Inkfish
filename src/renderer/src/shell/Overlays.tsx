import { DeletePopover, UndoToast, type Anchor } from '../views/DeletePopover'
import CommandPalette, { type RunnableCommand } from '../views/CommandPalette'
import { ConfirmModal, CtxMenu, PromptModal, type MenuItem } from '../views/Dialogs'
import FolderPicker from '../views/FolderPicker'
import Onboarding from '../views/Onboarding'
import { BrandEasterEgg } from '../views/easter-egg/BrandEasterEgg'
import { dirOf, type MoveItem } from '../../../shared/note-move'
import type { PaletteMode, PaletteNote } from '../../../shared/command-palette'
import type { AppProfileInfo } from '../../../shared/profile'
import type { NoteEntry, SysInfo, VaultInfo } from '../../../shared/types'
import logoUrl from '../assets/logo.png'
import type { MenuState } from './types'

interface Props {
  menu: MenuState | null
  menuItems: (target: MenuState['target']) => MenuItem[]
  setMenu: (menu: MenuState | null) => void
  palette: PaletteMode | null
  paletteCommands: RunnableCommand[]
  paletteNotes: PaletteNote[]
  sys: SysInfo | null
  setPalette: (mode: PaletteMode | null) => void
  popOut: (id: string | null, opts?: { tear?: boolean }) => void
  leaveSettings: () => void
  selectNote: (id: string) => void
  prompt: {
    title: string
    initial: string
    confirm: string
    onSubmit: (v: string) => void
  } | null
  setPrompt: (
    prompt: {
      title: string
      initial: string
      confirm: string
      onSubmit: (v: string) => void
    } | null
  ) => void
  confirm: {
    title: string
    body: string
    confirm: string
    onConfirm: () => void
  } | null
  setConfirm: (
    confirm: {
      title: string
      body: string
      confirm: string
      onConfirm: () => void
    } | null
  ) => void
  showOnboarding: boolean
  ostep: number
  setOstep: (n: number) => void
  vaultInfo: VaultInfo | null
  profile: AppProfileInfo | null
  onVaultReady: (v: VaultInfo) => void
  setShowOnboarding: (v: boolean) => void
  notify: (msg: string) => void
  movePick: { items: MoveItem[]; name: string; x: number; y: number } | null
  folderList: string[]
  setMovePick: (m: { items: MoveItem[]; name: string; x: number; y: number } | null) => void
  doMove: (rel: string, kind: 'file' | 'dir', dest: string) => Promise<void>
  doMoveMany: (items: MoveItem[], dest: string) => Promise<void>
  delAsk: { entry: NoteEntry; title: string; lines: string[]; anchor: Anchor } | null
  setDelAsk: (d: { entry: NoteEntry; title: string; lines: string[]; anchor: Anchor } | null) => void
  trashWithUndo: (rel: string, title: string) => Promise<void>
  rowEl: (id: string) => HTMLElement | null
  undoDel: { key: number; message: string; trashId: string; rel: string; wasOpen: boolean } | null
  closeUndo: () => void
  undoTrash: (u: { trashId: string; rel: string; wasOpen: boolean }) => Promise<void>
  toast: string | null
  brandEgg: { open: boolean; close: () => void }
}

export default function Overlays({
  menu,
  menuItems,
  setMenu,
  palette,
  paletteCommands,
  paletteNotes,
  sys,
  setPalette,
  popOut,
  leaveSettings,
  selectNote,
  prompt,
  setPrompt,
  confirm,
  setConfirm,
  showOnboarding,
  ostep,
  setOstep,
  vaultInfo,
  profile,
  onVaultReady,
  setShowOnboarding,
  notify,
  movePick,
  folderList,
  setMovePick,
  doMove,
  doMoveMany,
  delAsk,
  setDelAsk,
  trashWithUndo,
  rowEl,
  undoDel,
  closeUndo,
  undoTrash,
  toast,
  brandEgg
}: Props): React.JSX.Element {
  return (
    <>
      {menu && <CtxMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}
      {palette && (
        <CommandPalette
          mode={palette}
          commands={paletteCommands}
          notes={paletteNotes}
          platform={sys?.platform ?? 'darwin'}
          onClose={() => setPalette(null)}
          onOpenNote={(id, pop) => {
            if (pop) popOut(id)
            else {
              leaveSettings()
              selectNote(id)
            }
          }}
        />
      )}
      {prompt && (
        <PromptModal
          title={prompt.title}
          initial={prompt.initial}
          placeholder={prompt.title}
          confirmLabel={prompt.confirm}
          onSubmit={prompt.onSubmit}
          onClose={() => setPrompt(null)}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirm}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {showOnboarding && (
        <Onboarding
          step={ostep}
          setStep={setOstep}
          vault={vaultInfo}
          profile={profile}
          onVaultReady={onVaultReady}
          onDone={() => setShowOnboarding(false)}
          notify={notify}
        />
      )}
      {movePick && (
        <FolderPicker
          title={
            movePick.items.length > 1
              ? `Move ${movePick.items.length} items to…`
              : `Move “${movePick.name.slice(0, 40)}” to…`
          }
          folders={
            movePick.items.length > 1
              ? // Never offer a destination inside one of the selected folders.
                folderList.filter((f) =>
                  !movePick.items.some((it) => it.kind === 'dir' && (f === it.rel || f.startsWith(`${it.rel}/`)))
                )
              : movePick.items[0]!.kind === 'dir'
                ? folderList.filter((f) => f !== movePick.items[0]!.rel && !f.startsWith(`${movePick.items[0]!.rel}/`))
                : folderList
          }
          current={movePick.items.length === 1 ? dirOf(movePick.items[0]!.rel) : undefined}
          x={movePick.x}
          y={movePick.y}
          onPick={(dir) => {
            const m = movePick
            setMovePick(null)
            const first = m.items[0]
            if (!first) return
            if (m.items.length === 1) void doMove(first.rel, first.kind, dir)
            else void doMoveMany(m.items, dir)
          }}
          onClose={() => setMovePick(null)}
        />
      )}
      {delAsk && (
        <DeletePopover
          anchor={delAsk.anchor}
          title={delAsk.title}
          path={delAsk.entry.path}
          lines={delAsk.lines}
          size={delAsk.entry.size}
          updatedAt={delAsk.entry.updatedAt}
          onConfirm={() => {
            const d = delAsk
            setDelAsk(null)
            void trashWithUndo(d.entry.path, d.title)
          }}
          onCancel={() => {
            const id = delAsk.entry.id
            setDelAsk(null)
            window.setTimeout(() => rowEl(id)?.querySelector<HTMLButtonElement>('.filerow')?.focus(), 0)
          }}
        />
      )}
      {undoDel && !toast && (
        <UndoToast
          key={undoDel.key}
          message={undoDel.message}
          onClose={closeUndo}
          onUndo={() => void undoTrash(undoDel)}
        />
      )}
      {toast && <div className="toast glass">{toast}</div>}
      {brandEgg.open && <BrandEasterEgg logoUrl={logoUrl} onClose={brandEgg.close} />}
    </>
  )
}
