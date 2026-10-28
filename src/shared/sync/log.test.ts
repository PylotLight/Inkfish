import { describe, expect, test } from 'bun:test'
import { appendCapped, appendCollapsed, summarize, shortError, SYNC_LOG_CAP, type SyncLogEntry } from './log'

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

  test('back-to-back applies from one phone collapse into one row', () => {
    const apply = (at: number, files: number, peer = 'Pixel'): SyncLogEntry => ({
      at,
      peer,
      kind: 'apply',
      files,
      message: `${files} file change(s) from ${peer}`
    })
    let log: SyncLogEntry[] = []
    log = appendCollapsed(log, apply(1000, 10))
    log = appendCollapsed(log, apply(2000, 11))
    log = appendCollapsed(log, apply(3000, 23))
    expect(log).toHaveLength(1)
    expect(log[0]!.files).toBe(44)
    expect(log[0]!.repeat).toBe(3)
    expect(log[0]!.at).toBe(3000)
    expect(summarize(log[0]!)).toBe('44 file changes from Pixel (×3)')
    // Another peer, or a gap past the window, starts a new row.
    log = appendCollapsed(log, apply(4000, 1, 'Other'))
    log = appendCollapsed(log, apply(4000 + 10 * 60_000, 2, 'Other'))
    expect(log).toHaveLength(3)
    expect(summarize(log[1]!)).toBe('1 file change from Other')
  })

  test('identical errors and no-op syncs collapse; real syncs do not', () => {
    let log: SyncLogEntry[] = []
    log = appendCollapsed(log, { ...base, at: 1, kind: 'error', message: 'offline' })
    log = appendCollapsed(log, { ...base, at: 2, kind: 'error', message: 'offline' })
    log = appendCollapsed(log, { ...base, at: 3 })
    log = appendCollapsed(log, { ...base, at: 4 })
    log = appendCollapsed(log, { ...base, at: 5, pulled: 2 })
    log = appendCollapsed(log, { ...base, at: 6, pulled: 2 })
    expect(log.map((e) => summarize(e))).toEqual(['offline (×2)', 'nothing to do (×2)', '↓2', '↓2'])
  })

  test('collapsed rows keep the newest attempt timing breakdown', () => {
    let log: SyncLogEntry[] = []
    log = appendCollapsed(log, { ...base, at: 1, stageMs: { finding: 80, comparing: 150 } })
    log = appendCollapsed(log, { ...base, at: 2, stageMs: { finding: 120, downloading: 300 } })
    expect(log[0]!.repeat).toBe(2)
    expect(log[0]!.stageMs).toEqual({ finding: 120, downloading: 300 })

    log = appendCollapsed(log, { ...base, at: 3 })
    expect(log[0]!.stageMs).toBeUndefined()
  })
})
