import { app, dialog, ipcMain, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as os from 'node:os'
import { getGlassState, getMainWindow, setGlassVibrancy, showWindow } from './window'
import { hidePopover } from './popover'
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
import {
  createProject,
  ensureSeedProjects,
  ensureVault,
  envManaged,
  listInbox,
  listProjects,
  meetingToMarkdown,
  parseVtt,
  readInboxItem,
  requireNotes,
  resolveAsset,
  routeToProject,
  saveAsset,
  setInboxStatus,
  storeRoot,
  undoRoute,
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
  listNotes,
  openDb,
  reindexVault,
  relatedNotes,
  removeNote,
  searchNotes
} from './db'
import { classify, providerStatus, speak, stopSpeak, summarize, transcribe } from './ai'

const isMac = process.platform === 'darwin'

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
    projectsDir: p.projectsDir,
    assetsDir: p.assetsDir,
    dbPath: p.dbPath,
    configured: vaultConfigured(),
    managed: envManaged()
  }
}

/** Background worker: classify + route one inbox item, never deleting raw. */
async function processInboxItem(id: string): Promise<{ note: NoteEntry; classify: ClassifyResult } | { error: string }> {
  let paths: VaultPaths
  try {
    paths = requireNotes()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const item = readInboxItem(id, paths)
  if (!item) return { error: `inbox item ${id} not found` }
  setInboxStatus(id, 'processing', paths)
  indexFile(join(paths.inboxDir, `${id}.md`), `inbox/${id}.md`)
  try {
    const projects = listProjects(paths)
    const result = await classify({ raw: item.raw, kind: item.kind, projects, projectHint: item.projectHint })
    const projectName = result.projectName || 'general'
    const routed = routeToProject(
      {
        inboxId: id,
        projectName,
        title: result.title,
        tags: result.tags,
        markdown: result.markdown,
        kind: item.kind
      },
      paths
    )
    setInboxStatus(id, 'ready', paths)
    indexFile(join(paths.inboxDir, `${id}.md`), `inbox/${id}.md`)
    const entry = indexFile(routed.path, routed.vaultRel)
    return {
      note: entry ?? {
        id: routed.noteId, path: routed.vaultRel, title: result.title, kind: item.kind,
        status: 'ready' as NoteStatus, projectId: result.projectId, inboxId: id,
        tags: result.tags, snippet: result.markdown.slice(0, 220),
        createdAt: Date.now(), updatedAt: Date.now()
      },
      classify: result
    }
  } catch (err) {
    setInboxStatus(id, 'inbox', paths)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * All renderer → main calls. To add a tool:
 * 1. add an `ipcMain.handle('domain:action', …)` here,
 * 2. expose it in `src/preload/index.ts`,
 * 3. call it from the renderer via `window.api`.
 */
export function registerIpc(): void {
  ipcMain.handle('ping', () => 'pong')

  ipcMain.handle('sys:info', (): SysInfo => {
    return {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMem: os.totalmem(),
      freeMem: os.freemem()
    }
  })

  ipcMain.handle(
    'notify:send',
    (_event: IpcMainInvokeEvent, payload: { title: string; body: string }): boolean =>
      notify(payload.title, payload.body)
  )

  ipcMain.handle('dock:set-badge', (_event: IpcMainInvokeEvent, count: number): boolean => {
    if (isMac) app.setBadgeCount(count)
    return isMac
  })

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
  ipcMain.handle(
    'glass:set',
    (_event: IpcMainInvokeEvent, name: VibrancyName | null): GlassState => {
      if (name !== null && !VIBRANCY_OPTIONS.includes(name)) return getGlassState()
      return setGlassVibrancy(name)
    }
  )
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
    return { indexed: reindexVault(paths.root), backend: dbKind() }
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
        ensureSeedProjects(paths)
        const backend = openDb(paths.dbPath)
        const indexed = reindexVault(paths.root)
        console.log(`[inkfish] vault home → ${paths.root} (${backend}, ${indexed} notes)`)
        return { info: info(), backend, indexed }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle(
    'vault:pick',
    async (): Promise<{ path: string } | { error: string }> => {
      const win = getMainWindow()
      const opts = {
        title: 'Choose your Inkfish vault folder',
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
        defaultPath: os.homedir()
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (picked.canceled || picked.filePaths.length === 0) return { error: 'cancelled' }
      return { path: picked.filePaths[0] as string }
    }
  )

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
        assets: input.assets ?? []
      },
      paths
    )
    indexFile(path, `inbox/${item.id}.md`)
    // Non-blocking auto-route: inbox shows `processing` → `ready`.
    void processInboxItem(item.id).catch((err) => console.error('[inbox] auto-route failed:', err))
    return item
  })

  ipcMain.handle('inbox:list', (): InboxItem[] => {
    if (!vaultConfigured()) return []
    return listInbox(requireNotes())
  })
  ipcMain.handle('inbox:count', (): number => countInbox())

  ipcMain.handle(
    'inbox:process',
    (_e: IpcMainInvokeEvent, id: string): ReturnType<typeof processInboxItem> =>
      processInboxItem(id)
  )

  ipcMain.handle('inbox:reassign', async (_e: IpcMainInvokeEvent, id: string, projectName: string) => {
    undoRoute(id, requireNotes())
    const item = readInboxItem(id, requireNotes())
    if (!item) return { error: `inbox item ${id} not found` }
    // Force the router to this project by passing an explicit hint.
    setInboxStatus(id, 'inbox', requireNotes())
    const paths = requireNotes()
    const projects = listProjects(paths)
    const result = await classify({ raw: item.raw, kind: item.kind, projects, projectHint: projectName })
    const routed = routeToProject(
      { inboxId: id, projectName: result.projectName, title: result.title, tags: result.tags, markdown: result.markdown, kind: item.kind },
      paths
    )
    setInboxStatus(id, 'ready', paths)
    indexFile(join(paths.inboxDir, `${id}.md`), `inbox/${id}.md`)
    indexFile(routed.path, routed.vaultRel)
    return { note: routed.noteId, path: routed.vaultRel }
  })

  ipcMain.handle('inbox:undo', (_e: IpcMainInvokeEvent, id: string): boolean => {
    const paths = requireNotes()
    const ok = undoRoute(id, paths)
    // Drop undone notes from the index (files are `.undone`, re-scan is cheap).
    void reindexVault(paths.root)
    return ok
  })

  ipcMain.handle('inbox:set-status', (_e: IpcMainInvokeEvent, id: string, status: NoteStatus): boolean =>
    setInboxStatus(id, status, requireNotes())
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
  ipcMain.handle(
    'notes:save',
    (_e: IpcMainInvokeEvent, id: string, markdown: string): NoteDoc | null => {
      const paths = requireNotes()
      const doc = getNote(id, paths.root)
      if (!doc) return null
      const abs = join(paths.root, doc.path)
      if (!existsSync(abs)) return null
      writeFileSync(abs, markdown, 'utf8')
      removeNote(id)
      indexFile(abs, doc.path)
      return getNote(id, paths.root)
    }
  )
  ipcMain.handle('notes:reveal', (_e: IpcMainInvokeEvent, id: string): boolean => {
    const paths = requireNotes()
    const doc = getNote(id, paths.root)
    if (!doc) return false
    void shell.showItemInFolder(join(paths.root, doc.path))
    return true
  })

  // --- assets (image paste / drop → assets/) ----------------------------------------
  ipcMain.handle(
    'assets:save',
    (_e: IpcMainInvokeEvent, fileName: string, dataUrl: string): string => {
      const m = /^data:(.+?);base64,(.+)$/.exec(dataUrl)
      if (!m) throw new Error('assets:save needs a data: URL')
      const buf = Buffer.from(m[2] ?? '', 'base64')
      return saveAsset(fileName, buf, requireNotes())
    }
  )
  ipcMain.handle('assets:path', (_e: IpcMainInvokeEvent, vaultRel: string): string =>
    resolveAsset(vaultRel, requireNotes())
  )

  // --- AI --------------------------------------------------------------------------
  ipcMain.handle('ai:providers', () => providerStatus())
  ipcMain.handle(
    'ai:classify',
    (_e: IpcMainInvokeEvent, raw: string, kind: NoteKind): Promise<ClassifyResult> =>
      classify({ raw, kind, projects: vaultConfigured() ? listProjects(requireNotes()) : [] })
  )
  ipcMain.handle(
    'ai:summarize',
    (_e: IpcMainInvokeEvent, text: string): Promise<{ text: string; provider: string }> => summarize(text)
  )
  ipcMain.handle('ai:speak', (_e: IpcMainInvokeEvent, text: string): Promise<boolean> => speak(text))
  ipcMain.handle('ai:stop-speak', (): boolean => {
    stopSpeak()
    return true
  })

  // --- voice / STT -------------------------------------------------------------------
  ipcMain.handle('stt:transcribe', (_e: IpcMainInvokeEvent, wavPath: string): Promise<SttResult> =>
    transcribe(wavPath)
  )
  ipcMain.handle(
    'stt:pick-audio',
    async (): Promise<{ path: string; transcript: SttResult } | { error: string }> => {
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
    }
  )

  // --- meeting import (manual recording + Teams .vtt) ----------------------------------
  ipcMain.handle(
    'meeting:import',
    (_e: IpcMainInvokeEvent, input: MeetingImportInput): InboxItem => {
      const paths = requireNotes()
      const cues = input.format === 'vtt' ? parseVtt(input.text) : null
      const raw =
        input.format === 'vtt' && cues
          ? meetingToMarkdown(cues, input.title ?? 'Meeting notes')
          : input.text.trim()
      const { item, path } = writeInboxItem(
        { kind: 'meeting', raw, projectHint: 'auto', source: input.source ?? 'meeting' },
        paths
      )
      indexFile(path, `inbox/${item.id}.md`)
      void processInboxItem(item.id).catch((err) => console.error('[meeting] route failed:', err))
      return item
    }
  )
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
