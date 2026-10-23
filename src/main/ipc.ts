import { getProxySettings, setProxySettings, testLocalProxy } from './proxy'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import {
  cancelPairing,
  renameDevice,
  readSyncLog,
  startPairing,
  startSync,
  syncBadge,
  syncStatus,
  unpair,
  type SyncStatus
} from './sync'
import type { SyncBadge } from '../shared/sync-badge'
import type { SyncLogEntry } from '../shared/sync'
import { keepFrontmatter } from '../shared/autosave'
import { rescanVaultFromDisk, startVaultWatch } from './watch'
import { moveEntry, renameEntry, renameToTitle, type MoveEntryResult, type TitleRenameResult } from './move'
import { isTitleSyncPath, sanitizeFileTitle } from '../shared/title-sync'
import { createMoveLog, mergeLinkMoves, type LinkMove } from '../shared/link-moves'
import { remapMiniNotes } from './mini-window'
import { setTags } from '../shared/tags'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as os from 'node:os'
import { getGlassState, getMainWindow, setGlassVibrancy, showWindow } from './window'
import { hidePopover } from './popover'
import { registerImageClipboardIpc } from './image-clipboard'
import { profile } from './profile'
import { profileBadgeText, type AppProfileInfo } from '../shared/profile'
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
  SttResult,
  SysInfo,
  VaultInfo,
  VibrancyName
} from '../shared/types'
import {
  appendDaily,
  createNoteFile,
  createProject,
  createDir,
  ensureDaily,
  deleteInboxItem,
  ensureVault,
  defaultVaultRoot,
  envManaged,
  listInbox,
  listProfiles,
  listProjects,
  loadTitles,
  migrateTitles,
  meetingToMarkdown,
  movePath,
  writeMeetingNote,
  parseVtt,
  purgeTrash,
  listTrash,
  restoreTrashEntries,
  loadTitleNamed,
  markTitleNamed,
  migrateTitleNamed,
  deleteTrash,
  mergeCaseDuplicates,
  requireNotes,
  resolveAsset,
  resolveNoteAbs,
  saveAsset,
  saveProfile,
  setInboxStatus,
  setTitleOverride,
  storeRoot,
  switchProfile,
  trashPath,
  vaultConfigured,
  vaultPaths,
  writeInboxItem,
  type VaultPaths
} from './vault'
import {
  closeDb,
  countInbox,
  dbKind,
  getNote,
  indexFile,
  indexPath,
  linkLookup,
  removePath,
  listNotes,
  openDb,
  reindexStaging,
  reindexVault,
  relatedNotes,
  removeNote,
  searchNotes
} from './db'
import { classify, providerStatus, speak, stopSpeak, summarize } from './ai'
import {
  loadRoutingPrefs,
  previewRoute,
  routeCorpus,
  routeInboxItem,
  saveRoutingPrefs,
  undoInboxRoute,
  type RouteOutcome
} from './routing'
import { aiConfigured, routeCompletion } from './ai-api'
import type { RoutePreview, RoutingPrefs } from '../shared/routing'
import { shortcutFor } from './shortcuts'
import { intelRun, intelStatus, loadIntelPrefs, saveIntelPrefs, type IntelRunInput } from './intelligence'
import type { IntelPrefs, IntelResult, IntelStatus } from '../shared/intelligence'
import {
  clearDownload,
  downloadProgress,
  listEngines,
  pauseDownload,
  prepareEngine,
  removeEngine,
  transcribe,
  type DownloadProgress
} from './stt'

const isMac = process.platform === 'darwin'

/**
 * Renames/moves whose links were just fixed on disk. A window that still holds text from before
 * (typed while the rename was in flight, or a mini window's pending autosave) gets them merged into
 * its next save instead of writing the old links back (shared/link-moves mergeLinkMoves).
 */
const moveLog = createMoveLog()

/** Reindex notes whose links a rename/move rewrote and push the new text to every window. */
function publishRewritten(rewritten: readonly string[], root: string, move: LinkMove | null | undefined): void {
  if (move) moveLog.add(move)
  for (const r of rewritten) {
    indexFile(join(root, r), r)
    const saved = getNote(r, root)
    if (!saved) continue
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('inkfish:note-saved', saved)
    }
  }
}

/** Targeted index update for a path that moved (file or folder): no full-vault rescan. */
function reindexMoved(root: string, from: string, to: string): void {
  removePath(from)
  indexPath(root, to)
}

/** Materials offered in the Glass tab. All are valid on current Electron. */
const VIBRANCY_OPTIONS: readonly VibrancyName[] = [
  'fullscreen-ui',
  'under-window',
  'sidebar',
  'hud',
  'content',
  'popover',
  'menu',
  'titlebar'
]

function notify(title: string, body: string): boolean {
  if (!Notification.isSupported()) return false
  new Notification({ title, body }).show()
  return true
}

function info(): VaultInfo {
  const p = vaultPaths()
  return {
    root: p.root,
    inboxDir: p.inboxDir,
    dailyDir: p.dailyDir,
    assetsDir: p.assetsDir,
    dbPath: p.dbPath,
    configured: vaultConfigured(),
    managed: envManaged()
  }
}

/** Background worker: classify + route one inbox item, never deleting raw. */
async function processInboxItem(
  id: string,
  opts: { apply: boolean; hint?: string; manual?: boolean }
): Promise<RouteOutcome | { error: string }> {
  let paths: VaultPaths
  try {
    paths = requireNotes()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  return routeInboxItem(id, paths, { ...opts, llm: routeCompletion })
}

/**
 * All renderer → main calls. To add a tool:
 * 1. add an `ipcMain.handle('domain:action', …)` here,
 * 2. expose it in `src/preload/index.ts`,
 * 3. call it from the renderer via `window.api`.
 */
export function registerIpc(): void {
  registerImageClipboardIpc()
  ipcMain.handle('sync:status', (): SyncStatus => syncStatus())
  ipcMain.handle('sync:pair', (): Promise<SyncStatus> => startPairing())
  ipcMain.handle('sync:cancel-pair', (): SyncStatus => cancelPairing())
  ipcMain.handle('sync:unpair', (_e: IpcMainInvokeEvent, id: string): SyncStatus => unpair(id))
  ipcMain.handle('sync:rename', (_e: IpcMainInvokeEvent, name: string): SyncStatus => renameDevice(name))
  ipcMain.handle('sync:log', (): SyncLogEntry[] => readSyncLog())
  ipcMain.handle('sync:badge', (): SyncBadge => syncBadge())

  ipcMain.handle('ping', () => 'pong')
  ipcMain.handle('proxy:get', () => getProxySettings())
  ipcMain.handle('proxy:set', (_event: IpcMainInvokeEvent, input: unknown) => setProxySettings(input))
  ipcMain.handle('proxy:test', (_event: IpcMainInvokeEvent, input: unknown) => testLocalProxy(input))

  ipcMain.handle('sys:info', (): SysInfo => {
    return {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      appVersion: app.getVersion()
    }
  })

  ipcMain.handle('notify:send', (_event: IpcMainInvokeEvent, payload: { title: string; body: string }): boolean =>
    notify(payload.title, payload.body)
  )

  ipcMain.handle('dock:set-badge', (_event: IpcMainInvokeEvent, count: number): boolean => {
    if (!isMac) return false
    // A dev profile keeps its "dev" badge, with the count beside it.
    if (profile.badge) app.dock?.setBadge(profileBadgeText(profile, count))
    else app.setBadgeCount(count)
    return true
  })

  ipcMain.handle('app:profile', (): AppProfileInfo => ({
    kind: profile.kind,
    name: profile.name,
    badge: profile.badge,
    captureShortcut: shortcutFor('capture'),
    dailyShortcut: shortcutFor('daily'),
    defaultVaultRoot: defaultVaultRoot()
  }))

  ipcMain.handle('win:hide', () => getMainWindow()?.hide())
  ipcMain.handle('win:show', () => showWindow())
  ipcMain.handle('win:minimize', () => getMainWindow()?.minimize())
  ipcMain.handle('win:flash', () => getMainWindow()?.flashFrame(true))

  // Hide the whole app (macOS: Cmd+H behavior — window + dock indicator go away).
  ipcMain.handle('app:hide', (): boolean => {
    if (isMac) app.hide()
    else getMainWindow()?.hide()
    return true
  })

  // Tray-only mode: remove the dock icon entirely (macOS). Restore with dock:show.
  ipcMain.handle('dock:hide', (): boolean => {
    if (isMac) app.dock?.hide()
    return isMac
  })
  ipcMain.handle('dock:show', (): boolean => {
    if (isMac) app.dock?.show()
    return isMac
  })

  ipcMain.handle('glass:get', (): GlassState => getGlassState())
  ipcMain.handle('glass:set', (_event: IpcMainInvokeEvent, name: VibrancyName | null): GlassState => {
    if (name !== null && !VIBRANCY_OPTIONS.includes(name)) return getGlassState()
    return setGlassVibrancy(name)
  })
  ipcMain.handle('glass:options', (): readonly VibrancyName[] => VIBRANCY_OPTIONS)

  ipcMain.handle('shell:open', (_event: IpcMainInvokeEvent, url: string): boolean => {
    if (!url.startsWith('https://')) return false
    void shell.openExternal(url)
    return true
  })

  ipcMain.handle('app:quit', () => app.quit())
  ipcMain.handle('popover:hide', () => hidePopover())

  // --- vault ------------------------------------------------------------------
  ipcMain.handle('vault:info', (): VaultInfo => info())
  ipcMain.handle('vault:reveal', (): boolean => {
    // Read-only: never creates anything.
    void shell.openPath(vaultPaths().root)
    return true
  })
  ipcMain.handle('vault:reindex', (): { indexed: number; backend: string } => {
    const paths = requireNotes()
    mergeCaseDuplicates(paths.root)
    const n = reindexVault(paths.root) + reindexStaging(paths)
    return { indexed: n, backend: dbKind() }
  })
  ipcMain.handle('vault:backend', (): string => dbKind())

  /** First-run (or move) vault selection: creates + seeds + indexes the new home. */
  ipcMain.handle(
    'vault:set-root',
    (
      _e: IpcMainInvokeEvent,
      root: string
    ): { info: VaultInfo; backend: string; indexed: number } | { error: string } => {
      if (envManaged()) return { error: 'vault location is managed by INKFISH_VAULT' }
      if (typeof root !== 'string' || !root.trim()) return { error: 'choose a folder' }
      try {
        const paths = ensureVault(vaultPaths(resolve(root)))
        storeRoot(paths.root)
        closeDb()
        mergeCaseDuplicates(paths.root)
        const backend = openDb(paths.dbPath)
        const indexed = reindexVault(paths.root) + reindexStaging(paths)
        console.log(`[inkfish] vault home → ${paths.root} (${backend}, ${indexed} notes)`)
        startSync()
        startVaultWatch([paths.root, paths.inboxDir, paths.dailyDir], rescanVaultFromDisk)
        return { info: info(), backend, indexed }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle('vault:pick', async (): Promise<{ path: string } | { error: string }> => {
    const win = getMainWindow()
    const opts = {
      title: 'Choose your Inkfish vault folder',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      defaultPath: os.homedir()
    }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || picked.filePaths.length === 0) return { error: 'cancelled' }
    return { path: picked.filePaths[0] as string }
  })

  // --- projects ----------------------------------------------------------------
  ipcMain.handle('projects:list', (): Project[] => {
    if (!vaultConfigured()) return []
    return listProjects(requireNotes())
  })
  ipcMain.handle('projects:create', (_e: IpcMainInvokeEvent, name: string): Project =>
    createProject(name, requireNotes())
  )

  // --- inbox --------------------------------------------------------------------
  ipcMain.handle('inbox:add', (_e: IpcMainInvokeEvent, input: InboxAddInput): InboxItem => {
    const paths = requireNotes()
    const { item, path } = writeInboxItem(
      {
        kind: input.kind,
        raw: input.raw,
        projectHint: input.projectHint ?? 'auto',
        source: input.source ?? 'tray',
        assets: input.assets ?? [],
        previewed: typeof input.previewed === 'string' ? input.previewed.slice(0, 300) : undefined
      },
      paths
    )
    indexFile(path, `inbox/${item.id}.md`)
    // Non-blocking auto-route: inbox shows `processing` → `ready` (or stays, with the reason).
    void processInboxItem(item.id, { apply: loadRoutingPrefs().autoFile }).catch((err) =>
      console.error('[inbox] auto-route failed:', err)
    )
    return item
  })

  ipcMain.handle('inbox:list', (): InboxItem[] => {
    if (!vaultConfigured()) return []
    return listInbox(requireNotes())
  })
  ipcMain.handle('inbox:count', (): number => countInbox())

  // "Route" clicked: file it now (applies a suggestion; low confidence still stays for review).
  ipcMain.handle('inbox:process', (_e: IpcMainInvokeEvent, id: string): ReturnType<typeof processInboxItem> =>
    processInboxItem(id, { apply: true, manual: true })
  )

  // Capture popover's live preview: the rules router on the same inputs filing uses (no model call).
  ipcMain.handle('route:preview', (_e: IpcMainInvokeEvent, raw: string, kind: NoteKind, hint?: string) => {
    if (!vaultConfigured() || typeof raw !== 'string' || !raw.trim()) return null
    const prefs = loadRoutingPrefs()
    const intel = loadIntelPrefs()
    const aiReady =
      (prefs.useAiProvider && aiConfigured()) ||
      (intel.provider === 'apple' && intel.organize && process.platform === 'darwin')
    try {
      return previewRoute(raw, kind, hint || 'auto', requireNotes(), aiReady) satisfies RoutePreview
    } catch (err) {
      console.warn('[route] preview failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  })

  // Move → folder: the user's choice always wins (new note there).
  ipcMain.handle('inbox:reassign', async (_e: IpcMainInvokeEvent, id: string, projectName: string) => {
    const paths = requireNotes()
    undoInboxRoute(id, paths)
    const res = await processInboxItem(id, { apply: true, hint: projectName })
    if ('error' in res) return res
    return { note: res.note?.id ?? null, path: res.route.rel, route: res.route }
  })

  ipcMain.handle('inbox:undo', (_e: IpcMainInvokeEvent, id: string): boolean => undoInboxRoute(id, requireNotes()))

  ipcMain.handle('inbox:delete', (_e: IpcMainInvokeEvent, id: string): boolean => {
    const paths = requireNotes()
    undoInboxRoute(id, paths)
    const ok = deleteInboxItem(id, paths)
    removeNote(id)
    removeNote(`inbox/${id}.md`)
    removePath(`inbox/${id}.md`)
    return ok
  })

  // --- routing prefs (Settings › Routing) ---------------------------------------------
  ipcMain.handle('routing:prefs', (): RoutingPrefs => loadRoutingPrefs())
  ipcMain.handle('routing:set-prefs', (_e: IpcMainInvokeEvent, patch: Partial<RoutingPrefs>): RoutingPrefs =>
    saveRoutingPrefs(patch)
  )

  ipcMain.handle('inbox:set-status', (_e: IpcMainInvokeEvent, id: string, status: NoteStatus): boolean =>
    setInboxStatus(id, status, requireNotes())
  )

  // --- daily (day-log append + open-today; EOD source) -------------------------------
  ipcMain.handle('daily:append', (_e: IpcMainInvokeEvent, raw: string, kind?: NoteKind): { vaultRel: string } => {
    const paths = requireNotes()
    const out = appendDaily(raw, { kind: kind ?? 'text', source: 'tray' }, paths)
    indexFile(out.path, out.vaultRel)
    return { vaultRel: out.vaultRel }
  })
  // Open today's note, creating an empty one (front matter only) on first use.
  ipcMain.handle('daily:today', (): { vaultRel: string } => {
    const paths = requireNotes()
    const { abs, vaultRel } = ensureDaily(new Date(), paths, 'tray')
    indexFile(abs, vaultRel)
    return { vaultRel }
  })

  // --- profiles (named vault roots in app data; INKFISH_VAULT still wins) ------------
  ipcMain.handle('profiles:list', () => listProfiles())
  ipcMain.handle('profiles:save', (_e: IpcMainInvokeEvent, name: string, root: string) =>
    saveProfile(name, resolve(root))
  )
  ipcMain.handle(
    'profiles:switch',
    (_e: IpcMainInvokeEvent, id: string): { info: VaultInfo; backend: string; indexed: number } | { error: string } => {
      if (envManaged()) return { error: 'vault location is managed by INKFISH_VAULT' }
      try {
        const root = switchProfile(id)
        const paths = ensureVault(vaultPaths(resolve(root)))
        closeDb()
        const backend = openDb(paths.dbPath)
        const indexed = reindexVault(paths.root) + reindexStaging(paths)
        return { info: info(), backend, indexed }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // --- notes ---------------------------------------------------------------------
  ipcMain.handle('notes:list', (_e: IpcMainInvokeEvent, projectId?: string | null): NoteEntry[] => {
    if (!vaultConfigured()) return []
    return listNotes(projectId)
  })
  ipcMain.handle('notes:get', (_e: IpcMainInvokeEvent, id: string): NoteDoc | null => {
    if (!vaultConfigured()) return null
    return getNote(id, requireNotes().root)
  })
  ipcMain.handle('notes:search', (_e: IpcMainInvokeEvent, query: string): SearchResult[] => {
    if (!vaultConfigured()) return []
    return searchNotes(query)
  })
  ipcMain.handle('notes:related', (_e: IpcMainInvokeEvent, id: string): NoteEntry[] => {
    if (!vaultConfigured()) return []
    return relatedNotes(id)
  })
  // Autosave writes land here (debounced in the renderer, flushed on switch/blur/quit).
  const saveNoteText = (sender: WebContents, id: unknown, markdown: unknown): NoteDoc | null => {
    if (typeof id !== 'string' || typeof markdown !== 'string' || !vaultConfigured()) return null
    const paths = requireNotes()
    const doc = getNote(id, paths.root)
    if (!doc) return null
    const abs = resolveNoteAbs(doc.path, paths)
    if (!existsSync(abs)) return null
    // Text from before a recent rename/move still has the old links: merge the fix-up in.
    let text = markdown
    if (isTitleSyncPath(doc.path)) {
      const moves = moveLog.recent()
      if (moves.length) text = mergeLinkMoves(text, doc.path, moves, (p) => existsSync(join(paths.root, p)))
    }
    // Identical text: no write, no reindex, no watcher churn — just confirm.
    if (doc.markdown === text) return doc
    // The editor edits the body; keep the file's front matter (see keepFrontmatter).
    let existing = ''
    try {
      existing = readFileSync(abs, 'utf8')
    } catch {
      // unreadable → write the body as-is
    }
    writeFileSync(abs, keepFrontmatter(existing, text), 'utf8')
    removeNote(id)
    indexFile(abs, doc.path)
    const saved = getNote(id, paths.root)
    // Mini windows: every other window showing this note picks up the save.
    if (saved) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents !== sender) w.webContents.send('inkfish:note-saved', saved)
      }
    }
    return saved
  }
  // Header tag chips: rewrite only the front matter `tags:` (body untouched), reindex, broadcast.
  ipcMain.handle('notes:set-tags', (e: IpcMainInvokeEvent, id: unknown, tags: unknown): NoteDoc | null => {
    if (typeof id !== 'string' || !Array.isArray(tags) || !vaultConfigured()) return null
    const paths = requireNotes()
    const doc = getNote(id, paths.root)
    if (!doc) return null
    const abs = resolveNoteAbs(doc.path, paths)
    if (!existsSync(abs)) return null
    const existing = readFileSync(abs, 'utf8')
    const next = setTags(
      existing,
      tags.filter((t): t is string => typeof t === 'string')
    )
    if (next !== existing) {
      writeFileSync(abs, next, 'utf8')
      removeNote(id)
      indexFile(abs, doc.path)
    }
    const saved = getNote(id, paths.root) ?? getNote(doc.path, paths.root)
    if (saved) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('inkfish:note-saved', saved)
      }
    }
    return saved
  })
  ipcMain.handle('notes:save', (e: IpcMainInvokeEvent, id: string, markdown: string): NoteDoc | null =>
    saveNoteText(e.sender, id, markdown)
  )
  // Last-chance synchronous save from `beforeunload` (window closing / reloading), where an
  // async invoke may never get its reply.
  ipcMain.on('notes:save-sync', (e: IpcMainEvent, items: unknown) => {
    let ok = 0
    try {
      if (Array.isArray(items)) {
        for (const it of items as Array<{ id?: unknown; markdown?: unknown }>) {
          if (saveNoteText(e.sender, it?.id, it?.markdown)) ok++
        }
      }
    } catch (err) {
      console.error('[inkfish] sync save failed:', err)
    }
    e.returnValue = ok
  })
  ipcMain.handle('notes:reveal', (_e: IpcMainInvokeEvent, id: string): boolean => {
    const paths = requireNotes()
    const doc = getNote(id, paths.root)
    if (!doc) return false
    void shell.showItemInFolder(resolveNoteAbs(doc.path, paths))
    return true
  })
  // --- custom display titles (app-data `titles.json`, never in the notes) -------
  ipcMain.handle('notes:titles', (): Record<string, string> => loadTitles())
  ipcMain.handle('notes:set-title', (_e: IpcMainInvokeEvent, id: string, title: string): Record<string, string> =>
    setTitleOverride(id, title)
  )

  // --- file management (tree CRUD; fs op then renderer reindexes) ------------------
  ipcMain.handle('files:create', (_e: IpcMainInvokeEvent, dirRel: string): string => {
    const paths = requireNotes()
    const rel = createNoteFile(dirRel, paths)
    indexFile(join(paths.root, rel), rel)
    return rel
  })
  ipcMain.handle('files:mkdir', (_e: IpcMainInvokeEvent, parentRel: string, name: string): string =>
    createDir(parentRel, name, requireNotes())
  )
  // Hand rename (sidebar inline rename / Rename… prompt): same link fix-up as a title rename.
  ipcMain.handle(
    'files:rename',
    async (_e: IpcMainInvokeEvent, rel: unknown, newName: unknown): Promise<MoveEntryResult> => {
      if (typeof rel !== 'string' || typeof newName !== 'string') throw new Error('bad rename')
      const paths = requireNotes()
      const res = await renameEntry(rel, newName, paths, linkLookup)
      if (res.rel === rel) return res
      // Ids are paths — carry title overrides across (whole subtree for dirs).
      migrateTitles(rel, res.rel)
      // A file renamed by hand stops following its title; a renamed folder's notes keep their marks.
      migrateTitleNamed(rel, res.rel, res.rel.toLowerCase().endsWith('.md'))
      reindexMoved(paths.root, rel, res.rel)
      remapMiniNotes(rel, res.rel)
      publishRewritten(res.rewritten, paths.root, res.move)
      return res
    }
  )
  ipcMain.handle('notes:title-named', (): string[] => loadTitleNamed())
  // Filename follows the note title (header inline title + auto-named notes): in-place rename,
  // collision-safe, inbound links/[[wikilinks]] fixed. Targeted reindex — this runs while typing.
  ipcMain.handle(
    'files:rename-to-title',
    async (_e: IpcMainInvokeEvent, rel: unknown, title: unknown): Promise<TitleRenameResult> => {
      if (typeof rel !== 'string' || typeof title !== 'string') throw new Error('bad rename')
      const paths = requireNotes()
      const before = getNote(rel, paths.root)
      // Backlinks come from the index (no full-vault read); only the linking notes are opened.
      const res = await renameToTitle(rel, title, paths, linkLookup)
      // The file name IS the title now — a stale custom display title would hide it. Overrides are
      // keyed by note id, which is the front matter `id:` when the note has one (not its path), so
      // clear both. Also when the name already fit (header title typed back to the file name).
      const clearOverride = (id: string | undefined): void => {
        if (id && loadTitles()[id] !== undefined) setTitleOverride(id, '')
      }
      if (res.rel === rel) {
        if (sanitizeFileTitle(title)) {
          clearOverride(rel)
          clearOverride(before?.id)
        }
        return res
      }
      migrateTitles(rel, res.rel)
      // Inkfish named this file from its title: it keeps following it (Untitled or not).
      markTitleNamed(res.rel, true, rel)
      clearOverride(res.rel)
      clearOverride(before?.id)
      removeNote(before?.id ?? rel)
      indexFile(join(paths.root, res.rel), res.rel)
      remapMiniNotes(rel, res.rel)
      publishRewritten(res.rewritten, paths.root, res.move)
      return res
    }
  )
  ipcMain.handle('files:move', (_e: IpcMainInvokeEvent, rel: string, destDirRel: string): string => {
    const paths = requireNotes()
    const next = movePath(rel, destDirRel, paths)
    migrateTitles(rel, next)
    migrateTitleNamed(rel, next)
    reindexMoved(paths.root, rel, next)
    remapMiniNotes(rel, next)
    return next
  })
  // Sidebar drag & drop / folder picker: collision-safe move + relative link fix-ups.
  ipcMain.handle(
    'files:move-to',
    async (_e: IpcMainInvokeEvent, rel: unknown, destDirRel: unknown): Promise<MoveEntryResult> => {
      if (typeof rel !== 'string' || typeof destDirRel !== 'string') throw new Error('bad move')
      const paths = requireNotes()
      const res = await moveEntry(rel, destDirRel, paths, linkLookup)
      if (res.rel === rel) return res
      migrateTitles(rel, res.rel)
      migrateTitleNamed(rel, res.rel)
      reindexMoved(paths.root, rel, res.rel)
      remapMiniNotes(rel, res.rel)
      // Notes whose links changed: every window drops its cached copy for the new text.
      publishRewritten(res.rewritten, paths.root, res.move)
      return res
    }
  )
  ipcMain.handle('files:trash', (_e: IpcMainInvokeEvent, rel: string) => {
    const paths = requireNotes()
    const entry = trashPath(rel, paths)
    // Just that path (a note, or a folder's worth) leaves the index — no full rescan per delete.
    removePath(rel)
    return entry
  })
  ipcMain.handle('files:purge-trash', (): number => purgeTrash())
  ipcMain.handle('trash:list', () => listTrash())
  ipcMain.handle('trash:restore', (_e: IpcMainInvokeEvent, ids: string[] | 'all'): string[] => {
    const paths = requireNotes()
    const done = restoreTrashEntries(ids, paths)
    // Re-add just what came back (a note, or a folder's notes), wherever it lives.
    for (const r of done) {
      if (r.scope === 'vault') indexPath(paths.root, r.rel)
      else if (!r.isDir) {
        const base = r.scope === 'inbox' ? paths.inboxDir : paths.dailyDir
        indexFile(join(base, r.rel), `${r.scope}/${r.rel}`)
      }
    }
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('inkfish:vault-changed')
    return done.map((r) => r.rel)
  })
  ipcMain.handle('trash:delete', (_e: IpcMainInvokeEvent, ids: string[] | 'all'): number => deleteTrash(ids))
  ipcMain.handle('files:reveal', (_e: IpcMainInvokeEvent, rel: string): boolean => {
    const abs = join(requireNotes().root, rel)
    if (!existsSync(abs)) return false
    void shell.showItemInFolder(abs)
    return true
  })

  // --- assets (image paste / drop → assets/) ----------------------------------------
  ipcMain.handle('assets:save', (_e: IpcMainInvokeEvent, fileName: string, dataUrl: string): string => {
    const m = /^data:(.+?);base64,(.+)$/.exec(dataUrl)
    if (!m) throw new Error('assets:save needs a data: URL')
    const buf = Buffer.from(m[2] ?? '', 'base64')
    return saveAsset(fileName, buf, requireNotes())
  })
  ipcMain.handle('assets:path', (_e: IpcMainInvokeEvent, vaultRel: string): string =>
    resolveAsset(vaultRel, requireNotes())
  )

  // --- AI --------------------------------------------------------------------------
  ipcMain.handle('ai:providers', () => providerStatus())
  ipcMain.handle('ai:classify', (_e: IpcMainInvokeEvent, raw: string, kind: NoteKind): Promise<ClassifyResult> =>
    vaultConfigured()
      ? classify({
          raw,
          kind,
          projects: listProjects(requireNotes()),
          corpus: routeCorpus(raw),
          prefs: loadRoutingPrefs()
        })
      : classify({ raw, kind, projects: [] })
  )
  ipcMain.handle('ai:summarize', (_e: IpcMainInvokeEvent, text: string): Promise<{ text: string; provider: string }> =>
    summarize(text)
  )
  // --- Apple Intelligence (Foundation Models) ----------------------------------------
  ipcMain.handle('intel:status', (_e: IpcMainInvokeEvent, fresh?: boolean): Promise<IntelStatus> => intelStatus(fresh))
  ipcMain.handle('intel:prefs', (): IntelPrefs => loadIntelPrefs())
  ipcMain.handle('intel:set-prefs', (_e: IpcMainInvokeEvent, patch: Partial<IntelPrefs>): IntelPrefs =>
    saveIntelPrefs(patch)
  )
  ipcMain.handle('intel:run', (_e: IpcMainInvokeEvent, input: Omit<IntelRunInput, 'projects'>): Promise<IntelResult> =>
    intelRun({
      ...input,
      projects: vaultConfigured() ? listProjects(requireNotes()).map((p) => p.name) : []
    })
  )
  ipcMain.handle('intel:open-system-settings', (): boolean => {
    if (process.platform !== 'darwin') return false
    void shell.openExternal('x-apple.systempreferences:com.apple.Siri-Settings.extension')
    return true
  })
  ipcMain.handle('ai:speak', (_e: IpcMainInvokeEvent, text: string): Promise<boolean> => speak(text))
  ipcMain.handle('ai:stop-speak', (): boolean => {
    stopSpeak()
    return true
  })

  // --- voice / STT -------------------------------------------------------------------
  ipcMain.handle('stt:transcribe', (_e: IpcMainInvokeEvent, wavPath: string, engine?: string): Promise<SttResult> =>
    transcribe(wavPath, engine || undefined)
  )
  ipcMain.handle('stt:engines', (): Promise<SttEngine[]> => listEngines())
  const sendProgress = (p: DownloadProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('stt:progress', p)
  }
  ipcMain.handle('stt:prepare', (_e: IpcMainInvokeEvent, engine: string, mirror?: string): Promise<void> =>
    prepareEngine(engine, sendProgress, typeof mirror === 'string' ? mirror : '')
  )
  ipcMain.handle('stt:pause', (_e: IpcMainInvokeEvent, engine: string): void => pauseDownload(engine))
  ipcMain.handle('stt:clear-download', (_e: IpcMainInvokeEvent, engine: string): void => clearDownload(engine))
  ipcMain.handle('stt:downloads', (): DownloadProgress[] => downloadProgress())
  ipcMain.handle('stt:remove', (_e: IpcMainInvokeEvent, engine: string): Promise<void> => removeEngine(engine))
  ipcMain.handle(
    'stt:test',
    async (_e: IpcMainInvokeEvent, dataUrl: string, engine?: string, timeoutMs?: number): Promise<SttResult> => {
      const m = /^data:(.+?);base64,(.+)$/.exec(dataUrl)
      if (!m) throw new Error('stt:test needs a data: URL')
      const tmp = join(os.tmpdir(), `inkfish-stt-test-${Date.now()}.wav`)
      writeFileSync(tmp, Buffer.from(m[2] ?? '', 'base64'))
      try {
        return await transcribe(tmp, engine || undefined, timeoutMs || undefined)
      } finally {
        rmSync(tmp, { force: true })
      }
    }
  )
  ipcMain.handle('stt:pick-audio', async (): Promise<{ path: string; transcript: SttResult } | { error: string }> => {
    const win = getMainWindow()
    const opts = {
      title: 'Import audio for transcription',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac'] }]
    }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || picked.filePaths.length === 0) return { error: 'cancelled' }
    const wav = picked.filePaths[0] as string
    try {
      return { path: wav, transcript: await transcribe(wav) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // --- meeting import (manual recording + Teams .vtt) ----------------------------------
  ipcMain.handle('meeting:import', (_e: IpcMainInvokeEvent, input: MeetingImportInput): InboxItem => {
    const paths = requireNotes()
    const cues = input.format === 'vtt' ? parseVtt(input.text) : null
    const raw =
      input.format === 'vtt' && cues ? meetingToMarkdown(cues, input.title ?? 'Meeting notes') : input.text.trim()
    const { item, path } = writeInboxItem(
      { kind: 'meeting', raw, projectHint: 'auto', source: input.source ?? 'meeting' },
      paths
    )
    indexFile(path, `inbox/${item.id}.md`)
    void processInboxItem(item.id, { apply: loadRoutingPrefs().autoFile }).catch((err) =>
      console.error('[meeting] route failed:', err)
    )
    return item
  })
  ipcMain.handle('meeting:save', (_e: IpcMainInvokeEvent, input: MeetingSaveInput): string => {
    const paths = requireNotes()
    const rel = writeMeetingNote(input, paths)
    if (input.replaceRel && input.replaceRel !== rel) {
      migrateTitles(input.replaceRel, rel)
      indexFile(join(paths.root, input.replaceRel), input.replaceRel)
    }
    indexFile(join(paths.root, rel), rel)
    return rel
  })
  ipcMain.handle(
    'meeting:pick-file',
    async (): Promise<{ text: string; format: 'vtt' | 'text' } | { error: string }> => {
      const win = getMainWindow()
      const opts = {
        title: 'Import meeting transcript',
        properties: ['openFile'] as Array<'openFile'>,
        filters: [
          { name: 'Transcripts', extensions: ['vtt', 'txt', 'md'] },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (picked.canceled || picked.filePaths.length === 0) return { error: 'cancelled' }
      const file = picked.filePaths[0] as string
      const text = readFileSync(file, 'utf8')
      return { text, format: file.toLowerCase().endsWith('.vtt') ? 'vtt' : 'text' }
    }
  )
}
