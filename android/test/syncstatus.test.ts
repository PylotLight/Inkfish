import { describe, expect, test } from 'bun:test'
import { agoText, syncIndicator, type IndicatorInput } from '../src/lib/syncstatus'

const NOW = new Date(2026, 9, 19, 15, 0, 0).getTime()
const base: IndicatorInput = { phase: 'idle', macName: 'MacBook', lastSync: null, error: null }
const ind = (o: Partial<IndicatorInput>) => syncIndicator({ ...base, ...o }, NOW)

describe('android sync indicator', () => {
  test('unpaired → hidden, tap opens settings', () => {
    const i = ind({ phase: 'unpaired', macName: null })
    expect(i.state).toBe('hidden')
    expect(i.tap).toBe('open')
  })

  test('finding / syncing spin and ignore taps', () => {
    expect(ind({ phase: 'finding' })).toMatchObject({ state: 'connecting', spinning: true, tap: 'none' })
    expect(ind({ phase: 'syncing' })).toMatchObject({
      state: 'syncing',
      spinning: true,
      tap: 'none',
      tone: 'accent',
      label: 'Syncing with MacBook…'
    })
  })

  test('idle with a last sync → synced X ago, tap syncs now', () => {
    const i = ind({ lastSync: NOW - 5 * 60_000 })
    expect(i).toMatchObject({ state: 'synced', short: '5m', tap: 'sync', spinning: false })
    expect(i.label).toBe('Synced with MacBook · 5m ago')
    expect(ind({ lastSync: NOW - 10_000 }).label).toBe('Synced with MacBook · just now')
  })

  test('idle and never synced', () => {
    expect(ind({})).toMatchObject({ state: 'idle', tap: 'sync' })
    expect(ind({}).label).toContain('not synced yet')
  })

  test('offline keeps last-synced time', () => {
    const i = ind({ phase: 'offline', lastSync: NOW - 2 * 3_600_000 })
    expect(i).toMatchObject({ state: 'offline', short: 'offline', tone: 'faint', tap: 'sync' })
    expect(i.label).toBe("MacBook isn't on this Wi-Fi · last synced 2h ago")
  })

  test('error shows message, tap retries', () => {
    const i = ind({ phase: 'error', error: 'timeout' })
    expect(i).toMatchObject({ state: 'error', tone: 'danger', tap: 'sync' })
    expect(i.label).toBe('Sync failed — timeout')
  })

  test('held deletions → review, tap opens settings', () => {
    expect(ind({ phase: 'held', heldCount: 3 })).toMatchObject({
      state: 'held',
      tap: 'open',
      label: '3 deletions waiting for you'
    })
    expect(ind({ phase: 'held', heldCount: 1 }).label).toBe('1 deletion waiting for you')
  })

  test('agoText', () => {
    expect(agoText(NOW - 20_000, NOW)).toBe('just now')
    expect(agoText(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(agoText(NOW - 26 * 3_600_000, NOW)).toBe('Yesterday')
  })
})

describe('android sync indicator: protocol mismatch', () => {
  test('Mac too old → "update Mac", danger, tap opens sync settings', () => {
    const i = ind({ phase: 'outdated', outdated: 'mac' })
    expect(i).toMatchObject({ state: 'outdated', short: 'update Mac', tone: 'danger', tap: 'open', spinning: false })
    expect(i.label).toBe('Update Inkfish on MacBook to keep syncing')
  })

  test('phone too old → "update phone"', () => {
    const i = ind({ phase: 'outdated', outdated: 'phone' })
    expect(i.short).toBe('update phone')
    expect(i.label).toContain('this phone')
  })
})
