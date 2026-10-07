import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SttEngine, SttResult } from '../shared/types'

/**
 * Speech-to-text engines. Native only — never python/pip.
 *
 * The bundled helper (`stt/` SwiftPM package → Resources/bin/inkfish-stt)
 * hosts Apple Speech, Apple SpeechAnalyzer (macOS 26) and Parakeet
 * v3/Redux/Ultra/v2 via FluidAudio on the Neural Engine. It's an internal
 * sidecar the app spawns, not a user-facing tool. `parakeet-cli` (Homebrew
 * whisper-cpp) is picked up as one more engine when installed, and
 * `$INKFISH_STT_BIN` overrides everything (must print `{text, segments}`).
 */

/** Auto-pick order when no engine is chosen. */
const AUTO_ORDER = [
  'parakeet-ultra',
  'parakeet-v3',
  'parakeet-redux',
  'parakeet-v2',
  'apple-analyzer',
  'apple-speech',
  'parakeet-cli'
]

const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

export function helperPath(): string | null {
  if (process.platform !== 'darwin') return null
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [res ? join(res, 'bin', 'inkfish-stt') : '', join(process.cwd(), 'stt', 'bin', 'inkfish-stt')]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

async function onPath(bin: string): Promise<string | null> {
  for (const dir of EXTRA_BIN_DIRS) {
    const p = join(dir, bin)
    if (existsSync(p)) return p
  }
  try {
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'where' : 'which', [bin])
    return stdout.split('\n').map((l) => l.trim()).find(Boolean) ?? null
  } catch {
    return null
  }
}

/** Last meaningful stderr line (FluidAudio logs to stderr before our error). */
function lastLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { timeout: timeoutMs })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => reject(new Error(`transcription engine failed to start: ${e.message}`)))
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') reject(new Error('transcription timed out'))
      else if (code !== 0) reject(new Error(lastLine(err) || lastLine(out) || `engine exited ${code}`))
      else resolve(out)
    })
  })
}

export async function listEngines(): Promise<SttEngine[]> {
  const engines: SttEngine[] = []
  const override = process.env['INKFISH_STT_BIN']?.trim()
  if (override && existsSync(override)) {
    engines.push({ id: 'override', name: 'Custom ($INKFISH_STT_BIN)', available: true, ready: true, detail: override })
  }
  const helper = helperPath()
  if (helper) {
    try {
      engines.push(...(JSON.parse(await run(helper, ['engines'], 20_000)) as SttEngine[]))
    } catch (e) {
      engines.push({
        id: 'apple-speech', name: 'Built-in engines', available: false, ready: false,
        detail: `Helper failed: ${e instanceof Error ? e.message : String(e)}`
      })
    }
  } else if (process.platform === 'darwin') {
    engines.push({
      id: 'apple-speech', name: 'Built-in engines', available: false, ready: false,
      detail: 'Not built — install Xcode tools (`xcode-select --install`) and restart dev'
    })
  }
  const pc = await onPath('parakeet-cli')
  engines.push({
    id: 'parakeet-cli', name: 'parakeet.cpp (Homebrew)', available: pc !== null, ready: pc !== null,
    detail: pc ? `${pc} · Metal GPU` : 'Optional: `brew install whisper-cpp`'
  })
  return engines
}

function pickAuto(engines: SttEngine[]): SttEngine | undefined {
  if (engines[0]?.id === 'override') return engines[0]
  for (const id of AUTO_ORDER) {
    const e = engines.find((x) => x.id === id && x.ready)
    if (e) return e
  }
  return undefined
}

/** wav → transcript with the chosen engine ('' / undefined = best ready engine). */
export async function transcribe(wavPath: string, engineId?: string, timeoutMs = 300_000): Promise<SttResult> {
  const engines = await listEngines()
  const engine = engineId ? engines.find((e) => e.id === engineId) : pickAuto(engines)
  if (!engine) {
    throw new Error(
      engineId
        ? `Unknown engine ${engineId}`
        : 'No transcription engine ready — open Settings › Transcription to download one'
    )
  }
  if (!engine.available) throw new Error(`${engine.name}: ${engine.detail}`)
  const t0 = Date.now()
  let out: string
  if (engine.id === 'override') {
    out = await run(engine.detail, [wavPath, '--json'], timeoutMs)
  } else if (engine.id === 'parakeet-cli') {
    out = await run((await onPath('parakeet-cli')) as string, ['transcribe', '--input', wavPath, '--json'], timeoutMs)
  } else {
    out = await run(helperPath() as string, ['transcribe', wavPath, '--engine', engine.id], timeoutMs)
  }
  const ms = Date.now() - t0
  try {
    const p = JSON.parse(out) as { text?: string; segments?: SttResult['segments']; ms?: number }
    return { text: p.text ?? '', provider: engine.id, engine: engine.name, segments: p.segments ?? [], ms: p.ms ?? ms }
  } catch {
    const text = out.trim()
    if (!text) throw new Error(`${engine.name} returned no transcript`)
    return { text, provider: engine.id, engine: engine.name, segments: [], ms }
  }
}

/** Download an engine's models (Parakeet) or language assets (SpeechAnalyzer). */
export async function prepareEngine(engineId: string): Promise<void> {
  const helper = helperPath()
  if (!helper) throw new Error('Transcription helper not built')
  await run(helper, ['prepare', '--engine', engineId], 30 * 60_000)
}
