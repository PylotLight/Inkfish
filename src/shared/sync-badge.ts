/**
 * Desktop sync badge: pure state derivation for the sidebar-footer badge and the
 * tray tooltip. The Mac side never drives a sync — paired phones do (on launch,
 * on foreground, a few seconds after edits) — so "connected" here means "a phone
 * talked to us recently", and "syncing" means a phone session is in flight
 * (requests open, or a session started and hasn't sent /v1/done yet).
 *
 * Kept free of electron/node imports so it's unit-tested with bun test.
 */

export type SyncBadgeState = 'none' | 'offline' | 'syncing' | 'synced' | 'error' | 'outdated'

/** Which app needs updating before a phone can sync (protocol handshake, src/shared/sync/compat). */
export type OutdatedApp = 'mac' | 'phone'

/** Live per-phone activity tracked by src/main/sync around the request handler. */
export interface PeerActivity {
  /** Last authenticated request from this phone (any endpoint). */
  lastSeen: number | null
  /** Requests from this phone currently being handled. */
  inFlight: number
  /** A session started (manifest/get/apply) and hasn't finished (/v1/done) yet. */
  sessionSince: number | null
  /** Newest failed request/apply from this phone. */
  lastError: { at: number; message: string } | null
  /** Newest handshake refusal (426): which side is too old. Cleared by the next success. Optional so older callers still type-check. */
  outdated?: { at: number; app: OutdatedApp } | null
}

export interface BadgePeerInput {
  id: string
  name: string
  lastSync: number | null
  activity?: PeerActivity | null
}

export interface BadgeInput {
  running: boolean
  /** Listener error (port in use etc.). */
  error: string | null
  peers: BadgePeerInput[]
}

export type PeerBadgeState = 'syncing' | 'synced' | 'offline' | 'error' | 'outdated'

export interface BadgePeerRow {
  id: string
  name: string
  state: PeerBadgeState
  lastSeen: number | null
  lastSync: number | null
  inFlight: number
  error: string | null
  /** Set when this phone can't sync until one side updates ("update phone" / "update Mac"). */
  update: OutdatedApp | null
}

export interface SyncBadge {
  state: SyncBadgeState
  /** One-line summary ("Synced with Pixel 8 · 2m ago"). */
  label: string
  /** Newest successful sync across phones. */
  lastSync: number | null
  inFlight: number
  peers: BadgePeerRow[]
  /** When the derived state will change on its own (idle session / online window expiring), for one timer instead of polling. */
  nextChangeAt: number | null
}

/** A phone counts as connected for this long after its last request. Phones sync on launch / foreground / edits, so keep it generous. */
export const ONLINE_MS = 15 * 60_000
/** A session with no request for this long is considered over even without /v1/done (phone went away mid-sync). */
export const SESSION_IDLE_MS = 20_000
/** An error stays on the badge until a later success, or this long. */
export const ERROR_MS = 30 * 60_000

export function emptyActivity(): PeerActivity {
  return { lastSeen: null, inFlight: 0, sessionSince: null, lastError: null, outdated: null }
}

function peerRow(p: BadgePeerInput, now: number): { row: BadgePeerRow; next: number | null } {
  const a = p.activity ?? emptyActivity()
  const seen = Math.max(a.lastSeen ?? 0, p.lastSync ?? 0) || null
  const sessionLive = a.inFlight > 0 || (a.sessionSince !== null && a.lastSeen !== null && now - a.lastSeen < SESSION_IDLE_MS)
  const errLive = a.lastError !== null && now - a.lastError.at < ERROR_MS && a.lastError.at >= (p.lastSync ?? 0)
  const online = seen !== null && now - seen < ONLINE_MS
  const old = a.outdated ?? null
  const outdatedLive = old !== null && now - old.at < ERROR_MS && old.at >= (p.lastSync ?? 0)
  const state: PeerBadgeState = outdatedLive
    ? 'outdated'
    : sessionLive
      ? 'syncing'
      : errLive
        ? 'error'
        : online && p.lastSync !== null
          ? 'synced'
          : 'offline'
  const candidates: number[] = []
  if (outdatedLive && old) candidates.push(old.at + ERROR_MS)
  if (a.inFlight === 0 && a.sessionSince !== null && a.lastSeen !== null && sessionLive) candidates.push(a.lastSeen + SESSION_IDLE_MS)
  if (errLive && a.lastError) candidates.push(a.lastError.at + ERROR_MS)
  if (online && seen !== null) candidates.push(seen + ONLINE_MS)
  const next = candidates.length ? Math.min(...candidates) : null
  return {
    row: {
      id: p.id,
      name: p.name,
      state,
      lastSeen: seen,
      lastSync: p.lastSync,
      inFlight: a.inFlight,
      error: errLive ? (a.lastError?.message ?? null) : null,
      update: outdatedLive && old ? old.app : null
    },
    next
  }
}

export function deriveSyncBadge(input: BadgeInput, now: number): SyncBadge {
  const built = input.peers.map((p) => peerRow(p, now))
  const peers = built.map((b) => b.row)
  const nexts = built.map((b) => b.next).filter((n): n is number => n !== null)
  const lastSync = peers.reduce<number | null>((m, p) => (p.lastSync !== null && (m === null || p.lastSync > m) ? p.lastSync : m), null)
  const inFlight = peers.reduce((n, p) => n + p.inFlight, 0)
  const nextChangeAt = nexts.length ? Math.min(...nexts) : null
  const base = { lastSync, inFlight, peers, nextChangeAt }

  if (peers.length === 0) {
    return { ...base, state: input.error ? 'error' : 'none', label: input.error ? `Sync unavailable — ${input.error}` : 'No paired devices' }
  }
  if (input.error || !input.running) {
    return { ...base, state: 'error', label: input.error ? `Sync unavailable — ${input.error}` : 'Sync is not running' }
  }
  // A peer that can't sync until something is updated beats everything else: it fails every time, quietly otherwise.
  const outdated = peers.filter((p) => p.state === 'outdated')
  if (outdated.length) {
    const app = outdated.some((p) => p.update === 'mac') ? 'mac' : 'phone'
    const who = outdated.filter((p) => p.update === app)
    return {
      ...base,
      state: 'outdated',
      label: app === 'mac' ? `update Mac — ${names(who)} needs a newer Inkfish here to sync` : `update phone — ${names(who)} needs a newer Inkfish to sync`
    }
  }
  const syncing = peers.filter((p) => p.state === 'syncing')
  if (syncing.length) return { ...base, state: 'syncing', label: `Syncing with ${names(syncing)}…` }
  const errored = peers.filter((p) => p.state === 'error')
  if (errored.length) return { ...base, state: 'error', label: `Sync error with ${names(errored)}` }
  const synced = peers.filter((p) => p.state === 'synced')
  if (synced.length) {
    const newest = synced.reduce((a, b) => ((b.lastSync ?? 0) > (a.lastSync ?? 0) ? b : a))
    return { ...base, state: 'synced', label: `Synced with ${names(synced)} · ${ago(newest.lastSync, now)}` }
  }
  return {
    ...base,
    state: 'offline',
    label: lastSync ? `${plural(peers.length, 'device')} paired · not seen recently · last sync ${ago(lastSync, now)}` : `${plural(peers.length, 'device')} paired · never synced`
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", "never". */
export function ago(at: number | null, now: number): string {
  if (at === null) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Re-render the summary's relative time at `now` (main only pushes on state changes, so a stored label's "ago" goes stale). */
export function freshLabel(b: SyncBadge, now: number): string {
  if (b.lastSync === null) return b.label
  if (b.state === 'synced') return b.label.replace(/· [^·]+$/, `· ${ago(b.lastSync, now)}`)
  if (b.state === 'offline') return b.label.replace(/last sync [^·]+$/, `last sync ${ago(b.lastSync, now)}`)
  return b.label
}

/** Tray tooltip line, or null when nothing is paired (keep the plain tooltip). */
export function trayTooltip(appName: string, b: SyncBadge): string {
  if (b.state === 'none') return `${appName} — click for menu`
  return `${appName} — ${b.label}`
}

/** True when the badge changed in a way the UI should repaint for (ignores timestamps that only move "ago"). */
export function badgeChanged(a: SyncBadge | null, b: SyncBadge): boolean {
  if (!a) return true
  if (a.state !== b.state || a.inFlight !== b.inFlight || a.lastSync !== b.lastSync || a.peers.length !== b.peers.length) return true
  return a.peers.some((p, i) => {
    const q = b.peers[i]
    return !q || p.id !== q.id || p.state !== q.state || p.inFlight !== q.inFlight || p.lastSync !== q.lastSync || p.error !== q.error || p.name !== q.name || p.update !== q.update
  })
}

function names(ps: BadgePeerRow[]): string {
  if (ps.length <= 2) return ps.map((p) => p.name).join(' & ')
  return `${ps[0]!.name} +${ps.length - 1}`
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? '' : 's'}`
}
