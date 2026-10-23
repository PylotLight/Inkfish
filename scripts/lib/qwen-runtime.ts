import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

const VERSION = 'v0.1.44'
const assets: Record<string, string> = {
  'llama_webgpu_bridge.js': 'a704115fe87d3defff4a02c5a2b1d1bf0ab3bc1f00de3f40ed2c9b2d5983fd73',
  'llama_webgpu_bridge_worker.js': '47bbfa0fe897e708455b9497e9aa41d2e94489c329300c33b12936fb3169deca',
  'llama_webgpu_core.js': '67bade52aad19471ee96a7180db691e1f6b4e87d4254adaa3e5d9a31f6206ed1',
  'llama_webgpu_core.wasm': 'f643e79520ac97bc150db6806735b9b73a98b07eb1b2fa4146bb773944315c71',
  'llama_webgpu_core_mem64.js': '6575880ad6a631b6a8f9aaaebb9a5c3f1cc2910f59700ce529d3de6077276337',
  'llama_webgpu_core_mem64.wasm': 'aaf399050af09af0c44b55ecf9d665e8f6e18df6f6deada3feab07677ddd7233'
}
const directory = resolve(process.cwd(), 'node_modules/.cache/qwen-runtime', VERSION)
async function ensureAssets(): Promise<void> {
  mkdirSync(directory, { recursive: true })
  for (const [name, digest] of Object.entries(assets)) {
    const target = resolve(directory, name)
    if (existsSync(target) && createHash('sha256').update(readFileSync(target)).digest('hex') === digest) continue
    const response = await fetch(
      `https://github.com/leehack/llama-web-bridge-assets/releases/download/${VERSION}/${name}`
    )
    if (!response.ok) throw new Error(`Qwen bridge asset fetch failed (${response.status}): ${name}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error(`Qwen bridge asset checksum mismatch: ${name}`)
    writeFileSync(target, bytes)
  }
}

/** Vendor upstream bridge locally: same-origin URLs satisfy the renderer's restrictive CSP. */
export function qwenRuntime(): Plugin {
  const prefix = '/qwen-runtime/'
  return {
    name: 'inkfish-qwen-runtime',
    async configResolved() {
      await ensureAssets()
    },
    generateBundle() {
      for (const name of Object.keys(assets))
        this.emitFile({
          type: 'asset',
          fileName: `qwen-runtime/${name}`,
          source: readFileSync(resolve(directory, name))
        })
      this.emitFile({
        type: 'asset',
        fileName: 'qwen-runtime/LICENSE.txt',
        source: readFileSync(resolve(process.cwd(), 'build/qwen-runtime-LICENSE.txt'))
      })
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
          response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
          response.end(readFileSync(path))
        } catch {
          response.statusCode = 404
          response.end()
        }
      })
    }
  }
}
