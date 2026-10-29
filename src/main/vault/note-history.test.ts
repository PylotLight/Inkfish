import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearHistory,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
  prepareRestore,
  saveSnapshot
} from './note-history'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'inkfish-history-'))
  process.env['INKFISH_DATA'] = dataDir
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env['INKFISH_DATA']
})

const A = 'Work/plan.md'

describe('note history', () => {
  test('saves snapshots newest-first and lists summaries', () => {
    saveSnapshot(A, 'v1', 'ai-apply', 'Tidy formatting')
    saveSnapshot(A, 'v2', 'ai-apply', 'Fix typos')
    const list = listSnapshots(A)
    expect(list).toHaveLength(2)
    expect(list[0]!.label).toBe('Fix typos')
    expect(list[0]!.preview).toBe('v2')
    expect(list[1]!.preview).toBe('v1')
    // Other notes have no history.
    expect(listSnapshots('Work/other.md')).toHaveLength(0)
  })

  test('skips a snapshot identical to the newest one', () => {
    const first = saveSnapshot(A, 'same', 'ai-apply', 'Tidy formatting')
    const again = saveSnapshot(A, 'same', 'ai-apply', 'Tidy formatting')
    expect(first?.id).toBe(again?.id)
    expect(listSnapshots(A)).toHaveLength(1)
  })

  test('caps the history so it cannot grow unbounded', () => {
    for (let i = 0; i < 60; i++) saveSnapshot(A, `text ${i}`, 'ai-apply', 'Custom')
    expect(listSnapshots(A)).toHaveLength(50)
  })

  test('restore snapshots the current text first, then returns the old one', () => {
    saveSnapshot(A, 'source', 'ai-apply', 'Tidy formatting')
    const id = listSnapshots(A)[0]!.id
    const r = prepareRestore(A, id, 'current')
    expect(r?.markdown).toBe('source')
    expect(r?.savedCurrent).toBe(true)
    const list = listSnapshots(A)
    expect(list[0]!.label).toBe('Before restore')
    expect(list[0]!.preview).toBe('current')
    // Restoring again from the same snapshot: the current text IS that snapshot, so no-op.
    expect(prepareRestore(A, id, 'source')).toBeNull()
  })

  test('restore is a no-op when the snapshot equals the current text', () => {
    saveSnapshot(A, 'current', 'ai-apply', 'Summarise')
    const id = listSnapshots(A)[0]!.id
    expect(prepareRestore(A, id, 'current')).toBeNull()
  })

  test('unknown ids resolve to null', () => {
    expect(prepareRestore(A, 'nope', 'x')).toBeNull()
    expect(getSnapshot(A, 'nope')).toBeNull()
  })

  test('delete and clear', () => {
    saveSnapshot(A, 'v1', 'ai-apply', 'Tidy formatting')
    saveSnapshot(A, 'v2', 'ai-apply', 'Fix typos')
    const [v2] = listSnapshots(A)
    if (v2) deleteSnapshot(A, v2.id)
    expect(listSnapshots(A).map((s) => s.preview)).toEqual(['v1'])
    clearHistory(A)
    expect(listSnapshots(A)).toHaveLength(0)
  })

  test('nested note ids (slash paths) are isolated', () => {
    saveSnapshot('a/b/c.md', 'deep', 'ai-apply', 'Tidy formatting')
    saveSnapshot('a/b.md', 'shallow', 'ai-apply', 'Tidy formatting')
    expect(getSnapshot('a/b/c.md', listSnapshots('a/b/c.md')[0]!.id)?.markdown).toBe('deep')
    expect(getSnapshot('a/b.md', listSnapshots('a/b.md')[0]!.id)?.markdown).toBe('shallow')
  })
})
