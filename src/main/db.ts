import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import type { NoteDoc, NoteEntry, NoteKind, NoteStatus, SearchResult } from '../shared/types'
import { parseFrontmatter } from './vault'

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
  kind: NoteKind
  status: NoteStatus
  projectId: string | null
  inboxId: string | null
  tags: string
  body: string
  createdAt: number
  updatedAt: number
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
    kind: r.kind,
    status: r.status,
    projectId: r.projectId,
    inboxId: r.inboxId,
    tags: r.tags ? JSON.parse(r.tags) : [],
    snippet: body.slice(0, 220),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
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
        kind TEXT NOT NULL DEFAULT 'text',
        status TEXT NOT NULL DEFAULT 'inbox',
        projectId TEXT,
        inboxId TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL DEFAULT 0,
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
    const upsertStmt = db.prepare(`
      INSERT INTO notes (id, path, title, kind, status, projectId, inboxId, tags, body, createdAt, updatedAt, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path=excluded.path, title=excluded.title, kind=excluded.kind, status=excluded.status,
        projectId=excluded.projectId, inboxId=excluded.inboxId, tags=excluded.tags,
        body=excluded.body, updatedAt=excluded.updatedAt, embedding=excluded.embedding
    `)
    const getStmt = db.prepare('SELECT * FROM notes WHERE id = ?')
    const listStmt = db.prepare('SELECT * FROM notes ORDER BY updatedAt DESC LIMIT ?')
    const listByProject = db.prepare(
      'SELECT * FROM notes WHERE projectId = ? ORDER BY updatedAt DESC LIMIT ?'
    )
    const listInbox = db.prepare(
      "SELECT * FROM notes WHERE status IN ('inbox','processing') ORDER BY updatedAt DESC LIMIT ?"
    )
    const delStmt = db.prepare('DELETE FROM notes WHERE id = ?')
    const countStmt = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'inbox'")
    const clearStmt = db.prepare('DELETE FROM notes')
    return {
      upsert: (r) =>
        upsertStmt.run(
          r.id, r.path, r.title, r.kind, r.status, r.projectId, r.inboxId,
          r.tags, r.body, r.createdAt, r.updatedAt, r.embedding
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
      clear: () => void clearStmt.run()
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
    clear: () => rows.clear()
  }
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
  const [fm, body] = parseFrontmatter(readFileSync(absPath, 'utf8'))
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const id = str(fm['id']) ?? vaultRel
  const kind = (str(fm['kind']) as NoteKind | null) ?? 'text'
  const status = (str(fm['status']) as NoteStatus | null) ?? (vaultRel.startsWith('inbox/') ? 'inbox' : 'ready')
  const projectId = str(fm['project'])
  const inboxId = str(fm['inbox'])
  const tags = Array.isArray(fm['tags']) ? fm['tags'].join(',') : ''
  let createdAt = str(fm['created']) ? Date.parse(str(fm['created']) as string) : NaN
  if (!Number.isFinite(createdAt)) createdAt = Date.now()
  const row: NoteRow = {
    id, path: vaultRel, title: titleFromBody(body), kind, status,
    projectId, inboxId, tags: tags ? JSON.stringify(tags.split(',')) : '[]',
    body, createdAt, updatedAt: Date.now(), embedding: null
  }
  must().upsert(row)
  return rowToEntry(row)
}

/** Full vault re-scan: walks `inbox/` + `projects/` and indexes every `.md`. */
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
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(p)
      } else if (e.name.endsWith('.md') && !e.name.startsWith('.')) {
        if (indexFile(p, relative(root, p))) n++
      }
    }
  }
  walk(join(root, 'inbox'))
  walk(join(root, 'projects'))
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

export function getNote(id: string, root: string): NoteDoc | null {
  const row = must().get(id)
  if (!row) return null
  return { ...rowToEntry(row), markdown: row.body }
}

export function removeNote(id: string): void {
  must().remove(id)
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
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0
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
  return scored.sort((x, y) => y.s - x.s).slice(0, limit).map(({ r }) => rowToEntry(r))
}
