import type { SyncLogEntry } from './sync'

/** Automatic discovery backs off while the paired Mac is unavailable. */
export const OFFLINE_RETRY_BASE_MS = 3 * 60_000
export const OFFLINE_RETRY_MAX_MS = 30 * 60_000

export function shouldSkipAutomaticCheck(automatic: boolean, nextCheckAt: number, now = Date.now()): boolean {
  return automatic && now < nextCheckAt
}

export function offlineRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.floor(consecutiveFailures) - 1)
  return Math.min(OFFLINE_RETRY_BASE_MS * 2 ** Math.min(exponent, 20), OFFLINE_RETRY_MAX_MS)
}

export function isOfflineFailure(entry: Pick<SyncLogEntry, 'kind' | 'message'>): boolean {
  return (
    entry.kind === 'error' &&
    (entry.message === 'Mac not found on this Wi-Fi' || entry.message?.startsWith('connection lost — ') === true)
  )
}

/** Keep one offline row until a successful sync starts a new disconnected spell. */
export function hasLoggedOfflineFailure(log: readonly SyncLogEntry[], peer: string): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!
    if (entry.peer !== peer) continue
    if (entry.kind === 'sync') return false
    if (isOfflineFailure(entry)) return true
  }
  return false
}
