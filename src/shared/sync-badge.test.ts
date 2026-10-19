import { describe, expect, test } from 'bun:test'
import {
  ago,
  badgeChanged,
  deriveSyncBadge,
  emptyActivity,
  ERROR_MS,
  freshLabel,
  ONLINE_MS,
  SESSION_IDLE_MS,
  trayTooltip,
  type BadgePeerInput,
  type PeerActivity
} from './sync-badge'

const NOW = 1_800_000_000_000

function peer(over: Partial<BadgePeerInput> = {}, act: Partial<PeerActivity> | null = null): BadgePeerInput {
  return { id: 'p1', name: 'Pixel', lastSync: null, activity: act ? { ...emptyActivity(), ...act } : null, ...over }
}

const run = (peers: BadgePeerInput[], extra: { running?: boolean; error?: string | null } = {}) =>
  deriveSyncBadge({ running: extra.running ?? true, error: extra.error ?? null, peers }, NOW)

describe('sync badge state', () => {
  test('no paired devices → none (badge hidden)', () => {
    const b = run([])
    expect(b.state).toBe('none')
    expect(b.nextChangeAt).toBeNull()
  })

  test('listener error with no peers still surfaces', () => {
    expect(run([], { error: 'EADDRINUSE' }).state).toBe('error')
  })

  test('paired but never synced → offline', () => {
    const b = run([peer()])
    expect(b.state).toBe('offline')
    expect(b.label).toContain('never synced')
  })

  test('synced recently → synced with last-sync time', () => {
    const b = run([peer({ lastSync: NOW - 120_000 }, { lastSeen: NOW - 120_000 })])
    expect(b.state).toBe('synced')
    expect(b.label).toBe('Synced with Pixel · 2m ago')
    expect(b.lastSync).toBe(NOW - 120_000)
    // flips to offline when the online window runs out
    expect(b.nextChangeAt).toBe(NOW - 120_000 + ONLINE_MS)
  })

  test('not seen within the online window → offline', () => {
    const at = NOW - ONLINE_MS - 1
    const b = run([peer({ lastSync: at }, { lastSeen: at })])
    expect(b.state).toBe('offline')
    expect(b.label).toContain('not seen recently')
    expect(b.nextChangeAt).toBeNull()
  })

  test('requests in flight → syncing with counts', () => {
    const b = run([peer({ lastSync: NOW - 5000 }, { inFlight: 2, sessionSince: NOW - 1000, lastSeen: NOW - 500 })])
    expect(b.state).toBe('syncing')
    expect(b.inFlight).toBe(2)
    expect(b.peers[0]!.state).toBe('syncing')
    expect(b.label).toBe('Syncing with Pixel…')
  })

  test('between requests of an open session → still syncing until idle', () => {
    const live = run([peer({}, { sessionSince: NOW - 3000, lastSeen: NOW - 1000 })])
    expect(live.state).toBe('syncing')
    expect(live.nextChangeAt).toBe(NOW - 1000 + SESSION_IDLE_MS)
    const idle = run([peer({ lastSync: NOW - 30_000 }, { sessionSince: NOW - 40_000, lastSeen: NOW - SESSION_IDLE_MS - 1 })])
    expect(idle.state).toBe('synced')
  })

  test('failed apply after the last sync → error until a later success', () => {
    const err = { at: NOW - 1000, message: 'apply: 500 boom' }
    const b = run([peer({ lastSync: NOW - 2000 }, { lastSeen: NOW - 2000, lastError: err })])
    expect(b.state).toBe('error')
    expect(b.peers[0]!.error).toBe('apply: 500 boom')
    const healed = run([peer({ lastSync: NOW - 500 }, { lastSeen: NOW - 500, lastError: err })])
    expect(healed.state).toBe('synced')
    expect(healed.peers[0]!.error).toBeNull()
  })

  test('old errors expire', () => {
    const b = run([peer({ lastSync: NOW - ERROR_MS - 5000 }, { lastError: { at: NOW - ERROR_MS - 1, message: 'x' } })])
    expect(b.state).toBe('offline')
  })

  test('syncing outranks error outranks synced across peers', () => {
    const synced = peer({ id: 'a', name: 'A', lastSync: NOW - 1000 }, { lastSeen: NOW - 1000 })
    const errored = peer({ id: 'b', name: 'B', lastSync: NOW - 9000 }, { lastError: { at: NOW - 100, message: 'x' } })
    const syncing = peer({ id: 'c', name: 'C' }, { inFlight: 1 })
    expect(run([synced, errored]).state).toBe('error')
    expect(run([synced, errored, syncing]).state).toBe('syncing')
    expect(run([synced, errored, syncing]).label).toBe('Syncing with C…')
  })

  test('listener down with peers → error', () => {
    expect(run([peer({ lastSync: NOW })], { running: false }).state).toBe('error')
    expect(run([peer({ lastSync: NOW })], { error: 'listen EACCES' }).label).toContain('listen EACCES')
  })

  test('nextChangeAt is the soonest transition', () => {
    const a = peer({ id: 'a', lastSync: NOW - 1000 }, { lastSeen: NOW - 1000 })
    const b = peer({ id: 'b' }, { sessionSince: NOW - 2000, lastSeen: NOW - 2000 })
    expect(run([a, b]).nextChangeAt).toBe(NOW - 2000 + SESSION_IDLE_MS)
  })
})

describe('labels', () => {
  test('ago buckets', () => {
    expect(ago(null, NOW)).toBe('never')
    expect(ago(NOW - 10_000, NOW)).toBe('just now')
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(ago(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
    expect(ago(NOW + 5000, NOW)).toBe('just now')
  })

  test('freshLabel re-renders the relative time', () => {
    const b = run([peer({ lastSync: NOW - 60_000 }, { lastSeen: NOW - 60_000 })])
    expect(freshLabel(b, NOW + 10 * 60_000)).toBe('Synced with Pixel · 11m ago')
    const off = run([peer({ lastSync: NOW - ONLINE_MS - 60_000 })])
    expect(freshLabel(off, NOW + 3_600_000)).toMatch(/last sync 1h ago$/)
  })

  test('tray tooltip keeps the plain text until something is paired', () => {
    expect(trayTooltip('Inkfish', run([]))).toBe('Inkfish — click for menu')
    expect(trayTooltip('Inkfish', run([peer({ lastSync: NOW }, { lastSeen: NOW })]))).toBe('Inkfish — Synced with Pixel · just now')
  })

  test('two and many peer names', () => {
    const mk = (id: string) => peer({ id, name: id.toUpperCase() }, { inFlight: 1 })
    expect(run([mk('a'), mk('b')]).label).toBe('Syncing with A & B…')
    expect(run([mk('a'), mk('b'), mk('c')]).label).toBe('Syncing with A +2…')
  })
})

describe('badgeChanged (throttle repaint gate)', () => {
  test('same state → no repaint; state or counts change → repaint', () => {
    const a = run([peer({ lastSync: NOW - 1000 }, { lastSeen: NOW - 1000 })])
    const same = run([peer({ lastSync: NOW - 1000 }, { lastSeen: NOW - 900 })])
    expect(badgeChanged(null, a)).toBe(true)
    expect(badgeChanged(a, same)).toBe(false)
    expect(badgeChanged(a, run([peer({ lastSync: NOW - 1000 }, { inFlight: 1 })]))).toBe(true)
    expect(badgeChanged(a, run([peer({ lastSync: NOW }, { lastSeen: NOW })]))).toBe(true)
    expect(badgeChanged(a, run([]))).toBe(true)
  })
})
