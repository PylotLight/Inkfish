import { spawn } from 'node:child_process'
import { parseHelperJson } from '../shared/stt'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_INTEL_PREFS,
  INTEL_MAX_IMAGE_BYTES,
  INTEL_MAX_IMAGES,
  type IntelImage,
  type IntelPrefs,
  type IntelResult,
  type IntelStatus,
  type IntelTask
} from '../shared/intelligence'
import { getLfmModelForRuntime, isIntelRuntimeId } from '../shared/intel-runtime'
import { LFM_CATALOG } from '../shared/lfm-catalog'
import { localIntelStatus, runLocalIntel } from './intel-local'
import { getManagedLfmStatus, withManagedLfmServer } from './llama-managed'
import { helperPath } from './stt'
import { appDataDir } from './vault'

/**
 * Embedded intelligence: Apple Foundation Models or a user-run local inference
 * server. The local path only connects to loopback OpenAI-compatible servers and
 * sends no API key; callers fall back to the rules engine when unavailable.
 */

// --- prefs (app data, so the main-process router can read them) -------------------

function prefsPath(): string | null {
  const dir = appDataDir()
  return dir ? join(dir, 'intelligence.json') : null
}

export function loadIntelPrefs(): IntelPrefs {
  try {
    const p = prefsPath()
    if (!p || !existsSync(p)) return { ...DEFAULT_INTEL_PREFS }
    const data = JSON.parse(readFileSync(p, 'utf8')) as Partial<IntelPrefs>
    return sanitize({ ...DEFAULT_INTEL_PREFS, ...data })
  } catch {
    return { ...DEFAULT_INTEL_PREFS }
  }
}

export function saveIntelPrefs(patch: Partial<IntelPrefs>): IntelPrefs {
  const next = sanitize({ ...loadIntelPrefs(), ...patch })
  const p = prefsPath()
  if (p) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2))
  }
  return next
}

function sanitize(p: IntelPrefs): IntelPrefs {
  const engine = p.engine === 'apple' || isIntelRuntimeId(p.engine) ? p.engine : 'apple'
  return {
    provider: p.provider === 'off' ? 'off' : engine === 'apple' ? 'apple' : 'local',
    engine,
    // Keep an invalid value visible in Settings so status can explain why it is blocked.
    // localIntelStatus/completeLocalChat independently reject every non-loopback URL.
    localBaseUrl:
      String(p.localBaseUrl ?? '')
        .trim()
        .replace(/\/+$/, '')
        .slice(0, 500) || DEFAULT_INTEL_PREFS.localBaseUrl,
    localModel: String(p.localModel ?? '')
      .trim()
      .slice(0, 200),
    cleanup: Boolean(p.cleanup),
    organize: Boolean(p.organize),
    actionItems: Boolean(p.actionItems),
    style: p.style === 'light' || p.style === 'structured' ? p.style : 'standard',
    temperature: Math.max(0, Math.min(1, Number.isFinite(p.temperature) ? p.temperature : 0.2)),
    instructions: String(p.instructions ?? '').slice(0, 1200)
  }
}

// --- helper calls ------------------------------------------------------------------

function call(args: string[], stdin: string | null, timeoutMs: number): Promise<string> {
  const bin = helperPath()
  if (!bin) return Promise.reject(new Error('Inkfish helper not built — install Xcode tools and restart dev'))
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { timeout: timeoutMs })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => reject(new Error(`helper failed to start: ${e.message}`)))
    child.on('close', (code, signal) => {
      const last = err
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop()
      if (signal === 'SIGTERM') reject(new Error('Apple Intelligence timed out'))
      else if (code !== 0) reject(new Error(last || `helper exited ${code}`))
      else resolve(out)
    })
    if (stdin !== null) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

let cached: { at: number; status: IntelStatus } | null = null
const STATUS_TTL_MS = 60_000

/** Availability of the selected engine. Apple status is cached for a minute; local checks are live. */
export async function intelStatus(fresh = false): Promise<IntelStatus> {
  const prefs = loadIntelPrefs()
  if (prefs.engine !== 'apple') {
    if (prefs.engine === 'llama.cpp-managed') {
      const managed = getManagedLfmStatus()
      const model = getLfmModelForRuntime(prefs.engine, prefs.localModel)
      if (!managed.supportedPlatform) return { available: false, reason: 'platformUnsupported', detail: managed.detail }
      if (!managed.binaryReady) return { available: false, reason: 'binaryMissing', detail: managed.detail }
      if (!model) return { available: false, reason: 'invalidModel', detail: 'Choose one of the managed LFM3 models.' }
      const saved = managed.models.find((item) => item.apiModelId === model.apiModelId)
      if (!saved?.installed)
        return {
          available: false,
          reason: 'modelNotDownloaded',
          detail: `${model.name} weights are not downloaded yet. Review the LFM Open License and download the model in Settings.`
        }
      return {
        available: true,
        reason: 'available',
        detail: `${model.name} is installed. The local llama.cpp server starts when needed and stops after 10 minutes idle.`,
        runtime: 'llama.cpp (managed)'
      }
    }
    return localIntelStatus({ engine: prefs.engine, baseUrl: prefs.localBaseUrl, model: prefs.localModel })
  }
  if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status
  let status: IntelStatus
  if (process.platform !== 'darwin') {
    status = { available: false, reason: 'unsupported', detail: 'Apple Intelligence needs macOS 26 on Apple silicon' }
  } else {
    try {
      status = parseHelperJson<IntelStatus>(await call(['ai', 'status'], null, 15_000)) ?? {
        available: false,
        reason: 'helper',
        detail: 'Apple Intelligence status unreadable'
      }
    } catch (e) {
      status = { available: false, reason: 'helper', detail: e instanceof Error ? e.message : String(e) }
    }
  }
  cached = { at: Date.now(), status }
  return status
}

export interface IntelRunInput {
  task: IntelTask
  text: string
  projects?: string[]
  images?: IntelImage[]
  /** Overrides for the settings playground; omitted fields use saved prefs. */
  prefs?: Partial<IntelPrefs>
}

/** Strictly validate renderer-supplied image bytes before an inference request. */
export function sanitizeIntelImages(value: unknown): IntelImage[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > INTEL_MAX_IMAGES)
    throw new Error(`Send at most ${INTEL_MAX_IMAGES} images`)
  let total = 0
  const images = value.map((item): IntelImage => {
    if (!item || typeof item !== 'object') throw new Error('Invalid image payload')
    const { mime, data } = item as { mime?: unknown; data?: unknown }
    if (mime !== 'image/png' && mime !== 'image/jpeg') throw new Error('Only PNG and JPEG images are supported')
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1)
      throw new Error('Image payload is not valid base64')
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.length > INTEL_MAX_IMAGE_BYTES) throw new Error('Image exceeds the 4 MB per-image limit')
    const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if ((mime === 'image/png' && !png) || (mime === 'image/jpeg' && !jpeg))
      throw new Error('Image MIME type does not match its contents')
    total += bytes.length
    return { mime, data }
  })
  if (total > INTEL_MAX_IMAGE_BYTES * INTEL_MAX_IMAGES) throw new Error('Images exceed the 8 MB combined limit')
  return images
}

/** Run one task on the on-device model. Throws when unavailable — callers fall back. */
export async function intelRun(input: IntelRunInput): Promise<IntelResult> {
  // Renderer-supplied playground overrides are untrusted; re-sanitize the endpoint before any request.
  const prefs = sanitize({ ...loadIntelPrefs(), ...(input.prefs ?? {}) })
  const images = sanitizeIntelImages(input.images)
  if (prefs.engine !== 'apple') {
    if (images.length && input.task === 'cleanup')
      throw new Error('Image inputs require organise or summarise; cleanup is text-only')
    if (prefs.engine === 'llama.cpp-managed') {
      const modelId = images.length ? LFM_CATALOG['lfm3-vl-2b'].apiModelId : prefs.localModel
      const model = getLfmModelForRuntime(prefs.engine, modelId)
      if (!model) throw new Error('Select a supported managed LFM3 model')
      return withManagedLfmServer(model.key, (endpoint) =>
        runLocalIntel({
          config: {
            engine: 'llama.cpp-managed',
            baseUrl: endpoint.baseUrl,
            model: endpoint.model,
            expectedPid: endpoint.pid
          },
          task: input.task,
          text: input.text,
          projects: input.projects ?? [],
          style: prefs.style,
          instructions: prefs.instructions,
          temperature: prefs.temperature,
          cleanup: input.task === 'organize' ? prefs.cleanup : false,
          images
        })
      )
    }
    return runLocalIntel({
      config: { engine: prefs.engine, baseUrl: prefs.localBaseUrl, model: prefs.localModel },
      task: input.task,
      text: input.text,
      projects: input.projects ?? [],
      style: prefs.style,
      instructions: prefs.instructions,
      temperature: prefs.temperature,
      cleanup: input.task === 'organize' ? prefs.cleanup : false,
      images
    })
  }
  if (images.length)
    throw new Error('Apple Foundation Models does not accept image inputs; choose a local LFM3-VL llama.cpp model.')
  const req = {
    task: input.task,
    text: input.text,
    projects: input.projects ?? [],
    style: prefs.style,
    instructions: prefs.instructions,
    temperature: prefs.temperature,
    cleanup: input.task === 'organize' ? prefs.cleanup : undefined
  }
  // Long notes clean up in ~2.4k-char chunks, a few seconds each.
  const timeout = 30_000 + Math.ceil(input.text.length / 2400) * 20_000
  const t0 = Date.now()
  const out = parseHelperJson<IntelResult>(await call(['ai', 'run'], JSON.stringify(req), timeout))
  if (!out) throw new Error('Apple Intelligence returned no result')
  return { ...out, ms: out.ms || Date.now() - t0, provider: 'apple' }
}

/**
 * Map the model's project name onto a real project: exact match only (case-insensitive, outer
 * whitespace ignored). Loose containment used to file "the work project" under anything with
 * "work" in it; now anything else returns null so the router keeps its own call.
 */
export function matchProject<T extends { id: string; name: string }>(name: string, projects: T[]): T | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return projects.find((p) => p.name.toLowerCase() === n || p.id.toLowerCase() === n) ?? null
}
