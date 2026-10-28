/**
 * Sync history entries — one per sync session (or notable sync-side event),
 * rendered in Settings › Sync on both apps. Pure helpers live here so Mac
 * and Android log identical shapes; persistence is per-platform.
 */

import type { SyncStageTimings } from './engine'

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
  /** Per-stage elapsed milliseconds for the most recent session represented by this row. */
  stageMs?: SyncStageTimings
  /** human detail — error message, hold reason, heal summary */
  message?: string
  /** Mac `apply` rows: files changed (summed when rows collapse). */
  files?: number
  /** How many back-to-back sessions this row stands for (collapsed). Missing = 1. */
  repeat?: number
}

/** Back-to-back rows from the same peer within this window collapse into one. */
export const COLLAPSE_MS = 5 * 60 * 1000

function sameKind(a: SyncLogEntry, b: SyncLogEntry): boolean {
  if (a.peer !== b.peer || a.kind !== b.kind) return false
  if (a.kind === 'apply') return true
  // Identical errors / holds / no-op syncs repeat on every retry: one row.
  if (a.kind === 'error' || a.kind === 'hold') return a.message === b.message
  if (a.kind === 'sync') return isNoop(a) && isNoop(b)
  return false
}

function isNoop(e: SyncLogEntry): boolean {
  return !e.pulled && !e.pushed && !e.merged && !e.deleted && !e.moved && !e.conflicts?.length
}

/**
 * Append, but fold into the newest row when it's the same peer doing the
 * same thing within `COLLAPSE_MS` (repeated applies, identical errors,
 * no-op syncs): counts add up, `repeat` counts the sessions, `at` moves to
 * the newest. Keeps a busy sync from flooding the history with one row each.
 */
export function appendCollapsed(log: SyncLogEntry[], e: SyncLogEntry, windowMs = COLLAPSE_MS): SyncLogEntry[] {
  const last = log[log.length - 1]
  if (!last || !sameKind(last, e) || e.at - last.at > windowMs || e.at < last.at) return appendCapped(log, e)
  const merged: SyncLogEntry = {
    ...last,
    at: e.at,
    repeat: (last.repeat ?? 1) + 1,
    ...(e.kind === 'apply' ? { files: (last.files ?? 0) + (e.files ?? 0), message: e.message } : {}),
    ...(e.ms !== undefined ? { ms: e.ms } : {}),
    stageMs: e.stageMs
  }
  return [...log.slice(0, -1), merged]
}

export const SYNC_LOG_CAP = 100

/** Append, oldest-first, capped. Returns the new list. */
export function appendCapped(log: SyncLogEntry[], e: SyncLogEntry): SyncLogEntry[] {
  const next = [...log, e]
  return next.length > SYNC_LOG_CAP ? next.slice(next.length - SYNC_LOG_CAP) : next
}

/** One-line summary for the log list, e.g. `↓12 ↑3 · 1 conflict` or the message. */
export function summarize(e: SyncLogEntry): string {
  const times = e.repeat && e.repeat > 1 ? ` (×${e.repeat})` : ''
  if (e.kind === 'apply' && e.files !== undefined)
    return `${e.files} file change${e.files === 1 ? '' : 's'}${e.peer ? ` from ${e.peer}` : ''}${times}`
  if (e.message && (e.kind === 'error' || e.kind === 'hold' || e.kind === 'heal' || e.kind === 'apply'))
    return `${e.message}${times}`
  const parts: string[] = []
  if (e.pulled) parts.push(`↓${e.pulled}`)
  if (e.pushed) parts.push(`↑${e.pushed}`)
  if (e.merged) parts.push(`${e.merged} merged`)
  if (e.moved) parts.push(`${e.moved} moved`)
  if (e.deleted) parts.push(`${e.deleted} deleted`)
  if (e.conflicts?.length) parts.push(`${e.conflicts.length} conflict${e.conflicts.length === 1 ? '' : 's'}`)
  if (parts.length === 0) return e.kind === 'sync' ? `nothing to do${times}` : e.kind
  const head = parts.join(' · ')
  return e.message ? `${head} — ${e.message}` : head
}

/** First line, capped — safe to persist and render. */
export function shortError(err: unknown, cap = 300): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]!.slice(0, cap)
}
