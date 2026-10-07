import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseHelperJson, pickAutoEngine } from '../shared/stt'
import type { DownloadProgress, DownloadState, SttEngine, SttResult } from '../shared/types'
export type { DownloadProgress } from '../shared/types'

/**
 * Speech-to-text engines. Native only — never python/pip.
 *
 * The bundled helper (`stt/` SwiftPM package → Resources/bin/inkfish-stt)
 * hosts Apple Speech, Apple SpeechAnalyzer (macOS 26) and the FluidAudio
 * CoreML models (Parakeet, Phonon-2, Nemotron 3.5, Cohere) on the Neural
 * Engine. It's an internal sidecar the app spawns, not a user-facing tool.
 * No external installs. `$INKFISH_STT_BIN` (dev only) overrides everything
 * and must print `{text, segments}`.
 */

export function helperPath(): string | null {
  if (process.platform !== 'darwin') return null
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [res ? join(res, 'bin', 'inkfish-stt') : '', join(process.cwd(), 'stt', 'bin', 'inkfish-stt')]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

/** Last meaningful stderr line (FluidAudio logs to stderr before our error). */
function lastLine(s: string): string {
  return (
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  )
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
    engines.push({
      id: 'override',
      name: 'Custom ($INKFISH_STT_BIN)',
      available: true,
      ready: true,
      detail: override
    })
  }
  const helper = helperPath()
  if (helper) {
    try {
      engines.push(...(parseHelperJson<SttEngine[]>(await run(helper, ['engines'], 20_000)) ?? []))
    } catch (e) {
      engines.push({
        id: 'apple-speech',
        name: 'Built-in engines',
        available: false,
        ready: false,
        detail: `Helper failed: ${e instanceof Error ? e.message : String(e)}`
      })
    }
  } else if (process.platform === 'darwin') {
    engines.push({
      id: 'apple-speech',
      name: 'Built-in engines',
      available: false,
      ready: false,
      detail: 'Not built — install Xcode tools (`xcode-select --install`) and restart dev'
    })
  }
  return engines
}

/** wav → transcript with the chosen engine ('' / undefined = best ready engine). */
export async function transcribe(wavPath: string, engineId?: string, timeoutMs = 300_000): Promise<SttResult> {
  const engines = await listEngines()
  const engine = engineId ? engines.find((e) => e.id === engineId) : pickAutoEngine(engines)
  if (!engine) {
    throw new Error(
      engineId
        ? `Unknown engine ${engineId}`
        : 'No transcription engine ready — open Settings › Voice Engine to download one'
    )
  }
  if (!engine.available) throw new Error(`${engine.name}: ${engine.detail}`)
  const t0 = Date.now()
  let out: string
  if (engine.id === 'override') {
    out = await run(engine.detail, [wavPath, '--json'], timeoutMs)
  } else {
    out = await run(helperPath() as string, ['transcribe', wavPath, '--engine', engine.id], timeoutMs)
  }
  const ms = Date.now() - t0
  const p = parseHelperJson<{
    text?: string
    segments?: SttResult['segments']
    ms?: number
    runtime?: string
  }>(out)
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return {
      text: (p.text ?? '').trim(),
      provider: engine.id,
      engine: engine.name,
      segments: p.segments ?? [],
      ms: p.ms ?? ms,
      runtime: p.runtime || undefined
    }
  }
  const text = out.trim()
  if (!text) throw new Error(`${engine.name} returned no transcript`)
  return { text, provider: engine.id, engine: engine.name, segments: [], ms }
}

// MARK: downloads — progress, pause/resume, retry

const MAX_ATTEMPTS = 4
const BACKOFF_MS = [3_000, 10_000, 30_000]
const active = new Map<string, { child?: ChildProcess; paused: boolean; progress: DownloadProgress }>()

const BLOCKED_RE =
  /offline|timed? ?out|could not connect|cannot connect|network|connection|resolve|host|ssl|tls|certificate|proxy|forbidden|\b40[13]\b|\b429\b|\b5\d\d\b|-10(0[1-9]|20)|-1200|stall/i

export function downloadProgress(): DownloadProgress[] {
  return [...active.values()].map((d) => d.progress)
}

/**
 * Download an engine's models with live progress. Resolves when done or
 * paused; rejects after the last retry. FluidAudio resumes partial files with
 * HTTP Range, so pausing is just killing the helper and resuming re-runs it.
 * `mirror` repoints the Hugging Face host (e.g. https://hf-mirror.com).
 */
export async function prepareEngine(
  engineId: string,
  onProgress: (p: DownloadProgress) => void = () => {},
  mirror = ''
): Promise<void> {
  const helper = helperPath()
  if (!helper) throw new Error('Transcription helper not built')
  const existing = active.get(engineId)
  if (existing && !existing.paused && existing.child) return // already running
  const d = {
    child: undefined as ChildProcess | undefined,
    paused: false,
    progress: {
      id: engineId,
      state: 'downloading' as DownloadState,
      fraction: existing?.progress.fraction ?? 0,
      phase: '' as DownloadProgress['phase'],
      files: 0,
      total: 0,
      attempt: 1
    } as DownloadProgress
  }
  active.set(engineId, d)
  const emit = (patch: Partial<DownloadProgress>): void => {
    d.progress = { ...d.progress, ...patch }
    onProgress(d.progress)
  }
  emit({})
  const env = { ...process.env }
  if (mirror.trim()) env['REGISTRY_URL'] = mirror.trim().replace(/\/+$/, '')

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    emit({ state: 'downloading', attempt, error: undefined, blocked: undefined })
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(helper, ['prepare', '--engine', engineId], { env })
        d.child = child
        let err = ''
        let buf = ''
        child.stderr.on('data', (chunk: Buffer) => {
          buf += chunk.toString()
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('PROGRESS ')) {
              try {
                const p = JSON.parse(line.slice(9)) as Partial<DownloadProgress>
                emit({
                  // Monotonic: a resumed run re-lists first and must not dip the bar.
                  fraction: Math.max(d.progress.fraction, Math.min(1, p.fraction ?? 0)),
                  phase: p.phase ?? '',
                  files: p.files ?? 0,
                  total: p.total ?? 0
                })
              } catch {
                // malformed line — ignore
              }
            } else if (line.trim()) err += line + '\n'
          }
        })
        child.on('error', (e) => reject(new Error(`download helper failed to start: ${e.message}`)))
        child.on('close', (code) => {
          d.child = undefined
          if (d.paused) resolve()
          else if (code === 0) resolve()
          else reject(new Error(lastLine(err) || `download exited ${code}`))
        })
      })
      if (d.paused) {
        emit({ state: 'paused' })
        return
      }
      emit({ state: 'done', fraction: 1 })
      active.delete(engineId)
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const blocked = BLOCKED_RE.test(msg)
      if (attempt < MAX_ATTEMPTS) {
        emit({ state: 'retrying', error: msg, blocked })
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 30_000))
        if (d.paused) {
          emit({ state: 'paused' })
          return
        }
        continue
      }
      emit({ state: 'error', error: msg, blocked })
      throw new Error(
        blocked
          ? `Couldn't reach Hugging Face (${msg}). A VPN, firewall or network filter may be blocking it — retry, or switch the download source.`
          : msg
      )
    }
  }
}

/** Pause a running download; partial files stay on disk for resume. */
export function pauseDownload(engineId: string): void {
  const d = active.get(engineId)
  if (!d) return
  d.paused = true
  d.child?.kill('SIGTERM')
}

/** Forget a paused or failed download (its partial files go with `removeEngine`). */
export function clearDownload(engineId: string): void {
  pauseDownload(engineId)
  active.delete(engineId)
}

/** Delete an engine's downloaded models. */
export async function removeEngine(engineId: string): Promise<void> {
  clearDownload(engineId)
  const helper = helperPath()
  if (!helper) throw new Error('Transcription helper not built')
  await run(helper, ['remove', '--engine', engineId], 60_000)
}
