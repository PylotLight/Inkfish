#!/usr/bin/env node
// `bunx inkfish` / `npx inkfish` launcher.
//
// This package ships the built Electron main process under `out/` plus this
// shim. The shim launches the app with an Electron binary, resolved in order:
//   1. the `electron` dependency (source checkouts), or
//   2. an on-demand `electron@<pinned>` fetched via bunx/npx (~100 MB, cached).
//
// Primary distribution remains the signed GitHub artifacts + Homebrew cask
// (see README); npm is a convenience path for folks who already live in
// Bun/Node. `electron` must stay in devDependencies — electron-builder
// refuses to package otherwise — hence the on-demand fallback.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const main = join(root, 'out', 'main', 'index.js')

if (!existsSync(main)) {
  console.error(
    "inkfish: built app not found (expected out/main/index.js).\n" +
      'If you installed from source, run `bun install && bun run build` first.\n' +
      'Otherwise grab a signed build from https://github.com/PylotLight/Inkfish/releases'
  )
  process.exit(1)
}

const args = [main, ...process.argv.slice(2)]

// 1. Electron alongside the package (dev/source installs).
try {
  const electronBin = createRequire(import.meta.url)('electron')
  const child = spawnSync(electronBin, args, { stdio: 'inherit' })
  process.exit(child.status ?? 1)
} catch {
  // Not installed here — fall through to the on-demand fetch below.
}

// 2. Fetch a pinned Electron via the caller's own runner (cached after first run).
let pinned = 'electron'
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const range = pkg.devDependencies?.electron
  if (typeof range === 'string' && range.length > 0) pinned = `electron@${range}`
} catch {
  // Unpinned fallback is fine — any recent Electron runs the built app.
}

const runner = process.versions.bun ? 'bunx' : 'npx'
const runnerArgs = process.versions.bun ? [pinned, ...args] : ['--yes', pinned, ...args]
const child = spawnSync(runner, runnerArgs, { stdio: 'inherit' })
if (child.error) {
  console.error(
    `inkfish: could not launch Electron (${child.error.message}).\n` +
      `Install it once with \`${runner} ${pinned} --version\`, then retry.`
  )
  process.exit(1)
}
process.exit(child.status ?? 1)
