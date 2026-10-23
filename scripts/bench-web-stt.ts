// bun run bench:stt:web [--quick | --deep] [--offline] [web-engine-id ...]
// Linux: xvfb-run -a bun run bench:stt:web
// Uses the same engines, fixtures, warm-up, time limits and WER as Settings.
import { build } from 'vite'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const outDir = resolve(root, 'out/stt-bench')
await build({
  configFile: false,
  root,
  base: './',
  logLevel: 'warn',
  worker: { format: 'es' },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: resolve(root, 'scripts/stt-bench-renderer.ts'),
      output: { entryFileNames: 'bench.js' }
    }
  }
})
const csp = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8').match(
  /<meta\s+http-equiv="Content-Security-Policy"[^>]+>/
)?.[0]
if (!csp) throw new Error('Application CSP not found')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  resolve(outDir, 'index.html'),
  `<!doctype html><head>${csp}</head><body>Inkfish STT benchmark<script type="module" src="./bench.js"></script></body>`
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync('node', [resolve(root, 'scripts/electron-web-stt-bench.cjs'), ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit'
})
process.exit(result.status ?? 1)
