// Renders the Homebrew cask from Casks/inkfish.rb.tmpl, filling in the
// version and the SHA-256 of the macOS (Apple silicon) zip published to the GitHub release.
// This repo doubles as the tap (brew taps any repo with a Casks/ dir via
// `brew tap pylotlight/inkfish <url>`), so the release workflow renders
// straight to Casks/inkfish.rb on main. Run locally to sanity-check:
//
//   bun scripts/render-cask.ts \
//     --version 1.2.3 \
//     --sha256-arm <sha of Inkfish-1.2.3-mac-arm64.zip> \
//     [--out Casks/inkfish.rb]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = join(root, 'Casks', 'inkfish.rb.tmpl')

function fail(msg: string): never {
  console.error(`[render-cask] error: ${msg}`)
  process.exit(1)
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: bun scripts/render-cask.ts --version X.Y.Z --sha256-arm HEX [--out PATH]'
  )
  console.log('Without --out, prints to stdout.')
  process.exit(0)
}

const version = argValue('--version')
const shaArm = argValue('--sha256-arm')
const out = argValue('--out')

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`--version is required and must be semver, got '${version}'`)
}
const SHA256 = /^[0-9a-f]{64}$/
if (!shaArm || !SHA256.test(shaArm)) {
  fail('--sha256-arm must be a lowercase hex sha256')
}

const cask = readFileSync(templatePath, 'utf8')
  .replaceAll('{{VERSION}}', version)
  .replaceAll('{{SHA256_ARM64}}', shaArm)

if (cask.includes('{{')) {
  fail('template still has unfilled placeholders')
}

if (out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, cask)
  console.log(`[render-cask] wrote ${out}`)
} else {
  process.stdout.write(cask)
}
