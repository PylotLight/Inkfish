import { contextBridge, ipcRenderer } from 'electron'
import type {
  ClassifyResult,
  GlassState,
  InboxAddInput,
  InboxItem,
  MeetingImportInput,
  NoteDoc,
  NoteEntry,
  NoteKind,
  NoteStatus,
  Project,
  SearchResult,
  SttResult,
  SysInfo,
  VaultInfo,
  VibrancyName
} from '../shared/types'

export interface Versions {
  node: () => string
  chrome: () => string
  electron: () => string
}

/**
 * The full renderer → main surface. Sections mirror `src/main/ipc.ts`.
 * Add a tool there first, then expose it here — `window.api` is typed
 * end-to-end, so the renderer sees the new call immediately.
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  versions: {
    node: (): string => process.versions.node,
    chrome: (): string => process.versions.chrome,
    electron: (): string => process.versions.electron
  } satisfies Versions,
  sys: {
    info: (): Promise<SysInfo> => ipcRenderer.invoke('sys:info')
  },
  notify: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke('notify:send', { title, body }),
  dock: {
    setBadge: (count: number): Promise<boolean> => ipcRenderer.invoke('dock:set-badge', count),
    hide: (): Promise<boolean> => ipcRenderer.invoke('dock:hide'),
    show: (): Promise<boolean> => ipcRenderer.invoke('dock:show')
  },
  glass: {
    get: (): Promise<GlassState> => ipcRenderer.invoke('glass:get'),
    set: (name: VibrancyName | null): Promise<GlassState> => ipcRenderer.invoke('glass:set', name),
    options: (): Promise<VibrancyName[]> => ipcRenderer.invoke('glass:options')
  },
  win: {
    hide: (): Promise<void> => ipcRenderer.invoke('win:hide'),
    show: (): Promise<void> => ipcRenderer.invoke('win:show'),
    minimize: (): Promise<void> => ipcRenderer.invoke('win:minimize'),
    flash: (): Promise<void> => ipcRenderer.invoke('win:flash')
  },
  shell: {
    open: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open', url)
  },
  app: {
    hide: (): Promise<boolean> => ipcRenderer.invoke('app:hide'),
    quit: (): Promise<void> => ipcRenderer.invoke('app:quit')
  },
  popover: {
    hide: (): Promise<void> => ipcRenderer.invoke('popover:hide')
  },
  onOpenToday: (cb: () => void): (() => void) => {
    const fn = (): void => cb()
    ipcRenderer.on('inkfish:open-today', fn)
    return () => ipcRenderer.removeListener('inkfish:open-today', fn)
  },
  // --- inkfish ---
  vault: {
    info: (): Promise<VaultInfo> => ipcRenderer.invoke('vault:info'),
    reveal: (): Promise<boolean> => ipcRenderer.invoke('vault:reveal'),
    reindex: (): Promise<{ indexed: number; backend: string }> =>
      ipcRenderer.invoke('vault:reindex'),
    backend: (): Promise<string> => ipcRenderer.invoke('vault:backend'),
    pick: (): Promise<{ path: string } | { error: string }> =>
      ipcRenderer.invoke('vault:pick'),
    setRoot: (
      root: string
    ): Promise<{ info: VaultInfo; backend: string; indexed: number } | { error: string }> =>
      ipcRenderer.invoke('vault:set-root', root)
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    create: (name: string): Promise<Project> => ipcRenderer.invoke('projects:create', name)
  },
  inbox: {
    add: (input: InboxAddInput): Promise<InboxItem> => ipcRenderer.invoke('inbox:add', input),
    list: (): Promise<InboxItem[]> => ipcRenderer.invoke('inbox:list'),
    count: (): Promise<number> => ipcRenderer.invoke('inbox:count'),
    process: (id: string): Promise<{ note: NoteEntry } | { error: string }> =>
      ipcRenderer.invoke('inbox:process', id),
    reassign: (id: string, projectName: string): Promise<{ note: string; path: string } | { error: string }> =>
      ipcRenderer.invoke('inbox:reassign', id, projectName),
    undo: (id: string): Promise<boolean> => ipcRenderer.invoke('inbox:undo', id),
    setStatus: (id: string, status: NoteStatus): Promise<boolean> =>
      ipcRenderer.invoke('inbox:set-status', id, status)
  },
  daily: {
    append: (raw: string, kind?: NoteKind): Promise<{ vaultRel: string }> =>
      ipcRenderer.invoke('daily:append', raw, kind),
    today: (): Promise<{ vaultRel: string }> => ipcRenderer.invoke('daily:today')
  },
  profiles: {
    list: (): Promise<Array<{ id: string; name: string; root: string }>> =>
      ipcRenderer.invoke('profiles:list'),
    save: (name: string, root: string): Promise<Array<{ id: string; name: string; root: string }>> =>
      ipcRenderer.invoke('profiles:save', name, root),
    switch: (id: string): Promise<unknown> => ipcRenderer.invoke('profiles:switch', id)
  },
  files: {
    create: (dirRel: string): Promise<string> => ipcRenderer.invoke('files:create', dirRel),
    mkdir: (parentRel: string, name: string): Promise<string> =>
      ipcRenderer.invoke('files:mkdir', parentRel, name),
    rename: (rel: string, newName: string): Promise<string> =>
      ipcRenderer.invoke('files:rename', rel, newName),
    trash: (rel: string): Promise<{ id: string; originalRel: string; name: string }> =>
      ipcRenderer.invoke('files:trash', rel),
    purgeTrash: (): Promise<number> => ipcRenderer.invoke('files:purge-trash'),
    reveal: (rel: string): Promise<boolean> => ipcRenderer.invoke('files:reveal', rel)
  },
  notes: {
    list: (projectId?: string | null): Promise<NoteEntry[]> =>
      ipcRenderer.invoke('notes:list', projectId),
    get: (id: string): Promise<NoteDoc | null> => ipcRenderer.invoke('notes:get', id),
    search: (query: string): Promise<SearchResult[]> => ipcRenderer.invoke('notes:search', query),
    related: (id: string): Promise<NoteEntry[]> => ipcRenderer.invoke('notes:related', id),
    save: (id: string, markdown: string): Promise<NoteDoc | null> =>
      ipcRenderer.invoke('notes:save', id, markdown),
    reveal: (id: string): Promise<boolean> => ipcRenderer.invoke('notes:reveal', id),
    titles: (): Promise<Record<string, string>> => ipcRenderer.invoke('notes:titles'),
    setTitle: (id: string, title: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('notes:set-title', id, title)
  },
  assets: {
    save: (fileName: string, dataUrl: string): Promise<string> =>
      ipcRenderer.invoke('assets:save', fileName, dataUrl),
    path: (vaultRel: string): Promise<string> => ipcRenderer.invoke('assets:path', vaultRel)
  },
  ai: {
    providers: (): Promise<Array<{ id: string; available: boolean; detail: string }>> =>
      ipcRenderer.invoke('ai:providers'),
    classify: (raw: string, kind: NoteKind): Promise<ClassifyResult> =>
      ipcRenderer.invoke('ai:classify', raw, kind),
    summarize: (text: string): Promise<{ text: string; provider: string }> =>
      ipcRenderer.invoke('ai:summarize', text),
    speak: (text: string): Promise<boolean> => ipcRenderer.invoke('ai:speak', text),
    stopSpeak: (): Promise<boolean> => ipcRenderer.invoke('ai:stop-speak')
  },
  stt: {
    transcribe: (wavPath: string): Promise<SttResult> =>
      ipcRenderer.invoke('stt:transcribe', wavPath),
    pickAudio: (): Promise<{ path: string; transcript: SttResult } | { error: string }> =>
      ipcRenderer.invoke('stt:pick-audio')
  },
  meeting: {
    import: (input: MeetingImportInput): Promise<InboxItem> =>
      ipcRenderer.invoke('meeting:import', input),
    pickFile: (): Promise<{ text: string; format: 'vtt' | 'text' } | { error: string }> =>
      ipcRenderer.invoke('meeting:pick-file')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.api = api
}

export type PreloadAPI = typeof api
