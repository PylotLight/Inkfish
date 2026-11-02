import { describe, expect, test } from 'bun:test'
import {
  hasLoggedOfflineFailure,
  isOfflineFailure,
  offlineRetryDelay,
  shouldSkipAutomaticCheck
} from '../src/lib/syncschedule'
import type { SyncLogEntry } from '../src/lib/sync'

const offline = (at: number, peer = 'Mac'): SyncLogEntry => ({
  at,
  peer,
  kind: 'error',
  message: 'Mac not found on this Wi-Fi'
})

describe('Android offline sync scheduling', () => {
  test('throttles automatic checks but lets explicit manual checks through', () => {
    expect(shouldSkipAutomaticCheck(true, 300, 299)).toBe(true)
    expect(shouldSkipAutomaticCheck(true, 300, 300)).toBe(false)
    expect(shouldSkipAutomaticCheck(false, 300, 1)).toBe(false)
  })

  test('backs automatic discovery off from 3 minutes to a 30-minute cap', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(offlineRetryDelay)).toEqual([
      3 * 60_000,
      6 * 60_000,
      12 * 60_000,
      24 * 60_000,
      30 * 60_000,
      30 * 60_000,
      30 * 60_000
    ])
  })

  test('recognizes discovery misses and lost connections as offline failures', () => {
    expect(isOfflineFailure(offline(1))).toBe(true)
    expect(isOfflineFailure({ at: 2, peer: 'Mac', kind: 'error', message: 'connection lost — timeout' })).toBe(true)
    expect(isOfflineFailure({ at: 3, peer: 'Mac', kind: 'error', message: 'permission denied' })).toBe(false)
    expect(isOfflineFailure({ at: 4, peer: 'Mac', kind: 'sync' })).toBe(false)
  })

  test('keeps one outage entry across elapsed time and unrelated errors until a sync succeeds', () => {
    expect(
      hasLoggedOfflineFailure([offline(1), { at: 10_000_000, peer: 'Mac', kind: 'error', message: 'timeout' }], 'Mac')
    ).toBe(true)
    expect(hasLoggedOfflineFailure([offline(1), { at: 2, peer: 'Mac', kind: 'sync' }], 'Mac')).toBe(false)
    expect(hasLoggedOfflineFailure([offline(1, 'Other Mac')], 'Mac')).toBe(false)
    expect(hasLoggedOfflineFailure([], 'Mac')).toBe(false)
  })
})
