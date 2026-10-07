import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { fromBase64, toBase64, utf8Decode, utf8Encode } from './bytes'
import type { Manifest } from './plan'

/**
 * Wire protocol v1 — LAN only. The Mac listens on HTTP; the phone is the
 * client and drives every sync. Every request and response body is sealed
 * with XChaCha20-Poly1305 under the per-phone key from the pairing QR, so
 * nothing on the network can read notes or forge requests, and a peer that
 * isn't paired gets nothing but `/v1/hello`. Bodies travel as base64 text.
 */

export const PROTOCOL = 1
export const DEFAULT_PORT = 47821
/** Pairing QR validity. */
export const PAIR_TTL_MS = 5 * 60 * 1000
/** Max clock skew / replay window. */
export const SKEW_MS = 5 * 60 * 1000

export type Random = (n: number) => Uint8Array

export interface PairPayload {
  v: 1
  /** Mac device id */
  id: string
  /** Mac display name */
  name: string
  /** 32-byte key, base64url — becomes this phone's sync key */
  key: string
  /** LAN IPv4s the Mac listens on */
  hosts: string[]
  port: number
  /** Expiry (epoch ms) */
  exp: number
}

export function encodePairUri(p: PairPayload): string {
  return `inkfish://pair?d=${toBase64(utf8Encode(JSON.stringify(p)), true)}`
}

export function decodePairUri(uri: string): PairPayload | null {
  try {
    const m = /^inkfish:\/\/pair\?d=([A-Za-z0-9_-]+)$/.exec(uri.trim())
    if (!m?.[1]) return null
    const p = JSON.parse(utf8Decode(fromBase64(m[1]))) as PairPayload
    if (p.v !== 1 || !p.id || !p.key || !Array.isArray(p.hosts) || !p.port) return null
    return p
  } catch {
    return null
  }
}

export function aad(kind: 'req' | 'res', path: string, peerId: string): Uint8Array {
  return utf8Encode(`inkfish/${PROTOCOL} ${kind} ${path} ${peerId}`)
}

/** nonce(24) ‖ ciphertext+tag, base64. */
export function seal(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array, random: Random): string {
  const nonce = random(24)
  const ct = xchacha20poly1305(key, nonce, ad).encrypt(plaintext)
  const out = new Uint8Array(24 + ct.length)
  out.set(nonce)
  out.set(ct, 24)
  return toBase64(out)
}

/** Throws on tampering / wrong key. Returns plaintext and the nonce (for replay checks). */
export function open(key: Uint8Array, sealed: string, ad: Uint8Array): { plain: Uint8Array; nonce: string } {
  const raw = fromBase64(sealed)
  if (raw.length < 24 + 16) throw new Error('short message')
  const nonce = raw.subarray(0, 24)
  const plain = xchacha20poly1305(key, nonce, ad).decrypt(raw.subarray(24))
  return { plain, nonce: toBase64(nonce) }
}

interface Envelope<T> {
  ts: number
  body: T
}

export function sealJson<T>(key: Uint8Array, body: T, ad: Uint8Array, random: Random, now = Date.now()): string {
  const env: Envelope<T> = { ts: now, body }
  return seal(key, utf8Encode(JSON.stringify(env)), ad, random)
}

export function openJson<T>(key: Uint8Array, sealed: string, ad: Uint8Array): { body: T; ts: number; nonce: string } {
  const { plain, nonce } = open(key, sealed, ad)
  const env = JSON.parse(utf8Decode(plain)) as Envelope<T>
  return { body: env.body, ts: env.ts, nonce }
}

// --- endpoints -------------------------------------------------------------

export const PEER_HEADER = 'x-inkfish-peer'

export interface Hello {
  app: 'inkfish'
  v: number
  id: string
  name: string
}

export interface PairReq {
  name: string
}
export interface PairRes {
  id: string
  name: string
}

export interface ManifestRes {
  manifest: Manifest
}

export interface GetReq {
  paths: string[]
}
export interface GetRes {
  /** path → base64 content (missing paths omitted) */
  files: Record<string, string>
}

export interface ApplyReq {
  moves: Array<{ from: string; to: string }>
  writes: Array<{ path: string; data: string }>
  deletes: string[]
}
export interface ApplyRes {
  manifest: Manifest
}

/** Paths are vault-relative, forward slashes, no `..`, nothing hidden at the top. */
export function safeRel(p: string): boolean {
  if (!p || p.length > 1024 || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  const parts = p.split('/')
  return parts.every((s) => s !== '' && s !== '.' && s !== '..')
}
