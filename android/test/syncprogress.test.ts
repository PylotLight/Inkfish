import { describe, expect, test } from 'bun:test'
import { syncIndicator } from '../src/lib/syncstatus'
import type { SyncProgress } from '../src/lib/sync'

const base = { macName: 'Mac', lastSync: null, error: null }
const p = (x: Partial<SyncProgress>): SyncProgress => ({
  stage: 'downloading',
  done: 0,
  total: 0,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: 0,
  stageAt: 0,
  ...x
})

describe('header / drawer indicator with live progress', () => {
  test('downloading shows % and a progress line', () => {
    const ind = syncIndicator(
      {
        ...base,
        phase: 'syncing',
        progress: p({ done: 30, total: 120, bytesDone: 3 << 20, bytesTotal: 12 << 20, stageAt: 0 })
      },
      10_000
    )
    expect(ind.short).toBe('25%')
    expect(ind.pct).toBe(25)
    expect(ind.label).toContain('downloading 30 of 120')
    expect(ind.label).toContain('3.0 MB of 12 MB')
    expect(ind.label).toContain('left')
    expect(ind.spinning).toBe(true)
  })

  test('comparing / applying show the stage, no bar', () => {
    const ind = syncIndicator({ ...base, phase: 'syncing', progress: p({ stage: 'comparing' }) }, 1)
    expect(ind.short).toBe('comparing')
    expect(ind.pct).toBeNull()
  })

  test('no progress (older engine) falls back to plain syncing', () => {
    const ind = syncIndicator({ ...base, phase: 'syncing', progress: null }, 1)
    expect(ind.short).toBe('syncing')
  })
})
