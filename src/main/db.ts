import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import type { NoteDoc, NoteEntry, NoteKind, NoteStatus, SearchResult } from '../shared/types'
import { parseFrontmatter, slugToId } from './vault'
import { parseTags } from '../shared/tags'
import { ftsQuery } from '../shared/routing'

/**
 * SQLite index (main process only). Plain `.md` files stay the source of
 * truth — this is a cache for FTS search + metadata. Rebuildable any time
 * by re-scanning the vault.
 *
 * Backend: `node:sqlite` (built into modern Node/Electron) with an FTS5
 * table. If unavailable, falls back to an in-memory index with substring
 * search so the app still works.
 *
 * `note_embeddings` stores JSON vectors for now; the `sqlite-vec` extension
 * can replace the column later without changing this interface (related /
 * project-suggest run cosine similarity in JS either way).
 */

export interface NoteRow {
  id: string
  path: string
  title: string
  frontmatterTitle?: string | null
  kind: NoteKind
  status: NoteStatus
  projectId: string | null
  inboxId: string | null
  tags: string
  body: string
  createdAt: number
  updatedAt: number
  /** File bytes (from fs stat at index time). */
  size: number
  embedding: string | null
}

interface Backend {
  upsert(row: NoteRow): void
  remove(id: string): void
  get(id: string): NoteRow | null
  list(projectId?: string | null, limit?: number): NoteRow[]
  search(query: string, limit: number): Array<NoteRow & { rank: number }>
  countInbox(): number
  clear(): void
  /** Every indexed vault rel (staging included). */
  paths(): string[]
  /** Vault rels whose indexed body contains any of `needles` (already lowercased). */
  bodiesContaining(needles: string[]): string[]
  /** Drop every row at `rel` or under `rel/` (a file or a whole folder). */
  removePath(rel: string): number
  /** Vault notes matching any of `terms` (stems, prefix match), best first. Staging excluded. */
  termHits(terms: string[], limit: number): RouteHitRow[]
  /** path/kind/tags of every vault note (staging excluded). */
  meta(): Array<{ path: string; kind: string; tags: string }>
}

export interface RouteHitRow {
  path: string
  title: string
  kind: string
  tags: string
  body: string
}

/** Cast node:sqlite rows (Record<string, SQLOutputValue>) to our row shape. */
function rows<T>(v: unknown): T {
  return v as T
}

function rowToEntry(r: NoteRow): NoteEntry {
  const body = r.body.replace(/^#\s+.*\n/, '').trim()
  return {
    id: r.id,
    path: r.path,
    title: r.title,
    ...(r.frontmatterTitle ? { frontmatterTitle: r.frontmatterTitle } : {}),
    kind: r.kind,
    status: r.status,
    projectId: r.projectId,
    inboxId: r.inboxId,
    tags: r.tags ? JSON.parse(r.tags) : [],
    snippet: body.slice(0, 220),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    size: r.size ?? 0
  }
}

// --- node:sqlite backend ---------------------------------------------------------

function createSqliteBackend(dbPath: string): Backend | null {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('node:sqlite') as typeof import('node:sqlite')
    const db = new mod.DatabaseSync(dbPath)
    sqliteHandle = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        frontmatterTitle TEXT,
        kind TEXT NOT NULL DEFAULT 'text',
        status TEXT NOT NULL DEFAULT 'inbox',
        projectId TEXT,
        inboxId TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        embedding TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, body, tags, content='notes', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, body, tags)
          VALUES (new.rowid, new.title, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
          VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
          VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        INSERT INTO notes_fts(rowid, title, body, tags)
          VALUES (new.rowid, new.title, new.body, new.tags);
      END;
      CREATE TABLE IF NOT EXISTS note_embeddings (
        noteId TEXT PRIMARY KEY,
        vec TEXT NOT NULL,
        dims INTEGER NOT NULL DEFAULT 0
      );
    `)
    // Migrate older DBs that predate the `size` and portable title columns.
    try {
      const cols = db.prepare(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'size')) {
        db.exec(`ALTER TABLE notes ADD COLUMN size INTEGER NOT NULL DEFAULT 0`)
      }
      if (!cols.some((c) => c.name === 'frontmatterTitle')) {
        db.exec(`ALTER TABLE notes ADD COLUMN frontmatterTitle TEXT`)
      }
    } catch {
      // fresh table already has it
    }
    const upsertStmt = db.prepare(`
      INSERT INTO notes (id, path, title, frontmatterTitle, kind, status, projectId, inboxId, tags, body, createdAt, updatedAt, size, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path=excluded.path, title=excluded.title, frontmatterTitle=excluded.frontmatterTitle,
        kind=excluded.kind, status=excluded.status,
        projectId=excluded.projectId, inboxId=excluded.inboxId, tags=excluded.tags,
        body=excluded.body, createdAt=excluded.createdAt, updatedAt=excluded.updatedAt,
        size=excluded.size, embedding=excluded.embedding
    `)
    const getStmt = db.prepare('SELECT * FROM notes WHERE id = ?')
    const listStmt = db.prepare('SELECT * FROM notes ORDER BY updatedAt DESC LIMIT ?')
    const listByProject = db.prepare('SELECT * FROM notes WHERE projectId = ? ORDER BY updatedAt DESC LIMIT ?')
    const listInbox = db.prepare(
      "SELECT * FROM notes WHERE status IN ('inbox','processing') ORDER BY updatedAt DESC LIMIT ?"
    )
    const delStmt = db.prepare('DELETE FROM notes WHERE id = ?')
    const countStmt = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'inbox'")
    const clearStmt = db.prepare('DELETE FROM notes')
    const pathsStmt = db.prepare('SELECT path FROM notes')
    const delPathStmt = db.prepare('DELETE FROM notes WHERE path = ? OR substr(path, 1, ?) = ?')
    const metaStmt = db.prepare(
      "SELECT path, kind, tags FROM notes WHERE path NOT LIKE 'inbox/%' AND path NOT LIKE 'daily/%'"
    )
    // Title counts most, then tags, then body (bm25 column weights).
    const hitsStmt = db.prepare(`
      SELECT n.path, n.title, n.kind, n.tags, n.body FROM notes n
      JOIN notes_fts ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH ? AND n.path NOT LIKE 'inbox/%' AND n.path NOT LIKE 'daily/%'
      ORDER BY bm25(notes_fts, 4.0, 1.0, 2.0) LIMIT ?`)
    return {
      upsert: (r) =>
        upsertStmt.run(
          r.id,
          r.path,
          r.title,
          r.frontmatterTitle ?? null,
          r.kind,
          r.status,
          r.projectId,
          r.inboxId,
          r.tags,
          r.body,
          r.createdAt,
          r.updatedAt,
          r.size,
          r.embedding
        ),
      remove: (id) => void delStmt.run(id),
      get: (id) => rows<NoteRow | undefined>(getStmt.get(id)) ?? null,
      list: (projectId, limit = 200) => {
        if (projectId === 'inbox') return rows<NoteRow[]>(listInbox.all(limit))
        if (projectId) return rows<NoteRow[]>(listByProject.all(projectId, limit))
        return rows<NoteRow[]>(listStmt.all(limit))
      },
      search: (query, limit) => {
        try {
          const rows_ = rows<Array<NoteRow & { rank: number }>>(
            db
              .prepare(
                `SELECT n.*, rank AS rank FROM notes n
               JOIN notes_fts ON notes_fts.rowid = n.rowid
               WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`
              )
              .all(query, limit)
          )
          return rows_
        } catch {
          const like = `%${query.replace(/[%_]/g, '')}%`
          return rows<Array<NoteRow & { rank: number }>>(
            db
              .prepare(
                'SELECT *, 0 AS rank FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY updatedAt DESC LIMIT ?'
              )
              .all(like, like, limit) ?? []
          )
        }
      },
      countInbox: () => (countStmt.get() as { n: number }).n,
      clear: () => void clearStmt.run(),
      paths: () => rows<Array<{ path: string }>>(pathsStmt.all()).map((r) => r.path),
      bodiesContaining: (needles) => {
        if (needles.length === 0) return []
        // SQLite's lower() only folds ASCII: non-ASCII needles are matched in JS instead.
        // eslint-disable-next-line no-control-regex
        const ascii = needles.every((n) => /^[\x00-\x7f]*$/.test(n))
        if (!ascii) {
          const all = rows<Array<{ path: string; body: string }>>(db.prepare('SELECT path, body FROM notes').all())
          return all.filter((r) => bodyHas(r.body, needles)).map((r) => r.path)
        }
        const where = needles.map(() => 'instr(lower(body), ?) > 0').join(' OR ')
        return rows<Array<{ path: string }>>(db.prepare(`SELECT path FROM notes WHERE ${where}`).all(...needles)).map(
          (r) => r.path
        )
      },
      removePath: (rel) => {
        const prefix = `${rel}/`
        return Number(delPathStmt.run(rel, prefix.length, prefix).changes ?? 0)
      },
      termHits: (terms, limit) => {
        const q = ftsQuery(terms)
        if (!q) return []
        try {
          return rows<RouteHitRow[]>(hitsStmt.all(q, limit))
        } catch {
          return []
        }
      },
      meta: () => rows<Array<{ path: string; kind: string; tags: string }>>(metaStmt.all())
    }
  } catch (err) {
    console.warn('[db] node:sqlite unavailable, using in-memory index:', String(err))
    try {
      sqliteHandle?.close()
    } catch {
      // ignore
    }
    sqliteHandle = null
    return null
  }
}

function bodyHas(body: string, needles: string[]): boolean {
  const lower = body.toLowerCase()
  return needles.some((n) => lower.includes(n))
}

// --- memory fallback ---------------------------------------------------------------

function createMemoryBackend(): Backend {
  const rows = new Map<string, NoteRow>()
  return {
    upsert: (r) => void rows.set(r.id, r),
    remove: (id) => void rows.delete(id),
    get: (id) => rows.get(id) ?? null,
    list: (projectId, limit = 200) => {
      let all = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      if (projectId === 'inbox') all = all.filter((r) => r.status === 'inbox' || r.status === 'processing')
      else if (projectId) all = all.filter((r) => r.projectId === projectId)
      return all.slice(0, limit)
    },
    search: (query, limit) => {
      const q = query.toLowerCase()
      return [...rows.values()]
        .filter((r) => `${r.title}\n${r.body}\n${r.tags}`.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((r) => ({ ...r, rank: 0 }))
    },
    countInbox: () => [...rows.values()].filter((r) => r.status === 'inbox').length,
    clear: () => rows.clear(),
    paths: () => [...rows.values()].map((r) => r.path),
    bodiesContaining: (needles) => [...rows.values()].filter((r) => bodyHas(r.body, needles)).map((r) => r.path),
    removePath: (rel) => {
      let n = 0
      for (const [id, r] of rows) {
        if (r.path === rel || r.path.startsWith(`${rel}/`)) {
          rows.delete(id)
          n++
        }
      }
      return n
    },
    termHits: (terms, limit) => {
      if (terms.length === 0) return []
      return [...rows.values()]
        .filter((r) => !isStaging(r.path))
        .map((r) => {
          const hay = `${r.title}\n${r.body}\n${r.tags}`.toLowerCase()
          return { r, n: terms.filter((t) => hay.includes(t)).length }
        })
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n || b.r.updatedAt - a.r.updatedAt)
        .slice(0, limit)
        .map(({ r }) => ({ path: r.path, title: r.title, kind: r.kind, tags: r.tags, body: r.body }))
    },
    meta: () =>
      [...rows.values()].filter((r) => !isStaging(r.path)).map((r) => ({ path: r.path, kind: r.kind, tags: r.tags }))
  }
}

function isStaging(path: string): boolean {
  return path.startsWith('inbox/') || path.startsWith('daily/')
}

// --- index API ---------------------------------------------------------------------

let backend: Backend | null = null
let backendKind = 'none'
let sqliteHandle: { close(): void } | null = null

export function openDb(dbPath: string): string {
  closeDb()
  const sqlite = createSqliteBackend(dbPath)
  if (sqlite) {
    backend = sqlite
    backendKind = 'sqlite+fts5'
  } else {
    backend = createMemoryBackend()
    backendKind = 'memory'
  }
  return backendKind
}

/** Release the current index (sqlite handle or memory) — used when the vault moves. */
export function closeDb(): void {
  try {
    sqliteHandle?.close()
  } catch {
    // already closed
  }
  sqliteHandle = null
  backend = null
  backendKind = 'none'
}

function must(): Backend {
  if (!backend) {
    backend = createMemoryBackend()
    backendKind = 'memory'
  }
  return backend
}

export function dbKind(): string {
  return backendKind
}

function titleFromBody(body: string): string {
  const h = /^#\s+(.+)$/m.exec(body)
  if (h?.[1]) return h[1].trim().slice(0, 120)
  return body.split('\n')[0]?.trim().slice(0, 120) || 'Untitled'
}

/** Index (or re-index) one vault `.md` file. */
export function indexFile(absPath: string, vaultRel: string): NoteEntry | null {
  if (!existsSync(absPath)) {
    must().remove(vaultRel)
    return null
  }
  const raw = readFileSync(absPath, 'utf8')
  const [fm, body] = parseFrontmatter(raw)
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const id = str(fm['id']) ?? vaultRel
  const kind = (str(fm['kind']) as NoteKind | null) ?? 'text'
  const status = (str(fm['status']) as NoteStatus | null) ?? (vaultRel.startsWith('inbox/') ? 'inbox' : 'ready')
  const fromFm = str(fm['project'])
  const fromPath = projectFromPath(vaultRel)
  const projectId = fromFm ?? (fromPath ? slugToId(fromPath) : null)
  const inboxId = str(fm['inbox'])
  const frontmatterTitle =
    typeof fm['title'] === 'string' && fm['title'].trim() ? fm['title'].trim().slice(0, 200) : null
  // Inline `[a, b]`, YAML block `- a` lists and plain `a, b` all count (shared/tags.ts).
  const tagList = parseTags(raw)
  let createdAt = str(fm['created']) ? Date.parse(str(fm['created']) as string) : NaN
  // Real filesystem times — imports keep their true age instead of "now".
  let size = 0
  let mtime = Date.now()
  try {
    const st = statSync(absPath)
    size = st.size
    mtime = st.mtimeMs
    if (!Number.isFinite(createdAt)) {
      createdAt = st.birthtimeMs > 0 ? st.birthtimeMs : mtime
    }
  } catch {
    if (!Number.isFinite(createdAt)) createdAt = Date.now()
  }
  const row: NoteRow = {
    id,
    path: vaultRel,
    title: vaultRel.startsWith('inbox/') ? titleFromBody(body) : (frontmatterTitle ?? titleFromBody(body)),
    frontmatterTitle,
    kind,
    status,
    projectId,
    inboxId,
    tags: JSON.stringify(tagList),
    body,
    createdAt,
    updatedAt: mtime,
    size,
    embedding: null
  }
  must().upsert(row)
  return rowToEntry(row)
}

/** Folder-derived project for imported notes (Obsidian trees). Staging
 * (`inbox/`, `daily/`) never becomes a project; legacy `projects/<p>/`
 * maps to `<p>` so pre-migration indexes stay sane. */
export function projectFromPath(vaultRel: string): string | null {
  const parts = vaultRel.split('/')
  if (parts[0] === 'projects' && parts[1]) return parts[1] ?? null
  if (parts[0] === 'inbox' || parts[0] === 'daily') return null
  return parts.length > 1 ? (parts[0] ?? null) : null
}

/** Full notes-home scan: every non-hidden `.md` — our projects plus
 * imported trees (Obsidian vaults). Rebuilds the index from files.
 * Skips the staging namespace (`inbox/`, `daily/`): those live in app data
 * and are indexed separately via `reindexStaging`. */
export function reindexVault(root: string): number {
  must().clear()
  let n = 0
  const walk = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      const rel = relative(root, p)
      const top = rel.split('/')[0]
      if (top === 'inbox' || top === 'daily') continue
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(p)
      } else if (e.name.endsWith('.md') && !e.name.startsWith('.')) {
        if (indexFile(p, relative(root, p))) n++
      }
    }
  }
  walk(root)
  return n
}

/** Index staging (app-data `inbox/` + `daily/`) under the same rel namespace
 * (`inbox/<id>.md`, `daily/YYYY-MM-DD.md`). Does NOT clear — call after
 * `reindexVault` so one boot covers both. */
export function reindexStaging(paths: { inboxDir: string; dailyDir: string }): number {
  let n = 0
  const flat = (dir: string, prefix: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue
      if (indexFile(join(dir, e.name), `${prefix}/${e.name}`)) n++
    }
  }
  flat(paths.inboxDir, 'inbox')
  flat(paths.dailyDir, 'daily')
  return n
}

export function searchNotes(query: string, limit = 50): SearchResult[] {
  if (!query.trim()) return []
  return must()
    .search(query, limit)
    .map((r) => ({ ...rowToEntry(r), rank: r.rank ?? 0 }))
}

export function listNotes(projectId?: string | null, limit = 200): NoteEntry[] {
  return must().list(projectId, limit).map(rowToEntry)
}

export function getNote(id: string, _root: string): NoteDoc | null {
  const row = must().get(id)
  if (!row) return null
  return { ...rowToEntry(row), markdown: row.body }
}

export function removeNote(id: string): void {
  must().remove(id)
}

/**
 * Backlink lookup for a rename/move, straight from the index (no file reads): every vault note's
 * rel (staging `inbox/` / `daily/` left out — they never link into the vault by path) and the ones
 * whose text mentions any of `needles` (case-insensitive). Candidates are a superset; the caller
 * parses links in just those files.
 */
export function linkLookup(needles: string[]): { notes: string[]; candidates: string[] } {
  const vaultOnly = (p: string): boolean => !p.startsWith('inbox/') && !p.startsWith('daily/')
  const lower = [...new Set(needles.map((n) => n.toLowerCase()).filter(Boolean))]
  return {
    notes: must().paths().filter(vaultOnly),
    candidates: must().bodiesContaining(lower).filter(vaultOnly)
  }
}

/** Drop a file (or a folder's worth of notes) from the index by path — trash, rename, move. */
export function removePath(rel: string): number {
  return must().removePath(rel)
}

/**
 * Index one vault path after it appeared (restore, rename, move): a `.md` file, or every `.md`
 * under a folder (dot entries skipped, like `reindexVault`). Returns how many notes were indexed.
 */
export function indexPath(root: string, rel: string): number {
  const abs = join(root, rel)
  let st
  try {
    st = statSync(abs)
  } catch {
    return 0
  }
  if (st.isFile()) return rel.endsWith('.md') && indexFile(abs, rel) ? 1 : 0
  if (!st.isDirectory()) return 0
  let n = 0
  const walk = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md') && indexFile(p, relative(root, p))) n++
    }
  }
  walk(abs)
  return n
}

export function countInbox(): number {
  return must().countInbox()
}

export function saveEmbedding(noteId: string, vec: number[]): void {
  const row = must().get(noteId)
  if (row) {
    row.embedding = JSON.stringify(vec)
    must().upsert(row)
  }
}

/** Cosine-similarity related notes (JS fallback until sqlite-vec lands). */
export function relatedNotes(noteId: string, limit = 5): NoteEntry[] {
  const row = must().get(noteId)
  if (!row?.embedding) return []
  const a: number[] = JSON.parse(row.embedding)
  const scored: Array<{ r: NoteRow; s: number }> = []
  for (const cand of must().list(undefined, 1000)) {
    if (cand.id === noteId || !cand.embedding) continue
    const b: number[] = JSON.parse(cand.embedding)
    if (b.length !== a.length) continue
    let dot = 0,
      na = 0,
      nb = 0
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? 0,
        y = b[i] ?? 0
      dot += x * y
      na += x * x
      nb += y * y
    }
    if (na > 0 && nb > 0) {
      const s = dot / (Math.sqrt(na) * Math.sqrt(nb))
      // Floor: below this the "relation" is noise, not signal.
      if (s >= 0.2) scored.push({ r: cand, s })
    }
  }
  return scored
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map(({ r }) => rowToEntry(r))
}

/** Notes matching the capture's key terms (router candidates). */
export function routeHits(terms: string[], limit = 60): Array<RouteHitRow & { tagList: string[] }> {
  return must()
    .termHits(terms, limit)
    .map((r) => ({ ...r, tagList: safeTags(r.tags) }))
}

/** Every vault note's path/kind/tags (folder profiles + tag vocabulary). */
export function routeMeta(): Array<{ path: string; kind: string; tags: string[] }> {
  return must()
    .meta()
    .map((r) => ({ path: r.path, kind: r.kind, tags: safeTags(r.tags) }))
}

function safeTags(json: string): string[] {
  try {
    const v = JSON.parse(json || '[]') as unknown
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}
