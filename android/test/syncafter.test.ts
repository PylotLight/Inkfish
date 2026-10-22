import { describe, expect, test } from 'bun:test'
import { afterSync, QUIET_AFTER_SYNC_MS } from '../src/lib/syncafter'
import type { SyncReport } from '../src/lib/sync'

const empty: SyncReport = {
  pulled: 0,
  pushed: 0,
  merged: 0,
  conflicts: [],
  deleted: 0,
  moved: 0,
  changedLocal: [],
  movedLocal: []
}

describe('after a sync', () => {
  test('pulls, moves, deletes and case adoptions all refresh the UI right away', () => {
    expect(afterSync({ ...empty, pulled: 3, changedLocal: ['a.md', 'b.md', 'c.md'] }).refresh).toBe(true)
    expect(afterSync({ ...empty, deleted: 1, changedLocal: ['a.md'] }).refresh).toBe(true)
    const mv = afterSync({ ...empty, moved: 1, movedLocal: [{ from: 'a.md', to: 'b.md' }] })
    expect(mv.refresh).toBe(true)
    expect(mv.moves).toEqual([{ from: 'a.md', to: 'b.md' }])
    const ad = afterSync({
      ...empty,
      adopted: 2,
      movedLocal: [
        { from: 'work/a.md', to: 'Work/a.md' },
        { from: 'work/b.md', to: 'Work/b.md' }
      ]
    })
    expect(ad.moves).toHaveLength(2)
    expect(ad.note).toBe('2 renamed to match the Mac')
  })

  test('even a no-op sync refreshes (heal may have moved files), but quietly', () => {
    const r = afterSync(empty)
    expect(r.refresh).toBe(true)
    expect(r.note).toBeNull()
    expect(r.quietMs).toBe(QUIET_AFTER_SYNC_MS)
  })

  test('cleanup is reported', () => {
    expect(afterSync({ ...empty, cleaned: 1 }).note).toBe('1 duplicate copy trashed')
    expect(afterSync({ ...empty, cleaned: 3, adopted: 1 }).note).toBe(
      '1 renamed to match the Mac · 3 duplicate copies trashed'
    )
  })
})
