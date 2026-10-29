import { afterEach, describe, expect, test } from 'bun:test'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { once } from 'node:events'
import { createModelDownloadProxy, type ModelDownloadProxy } from './model-download-proxy'
import { DEFAULT_PROXY_SETTINGS, type ProxySettings } from '../shared/proxy-settings'

const servers: Array<Server | HttpServer> = []
const bridges: ModelDownloadProxy[] = []
const sockets: Socket[] = []

const settings = (
  rules: ProxySettings['rules'] = [],
  proxies: ProxySettings['proxies'] = [],
  primaryEnabled = false
): ProxySettings => ({
  ...DEFAULT_PROXY_SETTINGS,
  primary: { ...DEFAULT_PROXY_SETTINGS.primary, enabled: primaryEnabled, bypassLocalNetwork: false },
  proxies,
  rules
})

async function listen(server: Server | HttpServer): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as { port: number }).port
}

async function bridgeFor(config: ProxySettings, blocked: () => boolean = () => false): Promise<ModelDownloadProxy> {
  const bridge = await createModelDownloadProxy(config, blocked)
  bridges.push(bridge)
  return bridge
}

function rawRequest(port: number, bytes: Buffer, timeoutMs = 1200): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1')
    sockets.push(socket)
    const chunks: Buffer[] = []
    const timer = setTimeout(() => socket.destroy(new Error('request timed out')), timeoutMs)
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    socket.on('connect', () => socket.write(bytes))
  })
}

function portOf(bridge: ModelDownloadProxy): number {
  return Number(new URL(bridge.url).port)
}

function get(path: string, host: string, extra = ''): Buffer {
  return Buffer.from(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`)
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.close()
})

describe('model download proxy', () => {
  test('forwards range requests and preserves a 206 response', async () => {
    const origin = createHttpServer((req, res) => {
      expect(req.headers.range).toBe('bytes=3-5')
      res.writeHead(206, { 'content-range': 'bytes 3-5/6' })
      res.end('def')
    })
    const originPort = await listen(origin)
    const bridge = await bridgeFor(settings())

    const response = await rawRequest(
      portOf(bridge),
      get(`http://127.0.0.1:${originPort}/model`, `127.0.0.1:${originPort}`, 'Range: bytes=3-5\r\n')
    )
    expect(response.toString()).toContain('206')
    expect(response.toString().toLowerCase()).toContain('content-range: bytes 3-5/6')
    expect(response.toString()).toContain('def')
  })

  test('uses remote DNS in SOCKS CONNECT and forwards tunnel bytes', async () => {
    let target = ''
    const socks = createServer((socket) => {
      socket.once('data', (greeting) => {
        expect([...greeting]).toEqual([5, 1, 0])
        socket.write(Buffer.from([5, 0]))
        socket.once('data', (request: Buffer) => {
          expect(request[3]).toBe(3)
          const length = request[4]!
          target = request.subarray(5, 5 + length).toString()
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]))
          socket.once('data', (data) => {
            expect(data.toString()).toContain('hello')
            socket.end('world')
          })
        })
      })
    })
    const socksPort = await listen(socks)
    const bridge = await bridgeFor(
      settings(
        [{ pattern: 'example.test', route: 'proxy:Remote' }],
        [{ name: 'Remote', host: '127.0.0.1', port: socksPort }]
      )
    )

    const response = await rawRequest(
      portOf(bridge),
      Buffer.from('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nConnection: close\r\n\r\nhello')
    )
    expect(target).toBe('example.test')
    expect(response.toString()).toContain('200 Connection Established')
    expect(response.toString()).toContain('world')
  })

  test('returns 502 for failed SOCKS negotiation without direct local fallback', async () => {
    let directHits = 0
    const destination = createHttpServer((_req, res) => {
      directHits++
      res.end('must not reach direct destination')
    })
    const destinationPort = await listen(destination)
    const socks = createServer((socket) => {
      socket.once('data', () => socket.end(Buffer.from([5, 2])))
    })
    const socksPort = await listen(socks)
    const bridge = await bridgeFor(
      settings(
        [{ pattern: 'forbidden.test', route: 'proxy:Broken' }],
        [{ name: 'Broken', host: '127.0.0.1', port: socksPort }],
        true
      )
    )

    const response = await rawRequest(
      portOf(bridge),
      get(`http://forbidden.test:${destinationPort}/private`, `forbidden.test:${destinationPort}`)
    )
    expect(response.toString()).toContain('502')
    expect(directHits).toBe(0)
  })

  test('returns 502 when the selected SOCKS endpoint is dead and never falls back locally', async () => {
    let directHits = 0
    const destination = createHttpServer((_req, res) => {
      directHits++
      res.end('unexpected')
    })
    const destinationPort = await listen(destination)
    const dead = createServer()
    const deadPort = await listen(dead)
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    const bridge = await bridgeFor(
      settings(
        [{ pattern: 'forbidden.test', route: 'proxy:Dead' }],
        [{ name: 'Dead', host: '127.0.0.1', port: deadPort }],
        true
      )
    )

    const response = await rawRequest(
      portOf(bridge),
      get(`http://forbidden.test:${destinationPort}/private`, `forbidden.test:${destinationPort}`)
    )
    expect(response.toString()).toContain('502')
    expect(directHits).toBe(0)
  })

  test('routes named-proxy CONNECT by hostname and parses port 443', async () => {
    let requestedHost = ''
    let requestedPort = 0
    const socks = createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from([5, 0]))
        socket.once('data', (request: Buffer) => {
          requestedHost = request.subarray(5, 5 + request[4]!).toString()
          requestedPort = request.readUInt16BE(5 + request[4]!)
          socket.end(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]))
        })
      })
    })
    const socksPort = await listen(socks)
    const bridge = await bridgeFor(
      settings(
        [{ pattern: 'cdn.example.test', route: 'proxy:CDN' }],
        [{ name: 'CDN', host: '127.0.0.1', port: socksPort }]
      )
    )

    const response = await rawRequest(
      portOf(bridge),
      Buffer.from('CONNECT cdn.example.test:443 HTTP/1.1\r\nHost: cdn.example.test:443\r\nConnection: close\r\n\r\n')
    )
    expect(response.toString()).toContain('200 Connection Established')
    expect(requestedHost).toBe('cdn.example.test')
    expect(requestedPort).toBe(443)
  })

  test('close aborts an established CONNECT tunnel and an in-progress SOCKS handshake', async () => {
    const upstreamSockets: Socket[] = []
    const socks = createServer((socket) => {
      upstreamSockets.push(socket)
      socket.once('data', () => socket.write(Buffer.from([5, 0])))
      // Deliberately withhold the destination reply, leaving negotiation in progress.
    })
    const socksPort = await listen(socks)
    const bridge = await bridgeFor(
      settings(
        [{ pattern: 'example.test', route: 'proxy:Hold' }],
        [{ name: 'Hold', host: '127.0.0.1', port: socksPort }]
      )
    )

    const established = netConnect(portOf(bridge), '127.0.0.1')
    const handshaking = netConnect(portOf(bridge), '127.0.0.1')
    sockets.push(established, handshaking)
    await Promise.all([once(established, 'connect'), once(handshaking, 'connect')])
    const connectRequest = Buffer.from('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n')
    established.write(connectRequest)
    handshaking.write(connectRequest)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 40)
      const check = (): void => {
        if (upstreamSockets.length >= 2) {
          clearTimeout(timer)
          resolve()
        }
      }
      socks.on('connection', check)
    })
    bridge.close()
    const closed = await Promise.all(
      upstreamSockets.map(
        (socket) =>
          new Promise<boolean>((resolve) => {
            let settled = false
            const settle = (value: boolean): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(value)
            }
            // The abort can RST a SOCKS socket whose reply is still unread,
            // which surfaces as 'error' before the 'close' that follows; wait
            // for the close instead of failing on the error.
            const timer = setTimeout(() => settle(false), 300)
            socket.once('error', () => {})
            socket.once('close', () => settle(true))
          })
      )
    )
    expect(closed).toEqual([true, true])
  })

  test('rejects a request if blocked state changes during connection setup', async () => {
    let blocked = false
    const destination = createHttpServer((_req, res) => res.end('should not be reached'))
    const destinationPort = await listen(destination)
    const bridge = await bridgeFor(settings(), () => blocked)
    const blocker = netConnect(destinationPort, '127.0.0.1')
    sockets.push(blocker)
    await once(blocker, 'connect')
    blocked = true

    const response = await rawRequest(
      portOf(bridge),
      get(`http://127.0.0.1:${destinationPort}/`, `127.0.0.1:${destinationPort}`)
    )
    expect(response.toString()).toContain('403')
  })

  test('rejects malformed CONNECT authorities and unsupported HTTP methods', async () => {
    const bridge = await bridgeFor(settings())
    const malformed = await rawRequest(
      portOf(bridge),
      Buffer.from('CONNECT example.test HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n')
    )
    const unsupported = await rawRequest(
      portOf(bridge),
      Buffer.from('POST http://example.test/model HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n')
    )
    expect(malformed.toString()).toContain('400')
    expect(unsupported.toString()).toContain('405')
  })

  test('preserves an HTTP redirect response and its Location header', async () => {
    const origin = createHttpServer((_req, res) => {
      res.writeHead(302, { location: 'https://cdn.example.test/model' })
      res.end()
    })
    const originPort = await listen(origin)
    const bridge = await bridgeFor(settings())

    const response = await rawRequest(
      portOf(bridge),
      get(`http://127.0.0.1:${originPort}/model`, `127.0.0.1:${originPort}`)
    )
    expect(response.toString()).toContain('302')
    expect(response.toString().toLowerCase()).toContain('location: https://cdn.example.test/model')
  })
})
