// Build the Apple Speech CLI → stt/bin/inkfish-stt
// (universal arm64 + x86_64, macOS 12+, ad-hoc signed, Info.plist embedded so
// TCC has a usage string even when run outside the app). No-op off macOS.
// Runs automatically from `bun run dev` and `bun run build`; skips when the
// binary is newer than its sources. Missing Xcode tools: warns locally,
// fails in CI (releases must bundle it). `--force` rebuilds.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') {
  console.log('[stt:build] not macOS — skipping Apple Speech CLI')
  process.exit(0)
}

const src = join(root, 'stt', 'inkfish-stt.swift')
const plist = join(root, 'stt', 'Info.plist')
const outDir = join(root, 'stt', 'bin')
const out = join(outDir, 'inkfish-stt')
const fresh =
  !process.argv.includes('--force') &&
  existsSync(out) &&
  [src, plist].every((f) => statSync(f).mtimeMs <= statSync(out).mtimeMs)
if (fresh) {
  console.log('[stt:build] up to date')
  process.exit(0)
}
try {
  execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' })
} catch {
  const msg = '[stt:build] swiftc not found — run `xcode-select --install` to enable Apple Speech transcription'
  if (process.env['CI']) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg)
  process.exit(0)
}
mkdirSync(outDir, { recursive: true })

const run = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

const slices: string[] = []
for (const arch of ['arm64', 'x86_64']) {
  const slice = join(outDir, `inkfish-stt-${arch}`)
  run('xcrun', [
    'swiftc', '-O', '-target', `${arch}-apple-macos12`,
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
    src, '-o', slice
  ])
  slices.push(slice)
}
run('lipo', ['-create', ...slices, '-output', out])
for (const s of slices) rmSync(s)
run('codesign', ['--force', '--sign', '-', '--options', 'runtime', out])
console.log(`[stt:build] ${out}`)
