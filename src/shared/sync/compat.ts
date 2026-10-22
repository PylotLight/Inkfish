import { MIN_PEER, PROTOCOL } from './protocol'

/**
 * Protocol handshake between the Mac (server) and the phone (client).
 *
 * Each side advertises the protocol it speaks (`protocol`) and the oldest peer
 * protocol it still accepts (`minPeer`). The Mac puts both in `/v1/hello`; the
 * phone sends both as headers on every POST. Purely additive: a peer that sends
 * neither is an older build and counts as protocol 1 / minPeer 1, which is what
 * every build before the handshake spoke.
 *
 * Bump PROTOCOL when the wire format changes; raise MIN_PEER only when an
 * older peer would actually break (it then sees "update phone" / "update Mac"
 * instead of failing silently).
 */

export const PROTOCOL_HEADER = 'x-inkfish-protocol'
export const MIN_PEER_HEADER = 'x-inkfish-min-peer'
/** HTTP status the Mac answers with when the two sides can't talk. */
export const INCOMPATIBLE_STATUS = 426

export interface PeerVersion {
  protocol: number
  minPeer: number
}

export const SELF_VERSION: PeerVersion = { protocol: PROTOCOL, minPeer: MIN_PEER }

function int(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null
}

/**
 * Normalize whatever a peer told us (hello JSON, headers, nothing at all).
 * Missing / garbage → protocol 1. `v` is the pre-handshake hello field.
 */
export function peerVersion(x: { protocol?: unknown; minPeer?: unknown; v?: unknown } | null | undefined): PeerVersion {
  const protocol = int(x?.protocol) ?? int(x?.v) ?? 1
  const minPeer = int(x?.minPeer) ?? 1
  return { protocol, minPeer }
}

/**
 * - `ok`: talk
 * - `peer-outdated`: the other side is older than we accept → update THEM
 * - `self-outdated`: the other side needs a newer us → update US
 */
export type Compat = 'ok' | 'peer-outdated' | 'self-outdated'

export function compat(self: PeerVersion, peer: PeerVersion): Compat {
  if (peer.protocol < self.minPeer) return 'peer-outdated'
  if (self.protocol < peer.minPeer) return 'self-outdated'
  return 'ok'
}

export type Side = 'mac' | 'phone'

/** Which app needs updating, seen from `self`'s side (null = compatible). */
export function outdatedApp(self: Side, c: Compat): Side | null {
  if (c === 'ok') return null
  const other: Side = self === 'mac' ? 'phone' : 'mac'
  return c === 'peer-outdated' ? other : self
}

/** Short badge text: "update phone" / "update Mac". */
export function updateLabel(app: Side): string {
  return app === 'mac' ? 'update Mac' : 'update phone'
}

/** Body of a 426: `incompatible:<app>:<detail>` so the phone knows which side to blame. */
export function incompatibleBody(app: Side, mac: PeerVersion, phone: PeerVersion): string {
  return `incompatible:${app}:mac v${mac.protocol} (needs phone ≥v${mac.minPeer}), phone v${phone.protocol} (needs mac ≥v${phone.minPeer})`
}

export function parseIncompatible(body: string): Side | null {
  const m = /^incompatible:(mac|phone):/.exec(body)
  return m ? (m[1] as Side) : null
}

/** Thrown on the phone when the Mac and phone can't sync until one is updated. */
export class SyncIncompatible extends Error {
  /** The app that needs updating. */
  readonly app: Side
  constructor(app: Side, detail = '') {
    super(
      `${app === 'mac' ? 'Update Inkfish on the Mac' : 'Update Inkfish on this phone'} to keep syncing${detail ? ` (${detail})` : ''}`
    )
    this.name = 'SyncIncompatible'
    this.app = app
  }
}

/** Headers the phone sends on every POST. */
export function versionHeaders(v: PeerVersion = SELF_VERSION): Record<string, string> {
  return { [PROTOCOL_HEADER]: String(v.protocol), [MIN_PEER_HEADER]: String(v.minPeer) }
}
