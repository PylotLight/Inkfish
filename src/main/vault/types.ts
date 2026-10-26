import type { NoteKind, NoteSource } from '../../shared/types'

/**
 * Vault writer (main process only). Plain `.md` files are the source of
 * truth; sqlite (`db.ts`) is just an index.
 *
 * Layout rule: the notes home (vault) holds ONLY finalised outputs — plain
 * note files and folders (a routed note lands in `<vault>/<project>/`, a
 * "project" is just the top-level folder name, no app container dir).
 * Everything working-state lives in the hidden app-data dir: raw inbox
 * captures, day-log scratch, trash, undone routings, index.
 * Never deletes raw inbox files.
 */

export interface VaultPaths {
  /** User-visible notes home: finalised outputs only. */
  root: string
  /** Staging in app data: raw captures, never in the vault. */
  inboxDir: string
  /** Staging in app data: day-log scratch, never in the vault. */
  dailyDir: string
  /** Final attachments in the vault (embedded by finalised notes). */
  assetsDir: string
  /** App-managed index in the hidden app-data dir — never in the notes home. */
  dbPath: string
}

// --- homes: app data (hidden) vs notes (user-visible) ------------------------------
// App data (config, sqlite index, models) lives in the platform app-data dir
// (`app.getPath('userData')` — ~/.config/<app> on Linux, ~/Library/… on mac).
// Override with INKFISH_DATA for dev/tests. The notes home is chosen by the
// user in onboarding (or INKFISH_VAULT) and holds only plain .md + assets.

export interface NoteProfile {
  id: string
  name: string
  root: string
}

export interface MoveOptions {
  /** Name already taken in the destination: throw (default) or pick `Name 2.md`. */
  onConflict?: 'error' | 'rename'
}

/** Move a file or dir into another folder ('' = root). Returns new vaultRel. */
export interface CaseMergeReport {
  dirs: number
  files: number
}

/** Collapse sibling dirs/files that differ only by case, recursively.
 * Survivor spelling is the lowercase fold (or the already-lowercase member),
 * so macOS and Android always agree. Reserved top-level names are skipped.
 * Returns what moved. */
export type TrashScope = 'vault' | 'inbox' | 'daily'

export interface TrashEntry {
  id: string
  originalRel: string
  name: string
  isDir: boolean
  deletedAt: number
  /** Which root originalRel is relative to. Missing on old entries = vault. */
  scope?: TrashScope
}

export interface InboxWriteInput {
  kind: NoteKind
  raw: string
  projectHint?: string
  source?: NoteSource
  assets?: string[]
  /** Route the capture popover previewed (`routeKey`), to flag a different outcome at filing. */
  previewed?: string
}

export interface RouteInput {
  inboxId: string
  projectName: string
  title: string
  tags: string[]
  markdown: string
  kind: NoteKind
}
