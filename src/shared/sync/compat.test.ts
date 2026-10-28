import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  assertCompatible,
  compat,
  createHandler,
  findMacHello,
  httpRemote,
  incompatibleBody,
  INCOMPATIBLE_STATUS,
  MIN_PEER,
  MIN_PEER_HEADER,
  outdatedApp,
  parseHello,
  parseIncompatible,
  PEER_HEADER,
  peerVersion,
  PROTOCOL,
  PROTOCOL_HEADER,
  SELF_VERSION,
  SyncIncompatible,
  toBase64,
  updateLabel,
  versionHeaders,
  type Fetch,
  type MacPeer,
  type Manifest,
  type PeerRecord,
  type PeerVersion,
  type SyncFs
} from './index'

const random = (n: number): Uint8Array => new Uint8Array(randomBytes(n))

const emptyFs: SyncFs = {
  list: async (): Promise<Manifest> => ({}),
  read: async () => new Uint8Array(),
  write: async () => undefined,
  remove: async () => undefined,
  move: async () => undefined
}

describe('peerVersion: missing fields = protocol 1', () => {
  test('nothing at all (pre-handshake phone / Mac)', () => {
    expect(peerVersion(undefined)).toEqual({ protocol: 1, minPeer: 1 })
    expect(peerVersion(null)).toEqual({ protocol: 1, minPeer: 1 })
    expect(peerVersion({})).toEqual({ protocol: 1, minPeer: 1 })
  })
  test('old hello only has v', () => {
    expect(peerVersion({ v: 1 })).toEqual({ protocol: 1, minPeer: 1 })
    expect(peerVersion({ v: 3 })).toEqual({ protocol: 3, minPeer: 1 })
  })
  test('header strings parse, garbage falls back', () => {
    expect(peerVersion({ protocol: '2', minPeer: '1' })).toEqual({ protocol: 2, minPeer: 1 })
    expect(peerVersion({ protocol: 'banana', minPeer: -4 })).toEqual({ protocol: 1, minPeer: 1 })
    expect(peerVersion({ protocol: 2.5 })).toEqual({ protocol: 1, minPeer: 1 })
    // explicit protocol wins over legacy v
    expect(peerVersion({ v: 1, protocol: 2 })).toEqual({ protocol: 2, minPeer: 1 })
  })
})

describe('compat matrix', () => {
  const v = (protocol: number, minPeer: number): PeerVersion => ({ protocol, minPeer })
  test('same version, and today’s build with an old peer, are fine', () => {
    expect(compat(v(1, 1), v(1, 1))).toBe('ok')
    expect(compat(SELF_VERSION, peerVersion(undefined))).toBe('ok')
    expect(compat(v(3, 2), v(2, 1))).toBe('ok')
  })
  test('app versions (betas included) never enter the handshake: only protocol ints do', () => {
    // a v0.2.15-beta.1 Mac and an android-v0.2.8 phone from the same protocol talk fine;
    // "update phone / Mac" comes only from protocol < minPeer, never from 0.2.15-beta.1 < 0.2.15.
    expect(Number.isInteger(SELF_VERSION.protocol) && Number.isInteger(SELF_VERSION.minPeer)).toBe(true)
    expect(compat(SELF_VERSION, peerVersion({ protocol: String(PROTOCOL), minPeer: String(MIN_PEER) }))).toBe('ok')
  })
  test('peer older than we accept → update them', () => {
    expect(compat(v(2, 2), v(1, 1))).toBe('peer-outdated')
    expect(outdatedApp('mac', 'peer-outdated')).toBe('phone')
    expect(outdatedApp('phone', 'peer-outdated')).toBe('mac')
  })
  test('peer needs a newer us → update us', () => {
    expect(compat(v(1, 1), v(2, 2))).toBe('self-outdated')
    expect(outdatedApp('mac', 'self-outdated')).toBe('mac')
    expect(outdatedApp('phone', 'self-outdated')).toBe('phone')
  })
  test('labels + 426 body round trip', () => {
    expect(updateLabel('phone')).toBe('update phone')
    expect(updateLabel('mac')).toBe('update Mac')
    expect(parseIncompatible(incompatibleBody('phone', v(2, 2), v(1, 1)))).toBe('phone')
    expect(parseIncompatible(incompatibleBody('mac', v(1, 1), v(2, 2)))).toBe('mac')
    expect(parseIncompatible('bad seal')).toBeNull()
  })
  test('this build still speaks to protocol-1 peers (nothing released breaks)', () => {
    expect(PROTOCOL).toBeGreaterThanOrEqual(1)
    expect(MIN_PEER).toBe(1)
    expect(versionHeaders()).toEqual({ [PROTOCOL_HEADER]: String(PROTOCOL), [MIN_PEER_HEADER]: String(MIN_PEER) })
  })
})

/** In-process Mac + phone. `phoneSends` = the phone's headers (null = an old phone that sends none). */
function wire(macVersion?: PeerVersion, phoneSends: PeerVersion | null = SELF_VERSION) {
  const peers = new Map<string, PeerRecord>()
  const key = random(32)
  peers.set('phone-abcdef12', { id: 'phone-abcdef12', name: 'Pixel', key: toBase64(key), pairedAt: 0 })
  const handle = createHandler({
    device: { id: 'mac-1234567890', name: 'Mac' },
    fs: emptyFs,
    random,
    getPeer: async (id) => peers.get(id) ?? null,
    pending: () => null,
    addPeer: async () => undefined,
    touchPeer: () => undefined,
    changed: () => undefined,
    version: macVersion
  })
  const fetchFn: Fetch = async (url, init) => {
    const u = new URL(url)
    const h = init?.headers ?? {}
    const meta =
      phoneSends === null
        ? undefined
        : {
            protocol: h[PROTOCOL_HEADER] && String(phoneSends.protocol),
            minPeer: h[MIN_PEER_HEADER] && String(phoneSends.minPeer)
          }
    const r = await handle(init?.method ?? 'GET', u.pathname, h[PEER_HEADER] ?? null, init?.body ?? '', meta)
    return { ok: r.status === 200, status: r.status, text: async () => r.body }
  }
  const mac: MacPeer = { id: 'mac-1234567890', name: 'Mac', key: toBase64(key), hosts: ['192.168.1.20'], port: 47821 }
  return { handle, fetchFn, mac }
}

describe('handshake over the wire', () => {
  test('hello advertises protocol + minPeer and keeps the legacy v', async () => {
    const { handle } = wire()
    const h = parseHello((await handle('GET', '/v1/hello', null, '')).body)!
    expect(h).toMatchObject({ app: 'inkfish', v: PROTOCOL, protocol: PROTOCOL, minPeer: MIN_PEER })
  })

  test('new phone ↔ new Mac syncs', async () => {
    const { fetchFn, mac } = wire()
    const found = await findMacHello(fetchFn, mac)
    expect(found?.host).toBe('192.168.1.20')
    expect(() => assertCompatible(found!.hello)).not.toThrow()
    expect(await httpRemote(fetchFn, found!.host, mac, 'phone-abcdef12', random).manifest()).toEqual({})
  })

  test('known addresses are probed together; a stale address does not delay a live one', async () => {
    const started: string[] = []
    const fetchFn: Fetch = async (url, init) => {
      const host = new URL(url).hostname
      started.push(host)
      if (host === '192.168.1.21')
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ app: 'inkfish', v: 1, id: 'mac-1234567890', name: 'Mac' })
        }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250)
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            resolve()
          },
          { once: true }
        )
      })
      return { ok: false, status: 404, text: async () => '' }
    }
    const startedAt = Date.now()
    const found = await findMacHello(fetchFn, {
      id: 'mac-1234567890',
      lastHost: '192.168.1.10',
      hosts: ['192.168.1.20', '192.168.1.21'],
      port: 47821
    })
    expect(found?.host).toBe('192.168.1.21')
    expect(new Set(started)).toEqual(new Set(['192.168.1.10', '192.168.1.20', '192.168.1.21']))
    expect(Date.now() - startedAt).toBeLessThan(150)
  })

  test('subnet scan cancels in-flight probes when the paired Mac answers', async () => {
    const fetchFn: Fetch = async (url, init) => {
      const host = new URL(url).hostname
      if (host === '192.168.1.10')
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ app: 'inkfish', v: 1, id: 'other-mac', name: 'Other' })
        }
      if (host === '192.168.1.1')
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ app: 'inkfish', v: 1, id: 'mac-1234567890', name: 'Mac' })
        }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250)
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            resolve()
          },
          { once: true }
        )
      })
      return { ok: false, status: 404, text: async () => '' }
    }
    const startedAt = Date.now()
    const found = await findMacHello(fetchFn, { id: 'mac-1234567890', hosts: ['192.168.1.10'], port: 47821 })
    expect(found?.host).toBe('192.168.1.1')
    expect(Date.now() - startedAt).toBeLessThan(150)
  })

  test('old phone (no headers) ↔ new Mac still syncs', async () => {
    const { fetchFn, mac } = wire(undefined, null)
    expect(await httpRemote(fetchFn, '192.168.1.20', mac, 'phone-abcdef12', random).manifest()).toEqual({})
  })

  test('new phone ↔ old Mac (hello without protocol fields) is compatible', () => {
    expect(() => assertCompatible({ app: 'inkfish', v: 1, id: 'm', name: 'Mac' })).not.toThrow()
  })

  test('Mac that needs a newer phone → 426 "phone", phone throws update phone', async () => {
    const { handle, fetchFn, mac } = wire({ protocol: 2, minPeer: 2 }, null)
    const r = await handle('POST', '/v1/manifest', 'phone-abcdef12', 'x')
    expect(r.status).toBe(INCOMPATIBLE_STATUS)
    expect(parseIncompatible(r.body)).toBe('phone')
    const err = await httpRemote(fetchFn, '192.168.1.20', mac, 'phone-abcdef12', random)
      .manifest()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SyncIncompatible)
    expect((err as SyncIncompatible).app).toBe('phone')
  })

  test('phone that needs a newer Mac → 426 "mac" on the Mac, and the phone spots it from hello first', async () => {
    const { handle } = wire()
    const r = await handle('POST', '/v1/manifest', 'phone-abcdef12', 'x', { protocol: '3', minPeer: '3' })
    expect(r.status).toBe(INCOMPATIBLE_STATUS)
    expect(parseIncompatible(r.body)).toBe('mac')

    const hello = parseHello((await handle('GET', '/v1/hello', null, '')).body)!
    const future: PeerVersion = { protocol: 3, minPeer: 3 }
    let caught: unknown
    try {
      assertCompatible(hello, future)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SyncIncompatible)
    expect((caught as SyncIncompatible).app).toBe('mac')
  })
})
