import { connect, type Socket } from 'node:net'
import { Agent, createServer, request, type IncomingMessage } from 'node:http'
import { effectiveRouteForUrl } from '../shared/proxy-routing'
import type { ProxySettings } from '../shared/proxy-settings'

export interface ModelDownloadProxy {
  url: string
  close(): void
}
const CONNECT_TIMEOUT = 10_000

/** FluidAudio's HTTP(S) proxy hook → Inkfish's per-destination SOCKS policy.
 * HTTPS uses CONNECT: TLS and certificate validation remain in URLSession.
 */
export async function createModelDownloadProxy(
  settings: ProxySettings,
  isBlocked: () => boolean
): Promise<ModelDownloadProxy> {
  const sockets = new Set<Socket>()
  let closed = false
  const blocked = (): boolean => closed || isBlocked()
  const track = (socket: Socket): Socket => {
    sockets.add(socket)
    // Always consume transport errors, including after the handshake completes.
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    return socket
  }

  async function acquire(url: URL): Promise<Socket> {
    const route = effectiveRouteForUrl(url.href, settings)
    if (blocked() || !route) throw new Error('Download routing is blocked')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const socket = track(connect(route.kind === 'proxy' ? { host: route.host, port: route.port } : { host, port }))
    await new Promise<void>((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0)
      let stage = 0
      let settled = false
      const timer = setTimeout(() => finish(new Error('Download proxy connection timed out')), CONNECT_TIMEOUT)
      const onError = (error: Error): void => finish(error)
      const onClose = (): void => finish(new Error('Download proxy connection closed'))
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        socket.removeListener('data', onData)
        socket.removeListener('connect', onConnect)
      }
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error || blocked()) {
          socket.destroy()
          reject(error ?? new Error('Download routing is blocked'))
        } else {
          socket.pause()
          if (buffer.length) socket.unshift(buffer)
          resolve()
        }
      }
      const onConnect = (): void => {
        if (blocked()) return finish(new Error('Download routing is blocked'))
        if (route.kind === 'direct') return finish()
        socket.write(Buffer.from([5, 1, 0]))
      }
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        try {
          if (stage === 0 && buffer.length >= 2) {
            if (buffer[0] !== 5 || buffer[1] !== 0) throw new Error('SOCKS proxy rejected no-auth negotiation')
            buffer = buffer.subarray(2)
            stage = 1
            // A domain-name target also supports IP literals and avoids local
            // DNS lookups. URL normalisation supplies ASCII/IDNA hostnames.
            const name = Buffer.from(host)
            if (!name.length || name.length > 255) throw new Error('Invalid SOCKS destination')
            const destinationPort = Buffer.alloc(2)
            destinationPort.writeUInt16BE(port)
            socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, destinationPort]))
          }
          if (stage === 1 && buffer.length >= 4) {
            if (buffer[0] !== 5 || buffer[1] !== 0 || buffer[2] !== 0)
              throw new Error('SOCKS proxy rejected destination')
            const type = buffer[3]
            if (type !== 1 && type !== 3 && type !== 4) throw new Error('Invalid SOCKS proxy reply')
            if (type === 3 && buffer.length < 5) return
            const length = type === 1 ? 10 : type === 4 ? 22 : 7 + buffer[4]!
            if (buffer.length < length) return
            buffer = buffer.subarray(length)
            finish()
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
      socket.once('connect', onConnect)
      socket.on('data', onData)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
    if (blocked()) {
      socket.destroy()
      throw new Error('Download routing is blocked')
    }
    return socket
  }

  function destination(req: IncomingMessage): URL {
    const url = new URL(req.url ?? '')
    if (url.protocol !== 'http:' || !url.hostname || url.username || url.password)
      throw new Error('Expected an absolute HTTP model URL')
    return url
  }

  const server = createServer((req, res) => {
    const fail = (code: number): void => {
      if (!res.headersSent) {
        res.writeHead(code, { connection: 'close' })
        res.end()
      } else res.destroy()
    }
    if (blocked()) return fail(403)
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405)
    let url: URL
    try {
      url = destination(req)
    } catch {
      return fail(400)
    }
    void acquire(url).then(
      (socket) => {
        if (res.destroyed || blocked()) {
          socket.destroy()
          fail(403)
          return
        }
        const agent = new Agent({ keepAlive: false })
        agent.createConnection = () => socket
        const headers = { ...req.headers, host: url.host, connection: 'close' }
        delete (headers as Record<string, unknown>)['proxy-connection']
        delete (headers as Record<string, unknown>)['proxy-authorization']
        const upstream = request(url, { method: req.method, headers, agent }, (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers)
          response.once('error', () => res.destroy())
          response.pipe(res)
        })
        upstream.once('error', () => fail(502))
        req.once('aborted', () => upstream.destroy())
        res.once('close', () => {
          upstream.destroy()
          socket.destroy()
          agent.destroy()
        })
        req.pipe(upstream)
        socket.resume()
      },
      () => fail(blocked() ? 403 : 502)
    )
  })
  server.on('connection', (socket) => track(socket))
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', (req, rawClient, head) => {
    const client = rawClient as Socket
    const fail = (code: number): void => {
      client.end(
        `HTTP/1.1 ${code} ${code === 403 ? 'Forbidden' : code === 400 ? 'Bad Request' : 'Bad Gateway'}\r\nConnection: close\r\n\r\n`
      )
    }
    if (blocked()) return fail(403)
    let url: URL
    try {
      const authority = req.url ?? ''
      // URL removes the default :443 port, so validate the original authority.
      if (!/^(\[[0-9a-fA-F:.]+\]|[^\s/:@?#]+):[0-9]+$/.test(authority)) throw new Error('Invalid CONNECT authority')
      url = new URL(`https://${authority}`)
      if (!url.hostname || Number(authority.slice(authority.lastIndexOf(':') + 1)) < 1)
        throw new Error('Invalid CONNECT port')
    } catch {
      return fail(400)
    }
    void acquire(url).then(
      (upstream) => {
        if (client.destroyed || blocked()) {
          upstream.destroy()
          fail(403)
          return
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        client.once('close', () => upstream.destroy())
        upstream.once('close', () => client.destroy())
        client.once('error', () => upstream.destroy())
        upstream.once('error', () => client.destroy())
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
        upstream.resume()
      },
      () => fail(blocked() ? 403 : 502)
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not bind model download proxy')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close(): void {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.close()
    }
  }
}
