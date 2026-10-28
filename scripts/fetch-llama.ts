import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const TAG = 'b11946'
const ARCHIVE = `llama-${TAG}-bin-macos-arm64.tar.gz`
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${ARCHIVE}`
const SIZE = 16_438_371
const SHA256 = 'd618da5e7bbb19077f086e6a7e1d77eab55b9bfd481f7531aadada86d13db9ed'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'llm', 'bin')
const VERSION_MARKER = `tag=${TAG}\nsha256=${SHA256}\n`

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log('[llama] pinned llama-server bundle is macOS ARM64 only; skipping on this build host')
  process.exit(0)
}

const installedMarker = join(OUTPUT, 'VERSION')
if (existsSync(join(OUTPUT, 'llama-server')) && existsSync(join(OUTPUT, 'LICENSE'))) {
  try {
    if (readFileSync(installedMarker, 'utf8') === VERSION_MARKER) {
      console.log(`[llama] ${TAG} already installed`)
      process.exit(0)
    }
  } catch {
    // Replace partial or older installations below.
  }
}

const temp = mkdtempSync(join(tmpdir(), 'inkfish-llama-'))
const archivePath = join(temp, ARCHIVE)
const extracted = join(temp, 'extract')
const staged = join(ROOT, 'llm', `bin-stage-${process.pid}`)

try {
  console.log(`[llama] downloading ${ARCHIVE}`)
  const response = await fetch(URL, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${ARCHIVE}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== SIZE) throw new Error(`Unexpected archive size: expected ${SIZE}, received ${bytes.length}`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== SHA256) throw new Error(`llama.cpp archive SHA-256 mismatch: ${digest}`)
  writeFileSync(archivePath, bytes)

  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const expectedRoot = `llama-${TAG}/`
  if (
    entries.some(
      (entry) => entry.startsWith('/') || entry.split('/').includes('..') || !entry.startsWith(expectedRoot)
    ) ||
    !entries.includes(`${expectedRoot}llama-server`) ||
    !entries.includes(`${expectedRoot}LICENSE`)
  ) {
    throw new Error('Unexpected or unsafe paths in the pinned llama.cpp archive')
  }

  mkdirSync(extracted, { recursive: true })
  execFileSync('tar', ['-xzf', archivePath, '-C', extracted], { stdio: 'ignore' })
  const source = join(extracted, `llama-${TAG}`)
  const server = join(source, 'llama-server')
  const license = join(source, 'LICENSE')
  if (!existsSync(server) || !existsSync(license)) throw new Error('Archive is missing llama-server or its LICENSE')

  mkdirSync(dirname(OUTPUT), { recursive: true })
  rmSync(staged, { recursive: true, force: true })
  cpSync(source, staged, { recursive: true })
  chmodSync(join(staged, 'llama-server'), 0o755)
  writeFileSync(join(staged, 'VERSION'), VERSION_MARKER, 'utf8')
  rmSync(OUTPUT, { recursive: true, force: true })
  renameSync(staged, OUTPUT)
  console.log(`[llama] installed ${TAG} with bundled dependencies and license at ${OUTPUT}`)
} catch (error) {
  rmSync(staged, { recursive: true, force: true })
  throw error
} finally {
  rmSync(temp, { recursive: true, force: true })
}
