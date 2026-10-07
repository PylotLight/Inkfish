// Build Inkfish's bundled transcription helper → stt/bin/inkfish-stt
// (SwiftPM package in stt/: Apple Speech, SpeechAnalyzer, Parakeet via
// FluidAudio). Universal arm64 + x86_64 when possible, else host arch.
// Runs from `bun run dev` and `bun run build`; skips when the binary is newer
// than its sources. No Xcode tools: warns locally, fails in CI. `--force`
// rebuilds. No-op off macOS.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') {
  console.log('[stt:build] not macOS — skipping transcription helper')
  process.exit(0)
}

const pkg = join(root, 'stt')
const outDir = join(pkg, 'bin')
const out = join(outDir, 'inkfish-stt')

function newestSource(dir: string): number {
  let t = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.build' || e.name === 'bin') continue
    const p = join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newestSource(p) : statSync(p).mtimeMs)
  }
  return t
}

if (!process.argv.includes('--force') && existsSync(out) && newestSource(pkg) <= statSync(out).mtimeMs) {
  console.log('[stt:build] up to date')
  process.exit(0)
}

try {
  execFileSync('xcrun', ['--find', 'swift'], { stdio: 'ignore' })
} catch {
  const msg = '[stt:build] Swift not found — run `xcode-select --install` to enable transcription'
  if (process.env['CI']) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg)
  process.exit(0)
}

const base = ['swift', 'build', '-c', 'release', '--package-path', pkg]
const swift = (args: string[]): void => {
  execFileSync('xcrun', [...base, ...args], { stdio: 'inherit' })
}
// Where SwiftPM put the product. Layout moved between toolchains
// (.build/apple/Products/Release → .build/out/…), so ask it, then probe.
const binPath = (args: string[]): string | null => {
  const asked = (() => {
    try {
      return execFileSync('xcrun', [...base, ...args, '--show-bin-path'], { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  })()
  const candidates = [
    asked,
    join(pkg, '.build', 'apple', 'Products', 'Release'),
    join(pkg, '.build', 'out', 'Products', 'Release'),
    join(pkg, '.build', 'release'),
    join(pkg, '.build', 'arm64-apple-macosx', 'release')
  ]
  return candidates.find((d) => d && existsSync(join(d, 'inkfish-stt'))) ?? null
}

let productDir: string | null = null
try {
  swift(['--arch', 'arm64', '--arch', 'x86_64'])
  productDir = binPath(['--arch', 'arm64', '--arch', 'x86_64'])
} catch {
  console.warn('[stt:build] universal build failed — building for this Mac only')
}
if (!productDir) {
  swift([])
  productDir = binPath([])
}
if (!productDir) {
  console.error('[stt:build] built, but could not find the inkfish-stt product under stt/.build')
  process.exit(process.env['CI'] ? 1 : 0)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
cpSync(join(productDir, 'inkfish-stt'), out)
// SwiftPM resource bundles (Bundle.module) must sit next to the executable.
for (const e of readdirSync(productDir)) {
  if (e.endsWith('.bundle')) cpSync(join(productDir, e), join(outDir, e), { recursive: true })
}
execFileSync('strip', ['-x', out])
execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', out], { stdio: 'inherit' })
console.log(`[stt:build] ${out}`)
