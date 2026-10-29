import type { MouseEventHandler } from 'react'
import { APP_NAME } from '../../../shared/config'
import logoUrl from '../assets/logo.png'
import type { InboxItem, NoteEntry, NoteKind, Project, SysInfo, VaultInfo } from '../../../shared/types'
import type { KindFilter, RowActions } from '../views/FolderTree'
import FolderTree from '../views/FolderTree'
import InboxQueue from '../views/InboxQueue'
import SyncBadge from '../views/SyncBadge'
import { Icon } from '../views/icons'
import { vaultLabel, vaultTooltip } from '../../../shared/sidebar'
import type { MoveItem } from '../../../shared/note-move'
import { KINDS, type MenuState, type Scope, type Selection } from './types'

interface Props {
  sideCollapsed: boolean
  setSideCollapsed: (update: boolean | ((v: boolean) => boolean)) => void
  scope: Scope
  setScope: (scope: Scope) => void
  settingsOpen: boolean
  showMeeting: boolean
  meetingLive: boolean
  pendingCount: number
  updateBadge: boolean
  isMacUi: boolean
  profile: { badge?: string; name: string } | null
  onBrandEggClick: MouseEventHandler<HTMLDivElement>
  query: string
  setQuery: (q: string) => void
  pickScope: (s: Scope) => void
  openToday: () => void
  openJournal: () => void
  leaveSettings: () => void
  openSettings: () => void
  openSettingsAt: (tab: string) => void
  setShowMeeting: (v: boolean) => void
  inbox: InboxItem[]
  projects: Project[]
  sel: Selection
  selectInbox: (id: string) => void
  deleteInbox: (id: string) => void
  refreshAll: () => void
  notify: (msg: string) => void
  captureKey: string
  finalNotes: NoteEntry[]
  dirs: string[]
  kind: KindFilter
  setKind: (k: KindFilter) => void
  titleOf: (n: NoteEntry) => string
  results: NoteEntry[] | null
  revealDir: string | null
  selectNote: (id: string) => void
  pickDir: (rel: string) => void
  setMenu: (menu: MenuState) => void
  doCreateFile: (dir: string) => void
  doCreateFolder: () => void
  targetDir: string
  doMove: (rel: string, kind: 'file' | 'dir', dest: string) => void
  doMoveMany: (items: MoveItem[], dest: string) => void
  onTreeSelChange: (items: MoveItem[]) => void
  rowActions: RowActions
  kindsPresent: number
  kindCounts: Map<NoteKind, number>
  openPath: string | null
  vaultInfo: VaultInfo | null
  sys: SysInfo | null
}

export default function Sidebar({
  sideCollapsed,
  setSideCollapsed,
  scope,
  setScope,
  settingsOpen,
  showMeeting,
  meetingLive,
  pendingCount,
  updateBadge,
  isMacUi,
  profile,
  onBrandEggClick,
  query,
  setQuery,
  pickScope,
  openToday,
  openJournal,
  leaveSettings,
  openSettings,
  openSettingsAt,
  setShowMeeting,
  inbox,
  projects,
  sel,
  selectInbox,
  deleteInbox,
  refreshAll,
  notify,
  captureKey,
  finalNotes,
  dirs,
  kind,
  setKind,
  titleOf,
  results,
  revealDir,
  selectNote,
  pickDir,
  setMenu,
  doCreateFile,
  doCreateFolder,
  targetDir,
  doMove,
  doMoveMany,
  onTreeSelChange,
  rowActions,
  kindsPresent,
  kindCounts,
  openPath,
  vaultInfo,
  sys
}: Props): React.JSX.Element {
  return (
    <>
      {/* Sidebar toggle (Obsidian-style): pinned in the titlebar strip right of the traffic lights
           while the sidebar is open, hidden while collapsed (the ribbon's first icon then takes
           over as the expand affordance). Fixed + no-drag (shared/sidebar.ts). */}
      <button
        className="side-toggle titlebar-toggle"
        onClick={() => setSideCollapsed((v) => !v)}
        title={`${sideCollapsed ? 'Show' : 'Hide'} sidebar (${isMacUi ? '⌘\\' : 'Ctrl+\\'})`}
        aria-label={sideCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-expanded={!sideCollapsed}
        aria-pressed={!sideCollapsed}
      >
        <Icon name="panel-left" size={18} />
      </button>

      {/* Collapsed: slim icon ribbon so the app stays navigable without the full sidebar. */}
      {sideCollapsed && (
        <nav className="side-ribbon" aria-label="Navigation">
          <button
            className="ribbon-btn"
            title={`Show sidebar (${isMacUi ? '⌘\\' : 'Ctrl+\\'})`}
            aria-label="Show sidebar"
            aria-expanded={false}
            onClick={() => setSideCollapsed(false)}
          >
            <Icon name="panel-left" size={24} />
          </button>
          <button
            className="ribbon-btn"
            title={`Search notes (${isMacUi ? '⌘\\' : 'Ctrl+\\'} shows the sidebar)`}
            aria-label="Search notes"
            onClick={() => {
              setSideCollapsed(false)
              if (scope !== 'notes') setScope('notes')
              setTimeout(() => document.querySelector<HTMLInputElement>('.side-search')?.focus(), 0)
            }}
          >
            <Icon name="search" size={24} />
          </button>
          {(['home', 'notes', 'inbox'] as Scope[]).map((s) => {
            const on = scope === s && !settingsOpen && !showMeeting
            return (
              <button
                key={s}
                className={`ribbon-btn${on ? ' on' : ''}`}
                title={
                  s === 'home'
                    ? 'Home'
                    : s === 'notes'
                      ? 'Notes'
                      : `Inbox${pendingCount > 0 ? ` (${pendingCount})` : ''}`
                }
                aria-label={s === 'home' ? 'Home' : s === 'notes' ? 'Notes' : 'Inbox'}
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  leaveSettings()
                  setShowMeeting(false)
                  pickScope(s)
                  // The inbox queue lives in the sidebar — bring it back to show it.
                  if (s === 'inbox') setSideCollapsed(false)
                }}
              >
                <Icon name={s} size={24} />
                {s === 'inbox' && pendingCount > 0 && <span className="ribbon-dot" aria-hidden />}
              </button>
            )
          })}
          <span className="ribbon-sep" aria-hidden />
          <button
            className="ribbon-btn"
            title={`Today's note (${isMacUi ? '⌘⇧D' : 'Ctrl+Shift+D'})`}
            aria-label="Today's note"
            onClick={() => {
              leaveSettings()
              void openToday()
            }}
          >
            <Icon name="sun" size={24} />
          </button>
          <button
            className={`ribbon-btn${scope === 'journal' && !settingsOpen && !showMeeting ? ' on' : ''}`}
            title={`Journal (${isMacUi ? '⌘⇧J' : 'Ctrl+Shift+J'})`}
            aria-label="Journal"
            aria-current={scope === 'journal' && !settingsOpen && !showMeeting ? 'page' : undefined}
            onClick={openJournal}
          >
            <Icon name="journal" size={24} />
          </button>
          <button
            className={`ribbon-btn${showMeeting && !settingsOpen ? ' on' : ''}${meetingLive ? ' rec-live' : ''}`}
            title={meetingLive ? 'Meeting recording — open it' : 'Meetings: record & transcribe a call'}
            aria-label={meetingLive ? 'Recording' : 'Meetings'}
            aria-pressed={showMeeting && !settingsOpen}
            onClick={() => {
              leaveSettings()
              setShowMeeting(true)
            }}
          >
            <Icon name={meetingLive ? 'record' : 'mic'} size={24} />
          </button>
          <span className="flex-sp" />
          <button
            className={`ribbon-btn${settingsOpen ? ' on' : ''}`}
            title="Settings"
            aria-label="Settings"
            onClick={openSettings}
          >
            <Icon name="settings" size={24} />
            {updateBadge && <span className="ribbon-dot" aria-label="Update available" />}
          </button>
        </nav>
      )}

      {/* Core sidebar: search, scopes, dir tree with files, kind filters. */}
      <aside className="sidebar core" inert={sideCollapsed} aria-hidden={sideCollapsed || undefined}>
        {/* Titlebar strip: window drag handle; the toggle floats over its left end. */}
        <div className="side-head">
          <span className="flex-sp" />
          {profile?.badge && (
            <span
              className="pill profile-pill"
              title={`Separate ${profile.name} profile — its own settings, notes folder and sync`}
            >
              {profile.badge}
            </span>
          )}
          {/* Psst: triple-click the logo (views/easter-egg). */}
          <div className="brand-logo-frame" onClick={onBrandEggClick} title={APP_NAME}>
            <img src={logoUrl} alt={APP_NAME} className="brand-logo-img" draggable={false} />
          </div>
        </div>

        <div className="side-search-wrap">
          <Icon name="search" size={15} className="side-search-icon" />
          <input
            className="search side-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (scope !== 'notes') setScope('notes')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
            placeholder="Search notes…"
            aria-label="Search notes"
            spellCheck={false}
          />
        </div>

        <div className="scope-tabs" role="tablist" aria-label="Sidebar scope">
          {(['home', 'notes', 'inbox'] as Scope[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              className={scope === s ? 'on' : ''}
              onClick={() => pickScope(s)}
            >
              {s === 'home' ? 'Home' : s === 'notes' ? 'Notes' : 'Inbox'}
              {s === 'inbox' && pendingCount > 0 && <span className="badge">{pendingCount}</span>}
            </button>
          ))}
        </div>

        {/* Day-log + meetings live here (not above the note) so the doc gets the full pane. */}
        <div className="side-actions" role="toolbar" aria-label="Quick actions">
          <button
            className="side-action"
            title={`Open today's note (${isMacUi ? '⌘⇧D' : 'Ctrl+Shift+D'}) · ${captureKey || 'quick capture'} → Today adds a timestamped line here`}
            onClick={() => {
              leaveSettings()
              void openToday()
            }}
          >
            <Icon name="sun" size={16} /> Today
          </button>
          <button
            className={`side-action${scope === 'journal' && !settingsOpen && !showMeeting ? ' on' : ''}`}
            title={`Journal: every daily note in one timeline (${isMacUi ? '⌘⇧J' : 'Ctrl+Shift+J'})`}
            aria-pressed={scope === 'journal' && !settingsOpen && !showMeeting}
            onClick={openJournal}
          >
            <Icon name="journal" size={16} /> Journal
          </button>
          <button
            className={`side-action${showMeeting && !settingsOpen ? ' on' : ''}${meetingLive ? ' rec-live' : ''}`}
            title={meetingLive ? 'Meeting recording — open it' : 'Meetings: record & transcribe a call'}
            aria-pressed={showMeeting && !settingsOpen}
            onClick={() => {
              leaveSettings()
              setShowMeeting(true)
            }}
          >
            <Icon name={meetingLive ? 'record' : 'mic'} size={16} /> {meetingLive ? 'Recording' : 'Meetings'}
          </button>
        </div>

        {scope === 'inbox' ? (
          <div className="side-scroll">
            <InboxQueue
              items={inbox}
              projects={projects}
              selectedId={sel !== null && sel.origin === 'inbox' ? sel.id : null}
              onSelect={selectInbox}
              onDelete={deleteInbox}
              onRefresh={refreshAll}
              notify={notify}
            />
          </div>
        ) : (
          <div className="side-scroll">
            <FolderTree
              captureKey={captureKey}
              notes={finalNotes}
              dirs={dirs}
              kind={kind}
              titleOf={titleOf}
              selectedId={sel?.origin === 'note' ? sel.id : null}
              selectedPath={openPath}
              results={results}
              revealDir={revealDir}
              onOpenFile={selectNote}
              onPickDir={pickDir}
              onMenu={(target, x, y) => setMenu({ x, y, target })}
              onNewNote={() => doCreateFile(targetDir)}
              onNewFolder={doCreateFolder}
              targetDir={targetDir}
              onMove={(rel, k, dest) => void doMove(rel, k, dest)}
              onMoveMany={(items, dest) => void doMoveMany(items, dest)}
              onSelectionChange={onTreeSelChange}
              rowActions={rowActions}
              filters={
                // Only worth a row when there is something to filter between (or a filter is on).
                kindsPresent > 1 || kind !== 'all' ? (
                  <div className="chips kinds" aria-label="Filter by kind">
                    {KINDS.filter(
                      (k) => k.id === 'all' || (kindCounts.get(k.id as NoteKind) ?? 0) > 0 || kind === k.id
                    ).map((k) => (
                      <button
                        key={k.id}
                        className={kind === k.id ? 'on' : ''}
                        onClick={() => {
                          setKind(k.id)
                          setScope('notes')
                        }}
                        title={
                          k.id === 'all'
                            ? `${finalNotes.length} notes`
                            : `${kindCounts.get(k.id as NoteKind) ?? 0} ${k.name.toLowerCase()} notes`
                        }
                      >
                        {k.name}
                        <span className="count">
                          {k.id === 'all' ? finalNotes.length : (kindCounts.get(k.id as NoteKind) ?? 0)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null
              }
            />
          </div>
        )}

        {/* Obsidian-style bottom vault bar: vault chip left, equal icon buttons right. Version
            rides in the chip tooltip (and Settings › About) to keep the row quiet. */}
        <div className="side-foot">
          <button
            className="vault-chip"
            onClick={() => void window.api.vault.reveal()}
            title={vaultTooltip(vaultInfo?.root, sys?.appVersion)}
            aria-label={`Open vault folder ${vaultLabel(vaultInfo?.root)}`}
          >
            <Icon name="folder" size={14} />
            <span className="vault-name">{vaultLabel(vaultInfo?.root)}</span>
          </button>
          <div className="foot-actions">
            <SyncBadge onOpen={() => openSettingsAt('sync')} />
            <button
              className="foot-btn"
              onClick={openSettings}
              title={updateBadge ? 'Settings — update available' : 'Settings'}
              aria-label="Settings"
            >
              <Icon name="settings" size={16} />
              {updateBadge && <span className="update-dot" aria-label="Update available" />}
            </button>
            <button
              className="foot-btn quit"
              onClick={() => void window.api.app.quit()}
              title="Quit Inkfish"
              aria-label="Quit Inkfish"
            >
              <Icon name="power" size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
