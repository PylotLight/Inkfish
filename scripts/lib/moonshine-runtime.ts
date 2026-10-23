import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

/** Keep the official JS workers, pthread module and WASM together, unbundled. */
export function moonshineRuntime(): Plugin {
  const require = createRequire(import.meta.url)
  const directory = dirname(require.resolve('@moonshine-ai/moonshine-wasm/moonshine.wasm'))
  const prefix = '/moonshine-runtime/'
  return {
    name: 'inkfish-moonshine-runtime',
    generateBundle() {
      for (const file of readdirSync(directory)) {
        if (!/\.(?:js|mjs|wasm|json)$/.test(file)) continue
        this.emitFile({
          type: 'asset',
          fileName: `moonshine-runtime/${file}`,
          source: readFileSync(resolve(directory, file))
        })
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? ''
        if (!pathname.startsWith(prefix)) return next()
        const path = resolve(directory, decodeURIComponent(pathname.slice(prefix.length)))
        if (!path.startsWith(directory + sep)) {
          response.statusCode = 403
          response.end()
          return
        }
        try {
          const bytes = readFileSync(path)
          response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
          response.end(bytes)
        } catch {
          response.statusCode = 404
          response.end()
        }
      })
    }
  }
}
