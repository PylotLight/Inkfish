import * as FileSystem from 'expo-file-system/legacy'
import { entryFromFile, type InboxItem, type NoteEntry, type Project } from '../format'
import { APP, VAULT, idToRel, noteEntryCache, rememberIds } from './state'
import { ensureTree, mkdir, readText, RESERVED, SKIP_STAT, writeText } from './paths'
import { fileLabel, foldName, hasCaseDupes, mapLimit, mergeCaseDuplicates, projectsFromNames } from './fs'
import { dayCache, type DayInfo } from './daily'

interface ScannedFile {
  rel: string
  uri: string
  size: number
  mtime: number
}

export interface VaultScan {
  files: ScannedFile[]
  dirs: string[]
  /** Non-note files (images, audio…), vault-relative — recorded without a stat. */
  attachments: string[]
  /** Some folder holds two names that differ only by case (needs a heal). */
  caseDupes: boolean
}

type ScannedChild =
  { kind: 'dir'; uri: string; rel: string } | { kind: 'file'; file: ScannedFile } | { kind: 'attachment'; rel: string }

/**
 * One bounded-concurrency inventory pass for notes, folders and attachments.
 * Every folder of a level is listed (the v0.2.14 walk only descended into the
 * first 6 folders of each level and silently dropped the rest — notes went
 * missing from the drawer in bigger vaults). Attachments by extension skip the stat.
 */
export async function scanVault(root = VAULT, relBase = ''): Promise<VaultScan> {
  const files: ScannedFile[] = []
  const dirs: string[] = []
  const attachments: string[] = []
  let caseDupes = false
  let pending = [{ uri: root, rel: relBase }]

  while (pending.length) {
    const parents = pending
    pending = []
    const groups = await mapLimit(parents, 6, async (parent): Promise<ScannedChild[]> => {
      let names: string[]
      try {
        names = await FileSystem.readDirectoryAsync(parent.uri)
      } catch {
        return []
      }
      const visible = names.filter((name) => !name.startsWith('.'))
      // Only what the heal handles (folders + notes; reserved top-level names are never healed).
      const healable = visible.filter((n) => !SKIP_STAT.test(n) && !(parent.rel === '' && RESERVED.has(foldName(n))))
      if (!caseDupes && hasCaseDupes(healable)) caseDupes = true
      const children = await mapLimit(visible, 8, async (name): Promise<ScannedChild | null> => {
        const uri = `${parent.uri}${name}`
        const rel = parent.rel ? `${parent.rel}/${name}` : name
        const top = rel.split('/')[0] ?? ''
        if (top === 'inbox' || top === 'daily') return null
        if (SKIP_STAT.test(name)) return { kind: 'attachment', rel }
        try {
          const info = await FileSystem.getInfoAsync(uri)
          if (!info.exists) return null
          if (info.isDirectory) return { kind: 'dir', uri: `${uri}/`, rel }
          if (!name.endsWith('.md')) return /\.markdown$/i.test(name) ? null : { kind: 'attachment', rel }
          return {
            kind: 'file',
            file: {
              rel,
              uri,
              size: info.size ?? 0,
              mtime: info.modificationTime ? info.modificationTime * 1000 : Date.now()
            }
          }
        } catch {
          return null
        }
      })
      return children.filter((child): child is ScannedChild => child !== null)
    })

    for (const group of groups) {
      for (const child of group) {
        if (child.kind === 'file') {
          files.push(child.file)
          continue
        }
        if (child.kind === 'attachment') {
          attachments.push(child.rel)
          continue
        }
        const top = child.rel.split('/')[0] ?? ''
        // `assets` is scanned for legacy markdown, but never appears in the
        // sidebar. Inbox/daily were skipped above, matching the previous walk.
        if (!RESERVED.has(top.toLowerCase())) dirs.push(child.rel)
        pending.push(child)
      }
    }
  }

  dirs.sort((a, b) => a.localeCompare(b))
  attachments.sort()
  return { files, dirs, attachments, caseDupes }
}

/** Recursive vault walk — every non-hidden `.md` (our notes + imported trees). */
export async function walkVault(dir: string, relBase: string, out: string[]): Promise<void> {
  const scan = await scanVault(dir, relBase)
  out.push(...scan.files.map((file) => file.rel))
}

export async function entriesFromFiles(files: ScannedFile[]): Promise<NoteEntry[]> {
  const entries = await mapLimit(files, 8, async (file): Promise<NoteEntry | null> => {
    const cached = noteEntryCache.get(file.rel)
    if (cached && cached.size === file.size && cached.mtime === file.mtime) return cached.entry
    try {
      const entry = entryFromFile(file.rel, await readText(file.uri), { size: file.size, mtime: file.mtime })
      noteEntryCache.set(file.rel, { size: file.size, mtime: file.mtime, entry })
      return entry
    } catch {
      noteEntryCache.delete(file.rel)
      return null
    }
  })
  const present = new Set(files.map((file) => file.rel))
  for (const path of noteEntryCache.keys()) {
    if (!present.has(path)) noteEntryCache.delete(path)
  }
  return entries.filter((entry): entry is NoteEntry => entry !== null)
}

/** Every folder in the vault (rel paths), app-managed ones excluded — so empty folders still show in the sidebar. */
export async function listDirs(): Promise<string[]> {
  await ensureTree()
  return (await scanVault()).dirs
}

export interface VaultIndex {
  notes: NoteEntry[]
  projects: Project[]
  dirs: string[]
}

let indexTask: Promise<VaultIndex> | null = null

/**
 * Load all sidebar/store data from one filesystem inventory. Concurrent callers
 * share one pass. `onPartial` (first launch, no saved index) gets a stat-only
 * index — file names as titles, paths as ids — before every note is read, so
 * the drawer fills in seconds instead of after the last file read.
 */
export function listVaultIndex(opts: { onPartial?: (index: VaultIndex) => void } = {}): Promise<VaultIndex> {
  if (indexTask) return indexTask
  const task = buildVaultIndex(opts.onPartial)
  indexTask = task
  task
    .finally(() => {
      if (indexTask === task) indexTask = null
    })
    .catch(() => undefined)
  return task
}

/** Index row from the stat alone: the file name stands in for the title until the file is read. */
function provisionalEntry(file: ScannedFile): NoteEntry {
  return { ...entryFromFile(file.rel, '', { size: file.size, mtime: file.mtime }), title: fileLabel(file.rel) }
}

async function buildVaultIndex(onPartial?: (index: VaultIndex) => void): Promise<VaultIndex> {
  await ensureTree()
  let scan = await scanVault()
  if (scan.caseDupes) {
    // Heal only when this walk saw `Personal` + `personal` (same rule as sync).
    try {
      await mergeCaseDuplicates()
    } catch {
      // best-effort
    }
    scan = await scanVault()
  }
  const dirs = scan.dirs
  const projects = projectsFromNames(dirs.filter((dir) => !dir.includes('/')))
  if (onPartial) {
    const unread = scan.files.filter((f) => {
      const c = noteEntryCache.get(f.rel)
      return !c || c.size !== f.size || c.mtime !== f.mtime
    }).length
    if (unread > 200) {
      const rough = scan.files.map((f) => noteEntryCache.get(f.rel)?.entry ?? provisionalEntry(f))
      rough.sort((a, b) => b.updatedAt - a.updatedAt)
      onPartial({ notes: rough, dirs, projects })
    }
  }
  const notes = await entriesFromFiles(scan.files)
  notes.sort((a, b) => b.updatedAt - a.updatedAt)
  rememberIds(notes)
  attachmentsTask = Promise.resolve(scan.attachments.filter((p) => !/\.(md|markdown|txt)$/i.test(p)))
  return { notes, dirs, projects }
}

// --- persisted index snapshot ------------------------------------------------------
// The drawer, Home and search all read the note index. Building it from files
// means a stat per note (and a read per changed note), so the last index is
// kept on disk and shown immediately on launch; the scan then only re-reads
// what changed (size/mtime) and swaps the fresh index in. Files stay the truth:
// a missing or corrupt snapshot just means one full scan. Not synced (lives
// outside vault/ and staging/).

const INDEX_SNAPSHOT = `${APP}.cache/index-v1.json`

export interface IndexSnapshot {
  v: 1
  savedAt: number
  notes: NoteEntry[]
  dirs: string[]
  projects: Project[]
  inbox: InboxItem[]
  attachments?: string[]
  /** Daily-note summaries (Journal / Home Daily) — optional so older snapshots still load. */
  days?: DayInfo[]
}

function seedFromSnapshot(snap: IndexSnapshot): void {
  for (const e of snap.notes) {
    if (!noteEntryCache.has(e.path)) noteEntryCache.set(e.path, { size: e.size, mtime: e.updatedAt, entry: e })
  }
  if (idToRel.size === 0) rememberIds(snap.notes)
  if (!attachmentsTask && snap.attachments) attachmentsTask = Promise.resolve(snap.attachments)
  if (Array.isArray(snap.days)) {
    for (const d of snap.days) if (!dayCache.has(d.path)) dayCache.set(d.path, d)
  }
}

/** Last launch's index (one file read), or null. Seeds the per-file cache so the next scan only reads changes. */
export async function loadIndexSnapshot(): Promise<IndexSnapshot | null> {
  try {
    const raw = JSON.parse(await readText(INDEX_SNAPSHOT)) as Partial<IndexSnapshot>
    if (
      raw.v !== 1 ||
      !Array.isArray(raw.notes) ||
      !Array.isArray(raw.dirs) ||
      !Array.isArray(raw.projects) ||
      !Array.isArray(raw.inbox)
    )
      return null
    const snap = raw as IndexSnapshot
    seedFromSnapshot(snap)
    return snap
  } catch {
    return null
  }
}

export async function saveIndexSnapshot(index: VaultIndex, inbox: InboxItem[], days?: DayInfo[]): Promise<void> {
  const snap: IndexSnapshot = {
    v: 1,
    savedAt: Date.now(),
    notes: index.notes,
    dirs: index.dirs,
    projects: index.projects,
    inbox,
    attachments: attachmentsTask ? await attachmentsTask : undefined,
    ...(days ? { days } : {})
  }
  await mkdir(`${APP}.cache/`)
  const tmp = `${INDEX_SNAPSHOT}.tmp`
  await writeText(tmp, JSON.stringify(snap))
  await FileSystem.moveAsync({ from: tmp, to: INDEX_SNAPSHOT })
}

// --- every vault file (notes + attachments) ---------------------------------------

/** Vault-relative paths of every non-hidden file in the vault (any type). */
export async function listVaultFiles(): Promise<string[]> {
  const out: string[] = []
  let pending: Array<{ uri: string; rel: string }> = [{ uri: VAULT, rel: '' }]
  while (pending.length) {
    const batch = pending
    pending = []
    await mapLimit(batch, 6, async (dir) => {
      let names: string[]
      try {
        names = await FileSystem.readDirectoryAsync(dir.uri)
      } catch {
        return
      }
      await mapLimit(
        names.filter((n) => !n.startsWith('.')),
        8,
        async (n) => {
          const rel = dir.rel ? `${dir.rel}/${n}` : n
          try {
            const info = await FileSystem.getInfoAsync(`${dir.uri}${n}`)
            if (!info.exists) return
            if (info.isDirectory) pending.push({ uri: `${dir.uri}${n}/`, rel })
            else out.push(rel)
          } catch {
            // vanished mid-walk
          }
        }
      )
    })
  }
  return out.sort()
}

let attachmentsTask: Promise<string[]> | null = null

/** Non-note files in the vault (images, audio, …) for resolving image refs. Cached until `invalidateAttachments`. */
export function listAttachments(): Promise<string[]> {
  attachmentsTask ??= listVaultFiles()
    .then((all) => all.filter((p) => !/\.(md|markdown|txt)$/i.test(p)))
    .catch(() => [])
  return attachmentsTask
}

export function invalidateAttachments(): void {
  attachmentsTask = null
}

/** Reset the scan/index caches (tests only — keeps `listVaultIndex` honest after fs resets). */
export function resetScanForTests(): void {
  attachmentsTask = null
  indexTask = null
}
