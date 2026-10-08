import { contextBridge, ipcRenderer } from 'electron'
import type { IntelPrefs, IntelResult, IntelStatus, IntelTask } from '../shared/intelligence'
import type {
  ClassifyResult,
  GlassState,
  InboxAddInput,
  InboxItem,
  MeetingImportInput,
  MeetingSaveInput,
  NoteDoc,
  NoteEntry,
  NoteKind,
  NoteStatus,
  Project,
  SearchResult,
  SttEngine,
  DownloadProgress,
  SttResult,
  SysInfo,
  VaultInfo,
  VibrancyName
} from '../shared/types'
import type { SyncStatus } from '../main/sync'
import type { SyncLogEntry } from '../shared/sync'
import type { TrashEntry as TrashItem } from '../main/vault'

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
  notify: (title: string, body: string): Promise<boolean> => ipcRenderer.invoke('notify:send', { title, body }),
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
  sync: {
    status: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:status'),
    pair: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:pair'),
    cancelPair: (): Promise<SyncStatus> => ipcRenderer.invoke('sync:cancel-pair'),
    unpair: (id: string): Promise<SyncStatus> => ipcRenderer.invoke('sync:unpair', id),
    rename: (name: string): Promise<SyncStatus> => ipcRenderer.invoke('sync:rename', name),
    log: (): Promise<SyncLogEntry[]> => ipcRenderer.invoke('sync:log'),
    onStatus: (cb: () => void): (() => void) => {
      const fn = (): void => cb()
      ipcRenderer.on('sync:status-changed', fn)
      return () => ipcRenderer.removeListener('sync:status-changed', fn)
    }
  },
  /** Files changed outside the UI (a phone synced). */
  onVaultChanged: (cb: () => void): (() => void) => {
    const fn = (): void => cb()
    ipcRenderer.on('inkfish:vault-changed', fn)
    return () => ipcRenderer.removeListener('inkfish:vault-changed', fn)
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
    reindex: (): Promise<{ indexed: number; backend: string }> => ipcRenderer.invoke('vault:reindex'),
    backend: (): Promise<string> => ipcRenderer.invoke('vault:backend'),
    pick: (): Promise<{ path: string } | { error: string }> => ipcRenderer.invoke('vault:pick'),
    setRoot: (root: string): Promise<{ info: VaultInfo; backend: string; indexed: number } | { error: string }> =>
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
    process: (id: string): Promise<{ note: NoteEntry } | { error: string }> => ipcRenderer.invoke('inbox:process', id),
    reassign: (id: string, projectName: string): Promise<{ note: string; path: string } | { error: string }> =>
      ipcRenderer.invoke('inbox:reassign', id, projectName),
    undo: (id: string): Promise<boolean> => ipcRenderer.invoke('inbox:undo', id),
    setStatus: (id: string, status: NoteStatus): Promise<boolean> => ipcRenderer.invoke('inbox:set-status', id, status)
  },
  daily: {
    append: (raw: string, kind?: NoteKind): Promise<{ vaultRel: string }> =>
      ipcRenderer.invoke('daily:append', raw, kind),
    today: (): Promise<{ vaultRel: string }> => ipcRenderer.invoke('daily:today')
  },
  profiles: {
    list: (): Promise<Array<{ id: string; name: string; root: string }>> => ipcRenderer.invoke('profiles:list'),
    save: (name: string, root: string): Promise<Array<{ id: string; name: string; root: string }>> =>
      ipcRenderer.invoke('profiles:save', name, root),
    switch: (id: string): Promise<unknown> => ipcRenderer.invoke('profiles:switch', id)
  },
  files: {
    create: (dirRel: string): Promise<string> => ipcRenderer.invoke('files:create', dirRel),
    mkdir: (parentRel: string, name: string): Promise<string> => ipcRenderer.invoke('files:mkdir', parentRel, name),
    rename: (rel: string, newName: string): Promise<string> => ipcRenderer.invoke('files:rename', rel, newName),
    move: (rel: string, destDirRel: string): Promise<string> => ipcRenderer.invoke('files:move', rel, destDirRel),
    trash: (rel: string): Promise<{ id: string; originalRel: string; name: string }> =>
      ipcRenderer.invoke('files:trash', rel),
    purgeTrash: (): Promise<number> => ipcRenderer.invoke('files:purge-trash'),
    trashList: (): Promise<TrashItem[]> => ipcRenderer.invoke('trash:list'),
    restoreTrash: (ids: string[] | 'all'): Promise<string[]> => ipcRenderer.invoke('trash:restore', ids),
    deleteTrash: (ids: string[] | 'all'): Promise<number> => ipcRenderer.invoke('trash:delete', ids),
    reveal: (rel: string): Promise<boolean> => ipcRenderer.invoke('files:reveal', rel)
  },
  notes: {
    list: (projectId?: string | null): Promise<NoteEntry[]> => ipcRenderer.invoke('notes:list', projectId),
    get: (id: string): Promise<NoteDoc | null> => ipcRenderer.invoke('notes:get', id),
    search: (query: string): Promise<SearchResult[]> => ipcRenderer.invoke('notes:search', query),
    related: (id: string): Promise<NoteEntry[]> => ipcRenderer.invoke('notes:related', id),
    save: (id: string, markdown: string): Promise<NoteDoc | null> => ipcRenderer.invoke('notes:save', id, markdown),
    reveal: (id: string): Promise<boolean> => ipcRenderer.invoke('notes:reveal', id),
    titles: (): Promise<Record<string, string>> => ipcRenderer.invoke('notes:titles'),
    setTitle: (id: string, title: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('notes:set-title', id, title)
  },
  assets: {
    save: (fileName: string, dataUrl: string): Promise<string> => ipcRenderer.invoke('assets:save', fileName, dataUrl),
    path: (vaultRel: string): Promise<string> => ipcRenderer.invoke('assets:path', vaultRel)
  },
  ai: {
    providers: (): Promise<Array<{ id: string; available: boolean; detail: string }>> =>
      ipcRenderer.invoke('ai:providers'),
    classify: (raw: string, kind: NoteKind): Promise<ClassifyResult> => ipcRenderer.invoke('ai:classify', raw, kind),
    summarize: (text: string): Promise<{ text: string; provider: string }> => ipcRenderer.invoke('ai:summarize', text),
    speak: (text: string): Promise<boolean> => ipcRenderer.invoke('ai:speak', text),
    stopSpeak: (): Promise<boolean> => ipcRenderer.invoke('ai:stop-speak')
  },
  intel: {
    /** Apple Intelligence availability; `fresh` skips the 1-minute cache. */
    status: (fresh?: boolean): Promise<IntelStatus> => ipcRenderer.invoke('intel:status', fresh),
    prefs: (): Promise<IntelPrefs> => ipcRenderer.invoke('intel:prefs'),
    setPrefs: (patch: Partial<IntelPrefs>): Promise<IntelPrefs> => ipcRenderer.invoke('intel:set-prefs', patch),
    /** Playground run; `prefs` overrides saved settings for this call only. */
    run: (input: { task: IntelTask; text: string; prefs?: Partial<IntelPrefs> }): Promise<IntelResult> =>
      ipcRenderer.invoke('intel:run', input),
    openSystemSettings: (): Promise<boolean> => ipcRenderer.invoke('intel:open-system-settings')
  },
  stt: {
    /** engine '' / undefined = best ready engine. */
    transcribe: (wavPath: string, engine?: string): Promise<SttResult> =>
      ipcRenderer.invoke('stt:transcribe', wavPath, engine),
    /** Transcribe a WAV data: URL via a temp file (Settings test; nothing saved). */
    test: (wavDataUrl: string, engine?: string, timeoutMs?: number): Promise<SttResult> =>
      ipcRenderer.invoke('stt:test', wavDataUrl, engine, timeoutMs),
    engines: (): Promise<SttEngine[]> => ipcRenderer.invoke('stt:engines'),
    /** Download models / language assets for an engine (can take minutes). */
    prepare: (engine: string, mirror?: string): Promise<void> => ipcRenderer.invoke('stt:prepare', engine, mirror),
    /** Pause a download (partial files kept; prepare again resumes). */
    pause: (engine: string): Promise<void> => ipcRenderer.invoke('stt:pause', engine),
    clearDownload: (engine: string): Promise<void> => ipcRenderer.invoke('stt:clear-download', engine),
    downloads: (): Promise<DownloadProgress[]> => ipcRenderer.invoke('stt:downloads'),
    onProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
      const h = (_e: Electron.IpcRendererEvent, p: DownloadProgress): void => cb(p)
      ipcRenderer.on('stt:progress', h)
      return () => ipcRenderer.removeListener('stt:progress', h)
    },
    /** Delete an engine's downloaded models. */
    remove: (engine: string): Promise<void> => ipcRenderer.invoke('stt:remove', engine),
    pickAudio: (): Promise<{ path: string; transcript: SttResult } | { error: string }> =>
      ipcRenderer.invoke('stt:pick-audio')
  },
  /** Audio-only system capture (Core Audio tap via the helper). */
  systap: {
    start: (): Promise<{ rate: number } | { error: string }> => ipcRenderer.invoke('systap:start'),
    stop: (): Promise<void> => ipcRenderer.invoke('systap:stop'),
    onData: (cb: (pcm: Float32Array) => void): (() => void) => {
      const fn = (_e: unknown, buf: Uint8Array): void => {
        const copy = buf.slice()
        cb(new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4))
      }
      ipcRenderer.on('systap:data', fn)
      return () => ipcRenderer.removeListener('systap:data', fn)
    },
    onEnded: (cb: () => void): (() => void) => {
      const fn = (): void => cb()
      ipcRenderer.on('systap:ended', fn)
      return () => ipcRenderer.removeListener('systap:ended', fn)
    }
  },
  meeting: {
    import: (input: MeetingImportInput): Promise<InboxItem> => ipcRenderer.invoke('meeting:import', input),
    /** Write a live-captured meeting as its own note. Returns its vault rel. */
    save: (input: MeetingSaveInput): Promise<string> => ipcRenderer.invoke('meeting:save', input),
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
