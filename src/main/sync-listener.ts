import type { Server } from 'node:http'

/** Bind to the preferred port, falling back to an ephemeral port if it is already occupied. */
export function listenWithPortFallback(server: Server, preferredPort: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, retry: boolean): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (retry && err.code === 'EADDRINUSE') {
          attempt(0, false)
          return
        }
        reject(err)
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.removeListener('error', onError)
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Sync listener did not report a bound port'))
      })
    }

    attempt(preferredPort, true)
  })
}
