import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { InteractionManager } from 'react-native'
import { rulesClassify, type InboxItem, type NoteDoc, type NoteEntry, type NoteKind, type Project } from './format'
import * as vault from './vault'
import { purgeTrash } from './trash'

interface Store {
  /** The shell can render: last launch's index (or nothing, first run) is in. Never waits on a vault scan. */
  ready: boolean
  /** The background scan of the vault finished at least once this launch (lists are fresh). */
  indexed: boolean
  error: string | null
  inbox: InboxItem[]
  notes: NoteEntry[]
  projects: Project[]
  /** All vault folders (rel), including empty ones. */
  dirs: string[]
  /** Every daily note summarized, newest day first (Journal + Home Daily; from the saved index at launch). */
  days: vault.DayInfo[]
  /** One day's body, read on demand (Journal pages). */
  readDay: (day: string) => Promise<string>
  refresh: () => Promise<void>
  capture: (raw: string, kind: NoteKind, projectHint: string, assets: string[]) => Promise<InboxItem>
  captureDaily: (raw: string, kind: NoteKind) => Promise<string>
  routeInbox: (id: string, projectName?: string) => Promise<void>
  undoInbox: (id: string) => Promise<void>
  openNote: (id: string) => Promise<NoteDoc | null>
  saveNote: (id: string, markdown: string, ctx?: vault.SaveContext) => Promise<NoteDoc | null>
  newNote: (dir: string, name?: string) => Promise<string>
  createDir: (parentRel: string, name: string) => Promise<string>
  deleteFile: (rel: string) => Promise<void>
  deleteDir: (rel: string) => Promise<void>
  renameFile: (oldRel: string, newName: string) => Promise<string>
  renameDir: (oldRel: string, newName: string) => Promise<string>
  appendDaily: (raw: string, kind: NoteKind) => Promise<string>
  readDaily: () => Promise<{ rel: string; body: string }>
}

const Ctx = createContext<Store | null>(null)

/** Resolve after the current frame has been drawn (and touch handling settled). */
function afterFirstPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      InteractionManager.runAfterInteractions(() => resolve())
    })
  })
}

function sameEntry(a: NoteEntry, b: NoteEntry): boolean {
  return (
    a === b ||
    (a.id === b.id && a.path === b.path && a.updatedAt === b.updatedAt && a.size === b.size && a.title === b.title)
  )
}

function retainArray<T>(previous: T[], next: T[], equal: (a: T, b: T) => boolean = Object.is): T[] {
  return previous.length === next.length && previous.every((item, index) => equal(item, next[index]!)) ? previous : next
}

function sameDay(a: vault.DayInfo, b: vault.DayInfo): boolean {
  return a === b || (a.path === b.path && a.size === b.size && a.updatedAt === b.updatedAt)
}

function sameInboxItem(a: InboxItem, b: InboxItem): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.raw === b.raw &&
    a.status === b.status &&
    a.projectHint === b.projectHint &&
    a.createdAt === b.createdAt &&
    a.assets.length === b.assets.length &&
    a.assets.every((asset, index) => asset === b.assets[index])
  )
}

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [indexed, setIndexed] = useState(false)
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [dirs, setDirs] = useState<string[]>([])
  const [days, setDays] = useState<vault.DayInfo[]>([])
  const refreshTask = useRef<Promise<void> | null>(null)
  const refreshAgain = useRef(false)

  const apply = useCallback((index: vault.VaultIndex, ib: InboxItem[]): void => {
    setProjects((previous) =>
      retainArray(previous, index.projects, (a, b) => a.id === b.id && a.name === b.name && a.dir === b.dir)
    )
    setDirs((previous) => retainArray(previous, index.dirs))
    setInbox((previous) => retainArray(previous, ib, sameInboxItem))
    setNotes((previous) => retainArray(previous, index.notes, sameEntry))
  }, [])

  /** First-launch stat-only index: folders + file names, no inbox (it arrives with the full pass). */
  const applyRough = useCallback((index: vault.VaultIndex): void => {
    setProjects(index.projects)
    setDirs(index.dirs)
    setNotes((previous) => (previous.length ? previous : index.notes))
  }, [])

  /** Swap one saved note's row in place. False when it isn't a plain in-place update. */
  const notesRef = useRef<NoteEntry[]>([])
  notesRef.current = notes
  const patchEntry = useCallback((entry: NoteEntry, openedAt?: string): boolean => {
    if (entry.path.startsWith('inbox/') || entry.path.startsWith('daily/')) return false
    if (openedAt !== undefined && openedAt !== entry.path) return false
    const at = notesRef.current.findIndex((n) => n.path === entry.path)
    if (at < 0 || notesRef.current[at]!.id !== entry.id) return false
    setNotes((previous) => {
      const i = previous.findIndex((n) => n.path === entry.path)
      if (i < 0) return previous
      const next = previous.slice()
      next.splice(i, 1)
      // keep newest-first order
      const j = next.findIndex((n) => n.updatedAt <= entry.updatedAt)
      next.splice(j < 0 ? next.length : j, 0, entry)
      return next
    })
    return true
  }, [])

  const refresh = useCallback((): Promise<void> => {
    if (refreshTask.current) {
      refreshAgain.current = true
      return refreshTask.current
    }
    const task = (async () => {
      do {
        refreshAgain.current = false
        vault.invalidateAttachments()
        try {
          const [index, ib, dayRows] = await Promise.all([
            // Nothing on screen yet (first launch / no saved index): show names as soon as the stat pass is done.
            vault.listVaultIndex(notesRef.current.length === 0 ? { onPartial: applyRough } : {}),
            vault.listInbox(),
            // One flat staging folder; only changed days are re-read.
            vault.listDays().catch(() => null)
          ])
          apply(index, ib)
          if (dayRows) setDays((previous) => retainArray(previous, dayRows, sameDay))
          setError(null)
          // Persist for the next launch's instant drawer (debounced: saves come in bursts).
          if (snapshotTimer.current) clearTimeout(snapshotTimer.current)
          snapshotTimer.current = setTimeout(() => {
            snapshotTimer.current = null
            void vault.saveIndexSnapshot(index, ib, dayRows ?? undefined).catch(() => undefined)
          }, 1500)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } while (refreshAgain.current)
    })()
    refreshTask.current = task
    void task
      .finally(() => {
        if (refreshTask.current === task) refreshTask.current = null
      })
      .catch(() => undefined)
    return task
  }, [apply, applyRough])

  // Launch: show the last index at once (one file read), render, THEN scan the
  // vault in the background and swap the fresh lists in. Nothing here blocks
  // the first frame on the file system; trash purge waits until things settle.
  useEffect(() => {
    let live = true
    void (async () => {
      const snap = await vault.loadIndexSnapshot()
      if (!live) return
      if (snap) {
        apply({ notes: snap.notes, dirs: snap.dirs, projects: snap.projects }, snap.inbox)
        setDays(vault.cachedDays())
      }
      setReady(true)
      await afterFirstPaint()
      if (!live) return
      try {
        await vault.ensureTree()
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
      if (!live) return
      setIndexed(true)
      setTimeout(() => void purgeTrash().catch(() => undefined), 10_000)
    })()
    return () => {
      live = false
    }
  }, [apply, refresh])

  const capture = useCallback(
    async (raw: string, kind: NoteKind, projectHint: string, assets: string[]) => {
      const item = await vault.writeInboxItem({ kind, raw, projectHint, source: 'android', assets })
      // Non-blocking auto-route with the rules engine (Mac does this in main).
      await vault.setInboxStatus(item.id, 'processing')
      try {
        const fresh = await vault.listProjects()
        const r = rulesClassify(raw, kind, fresh, projectHint)
        await vault.routeToProject({
          inboxId: item.id,
          projectName: r.projectName,
          title: r.title,
          tags: r.tags,
          markdown: r.markdown,
          kind
        })
        await vault.setInboxStatus(item.id, 'ready')
      } catch {
        await vault.setInboxStatus(item.id, 'inbox')
      }
      await refresh()
      return item
    },
    [refresh]
  )

  const captureDaily = useCallback(
    async (raw: string, kind: NoteKind) => {
      const rel = await vault.appendDaily(raw, kind)
      await refresh()
      return rel
    },
    [refresh]
  )

  const routeInbox = useCallback(
    async (id: string, projectName?: string) => {
      const items = await vault.listInbox()
      const item = items.find((i) => i.id === id)
      if (!item) throw new Error(`inbox item ${id} not found`)
      await vault.undoRoute(id)
      const fresh = await vault.listProjects()
      const r = rulesClassify(item.raw, item.kind, fresh, projectName ?? item.projectHint)
      await vault.routeToProject({
        inboxId: id,
        projectName: r.projectName,
        title: r.title,
        tags: r.tags,
        markdown: r.markdown,
        kind: item.kind
      })
      await vault.setInboxStatus(id, 'ready')
      await refresh()
    },
    [refresh]
  )

  const undoInbox = useCallback(
    async (id: string) => {
      await vault.undoRoute(id)
      await refresh()
    },
    [refresh]
  )

  const value = useMemo<Store>(
    () => ({
      ready,
      indexed,
      error,
      inbox,
      notes,
      projects,
      dirs,
      days,
      readDay: (day) => vault.readDay(day),
      refresh,
      capture,
      captureDaily,
      routeInbox,
      undoInbox,
      openNote: (id) => vault.getNote(id),
      saveNote: async (id, md, ctx) => {
        const d = await vault.saveNote(id, md, ctx)
        // Autosave fires every ~700 ms of typing: patch the one row instead of
        // rescanning the whole vault. Anything unusual still gets a full refresh.
        if (d && !vault.takeRescan() && patchEntry(vault.entryOfDoc(d), ctx?.path)) return d
        await refresh()
        return d
      },
      newNote: async (dir, name) => {
        const id = name?.trim() ? await vault.createNamedNoteFile(dir, name.trim()) : await vault.createNoteFile(dir)
        await refresh()
        return id
      },
      createDir: async (parentRel, name) => {
        const rel = await vault.createDir(parentRel, name)
        await refresh()
        return rel
      },
      deleteFile: async (rel) => {
        await vault.trashNoteFile(rel)
        await refresh()
      },
      deleteDir: async (rel) => {
        await vault.trashDir(rel)
        await refresh()
      },
      renameFile: async (oldRel, newName) => {
        const next = await vault.renameNoteFile(oldRel, newName)
        await refresh()
        return next
      },
      renameDir: async (oldRel, newName) => {
        const next = await vault.renameDir(oldRel, newName)
        await refresh()
        return next
      },
      appendDaily: captureDaily,
      readDaily: () => vault.readDaily()
    }),
    [
      ready,
      indexed,
      error,
      inbox,
      notes,
      projects,
      dirs,
      days,
      refresh,
      patchEntry,
      capture,
      captureDaily,
      routeInbox,
      undoInbox
    ]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
