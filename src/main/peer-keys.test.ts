import { describe, expect, test } from 'bun:test'
import { migratePeers, openPeer, sealPeer, type AsyncSafeStorage, type StoredPeer } from './peer-keys'

/**
 * Fake keychain: "v10:" ciphertext is what the old sync encryptString wrote
 * (still decryptable, flagged for re-encryption), "v11:" is current.
 */
function fakeSafeStorage(available = true): AsyncSafeStorage & { encrypts: number } {
  const xor = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    encrypts: 0,
    async isAsyncEncryptionAvailable() { return available },
    async encryptStringAsync(t) { this.encrypts++; return Buffer.concat([Buffer.from('v11:'), xor(Buffer.from(t))]) },
    async decryptStringAsync(b) {
      const tag = b.subarray(0, 4).toString()
      if (tag !== 'v10:' && tag !== 'v11:') throw new Error('bad ciphertext')
      return { result: xor(b.subarray(4)).toString(), shouldReEncrypt: tag === 'v10:' }
    }
  }
}
const legacySeal = (t: string): string => Buffer.concat([Buffer.from('v10:'), Buffer.from(Buffer.from(t).map((x) => x ^ 0x5a))]).toString('base64')
const KEY = Buffer.alloc(32, 7).toString('base64')
const peer = (over: Partial<StoredPeer> = {}): StoredPeer => ({ id: 'phone-abcdefgh', name: 'Pixel', key: KEY, pairedAt: 1, ...over })

describe('peer keys on async safeStorage', () => {
  test('seal → open round-trips and never stores plaintext', async () => {
    const ss = fakeSafeStorage()
    const s = await sealPeer(ss, peer())
    expect(s.enc).toBe(true)
    expect(s.key).not.toBe(KEY)
    expect(await openPeer(ss, s)).toBe(KEY)
  })

  test('no keychain → stored plaintext like before, still opens', async () => {
    const ss = fakeSafeStorage(false)
    const s = await sealPeer(ss, peer())
    expect(s.enc).toBe(false)
    expect(await openPeer(ss, s)).toBe(KEY)
  })

  test('legacy sync-API ciphertext stays readable and is re-sealed once', async () => {
    const ss = fakeSafeStorage()
    const s = peer({ key: legacySeal(KEY), enc: true })
    const before = s.key
    let saves = 0
    expect(await openPeer(ss, s, () => saves++)).toBe(KEY)
    expect(saves).toBe(1)
    expect(s.key).not.toBe(before)
    expect(Buffer.from(s.key, 'base64').subarray(0, 4).toString()).toBe('v11:')
    // second open: current format, no more writes
    expect(await openPeer(ss, s, () => saves++)).toBe(KEY)
    expect(saves).toBe(1)
  })

  test('first-load migration re-seals legacy peers, skips plaintext + broken, persists once', async () => {
    const ss = fakeSafeStorage()
    const peers: StoredPeer[] = [
      peer({ id: 'a-legacy-01', key: legacySeal(KEY), enc: true }),
      peer({ id: 'b-legacy-02', key: legacySeal('other'), enc: true }),
      peer({ id: 'c-plain-003', enc: false }),
      peer({ id: 'd-broken-04', key: Buffer.from('junk').toString('base64'), enc: true })
    ]
    const broken = peers[3]!.key
    let persisted = 0
    expect(await migratePeers(ss, peers, () => persisted++)).toBe(2)
    expect(persisted).toBe(1)
    expect(await openPeer(ss, peers[0]!)).toBe(KEY)
    expect(await openPeer(ss, peers[1]!)).toBe('other')
    expect(peers[2]!.key).toBe(KEY)
    expect(peers[3]!.key).toBe(broken)
    // already migrated → no-op
    expect(await migratePeers(ss, peers, () => persisted++)).toBe(0)
    expect(persisted).toBe(1)
  })

  test('re-encrypt failure keeps old ciphertext readable', async () => {
    const ss = fakeSafeStorage()
    ss.encryptStringAsync = async () => { throw new Error('keychain locked') }
    const s = peer({ key: legacySeal(KEY), enc: true })
    const before = s.key
    let saves = 0
    expect(await openPeer(ss, s, () => saves++)).toBe(KEY)
    expect(s.key).toBe(before)
    expect(saves).toBe(0)
  })
})
