import { describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { listenWithPortFallback } from './sync-listener'

function listening(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

describe('sync listener port fallback', () => {
  test('reports the actual fallback port when the preferred port is occupied', async () => {
    const blocker = createServer()
    const listener = createServer()
    await listening(blocker, 0)
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('Blocker did not report its port')

    try {
      const actualPort = await listenWithPortFallback(listener, address.port, '127.0.0.1')
      expect(actualPort).toBeGreaterThan(0)
      expect(actualPort).not.toBe(address.port)
      expect(listener.address()).toMatchObject({ port: actualPort })
    } finally {
      await Promise.all([close(listener), close(blocker)])
    }
  })
})
