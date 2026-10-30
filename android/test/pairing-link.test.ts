import { describe, expect, test } from 'bun:test'
import { encodePairUri, type PairPayload } from '../../src/shared/sync'
import { pairingUriFromLink } from '../src/lib/pairingLink'

const payload: PairPayload = {
  v: 1,
  id: 'mac-0123456789abcdef',
  name: 'Inkfish Mac',
  key: Buffer.alloc(32, 7).toString('base64url'),
  hosts: ['192.168.1.84', '10.143.239.241'],
  port: 47822,
  exp: Date.now() + 60_000
}
const pairingUri = encodePairUri(payload)

describe('Android pairing deep links', () => {
  test('accepts a complete Inkfish pairing URI, including whitespace around it', () => {
    expect(pairingUriFromLink(`  ${pairingUri}\n`)).toBe(pairingUri)
  })

  test('ignores unrelated app links and malformed pairing URIs', () => {
    expect(pairingUriFromLink(null)).toBeNull()
    expect(pairingUriFromLink('https://example.com/')).toBeNull()
    expect(pairingUriFromLink('inkfish://settings')).toBeNull()
    expect(pairingUriFromLink('inkfish://pair?d=not-a-valid-payload')).toBeNull()
    expect(pairingUriFromLink(`${pairingUri}&unexpected=1`)).toBeNull()
  })
})
