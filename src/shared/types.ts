import type { BrowserWindow } from 'electron'

/**
 * Shared contracts between main ↔ preload ↔ renderer.
 * Everything here is types only, so it is safe to import from any process.
 * Runtime values live in `./config`.
 */

/** A vibrancy material accepted by `win.setVibrancy()`. Derived from Electron's
 * own types so it can never drift from the installed version. */
export type VibrancyName = NonNullable<Parameters<BrowserWindow['setVibrancy']>[0]>

export interface SysInfo {
  platform: NodeJS.Platform
  arch: string
  release: string
  hostname: string
  cpus: number
  totalMem: number
  freeMem: number
}

export interface GlassState {
  platform: NodeJS.Platform
  vibrancy: VibrancyName | null
  transparent: boolean
}

// --- Inkfish domain (types only, safe in any process) ---

/** Raw capture kind from tray popover / global shortcut. */
export type NoteKind = 'text' | 'voice' | 'image' | 'meeting'

/** Lifecycle: inbox dumping ground -> AI-sorted processed note. */
export type NoteStatus = 'inbox' | 'processing' | 'ready' | 'archived'

/** Where a capture came from. */
export type NoteSource = 'tray' | 'popover' | 'meeting' | 'image' | 'import'

export interface Project {
  id: string
  name: string
  /** Vault-relative dir, e.g. `projects/blobfish`. */
  dir: string
  color?: string
}

export interface InboxItem {
  id: string
  kind: NoteKind
  /** Raw user input: text, transcribed voice, image path, meeting transcript ref. */
  raw: string
  /** Optional local asset paths (audio wav, image png). */
  assets?: string[]
  status: NoteStatus
  projectHint?: string
  createdAt: number
}

export interface ProcessedNote {
  id: string
  inboxId: string
  projectId: string
  /** Formatted markdown body. */
  markdown: string
  tags: string[]
  /** Cosine-similarity / FTS helpers stored in sqlite-vec. */
  embedding?: number[]
  createdAt: number
}

// --- IPC payloads ---

export interface InboxAddInput {
  kind: NoteKind
  raw: string
  /** Project id, or 'auto' (default) for the AI router. */
  projectHint?: string
  source?: NoteSource
  /** Vault-relative asset paths already saved via `assets:save`. */
  assets?: string[]
}

export interface VaultInfo {
  /** Absolute vault root, e.g. `/Users/you/Inkfish`. */
  root: string
  inboxDir: string
  projectsDir: string
  assetsDir: string
  dbPath: string
  /** False on true first run — the wizard must pick a location before setup. */
  configured: boolean
  /** True when INKFISH_VAULT owns the location (dev/tests) — picker disabled. */
  managed: boolean
}

/** One row of the notes index: vault path + frontmatter + snippet. */
export interface NoteEntry {
  id: string
  /** Vault-relative path, e.g. `inbox/2026-10-05-abc123.md`. */
  path: string
  title: string
  kind: NoteKind
  status: NoteStatus
  projectId: string | null
  inboxId: string | null
  tags: string[]
  snippet: string
  createdAt: number
  updatedAt: number
  /** File bytes (fs stat at index time). */
  size: number
}

export interface NoteDoc extends NoteEntry {
  markdown: string
}

export interface SearchResult extends NoteEntry {
  rank: number
}

/** Output of `classify()` — which project, what title/tags, formatted body. */
export interface ClassifyResult {
  projectId: string
  projectName: string
  title: string
  tags: string[]
  /** Formatted GFM markdown body (no frontmatter — main adds it). */
  markdown: string
  /** 'apple' | 'rules' — which provider produced this. */
  provider: string
  confidence: number
}

export interface MeetingImportInput {
  /** Raw transcript text, or a `.vtt` / plain-text file dump. */
  text: string
  format: 'text' | 'vtt'
  title?: string
  source?: NoteSource
}

export interface SttResult {
  text: string
  /** 'parakeet' | 'apple' | 'unavailable' */
  provider: string
  segments?: Array<{ start: number; end: number; text: string }>
}
