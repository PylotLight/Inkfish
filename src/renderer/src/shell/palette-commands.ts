import { sendAiCommand } from '../nativeAi'
import type { NoteDoc } from '../../../shared/types'
import type { RunnableCommand } from '../views/CommandPalette'
import type { Scope, Tab } from './types'

export interface PaletteCommandContext {
  leaveSettings: () => void
  doCreateFile: (dir: string) => void
  targetDir: string
  doCreateFolder: () => void
  openToday: () => Promise<void>
  openJournal: () => void
  dayNav: { onPrev: (() => void) | null; onNext: (() => void) | null } | null
  setSideCollapsed: (update: boolean | ((v: boolean) => boolean)) => void
  openPath: string | null
  doRename: (rel: string, isDir: boolean) => void
  doc: NoteDoc | null
  openMovePicker: (rel: string, kind: 'file' | 'dir', name: string, x?: number, y?: number) => void
  titleOf: (e: { id: string; path: string; title: string }) => string
  setQuery: (q: string) => void
  setBackend: (b: string) => void
  refreshAll: () => void
  notify: (msg: string) => void
  pickScope: (s: Scope) => void
  meetingLive: boolean
  setShowMeeting: (v: boolean) => void
  showMeeting: boolean
  activeNoteId: string | null
  popOut: (id: string | null, opts?: { tear?: boolean }) => void
  activeTab: Tab | null
  tabs: Tab[]
  closeTab: (id: string) => void
  closeOthers: (id: string) => void
  togglePin: (id: string) => void
  openSettingsAt: (tab: string) => void
}

/** Every ⌘K command, built from the current workspace state. */
export function buildPaletteCommands(ctx: PaletteCommandContext): RunnableCommand[] {
  const {
    leaveSettings,
    doCreateFile,
    targetDir,
    doCreateFolder,
    openToday,
    openJournal,
    dayNav,
    setSideCollapsed,
    openPath,
    doRename,
    doc,
    openMovePicker,
    titleOf,
    setQuery,
    setBackend,
    refreshAll,
    notify,
    pickScope,
    meetingLive,
    setShowMeeting,
    showMeeting,
    activeNoteId,
    popOut,
    activeTab,
    tabs,
    closeTab,
    closeOthers,
    togglePin,
    openSettingsAt
  } = ctx

  return [
    {
      id: 'new-note',
      title: 'New Note',
      section: 'Notes',
      keywords: ['create', 'file', 'add'],
      run: () => {
        leaveSettings()
        doCreateFile(targetDir)
      }
    },
    {
      id: 'new-folder',
      title: 'New Folder',
      section: 'Notes',
      keywords: ['create', 'directory'],
      run: () => {
        leaveSettings()
        doCreateFolder()
      }
    },
    {
      id: 'today',
      title: "Open Today's Note",
      section: 'Notes',
      accelerator: 'CmdOrCtrl+Shift+D',
      keywords: ['daily', 'journal', 'day-log', 'today'],
      run: () => {
        leaveSettings()
        void openToday()
      }
    },
    {
      id: 'journal',
      title: 'Open Journal',
      section: 'Notes',
      accelerator: 'CmdOrCtrl+Shift+J',
      keywords: ['daily', 'journal', 'days', 'diary', 'log', 'calendar', 'history'],
      run: () => openJournal()
    },
    {
      id: 'day-prev',
      title: 'Previous Day Note',
      section: 'Notes',
      keywords: ['daily', 'yesterday', 'journal', 'back'],
      enabled: !!dayNav?.onPrev,
      run: () => {
        leaveSettings()
        dayNav?.onPrev?.()
      }
    },
    {
      id: 'day-next',
      title: 'Next Day Note',
      section: 'Notes',
      keywords: ['daily', 'tomorrow', 'journal', 'forward'],
      enabled: !!dayNav?.onNext,
      run: () => {
        leaveSettings()
        dayNav?.onNext?.()
      }
    },
    {
      id: 'search-text',
      title: 'Search Note Text…',
      section: 'Notes',
      keywords: ['find', 'full text'],
      run: () => {
        leaveSettings()
        setSideCollapsed(false)
        setTimeout(() => document.querySelector<HTMLInputElement>('.side-search')?.focus(), 0)
      }
    },
    {
      id: 'rename-note',
      title: 'Rename Note…',
      section: 'Notes',
      enabled: !!openPath,
      run: () => openPath && doRename(openPath, false)
    },
    {
      id: 'move-note',
      title: 'Move Note to…',
      section: 'Notes',
      keywords: ['folder', 'file', 'relocate', 'organize'],
      enabled: !!openPath && !openPath.startsWith('inbox/') && !openPath.startsWith('daily/'),
      run: () => {
        leaveSettings()
        if (openPath && doc) openMovePicker(openPath, 'file', titleOf(doc))
      }
    },
    {
      id: 'tag-search',
      title: 'Search by Tag…',
      section: 'Notes',
      keywords: ['tags', '#', 'filter'],
      run: () => {
        leaveSettings()
        setSideCollapsed(false)
        setQuery('#')
        setTimeout(() => document.querySelector<HTMLInputElement>('.side-search')?.focus(), 0)
      }
    },
    {
      id: 'rescan',
      title: 'Rescan Vault',
      section: 'Notes',
      keywords: ['reindex', 'refresh'],
      run: () => {
        window.api.vault
          .reindex()
          .then((r) => {
            setBackend(r.backend)
            refreshAll()
            notify(`Re-indexed ${r.indexed} notes`)
          })
          .catch((err: unknown) => notify(`Reindex failed: ${String(err)}`))
      }
    },
    {
      id: 'go-home',
      title: 'Go to Home',
      section: 'Navigate',
      keywords: ['dashboard'],
      run: () => {
        leaveSettings()
        pickScope('home')
      }
    },
    {
      id: 'go-notes',
      title: 'Go to Notes',
      section: 'Navigate',
      keywords: ['files', 'tree'],
      run: () => {
        leaveSettings()
        pickScope('notes')
      }
    },
    {
      id: 'go-inbox',
      title: 'Go to Inbox',
      section: 'Navigate',
      keywords: ['captures', 'queue'],
      run: () => {
        leaveSettings()
        pickScope('inbox')
      }
    },
    {
      id: 'meetings',
      title: meetingLive ? 'Meetings (recording)' : 'Meetings',
      section: 'Navigate',
      keywords: ['record', 'transcribe', 'capture', 'call', 'zoom', 'teams'],
      run: () => {
        leaveSettings()
        setShowMeeting(true)
      }
    },
    {
      id: 'meeting-record',
      title: meetingLive ? 'Go to Live Meeting Recording' : 'Record a Meeting…',
      section: 'Meetings',
      keywords: ['start', 'capture', 'transcribe', 'mic'],
      run: () => {
        leaveSettings()
        setShowMeeting(true)
      }
    },
    {
      id: 'meeting-close',
      title: 'Close Meetings',
      section: 'Meetings',
      enabled: showMeeting,
      keywords: ['back', 'exit'],
      run: () => setShowMeeting(false)
    },
    {
      id: 'ai-toggle-view',
      title: 'AI: Raw / Processed View',
      section: 'AI',
      accelerator: 'Shift+Alt+P',
      keywords: ['format', 'tidy', 'processed', 'raw', 'llm'],
      enabled: !!doc,
      run: () => {
        leaveSettings()
        sendAiCommand('toggle-view')
      }
    },
    {
      id: 'ai-process-note',
      title: 'AI: Process Note',
      section: 'AI',
      keywords: ['format', 'tidy', 'summarise', 'summarize', 'checklist', 'typos'],
      enabled: !!doc,
      run: () => {
        leaveSettings()
        sendAiCommand('process-note')
      }
    },
    {
      id: 'ai-process-selection',
      title: 'AI: Process Selection…',
      section: 'AI',
      accelerator: 'Shift+Alt+S',
      keywords: ['format', 'rewrite', 'fix', 'selected'],
      enabled: !!doc,
      run: () => {
        leaveSettings()
        sendAiCommand('process-selection')
      }
    },
    {
      id: 'toggle-sidebar',
      title: 'Toggle Sidebar',
      section: 'View',
      accelerator: 'CmdOrCtrl+\\',
      keywords: ['collapse', 'hide'],
      run: () => setSideCollapsed((v) => !v)
    },
    {
      id: 'pop-out',
      title: 'Pop Out to Mini Window',
      section: 'Window',
      accelerator: 'CmdOrCtrl+Shift+M',
      keywords: ['float', 'pin', 'mini', 'detach', 'tear off', 'always on top', 'side tab', 'tuck'],
      enabled: !!activeNoteId,
      run: () => popOut(activeNoteId)
    },
    {
      id: 'close-tab',
      title: 'Close Tab',
      section: 'Tabs',
      enabled: !!activeTab,
      run: () => activeTab && closeTab(activeTab.id)
    },
    {
      id: 'close-other-tabs',
      title: 'Close Other Tabs',
      section: 'Tabs',
      enabled: !!activeTab && tabs.length > 1,
      run: () => activeTab && closeOthers(activeTab.id)
    },
    {
      id: 'pin-tab',
      title: activeTab?.pinned ? 'Unpin Tab' : 'Pin Tab',
      section: 'Tabs',
      enabled: !!activeTab,
      run: () => activeTab && togglePin(activeTab.id)
    },
    {
      id: 'settings',
      title: 'Open Settings',
      section: 'Settings',
      keywords: ['preferences', 'options'],
      accelerator: 'CmdOrCtrl+,',
      run: () => openSettingsAt(sessionStorage.getItem('inkfish.settingsTab') ?? 'appearance')
    },
    ...(
      [
        ['appearance', 'Appearance', ['theme', 'font', 'accent', 'density', 'menu bar', 'tray']],
        ['mini-window', 'Mini Window', ['float', 'dock', 'tuck']],
        ['notes', 'Notes Location', ['vault', 'folder', 'move']],
        ['sync', 'Sync', ['phone', 'android', 'pair', 'lan']],
        ['trash', 'Trash', ['deleted', 'restore']],
        ['audio', 'Audio', ['microphone', 'input']],
        ['voice', 'Voice Engine', ['speech', 'transcription', 'stt', 'parakeet', 'redux']],
        ['ai', 'AI Provider', ['openai', 'anthropic', 'api key', 'llm', 'model', 'connect']],
        ['routing', 'Routing', ['route', 'inbox', 'file', 'folder', 'append', 'meetings folder', 'auto']],
        ['apple-intelligence', 'Apple Intelligence', ['ai', 'summarize', 'classify']]
      ] as Array<[string, string, string[]]>
    ).map(([tab, label, keywords]): RunnableCommand => ({
      id: `settings-${tab}`,
      title: `Settings: ${label}`,
      section: 'Settings',
      keywords,
      run: () => openSettingsAt(tab)
    })),
    { id: 'hide-window', title: 'Hide Inkfish', section: 'App', run: () => void window.api.win.hide() },
    {
      id: 'quit',
      title: 'Quit Inkfish',
      section: 'App',
      keywords: ['exit', 'close app'],
      run: () => void window.api.app.quit()
    }
  ]
}
