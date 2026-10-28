import type { ProxySettings, ProxyTestResult } from '../shared/proxy-settings'
import { contextBridge, ipcRenderer } from 'electron'
import type { AudioApp, SystemAudioSource, TapSources } from '../shared/systemAudio'
import type {
  IntelImage,
  IntelPrefs,
  IntelResult,
  IntelRunUpdate,
  IntelStatus,
  IntelTask
} from '../shared/intelligence'
import type { LfmModelKey } from '../shared/lfm-catalog'
import type { ManagedLfmDownloadProgress, ManagedLfmStatus } from '../shared/managed-llm'
import type { ManagedOnnxDownloadProgress, ManagedOnnxStatus } from '../shared/managed-onnx'
import type { InboxRoute, RoutePreview, RoutingPrefs } from '../shared/routing'
import type { AiApiStatus, AiProviderSettings, AiTestResult } from '../shared/ai-api'
import type { AiErrorDetail } from '../shared/ai-errors'
import type { AiApi, DiscoveryResult } from '../shared/ai-models'
import type { ProcessedEntry } from '../shared/ai-process'
import type { MenuBarSettings } from '../shared/menubar'
import type { AppProfileInfo } from '../shared/profile'
import type { ShortcutId, ShortcutSetResult, ShortcutState } from '../shared/shortcuts'
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
import type { SyncBadge } from '../shared/sync-badge'
import type { TrashEntry as TrashItem } from '../main/vault'
import type { CopyImageResult } from '../main/image-clipboard'
import type { MiniHeaderState, MiniSettingsState } from '../main/mini-window'
import type { MiniWindowSettings } from '../shared/mini-window'
import type { UpdateSettingsResult, UpdateState } from '../shared/update-feed'

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
  proxy: {
    get: (): Promise<ProxySettings> => ipcRenderer.invoke('proxy:get'),
    set: (settings: ProxySettings): Promise<ProxySettings> => ipcRenderer.invoke('proxy:set', settings),
    test: (settings: ProxySettings): Promise<ProxyTestResult> => ipcRenderer.invoke('proxy:test', settings)
  },
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
  /** Mini windows: one note floating over every app (main/mini-window.ts). */
  mini: {
    /** Pop a note out (already out: bring it up). `focus` takes the keyboard. */
    open: (noteId: string, focus?: boolean): Promise<boolean> => ipcRenderer.invoke('mini:open', noteId, focus),
    /** A tab dragged out of the tab strip: open it in a mini window under the pointer (focused). */
    tearOut: (noteId: string): Promise<boolean> => ipcRenderer.invoke('mini:tear-out', noteId),
    /** The main window's open note — what the global toggle pops out when no mini is open. */
    setActive: (noteId: string | null): void => ipcRenderer.send('mini:active', noteId),
    /** From a mini: close it and open its note in the main window. */
    returnToMain: (): Promise<void> => ipcRenderer.invoke('mini:return'),
    close: (): Promise<void> => ipcRenderer.invoke('mini:close'),
    /** From a mini: tuck to the nearest edge / slide back out. */
    tuck: (): Promise<void> => ipcRenderer.invoke('mini:tuck'),
    state: (): Promise<MiniHeaderState | null> => ipcRenderer.invoke('mini:state'),
    /** This mini's note moved/renamed on disk (ids are paths): follow it to the new id. */
    onNoteMoved: (cb: (m: { from: string; to: string }) => void): (() => void) => {
      const fn = (_e: unknown, m: { from: string; to: string }): void => cb(m)
      ipcRenderer.on('mini:note-moved', fn)
      return () => ipcRenderer.removeListener('mini:note-moved', fn)
    },
    onState: (cb: (s: MiniHeaderState) => void): (() => void) => {
      const fn = (_e: unknown, s: MiniHeaderState): void => cb(s)
      ipcRenderer.on('mini:state', fn)
      return () => ipcRenderer.removeListener('mini:state', fn)
    },
    settings: (): Promise<MiniSettingsState> => ipcRenderer.invoke('mini:settings'),
    setSettings: (patch: Partial<MiniWindowSettings>): Promise<MiniSettingsState> =>
      ipcRenderer.invoke('mini:set-settings', patch),
    /** Live sync: this window's unsaved text for a note (relayed to the others). */
    draft: (id: string, markdown: string): void => ipcRenderer.send('mini:draft', id, markdown),
    onDraft: (cb: (d: { id: string; markdown: string }) => void): (() => void) => {
      const fn = (_e: unknown, d: { id: string; markdown: string }): void => cb(d)
      ipcRenderer.on('inkfish:note-draft', fn)
      return () => ipcRenderer.removeListener('inkfish:note-draft', fn)
    },
    /** Another window saved a note. */
    onSaved: (cb: (doc: NoteDoc) => void): (() => void) => {
      const fn = (_e: unknown, doc: NoteDoc): void => cb(doc)
      ipcRenderer.on('inkfish:note-saved', fn)
      return () => ipcRenderer.removeListener('inkfish:note-saved', fn)
    },
    /** Main window: a mini handed its note back. */
    onOpenNote: (cb: (id: string) => void): (() => void) => {
      const fn = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on('inkfish:open-note', fn)
      return () => ipcRenderer.removeListener('inkfish:open-note', fn)
    },
    /** The dock handle page (data: URL) — main/mini-window-handle-page.ts. */
    handle: {
      onHandleState: (cb: (s: { edge: string; arrow: string; label: string }) => void): void => {
        ipcRenderer.on('mini:handle-state', (_e, s) => cb(s))
      },
      handleClick: (): void => ipcRenderer.send('mini:handle-click'),
      handleHover: (inside: boolean): void => ipcRenderer.send('mini:handle-hover', inside),
      handleDrag: (active: boolean): void => ipcRenderer.send('mini:handle-drag', active)
    }
  },
  /** Update notifications from the GitHub releases feed (main/updates.ts). */
  updates: {
    get: (): Promise<UpdateState> => ipcRenderer.invoke('updates:get'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check'),
    skip: (version: string): Promise<UpdateState> => ipcRenderer.invoke('updates:skip', version),
    remindLater: (): Promise<UpdateState> => ipcRenderer.invoke('updates:remind-later'),
    setSettings: (patch: { feedUrl?: string; betaChannel?: boolean }): Promise<UpdateSettingsResult> =>
      ipcRenderer.invoke('updates:settings:set', patch),
    download: (): Promise<boolean> => ipcRenderer.invoke('updates:download'),
    openRelease: (): Promise<boolean> => ipcRenderer.invoke('updates:open-release'),
    copyBrew: (): Promise<boolean> => ipcRenderer.invoke('updates:copy-brew'),
    onChanged: (cb: (s: UpdateState) => void): (() => void) => {
      const fn = (_e: unknown, s: UpdateState): void => cb(s)
      ipcRenderer.on('updates:changed', fn)
      return () => ipcRenderer.removeListener('updates:changed', fn)
    },
    /** A notification click asks the window to open Settings → About & updates. */
    onReveal: (cb: () => void): (() => void) => {
      const fn = (): void => cb()
      ipcRenderer.on('updates:reveal', fn)
      return () => ipcRenderer.removeListener('updates:reveal', fn)
    }
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
    /** Which app profile this is (release "Inkfish" vs "Inkfish Dev"…) — shared/profile.ts. */
    profile: (): Promise<AppProfileInfo> => ipcRenderer.invoke('app:profile'),
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
    },
    /** Live sync badge (sidebar footer). Pushed from main on real sync events, throttled. */
    badge: (): Promise<SyncBadge> => ipcRenderer.invoke('sync:badge'),
    onBadge: (cb: (b: SyncBadge) => void): (() => void) => {
      const fn = (_e: unknown, b: SyncBadge): void => cb(b)
      ipcRenderer.on('sync:badge', fn)
      return () => ipcRenderer.removeListener('sync:badge', fn)
    }
  },
  /** Files changed outside the UI (a phone synced). */
  /** Autosave: main asks this window to write pending text (app quit). Resolve to ack. */
  onFlushRequest: (cb: () => Promise<void>): (() => void) => {
    const fn = (_e: unknown, token: string): void => {
      void cb()
        .catch(() => undefined)
        .finally(() => ipcRenderer.send('inkfish:flush-done', token))
    }
    ipcRenderer.on('inkfish:flush', fn)
    ipcRenderer.send('inkfish:autosave-register', true)
    return () => {
      ipcRenderer.removeListener('inkfish:flush', fn)
      ipcRenderer.send('inkfish:autosave-register', false)
    }
  },
  onVaultChanged: (cb: () => void): (() => void) => {
    const fn = (): void => cb()
    ipcRenderer.on('inkfish:vault-changed', fn)
    return () => ipcRenderer.removeListener('inkfish:vault-changed', fn)
  },
  /** Edit › Find menu (macOS app menu, main/app-menu.ts) → the focused window's note. */
  onFind: (cb: (action: 'find' | 'replace' | 'next' | 'prev') => void): (() => void) => {
    const fn = (_e: unknown, action: 'find' | 'replace' | 'next' | 'prev'): void => cb(action)
    ipcRenderer.on('inkfish:find', fn)
    return () => ipcRenderer.removeListener('inkfish:find', fn)
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
    /** File it now. `note` is null when the router left it in the inbox (see `route.reason`). */
    process: (
      id: string,
      options?: { approveSuggestion?: boolean }
    ): Promise<{ note: NoteEntry | null; route: InboxRoute } | { error: string }> =>
      ipcRenderer.invoke('inbox:process', id, options),
    reassign: (
      id: string,
      projectName: string
    ): Promise<{ note: string | null; path: string; route: InboxRoute } | { error: string }> =>
      ipcRenderer.invoke('inbox:reassign', id, projectName),
    undo: (id: string): Promise<boolean> => ipcRenderer.invoke('inbox:undo', id),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('inbox:delete', id),
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
    /** Hand rename in place; fixes relative links and [[wikilinks]] into it (like a title rename). */
    rename: (rel: string, newName: string): Promise<{ rel: string; rewritten: string[] }> =>
      ipcRenderer.invoke('files:rename', rel, newName),
    move: (rel: string, destDirRel: string): Promise<string> => ipcRenderer.invoke('files:move', rel, destDirRel),
    /** Rename a note in place to its title's file name (`Title 2.md` on collision); fixes links into it. */
    renameToTitle: (rel: string, title: string): Promise<{ rel: string; rewritten: string[] }> =>
      ipcRenderer.invoke('files:rename-to-title', rel, title),
    /** Collision-safe move (`Name 2.md`) that also fixes relative links broken by it. */
    moveTo: (
      rel: string,
      destDirRel: string
    ): Promise<{ rel: string; renamed: boolean; moved: Array<{ from: string; to: string }>; rewritten: string[] }> =>
      ipcRenderer.invoke('files:move-to', rel, destDirRel),
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
    /** Replace the note's front matter `tags:` (body untouched). */
    setTags: (id: string, tags: string[]): Promise<NoteDoc | null> => ipcRenderer.invoke('notes:set-tags', id, tags),
    /** Synchronous last-chance save (beforeunload only — blocks the renderer until written). */
    saveSync: (items: Array<{ id: string; markdown: string }>): number =>
      ipcRenderer.sendSync('notes:save-sync', items) as number,
    reveal: (id: string): Promise<boolean> => ipcRenderer.invoke('notes:reveal', id),
    titles: (): Promise<Record<string, string>> => ipcRenderer.invoke('notes:titles'),
    /** Notes Inkfish named from their title (they keep following it; see Settings → Name files from title). */
    titleNamed: (): Promise<string[]> => ipcRenderer.invoke('notes:title-named'),
    setTitle: (id: string, title: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('notes:set-title', id, title)
  },
  assets: {
    save: (fileName: string, dataUrl: string): Promise<string> => ipcRenderer.invoke('assets:save', fileName, dataUrl),
    path: (vaultRel: string): Promise<string> => ipcRenderer.invoke('assets:path', vaultRel)
  },
  /** Rendered editor images: copy the picture / its path, reveal in Finder (main/image-clipboard.ts). */
  images: {
    copy: (url: string): Promise<CopyImageResult> => ipcRenderer.invoke('images:copy', url),
    copyPng: (pngDataUrl: string): Promise<boolean> => ipcRenderer.invoke('images:copy-png', pngDataUrl),
    locate: (url: string): Promise<string | null> => ipcRenderer.invoke('images:locate', url),
    reveal: (url: string): Promise<boolean> => ipcRenderer.invoke('images:reveal', url)
  },
  clipboard: {
    writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write-text', text)
  },
  ai: {
    providers: (): Promise<Array<{ id: string; available: boolean; detail: string }>> =>
      ipcRenderer.invoke('ai:providers'),
    classify: (raw: string, kind: NoteKind): Promise<ClassifyResult> => ipcRenderer.invoke('ai:classify', raw, kind),
    summarize: (text: string): Promise<{ text: string; provider: string }> => ipcRenderer.invoke('ai:summarize', text),
    speak: (text: string): Promise<boolean> => ipcRenderer.invoke('ai:speak', text),
    stopSpeak: (): Promise<boolean> => ipcRenderer.invoke('ai:stop-speak')
  },
  /** Settings › AI provider (served to the Prompt API by the local AI handler). The key never comes back. */
  aiApi: {
    status: (): Promise<AiApiStatus> => ipcRenderer.invoke('ai-api:status'),
    set: (patch: Partial<AiProviderSettings>): Promise<AiApiStatus> => ipcRenderer.invoke('ai-api:set', patch),
    setKey: (key: string): Promise<AiApiStatus> => ipcRenderer.invoke('ai-api:set-key', key),
    clearKey: (): Promise<AiApiStatus> => ipcRenderer.invoke('ai-api:clear-key'),
    /** Unsaved `patch` fields override the saved settings for this test only. */
    /** `testModel` = model to test (default: active); `testApi` = force Chat Completions / Responses. */
    test: (patch?: Partial<AiProviderSettings> & { testModel?: string; testApi?: AiApi }): Promise<AiTestResult> =>
      ipcRenderer.invoke('ai-api:test', patch),
    /** The local AI handler's last failed request newer than `since` (scrubbed), or null. */
    lastError: (since?: number): Promise<AiErrorDetail | null> => ipcRenderer.invoke('ai-api:last-error', since),
    /** Main changed the settings on its own (Auto learned a model's API): fresh status. */
    onChanged: (cb: (s: AiApiStatus) => void): (() => void) => {
      const fn = (_e: unknown, s: AiApiStatus): void => cb(s)
      ipcRenderer.on('ai-api:changed', fn)
      return () => ipcRenderer.removeListener('ai-api:changed', fn)
    },
    /** Find models on the provider (main does the requests; the key never reaches the renderer). */
    discover: (patch?: Partial<AiProviderSettings>): Promise<DiscoveryResult> =>
      ipcRenderer.invoke('ai-api:discover', patch),
    processedGet: (noteId: string): Promise<ProcessedEntry | null> =>
      ipcRenderer.invoke('ai-api:processed-get', noteId),
    processedSet: (entry: ProcessedEntry): Promise<boolean> => ipcRenderer.invoke('ai-api:processed-set', entry),
    processedClear: (noteId: string): Promise<boolean> => ipcRenderer.invoke('ai-api:processed-clear', noteId)
  },
  routing: {
    /** Settings › Routing (auto-file, default folder, append, meetings folder). */
    prefs: (): Promise<RoutingPrefs> => ipcRenderer.invoke('routing:prefs'),
    setPrefs: (patch: Partial<RoutingPrefs>): Promise<RoutingPrefs> => ipcRenderer.invoke('routing:set-prefs', patch),
    /** Where a capture would go if saved now (rules router, same inputs as filing; null = no vault / empty). */
    preview: (raw: string, kind: NoteKind, hint?: string): Promise<RoutePreview | null> =>
      ipcRenderer.invoke('route:preview', raw, kind, hint)
  },
  intel: {
    /** Apple Intelligence availability; `fresh` skips the 1-minute cache. */
    status: (fresh?: boolean): Promise<IntelStatus> => ipcRenderer.invoke('intel:status', fresh),
    managedStatus: (): Promise<ManagedLfmStatus> => ipcRenderer.invoke('intel:managed-status'),
    downloadManagedModel: (key: LfmModelKey, acceptedLicense: boolean): Promise<ManagedLfmStatus> =>
      ipcRenderer.invoke('intel:managed-download', key, acceptedLicense),
    pauseManagedDownload: (key: LfmModelKey): Promise<ManagedLfmStatus> =>
      ipcRenderer.invoke('intel:managed-pause', key),
    startManagedModel: (key: LfmModelKey): Promise<ManagedLfmStatus> => ipcRenderer.invoke('intel:managed-start', key),
    stopManaged: (): Promise<ManagedLfmStatus> => ipcRenderer.invoke('intel:managed-stop'),
    removeManagedModel: (key: LfmModelKey): Promise<ManagedLfmStatus> =>
      ipcRenderer.invoke('intel:managed-remove', key),
    openModelLicense: (): Promise<boolean> => ipcRenderer.invoke('intel:open-model-license'),
    onManagedProgress: (cb: (progress: ManagedLfmDownloadProgress) => void): (() => void) => {
      const fn = (_e: unknown, progress: ManagedLfmDownloadProgress): void => cb(progress)
      ipcRenderer.on('intel:managed-progress', fn)
      return () => ipcRenderer.removeListener('intel:managed-progress', fn)
    },
    onnxStatus: (): Promise<ManagedOnnxStatus> => ipcRenderer.invoke('intel:onnx-status'),
    downloadOnnxModel: (key: LfmModelKey, acceptedLicense: boolean): Promise<ManagedOnnxStatus> =>
      ipcRenderer.invoke('intel:onnx-download', key, acceptedLicense),
    pauseOnnxDownload: (key: LfmModelKey): Promise<ManagedOnnxStatus> => ipcRenderer.invoke('intel:onnx-pause', key),
    loadOnnxModel: (key: LfmModelKey): Promise<ManagedOnnxStatus> => ipcRenderer.invoke('intel:onnx-load', key),
    unloadOnnx: (): Promise<ManagedOnnxStatus> => ipcRenderer.invoke('intel:onnx-unload'),
    removeOnnxModel: (key: LfmModelKey): Promise<ManagedOnnxStatus> => ipcRenderer.invoke('intel:onnx-remove', key),
    onOnnxProgress: (cb: (progress: ManagedOnnxDownloadProgress) => void): (() => void) => {
      const fn = (_e: unknown, progress: ManagedOnnxDownloadProgress): void => cb(progress)
      ipcRenderer.on('intel:onnx-progress', fn)
      return () => ipcRenderer.removeListener('intel:onnx-progress', fn)
    },
    prefs: (): Promise<IntelPrefs> => ipcRenderer.invoke('intel:prefs'),
    setPrefs: (patch: Partial<IntelPrefs>): Promise<IntelPrefs> => ipcRenderer.invoke('intel:set-prefs', patch),
    /** Playground run; `prefs` overrides saved settings for this call only. */
    run: async (
      input: { task: IntelTask; text: string; prefs?: Partial<IntelPrefs>; images?: IntelImage[] },
      onUpdate?: (update: IntelRunUpdate) => void
    ): Promise<IntelResult> => {
      const runId = onUpdate ? globalThis.crypto.randomUUID() : undefined
      const listener = (_event: unknown, payload: { runId?: string; update?: IntelRunUpdate }): void => {
        if (payload.runId === runId && payload.update) onUpdate?.(payload.update)
      }
      if (runId) ipcRenderer.on('intel:run-update', listener)
      try {
        return (await ipcRenderer.invoke('intel:run', input, runId)) as IntelResult
      } finally {
        if (runId) ipcRenderer.removeListener('intel:run-update', listener)
      }
    },
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
    /** No source = all system audio; `{ mode: 'apps' }` taps just those apps (macOS 14.2+). */
    start: (source?: SystemAudioSource): Promise<{ rate: number } | { error: string }> =>
      ipcRenderer.invoke('systap:start', source),
    /** Per-app system audio available (macOS 14.2+ with the helper). */
    supported: (): Promise<boolean> => ipcRenderer.invoke('systap:supported'),
    /** Apps known to Core Audio, playing ones first (with icons). */
    apps: (): Promise<AudioApp[] | { error: string }> => ipcRenderer.invoke('systap:apps'),
    /** What the running tap is capturing (follows app restarts). */
    onSources: (cb: (s: TapSources) => void): (() => void) => {
      const fn = (_e: unknown, s: TapSources): void => cb(s)
      ipcRenderer.on('systap:sources', fn)
      return () => ipcRenderer.removeListener('systap:sources', fn)
    },
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
  /** Menu bar mode: tray icon, what its click opens, menu-bar-only (no Dock icon). */
  menubar: {
    settings: (): Promise<{ settings: MenuBarSettings; platform: string }> => ipcRenderer.invoke('menubar:settings'),
    set: (patch: Partial<MenuBarSettings>): Promise<MenuBarSettings> => ipcRenderer.invoke('menubar:set', patch),
    background: (): Promise<void> => ipcRenderer.invoke('menubar:background'),
    /** Changed elsewhere (the tray's right-click menu). */
    onChanged: (cb: (s: MenuBarSettings) => void): (() => void) => {
      const fn = (_e: unknown, s: MenuBarSettings): void => cb(s)
      ipcRenderer.on('menubar:changed', fn)
      return () => ipcRenderer.removeListener('menubar:changed', fn)
    }
  },
  /** Global capture shortcuts (Settings › Shortcuts, main/shortcuts.ts). */
  shortcuts: {
    get: (): Promise<ShortcutState> => ipcRenderer.invoke('shortcuts:get'),
    /** Set one ('' = off). Refused (invalid / taken by another app) → `error` set, old one kept. */
    set: (id: ShortcutId, accelerator: string): Promise<ShortcutSetResult> =>
      ipcRenderer.invoke('shortcuts:set', id, accelerator),
    /** A recorder field has focus: release Inkfish's capture shortcuts so they can be recorded. */
    recording: (on: boolean): void => ipcRenderer.send('shortcuts:recording', on),
    onChanged: (cb: (s: ShortcutState) => void): (() => void) => {
      const fn = (_e: unknown, s: ShortcutState): void => cb(s)
      ipcRenderer.on('shortcuts:changed', fn)
      return () => ipcRenderer.removeListener('shortcuts:changed', fn)
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
