import type { PeerRecord } from '../shared/sync'

/**
 * Paired-phone key at-rest handling, on Electron's async safeStorage API.
 *
 * The sync `safeStorage.encryptString/decryptString/isEncryptionAvailable`
 * calls are deprecated in Electron 45 and removed in 46. The async API reads
 * ciphertext written by the old sync API (same OS-keychain-backed format), so
 * stored `sync.json` peers stay readable as-is. When the async decryptor says
 * `shouldReEncrypt` (key rotated / legacy format), we re-seal the key and
 * persist it so the next load is on the current format.
 *
 * Kept free of `electron` imports so it's unit-testable under bun.
 */

export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>
}

/** key holds safeStorage-encrypted base64 when `enc` is true */
export type StoredPeer = PeerRecord & { enc?: boolean }

/** Seal a fresh peer key for storage (plaintext fallback when no keychain, same as before). */
export async function sealPeer(ss: AsyncSafeStorage, p: PeerRecord): Promise<StoredPeer> {
  const enc = await ss.isAsyncEncryptionAvailable()
  const key = enc ? (await ss.encryptStringAsync(p.key)).toString('base64') : p.key
  return { ...p, key, enc }
}

/**
 * Plaintext key for a stored peer. If the stored ciphertext needs re-sealing,
 * `stored` is updated in place and `onReEncrypt` is called to persist it.
 */
export async function openPeer(ss: AsyncSafeStorage, stored: StoredPeer, onReEncrypt?: () => void): Promise<string> {
  if (!stored.enc) return stored.key
  const { result, shouldReEncrypt } = await ss.decryptStringAsync(Buffer.from(stored.key, 'base64'))
  if (shouldReEncrypt) {
    try {
      stored.key = (await ss.encryptStringAsync(result)).toString('base64')
      onReEncrypt?.()
    } catch (err) {
      // Keep the old (still-readable) ciphertext; try again next time.
      console.warn('[sync] peer key re-encrypt failed', err instanceof Error ? err.message : String(err))
    }
  }
  return result
}

/**
 * First-load pass: open every encrypted peer so any that need re-sealing get
 * re-encrypted and persisted once. Peers that fail to decrypt are left alone
 * (same as before: that phone just has to re-pair). Returns how many changed.
 */
export async function migratePeers(ss: AsyncSafeStorage, peers: StoredPeer[], persist: () => void): Promise<number> {
  let changed = 0
  for (const p of peers) {
    if (!p.enc) continue
    try {
      await openPeer(ss, p, () => changed++)
    } catch {
      // undecryptable (keychain reset etc.) — leave as-is
    }
  }
  if (changed > 0) persist()
  return changed
}
