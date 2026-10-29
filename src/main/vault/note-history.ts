import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HistoryRestoreResult, HistorySnapshot, HistorySummary } from '../../shared/note-history'
import { appDataDir } from './appdata'

/**
 * Note history: content snapshots taken before AI rewrites a note, in app data
 * (never the vault — history must not pollute sync/Obsidian/git). One JSON file
 * per note, newest snapshot first, capped so it can't grow unbounded.
 *
 * Restore is lossless by construction: before writing a snapshot back, the note's
 * current text is itself saved as a snapshot, so any restore can be undone.
 */

const HISTORY_DIR = 'ai-history'
const MAX_SNAPSHOTS = 50

interface HistoryFile {
  noteId: string
  snapshots: HistorySnapshot[]
}

function historyPath(noteId: string): string | null {
  const dir = appDataDir()
  if (!dir) return null
  return join(dir, HISTORY_DIR, `${createHash('sha1').update(noteId).digest('hex')}.json`)
}

function readHistory(noteId: string): HistoryFile | null {
  const p = historyPath(noteId)
  if (!p || !existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as HistoryFile
    if (data.noteId !== noteId || !Array.isArray(data.snapshots)) return null
    data.snapshots = data.snapshots.filter(
      (s) => s && typeof s.id === 'string' && typeof s.markdown === 'string'
    )
    return data
  } catch {
    return null
  }
}

function writeHistory(file: HistoryFile): void {
  const p = historyPath(file.noteId)
  if (!p) return
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(file))
}

export function previewOf(markdown: string): string {
  const line = markdown.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return (line ?? '(empty)').slice(0, 80)
}

/**
 * Save one snapshot (newest first). A snapshot identical to the newest one is a no-op —
 * re-applying the same processed text twice is not two different sources.
 */
export function saveSnapshot(noteId: string, markdown: string, via: string, label: string): HistorySnapshot | null {
  const file = readHistory(noteId) ?? { noteId, snapshots: [] }
  const newest = file.snapshots[0]
  if (newest && newest.markdown === markdown) return newest
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
  const snap: HistorySnapshot = { id, at: Date.now(), via, label, markdown }
  file.snapshots = [snap, ...file.snapshots].slice(0, MAX_SNAPSHOTS)
  writeHistory(file)
  return snap
}

export function listSnapshots(noteId: string): HistorySummary[] {
  const file = readHistory(noteId)
  if (!file) return []
  return file.snapshots.map((s) => ({
    id: s.id,
    at: s.at,
    via: s.via,
    label: s.label,
    size: s.markdown.length,
    preview: previewOf(s.markdown)
  }))
}

/** Full text of one snapshot, or null (unknown id / gone). */
export function getSnapshot(noteId: string, id: string): HistorySnapshot | null {
  const file = readHistory(noteId)
  const snap = file?.snapshots.find((s) => s.id === id) ?? null
  return snap ?? null
}

/**
 * Prepare a restore: the note's CURRENT text becomes a snapshot first (so the restore
 * itself is undoable from history), then the chosen snapshot's text is returned for the
 * caller to write. Returns null when the id is unknown or the snapshot equals the current
 * text (nothing to restore).
 */
export function prepareRestore(
  noteId: string,
  id: string,
  currentMarkdown: string
): HistoryRestoreResult | null {
  const file = readHistory(noteId)
  const snap = file?.snapshots.find((s) => s.id === id)
  if (!file || !snap) return null
  if (snap.markdown === currentMarkdown) return null
  // The current text becomes a snapshot first, unless it is already the newest one.
  let savedCurrent = false
  const newest = file.snapshots[0]
  if (!newest || newest.markdown !== currentMarkdown) {
    file.snapshots = [
      {
        id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        via: 'before-restore',
        label: 'Before restore',
        markdown: currentMarkdown
      },
      ...file.snapshots
    ].slice(0, MAX_SNAPSHOTS)
    savedCurrent = true
  }
  writeHistory(file)
  return { markdown: snap.markdown, savedCurrent }
}

export function deleteSnapshot(noteId: string, id: string): void {
  const file = readHistory(noteId)
  if (!file) return
  file.snapshots = file.snapshots.filter((s) => s.id !== id)
  if (file.snapshots.length === 0) {
    const p = historyPath(noteId)
    if (p) rmSync(p, { force: true })
  } else writeHistory(file)
}

export function clearHistory(noteId: string): void {
  const p = historyPath(noteId)
  if (p) rmSync(p, { force: true })
}
