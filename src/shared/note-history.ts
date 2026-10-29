/**
 * Note history contract (shared): content snapshots taken before an AI rewrite lands on a
 * note, kept in app data. The main-process store (src/main/vault/note-history.ts) implements it;
 * the renderer lists / restores / deletes through the `aiApi.history*` preload methods.
 */

export interface HistorySnapshot {
  /** Timestamp-ish unique id. */
  id: string
  /** When the snapshot was taken (ms). */
  at: number
  /** What captured it: `ai-apply` (the source) or `before-restore` (the current text, saved so a restore is undoable). */
  via: string
  /** Human label (the AI action, or "Before restore"). */
  label: string
  markdown: string
}

/** Summary for the list view (no full text). */
export interface HistorySummary {
  id: string
  at: number
  via: string
  label: string
  size: number
  /** First non-blank line of the snapshot. */
  preview: string
}

/** Result of `prepareRestore` on the main side (see the store). */
export interface HistoryRestoreResult {
  /** The snapshot's text, for the caller to write into the note. */
  markdown: string
  /** True when the current text was itself saved as a new snapshot. */
  savedCurrent: boolean
}
