import type { InboxItem, NoteDoc, NoteEntry, Project, SysInfo, VaultInfo } from '../../../shared/types'
import type { MoveItem } from '../../../shared/note-move'
import type { DayRef } from '../../../shared/journal'
import { draftForEditor } from '../../../shared/autosave'
import { isTitleSyncPath } from '../../../shared/title-sync'
import type { Prefs } from '../theme'
import type { MenuState, Scope, Selection, Tab } from './types'
import TabBar from './TabBar'
import InboxBar from './InboxBar'
import Home from '../views/Home'
import Journal from '../views/Journal'
import NoteEditor from '../views/NoteEditor'
import Meetings from '../views/Meetings'
import SettingsView from '../views/Settings'
import { Icon } from '../views/icons'

interface Props {
  sideCollapsed: boolean
  meetingLive: boolean
  showMeeting: boolean
  leaveSettings: () => void
  setShowMeeting: (v: boolean) => void
  settingsOpen: boolean
  settingsNonce: number
  prefs: Prefs
  sys: SysInfo | null
  vaultInfo: VaultInfo | null
  backend: string
  setPrefs: (prefs: Prefs) => void
  setSettingsOpen: (v: boolean) => void
  setScope: (s: Scope) => void
  settingsReturn: Scope
  setOstep: (n: number) => void
  setShowOnboarding: (v: boolean) => void
  notify: (msg: string) => void
  refreshAll: () => void
  setBackend: (b: string) => void
  scope: Scope
  captureKey: string
  finalNotes: NoteEntry[]
  inbox: InboxItem[]
  todayEntry: NoteEntry | null
  journalDays: Array<DayRef<NoteEntry>>
  openJournal: () => void
  titleOf: (e: { id: string; path: string; title: string }) => string
  selectNote: (id: string) => void
  pickScope: (s: Scope) => void
  openToday: () => Promise<void>
  setTargetDir: (dir: string) => void
  setRevealDir: (dir: string | null) => void
  focusEndOn: (id: string) => void
  tabs: Tab[]
  allNotes: NoteEntry[]
  titles: Record<string, string>
  sel: Selection
  openEntry: (id: string, origin: 'inbox' | 'note') => void
  closeTab: (id: string) => void
  togglePin: (id: string) => void
  onReorder: (id: string, insertAt: number) => void
  setMenu: (menu: MenuState) => void
  doCreateFile: (dir: string) => void
  targetDir: string
  popOut: (id: string | null, opts?: { tear?: boolean }) => void
  popTitle: string
  activeItem: InboxItem | null
  projects: Project[]
  deleteInbox: (id: string) => void
  doc: NoteDoc | null
  drafts: Record<string, string>
  handleDraft: (id: string, markdown: string) => void
  flushAll: () => Promise<void>
  renameNote: (id: string, title: string) => void
  onEditorBlur: () => void
  dayNav: { onPrev: (() => void) | null; onNext: (() => void) | null; prevLabel?: string; nextLabel?: string } | null
  focusEnd: { id: string; token: number } | null
  openMovePicker: (items: MoveItem[], name: string, x: number, y: number) => void
  setNoteTags: (tags: string[]) => void
  setSideCollapsed: (update: boolean | ((v: boolean) => boolean)) => void
  setQuery: (q: string) => void
  allTags: string[]
  setMeetingLive: (v: boolean) => void
}

export default function Center({
  sideCollapsed,
  meetingLive,
  showMeeting,
  leaveSettings,
  setShowMeeting,
  settingsOpen,
  settingsNonce,
  prefs,
  sys,
  vaultInfo,
  backend,
  setPrefs,
  setSettingsOpen,
  setScope,
  settingsReturn,
  setOstep,
  setShowOnboarding,
  notify,
  refreshAll,
  setBackend,
  scope,
  captureKey,
  finalNotes,
  inbox,
  todayEntry,
  journalDays,
  openJournal,
  titleOf,
  selectNote,
  pickScope,
  openToday,
  setTargetDir,
  setRevealDir,
  focusEndOn,
  tabs,
  allNotes,
  titles,
  sel,
  openEntry,
  closeTab,
  togglePin,
  onReorder,
  setMenu,
  doCreateFile,
  targetDir,
  popOut,
  popTitle,
  activeItem,
  projects,
  deleteInbox,
  doc,
  drafts,
  handleDraft,
  flushAll,
  renameNote,
  onEditorBlur,
  dayNav,
  focusEnd,
  openMovePicker,
  setNoteTags,
  setSideCollapsed,
  setQuery,
  allTags,
  setMeetingLive
}: Props): React.JSX.Element {
  return (
    <>
      <div className="content inkfish center">
        {/* Window drag strip along the top; while collapsed it also carries the live-recording
            chip (the toggle itself is the fixed .titlebar-toggle above). */}
        <div className="side-rail" aria-hidden={!sideCollapsed || undefined}>
          {sideCollapsed && meetingLive && !showMeeting && (
            <button
              className="side-toggle rail-chip rec-live"
              onClick={() => {
                leaveSettings()
                setShowMeeting(true)
              }}
              title="Meeting recording — open it"
            >
              <Icon name="record" size={12} /> Recording
            </button>
          )}
        </div>
        {settingsOpen ? (
          <main className="view-scroll" aria-label="Settings">
            <SettingsView
              key={settingsNonce}
              prefs={prefs}
              vibrancySupported={sys?.platform === 'darwin'}
              vault={vaultInfo}
              sys={sys}
              backend={backend}
              onChange={setPrefs}
              onBack={() => {
                setSettingsOpen(false)
                setScope(settingsReturn)
              }}
              onPickVault={() => {
                setSettingsOpen(false)
                setOstep(0)
                setShowOnboarding(true)
              }}
              onRescan={() =>
                window.api.vault
                  .reindex()
                  .then((r) => {
                    setBackend(r.backend)
                    refreshAll()
                    notify(`Re-indexed ${r.indexed} notes`)
                  })
                  .catch((err: unknown) => notify(`Reindex failed: ${String(err)}`))
              }
              notify={notify}
            />
          </main>
        ) : showMeeting ? null : (
          <>
            {scope === 'home' ? (
              <main className="view-scroll" aria-label="Home">
                <Home
                  captureKey={captureKey}
                  notes={finalNotes}
                  inbox={inbox}
                  today={todayEntry}
                  days={journalDays}
                  onOpenJournal={openJournal}
                  titleOf={titleOf}
                  onOpenNote={selectNote}
                  onOpenInbox={() => pickScope('inbox')}
                  onOpenToday={() => void openToday()}
                  onTodayAppended={refreshAll}
                  onOpenFolder={(rel) => {
                    if (rel) {
                      setTargetDir(rel)
                      setRevealDir(rel)
                    }
                    setScope('notes')
                  }}
                  notify={notify}
                />
              </main>
            ) : scope === 'journal' ? (
              <main className="view-scroll" aria-label="Journal">
                <Journal
                  days={journalDays}
                  onOpen={(id) => {
                    selectNote(id)
                    focusEndOn(id)
                  }}
                  onOpenToday={() => void openToday()}
                />
              </main>
            ) : (
              <main className="note-stage" aria-label="Note">
                <TabBar
                  tabs={tabs}
                  activeId={sel?.origin === 'note' ? sel.id : null}
                  allNotes={allNotes}
                  titles={titles}
                  titleOf={titleOf}
                  onActivate={(id) => openEntry(id, 'note')}
                  onClose={closeTab}
                  onTogglePin={togglePin}
                  onReorder={onReorder}
                  onMenu={(id, x, y) => setMenu({ x, y, target: { kind: 'tab', id } })}
                  onNew={() => doCreateFile(targetDir)}
                  onPopOut={(id) => popOut(id)}
                  onTearOut={(id) => popOut(id, { tear: true })}
                  popTitle={popTitle}
                />
                {sel?.origin === 'inbox' && activeItem && (
                  <InboxBar
                    item={activeItem}
                    projects={projects}
                    onDelete={() => deleteInbox(activeItem.id)}
                    onDone={(noteId) => {
                      refreshAll()
                      if (noteId) selectNote(noteId)
                    }}
                    notify={notify}
                  />
                )}
                <NoteEditor
                  doc={doc}
                  title={doc ? titleOf(doc) : ''}
                  draft={draftForEditor(doc, drafts)}
                  onDraft={handleDraft}
                  onFlush={() => void flushAll()}
                  onRename={(t) => {
                    if (doc) renameNote(doc.id, t)
                  }}
                  renameHint={
                    prefs.nameFromTitle && sel?.origin === 'note' && doc && isTitleSyncPath(doc.path)
                      ? 'Click to rename — renames the file'
                      : 'Click to rename (display title only, file untouched)'
                  }
                  onEditorBlur={onEditorBlur}
                  notify={notify}
                  {...(dayNav
                    ? {
                        dayNav: {
                          onPrev: dayNav.onPrev,
                          onNext: dayNav.onNext,
                          prevLabel: dayNav.prevLabel,
                          nextLabel: dayNav.nextLabel
                        }
                      }
                    : {})}
                  focusEnd={focusEnd}
                  onMore={(x, y) => setMenu({ x, y, target: { kind: 'open-note' } })}
                  onPopOut={sel?.origin === 'note' ? () => popOut(sel.id) : undefined}
                  popOutTitle={popTitle}
                  {...(sel?.origin === 'note' && doc && !doc.path.startsWith('inbox/') && !doc.path.startsWith('daily/')
                    ? {
                        onMoveClick: (x: number, y: number) =>
                          openMovePicker([{ rel: doc.path, kind: 'file' }], titleOf(doc), x, y),
                        onSetTags: (t: string[]) => void setNoteTags(t),
                        onTagClick: (t: string) => {
                          setSideCollapsed(false)
                          setQuery(`#${t}`)
                        },
                        allTags
                      }
                    : {})}
                />
              </main>
            )}
          </>
        )}
        {(showMeeting || meetingLive) && (
          <main className="view-scroll" aria-label="Meetings" hidden={!showMeeting || settingsOpen}>
            <Meetings
              notes={finalNotes}
              titleOf={titleOf}
              onOpenNote={(id) => {
                setShowMeeting(false)
                selectNote(id)
              }}
              onRefresh={refreshAll}
              onClose={() => setShowMeeting(false)}
              onRecording={setMeetingLive}
              notify={notify}
            />
          </main>
        )}
      </div>
    </>
  )
}
