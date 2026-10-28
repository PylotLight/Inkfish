// Build Inkfish's bundled transcription helper → stt/bin/inkfish-stt
// (SwiftPM package in stt/: Apple Speech, SpeechAnalyzer, Parakeet via
// FluidAudio). arm64 only (Apple silicon).
// Runs from `bun run dev` and `bun run build`; skips when the binary and
// SwiftPM cache match the selected toolchain. No-op off macOS. `--force`
// rebuilds; a toolchain change clears SwiftPM's incompatible `.build` cache.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') {
  console.log('[stt:build] not macOS — skipping transcription helper')
  process.exit(0)
}

const pkg = join(root, 'stt')
const outDir = join(pkg, 'bin')
const out = join(outDir, 'inkfish-stt')
const buildDir = join(pkg, '.build')
const toolchainMarker = join(buildDir, 'inkfish-toolchain.txt')
const force = process.argv.includes('--force')

function newestSource(dir: string): number {
  let t = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.build' || e.name === 'bin') continue
    const p = join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newestSource(p) : statSync(p).mtimeMs)
  }
  return t
}

function versionParts(app: string): number[] {
  const match = /^Xcode_(\d+(?:\.\d+)*)\.app$/.exec(app)
  const version = match?.[1]
  return version ? version.split('.').map(Number) : [0]
}

function compareXcodeApps(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference) return difference
  }
  return a.localeCompare(b)
}

function newestStableDeveloperDir(): string | undefined {
  try {
    const apps = readdirSync('/Applications', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Xcode(?:_\d+(?:\.\d+)*)?\.app$/.test(entry.name))
      .filter((entry) => !/(?:beta|rc|release[_ -]?candidate)/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareXcodeApps)
      .reverse()
    return apps
      .map((app) => join('/Applications', app, 'Contents', 'Developer'))
      .find((candidate) => existsSync(candidate))
  } catch {
    return undefined
  }
}

function selectedDeveloperDir(): string | undefined {
  // CI explicitly runs the Xcode selector first; honor its system selection
  // rather than independently choosing a possibly different installed copy.
  if (process.env['CI']) {
    try {
      const selected = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim()
      if (selected) return selected
    } catch {
      // Fall through to an explicit override or the installed stable Xcode.
    }
  }
  if (process.env['DEVELOPER_DIR']) return resolve(process.env['DEVELOPER_DIR'])
  const stable = newestStableDeveloperDir()
  if (stable) return stable
  try {
    return execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

const buildEnv: NodeJS.ProcessEnv = { ...process.env }
const developerDir = selectedDeveloperDir()
if (developerDir && (process.env['CI'] || !buildEnv['DEVELOPER_DIR'])) {
  buildEnv['DEVELOPER_DIR'] = developerDir
  console.log(`[stt:build] using Xcode developer directory: ${developerDir}`)
}
const sourcesCurrent = existsSync(out) && newestSource(pkg) <= statSync(out).mtimeMs

let swiftVersion = ''
try {
  swiftVersion = execFileSync('xcrun', ['swift', '--version'], { encoding: 'utf8', env: buildEnv }).trim()
} catch {
  const msg = '[stt:build] Swift not found — run `xcode-select --install` to enable transcription'
  if (!force && sourcesCurrent) {
    console.warn(`${msg}; reusing the existing helper binary`)
    process.exit(0)
  }
  if (process.env['CI']) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg)
  process.exit(0)
}

const sdkVersion = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], {
  encoding: 'utf8',
  env: buildEnv
}).trim()
const sdkBuildVersion = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-build-version'], {
  encoding: 'utf8',
  env: buildEnv
}).trim()
const toolchainSignature = `DEVELOPER_DIR=${buildEnv['DEVELOPER_DIR'] ?? '(xcode-select)'}\n${swiftVersion}\nmacOS SDK=${sdkVersion} (${sdkBuildVersion})\n`
let cachedSignature = ''
try {
  cachedSignature = readFileSync(toolchainMarker, 'utf8')
} catch {
  // An unmarked cache may have been produced by an older Xcode selection.
}
const cacheMatches = cachedSignature === toolchainSignature
console.log(`[stt:build] ${swiftVersion.split('\n')[0]}`)
console.log(`[stt:build] macOS SDK ${sdkVersion} (${sdkBuildVersion}) · deployment target macOS 14`)

if (!force && sourcesCurrent && cacheMatches) {
  console.log('[stt:build] up to date (matching SwiftPM toolchain cache)')
  process.exit(0)
}

if (existsSync(buildDir) && !cacheMatches) {
  console.log('[stt:build] clearing SwiftPM cache because its compiler/SDK marker is missing or different')
  rmSync(buildDir, { recursive: true, force: true })
}

const base = ['swift', 'build', '-c', 'release', '--package-path', pkg]
const swift = (args: string[]): void => {
  execFileSync('xcrun', [...base, ...args], { stdio: 'inherit', env: buildEnv })
}
// Where SwiftPM put the product. Layout moved between toolchains
// (.build/apple/Products/Release → .build/out/…), so ask it, then probe.
const binPath = (args: string[]): string | null => {
  const asked = (() => {
    try {
      return execFileSync('xcrun', [...base, ...args, '--show-bin-path'], {
        encoding: 'utf8',
        env: buildEnv
      }).trim()
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

// Apple silicon only — Inkfish doesn't ship an Intel build.
const archArgs = ['--arch', 'arm64']
swift(archArgs)
const productDir = binPath(archArgs)
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
const archs = execFileSync('lipo', ['-archs', out], { encoding: 'utf8' }).trim()
if (!archs.split(/\s+/).includes('arm64')) {
  console.error(`[stt:build] ${out} has no arm64 slice (${archs})`)
  process.exit(1)
}
writeFileSync(toolchainMarker, toolchainSignature)
console.log(`[stt:build] ${out} (${archs})`)
