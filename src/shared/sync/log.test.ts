import { describe, expect, test } from 'bun:test'
import { appendCapped, summarize, shortError, SYNC_LOG_CAP, type SyncLogEntry } from './log'

const base: SyncLogEntry = { at: 1, peer: 'Mac', kind: 'sync' }

describe('sync log', () => {
  test('summarize counts', () => {
    expect(summarize(base)).toBe('nothing to do')
    expect(summarize({ ...base, pulled: 12, pushed: 3 })).toBe('↓12 · ↑3')
    expect(summarize({ ...base, pulled: 1, conflicts: ['a.md', 'b.md'] })).toBe('↓1 · 2 conflicts')
    expect(summarize({ ...base, kind: 'error', message: 'boom' })).toBe('boom')
    expect(summarize({ ...base, kind: 'heal', message: 'merged 1 folder(s)' })).toBe('merged 1 folder(s)')
  })

  test('append caps at 100, oldest-first', () => {
    let log: SyncLogEntry[] = []
    for (let i = 0; i < SYNC_LOG_CAP + 10; i++) log = appendCapped(log, { ...base, at: i })
    expect(log).toHaveLength(SYNC_LOG_CAP)
    expect(log[0]!.at).toBe(10)
    expect(log[log.length - 1]!.at).toBe(SYNC_LOG_CAP + 9)
  })

  test('shortError is one line and capped', () => {
    expect(shortError(new Error('a\nb'))).toBe('a')
    expect(shortError('x'.repeat(500))).toHaveLength(300)
  })
})
