/**
 * Sync history entries — one per sync session (or notable sync-side event),
 * rendered in Settings › Sync on both apps. Pure helpers live here so Mac
 * and Android log identical shapes; persistence is per-platform.
 */

export type SyncLogKind = 'sync' | 'apply' | 'heal' | 'hold' | 'error'

export interface SyncLogEntry {
  /** epoch ms */
  at: number
  /** peer device name ('' for local-only events like a heal) */
  peer: string
  kind: SyncLogKind
  pulled?: number
  pushed?: number
  merged?: number
  conflicts?: string[]
  deleted?: number
  moved?: number
  /** wall time of the session */
  ms?: number
  /** human detail — error message, hold reason, heal summary */
  message?: string
}

export const SYNC_LOG_CAP = 100

/** Append, oldest-first, capped. Returns the new list. */
export function appendCapped(log: SyncLogEntry[], e: SyncLogEntry): SyncLogEntry[] {
  const next = [...log, e]
  return next.length > SYNC_LOG_CAP ? next.slice(next.length - SYNC_LOG_CAP) : next
}

/** One-line summary for the log list, e.g. `↓12 ↑3 · 1 conflict` or the message. */
export function summarize(e: SyncLogEntry): string {
  if (e.message && (e.kind === 'error' || e.kind === 'hold' || e.kind === 'heal' || e.kind === 'apply')) return e.message
  const parts: string[] = []
  if (e.pulled) parts.push(`↓${e.pulled}`)
  if (e.pushed) parts.push(`↑${e.pushed}`)
  if (e.merged) parts.push(`${e.merged} merged`)
  if (e.moved) parts.push(`${e.moved} moved`)
  if (e.deleted) parts.push(`${e.deleted} deleted`)
  if (e.conflicts?.length) parts.push(`${e.conflicts.length} conflict${e.conflicts.length === 1 ? '' : 's'}`)
  if (parts.length === 0) return e.kind === 'sync' ? 'nothing to do' : e.kind
  const head = parts.join(' · ')
  return e.message ? `${head} — ${e.message}` : head
}

/** First line, capped — safe to persist and render. */
export function shortError(err: unknown, cap = 300): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]!.slice(0, cap)
}
