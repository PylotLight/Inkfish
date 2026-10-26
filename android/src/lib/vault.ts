/**
 * Vault I/O on top of `expo-file-system` (legacy string API — present in all
 * SDKs; migrate to the `File`/`Directory` API when it is removed).
 *
 * On-disk layout mirrors the Mac app exactly so a future sync is a plain
 * file copy — `.md` files stay the source of truth:
 *
 *   <doc>/inkfish/vault/...          finalised notes + assets/  (Mac: ~/Inkfish/)
 *   <doc>/inkfish/staging/inbox/…    raw captures               (Mac: app-data staging)
 *   <doc>/inkfish/staging/daily/…    day-log scratch
 *   <doc>/inkfish/staging/undone/…   undone routings
 *
 * V1 has no SQLite index (Mac uses FTS5 + sqlite-vec as a *cache*). Lists and
 * search scan files directly — fine for hundreds of notes, and the Mac
 * re-indexes from files on first sync anyway.
 */
import * as FileSystem from 'expo-file-system/legacy'
import {
  entryFromFile,
  inboxFromFile,
  newId,
  slugify,
  slugToId,
  stringifyFrontmatter,
  type InboxItem,
  type NoteDoc,
  type NoteEntry,
  type NoteKind,
  type NoteSource,
  type NoteStatus,
  type Project
} from './format'
import { bodyOf, frontmatterHead, planSave, relocate, withHead, withTitle } from './notesave'
import { relinkAfterRename } from './relink'
import {
  APP,
  ASSETS,
  DAILY,
  INBOX,
  UNDONE,
  VAULT,
  followMoves,
  idToRel,
  moved,
  noteEntryCache,
  recordMoves
} from './vault/state'
import { ensureTree, mkdir, readText, resetTreeForTests, RESERVED, writeText } from './vault/paths'
import { childDirs, childFiles, mapLimit, projectsFromNames, resolveDirRel } from './vault/fs'
import { entriesFromFiles, listVaultFiles, listVaultIndex, resetScanForTests, scanVault, walkVault } from './vault/scan'
import { resetDaysForTests } from './vault/daily'

export * from './vault/state'
export * from './vault/paths'
export * from './vault/fs'
export * from './vault/scan'
export * from './vault/daily'

// --- projects ---

export async function listProjects(): Promise<Project[]> {
  await ensureTree()
  return projectsFromNames(await childDirs(VAULT))
}

export async function createProject(name: string): Promise<Project> {
  const slug = slugify(name, 32)
  if (!slug || slug === 'untitled') throw new Error('project name is empty')
  await mkdir(`${VAULT}${slug}/`)
  return { id: slugToId(slug), name: slug, dir: slug }
}

// --- inbox ---

export interface InboxWriteInput {
  kind: NoteKind
  raw: string
  projectHint?: string
  source?: NoteSource
  assets?: string[]
}

export async function writeInboxItem(input: InboxWriteInput): Promise<InboxItem> {
  await ensureTree()
  const id = newId('in')
  const createdAt = Date.now()
  const fm = stringifyFrontmatter({
    id,
    kind: input.kind,
    status: 'inbox' satisfies NoteStatus,
    created: new Date(createdAt).toISOString(),
    source: input.source ?? 'android',
    projectHint: input.projectHint ?? 'auto',
    assets: input.assets ?? []
  })
  await writeText(`${INBOX}${id}.md`, `${fm}${input.raw.replace(/\s+$/, '')}\n`)
  return {
    id,
    kind: input.kind,
    raw: input.raw,
    assets: input.assets ?? [],
    status: 'inbox',
    projectHint: input.projectHint ?? 'auto',
    createdAt
  }
}

export async function listInbox(): Promise<InboxItem[]> {
  await ensureTree()
  const files = await childFiles(INBOX)
  const read = await mapLimit(files, 8, async (f): Promise<InboxItem | null> => {
    try {
      return inboxFromFile(f.replace(/\.md$/, ''), await readText(`${INBOX}${f}`))
    } catch {
      return null // skip unreadable captures
    }
  })
  const items = read.filter((i): i is InboxItem => i !== null)
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function setInboxStatus(id: string, status: NoteStatus): Promise<boolean> {
  const uri = `${INBOX}${id}.md`
  const info = await FileSystem.getInfoAsync(uri)
  if (!info.exists) return false
  const { parseFrontmatter } = await import('./format')
  const [fm, body] = parseFrontmatter(await readText(uri))
  fm['status'] = status
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) flat[k] = v
  await writeText(uri, `${stringifyFrontmatter(flat)}${body}`)
  return true
}

// --- routing (rules engine; same output shape as Mac `routeToProject`) ---

export interface RouteInput {
  inboxId: string
  projectName: string
  title: string
  tags: string[]
  markdown: string
  kind: NoteKind
}

export async function routeToProject(input: RouteInput): Promise<{ noteId: string; vaultRel: string }> {
  await ensureTree()
  const slug = slugify(input.projectName, 32)
  await mkdir(`${VAULT}${slug}/`)
  const noteId = newId('n')
  const createdAt = Date.now()
  const day = new Date(createdAt).toISOString().slice(0, 10)
  const base = `${day}-${slugify(input.title)}`
  let name = `${base}.md`
  let i = 1
  while ((await FileSystem.getInfoAsync(`${VAULT}${slug}/${name}`)).exists) {
    i++
    name = `${base} ${i}.md`
  }
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    project: slug,
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  })
  const rel = `${slug}/${name}`
  await writeText(`${VAULT}${rel}`, `${fm}# ${input.title}\n\n${input.markdown.replace(/\s+$/, '')}\n`)
  return { noteId, vaultRel: rel }
}

/** Undo a routing: processed file → staging/undone, inbox item back to `inbox`. */
export async function undoRoute(inboxId: string): Promise<boolean> {
  await ensureTree()
  const rels: string[] = []
  await walkVault(VAULT, '', rels)
  let found = false
  const { parseFrontmatter } = await import('./format')
  for (const rel of rels) {
    try {
      const text = await readText(`${VAULT}${rel}`)
      const [fm] = parseFrontmatter(text)
      if (fm['inbox'] === inboxId) {
        const base = rel.split('/').slice(-1)[0] ?? `${inboxId}.md`
        await writeText(`${UNDONE}${inboxId}-${base}`, text)
        await FileSystem.deleteAsync(`${VAULT}${rel}`, { idempotent: true })
        found = true
      }
    } catch {
      // keep going
    }
  }
  await setInboxStatus(inboxId, 'inbox')
  return found
}

// --- notes ---

export async function noteEntryForRel(rel: string): Promise<NoteEntry | null> {
  const abs = rel.startsWith('inbox/')
    ? `${INBOX}${rel.slice('inbox/'.length)}`
    : rel.startsWith('daily/')
      ? `${DAILY}${rel.slice('daily/'.length)}`
      : `${VAULT}${rel}`
  const info = await FileSystem.getInfoAsync(abs)
  if (!info.exists || info.isDirectory) return null
  try {
    return entryFromFile(rel, await readText(abs), {
      size: info.size ?? 0,
      mtime: info.modificationTime ? info.modificationTime * 1000 : Date.now()
    })
  } catch {
    return null
  }
}

export async function listNotes(projectId?: string | null): Promise<NoteEntry[]> {
  await ensureTree()
  const out = await entriesFromFiles((await scanVault()).files)
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  if (projectId === 'inbox') return out.filter((e) => e.status === 'inbox' || e.status === 'processing')
  if (projectId) return out.filter((e) => e.projectId === projectId)
  return out
}

function absForRel(rel: string): string {
  return rel.startsWith('inbox/')
    ? `${INBOX}${rel.slice('inbox/'.length)}`
    : rel.startsWith('daily/')
      ? `${DAILY}${rel.slice('daily/'.length)}`
      : `${VAULT}${rel}`
}

async function allNoteRels(): Promise<string[]> {
  const rels: string[] = []
  await walkVault(VAULT, '', rels)
  for (const f of await childFiles(INBOX)) rels.push(`inbox/${f}`)
  for (const f of await childFiles(DAILY)) rels.push(`daily/${f}`)
  return rels
}

/** Read one note file as a doc: a stat and a read, in parallel. */
async function docAt(rel: string): Promise<NoteDoc | null> {
  const abs = absForRel(rel)
  try {
    const [info, text] = await Promise.all([FileSystem.getInfoAsync(abs), readText(abs)])
    if (!info.exists || info.isDirectory) return null
    const e = entryFromFile(rel, text, {
      size: info.size ?? 0,
      mtime: info.modificationTime ? info.modificationTime * 1000 : Date.now()
    })
    return { ...e, markdown: bodyOf(text), head: frontmatterHead(text) }
  } catch {
    return null
  }
}

/** Where a note id most likely lives, without touching the disk. */
export function candidateRels(id: string): string[] {
  const out: string[] = []
  const known = idToRel.get(id)
  if (known) out.push(known, followMoves(known))
  if (id.endsWith('.md')) out.push(id, followMoves(id)) // path-id notes (no front matter id)
  out.push(`inbox/${id}.md`) // inbox items open in the editor by their id
  return [...new Set(out)]
}

/**
 * Open a note by id. Used to scan the whole vault one file at a time (two
 * bridge calls per note until it hit the right one) on every open and twice
 * per save. Now: the index says which file, so it's a stat + a read.
 */
export async function getNote(id: string): Promise<NoteDoc | null> {
  // Fast path, verified by the id read back from the file so a stale index can't open the wrong note.
  for (const rel of candidateRels(id)) {
    const doc = await docAt(rel)
    // A path opens the file at that path even when it has a front matter id
    // (rows from a not-yet-read first-launch index carry paths as ids).
    if (doc && (doc.id === id || rel === id)) return doc
  }
  // Slow path (note created outside this index): share/run one parallel index pass.
  const [index, staged] = await Promise.all([
    listVaultIndex(),
    Promise.all([childFiles(INBOX), childFiles(DAILY)]).then(([i, d]) => [
      ...i.map((f) => `inbox/${f}`),
      ...d.map((f) => `daily/${f}`)
    ])
  ])
  const hit = index.notes.find((e) => e.id === id)
  if (hit) return docAt(hit.path)
  for (const rel of staged) {
    const doc = await docAt(rel)
    if (doc && doc.id === id) return doc
  }
  return null
}

/** Tests/bench: forget every in-memory cache, like a fresh app process. */
export function resetMemoryForTests(): void {
  noteEntryCache.clear()
  resetDaysForTests()
  idToRel.clear()
  moved.clear()
  resetScanForTests()
  resetTreeForTests()
  rescanWanted = false
}

export interface SaveContext {
  /** Body the editor opened / last saved (merge base, and how a moved note is found again). */
  base?: string
  /** Path the editor opened the note at. */
  path?: string
  /** Front matter the note had when opened (kept if the note has to be recreated). */
  head?: string
  /** Explicit display-title edit; written into front matter without changing the note body. */
  title?: string
}

/**
 * Save an editor body. Front matter stays byte-for-byte; a change sync made
 * while the note was open is merged rather than overwritten; a note sync moved
 * or deleted under the editor is found again (or recreated) instead of the
 * edit being silently dropped. See `notesave.ts`.
 */
let rescanWanted = false

/** True once after a save wrote more than the note itself (a conflict copy): the index needs a full rescan. */
export function takeRescan(): boolean {
  const r = rescanWanted
  rescanWanted = false
  return r
}

/** The index row for a doc (drops the body), and remember it so the next scan doesn't re-read the file. */
export function entryOfDoc(doc: NoteDoc): NoteEntry {
  const { markdown: _m, head: _h, ...entry } = doc
  if (!doc.path.startsWith('inbox/') && !doc.path.startsWith('daily/')) {
    noteEntryCache.set(doc.path, { size: doc.size, mtime: doc.updatedAt, entry })
    idToRel.set(doc.id, doc.path)
  }
  return entry
}

export async function saveNote(id: string, markdown: string, ctx: SaveContext = {}): Promise<NoteDoc | null> {
  let doc = await getNote(id)
  if (!doc && ctx.path !== undefined && ctx.base !== undefined) {
    // Gone from under the editor: path-id notes (no front matter `id`) lose their id on a move.
    const candidates: Array<{ path: string; body: string }> = []
    for (const rel of await allNoteRels()) {
      try {
        candidates.push({ path: rel, body: bodyOf(await readText(absForRel(rel))) })
      } catch {
        // unreadable — skip
      }
    }
    // A rename this app saw (sync or drawer) wins; else find it by content.
    const followed = followMoves(ctx.path)
    const rel =
      followed !== ctx.path && candidates.some((c) => c.path === followed)
        ? followed
        : relocate(candidates, ctx.base, ctx.path)
    const abs = absForRel(rel)
    const info = await FileSystem.getInfoAsync(abs)
    if (!info.exists) {
      await mkdir(abs.slice(0, abs.lastIndexOf('/') + 1))
      const head = ctx.title?.trim() ? withTitle(ctx.head ?? '', ctx.title) : (ctx.head ?? '')
      await writeText(abs, withHead(head, markdown))
    } else {
      const disk = await readText(abs)
      const titled = ctx.title?.trim() ? withHead(withTitle(frontmatterHead(disk), ctx.title), bodyOf(disk)) : disk
      await writeText(abs, planSave({ path: rel, disk: titled, base: ctx.base, next: markdown }).file)
    }
    const e = await noteEntryForRel(rel)
    if (!e) return null
    const text = await readText(abs)
    return { ...e, markdown: bodyOf(text), head: frontmatterHead(text) }
  }
  if (!doc) return null
  const abs = absForRel(doc.path)
  const original = await readText(abs)
  const disk = ctx.title?.trim()
    ? withHead(withTitle(frontmatterHead(original), ctx.title), bodyOf(original))
    : original
  const plan = planSave({ path: doc.path, disk, base: ctx.base ?? bodyOf(disk), next: markdown })
  await writeText(abs, plan.file)
  if (plan.conflict) {
    const cAbs = absForRel(plan.conflict.path)
    await mkdir(cAbs.slice(0, cAbs.lastIndexOf('/') + 1))
    await writeText(cAbs, plan.conflict.text)
    rescanWanted = true
  }
  doc = await getNote(doc.id)
  return doc
}

export function searchNotesSync(entries: NoteEntry[], query: string): NoteEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return entries.filter((e) => `${e.title}\n${e.snippet}\n${e.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, 50)
}

// --- files: create note / trash ---

function cleanName(name: string, what: string): string {
  const t = name.trim().replace(/^\/+|\/+$/g, '')
  if (!t) throw new Error(`${what} name is empty`)
  if (t.includes('/') || t.includes('\\')) throw new Error(`${what} name can't contain /`)
  if (t === '.' || t === '..') throw new Error(`${what} name is reserved`)
  if (t.startsWith('.')) throw new Error(`${what} name can't start with .`)
  if (t.includes('..')) throw new Error(`${what} name is outside the vault`)
  return t
}

function ensureMd(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name : `${name}.md`
}

/** Create a subfolder inside `parentRel` ('' = vault root). Returns its rel. */
export async function createDir(parentRel: string, name: string): Promise<string> {
  const clean = cleanName(name, 'Folder')
  const parent = await resolveDirRel(parentRel)
  if (parent.split('/').includes('..')) throw new Error('folder is outside the vault')
  const rel = parent ? `${parent}/${clean}` : clean
  if (rel.split('/').includes('..')) throw new Error('folder is outside the vault')
  if (!parent && RESERVED.has(clean.toLowerCase())) throw new Error(`“${clean}” is reserved`)
  const abs = `${VAULT}${rel}/`
  if ((await FileSystem.getInfoAsync(abs)).exists) throw new Error(`“${clean}” already exists`)
  await mkdir(abs)
  return rel
}

const TRASH_VAULT = `${APP}trash/`

async function trashMove(abs: string, rel: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(abs)
  if (!info.exists) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${TRASH_VAULT}${stamp}/${rel}`
  await mkdir(dest.slice(0, dest.lastIndexOf('/') + 1))
  await FileSystem.moveAsync({ from: abs, to: dest })
}

function assertVaultRel(rel: string): void {
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('path is outside the vault')
  const top = rel.split('/')[0]?.toLowerCase()
  if (top === 'inbox' || top === 'daily' || top === 'assets') throw new Error('that folder is managed by the app')
}

/** Trash a single vault note (recoverable in Settings › Trash). */
export async function trashNoteFile(rel: string): Promise<void> {
  assertVaultRel(rel)
  await trashMove(`${VAULT}${rel}`, rel)
}

/** Trash a whole vault folder with everything in it (recoverable). */
export async function trashDir(dirRel: string): Promise<void> {
  assertVaultRel(dirRel)
  await trashMove(`${VAULT}${dirRel}`, dirRel)
}

/** Rename a vault note. `newName` is the bare filename (`Meeting` or `Meeting.md`). Returns the new rel. */
export async function renameNoteFile(oldRel: string, newName: string): Promise<string> {
  assertVaultRel(oldRel)
  const clean = ensureMd(cleanName(newName, 'File'))
  const slash = oldRel.lastIndexOf('/')
  const dir = slash >= 0 ? oldRel.slice(0, slash) : ''
  const next = dir ? `${dir}/${clean}` : clean
  if (next === oldRel) return oldRel
  if ((await FileSystem.getInfoAsync(`${VAULT}${next}`)).exists) throw new Error(`“${clean}” already exists`)
  const info = await FileSystem.getInfoAsync(`${VAULT}${oldRel}`)
  if (!info.exists || info.isDirectory) throw new Error('note not found')
  await FileSystem.moveAsync({ from: `${VAULT}${oldRel}`, to: `${VAULT}${next}` })
  recordMoves([{ from: oldRel, to: next }])
  try {
    await relinkVault(oldRel, next)
  } catch {
    // the rename itself happened; links are best-effort (same as the Mac)
  }
  return next
}

/**
 * Point other notes' `[[wikilinks]]` and relative markdown links at a renamed
 * note (same rewrite as the Mac's rename). Returns the notes it changed.
 */
export async function relinkVault(oldRel: string, newRel: string): Promise<string[]> {
  const files = await listVaultFiles()
  const all = new Set(files)
  const notes: Array<{ path: string; text: string }> = []
  await mapLimit(
    files.filter((p) => p.toLowerCase().endsWith('.md')),
    8,
    async (p) => {
      try {
        notes.push({ path: p, text: await readText(`${VAULT}${p}`) })
      } catch {
        // unreadable — leave it
      }
    }
  )
  const changed = relinkAfterRename(notes, oldRel, newRel, (rel) => all.has(rel))
  for (const n of changed) await writeText(`${VAULT}${n.path}`, n.text)
  return changed.map((n) => n.path)
}

/** Rename a vault folder. Returns the new rel. */
export async function renameDir(oldRel: string, newName: string): Promise<string> {
  assertVaultRel(oldRel)
  const clean = cleanName(newName, 'Folder')
  const slash = oldRel.lastIndexOf('/')
  const parent = slash >= 0 ? oldRel.slice(0, slash) : ''
  const next = parent ? `${parent}/${clean}` : clean
  if (!parent && RESERVED.has(clean.toLowerCase())) throw new Error(`“${clean}” is reserved`)
  if (next === oldRel) return oldRel
  if ((await FileSystem.getInfoAsync(`${VAULT}${next}`)).exists) throw new Error(`“${clean}” already exists`)
  const info = await FileSystem.getInfoAsync(`${VAULT}${oldRel}`)
  if (!info.exists || !info.isDirectory) throw new Error('folder not found')
  await FileSystem.moveAsync({ from: `${VAULT}${oldRel}`, to: `${VAULT}${next}` })
  return next
}

/** Create a note with a chosen filename. Returns the note id (for openNote). */
export async function createNamedNoteFile(dirRel: string, name: string): Promise<string> {
  await ensureTree()
  const clean = ensureMd(cleanName(name, 'File'))
  const resolved = await resolveDirRel(dirRel)
  if (resolved.split('/').includes('..')) throw new Error('folder is outside the vault')
  await mkdir(`${VAULT}${resolved ? `${resolved}/` : ''}`)
  const dot = clean.lastIndexOf('.')
  const base = dot > 0 ? clean.slice(0, dot) : clean
  let file = clean
  let i = 1
  while ((await FileSystem.getInfoAsync(`${VAULT}${resolved ? `${resolved}/` : ''}${file}`)).exists) {
    i++
    file = `${base} ${i}.md`
  }
  const rel = resolved ? `${resolved}/${file}` : file
  const noteId = newId('n')
  const fm = stringifyFrontmatter({ id: noteId, created: new Date().toISOString(), source: 'android' })
  await writeText(`${VAULT}${rel}`, `${fm}\n`)
  return noteId
}

export async function createNoteFile(dirRel: string): Promise<string> {
  await ensureTree()
  const resolved = await resolveDirRel(dirRel)
  if (resolved.split('/').includes('..')) throw new Error('folder is outside the vault')
  await mkdir(`${VAULT}${resolved ? `${resolved}/` : ''}`)
  let name = 'Untitled.md'
  let i = 1
  while ((await FileSystem.getInfoAsync(`${VAULT}${resolved ? `${resolved}/` : ''}${name}`)).exists) {
    i++
    name = `Untitled ${i}.md`
  }
  const rel = resolved ? `${resolved}/${name}` : name
  await writeText(`${VAULT}${rel}`, '')
  return rel
}

// --- assets ---

export async function saveAssetCopy(fromUri: string, ext: string): Promise<string> {
  await ensureTree()
  const now = new Date()
  const dir = `${ASSETS}${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/`
  await mkdir(dir)
  const name = `${newId('a')}${ext || '.bin'}`
  await FileSystem.copyAsync({ from: fromUri, to: `${dir}${name}` })
  return `assets/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${name}`
}
