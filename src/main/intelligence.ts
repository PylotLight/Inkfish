import { spawn } from 'node:child_process'
import { parseHelperJson } from '../shared/stt'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_INTEL_PREFS,
  type IntelPrefs,
  type IntelResult,
  type IntelStatus,
  type IntelTask
} from '../shared/intelligence'
import { helperPath } from './stt'
import { appDataDir } from './vault'

/**
 * Apple Intelligence — the on-device Foundation Models LLM (macOS 26), used
 * for note cleanup ("fluid intelligence"-style) and organising captures into
 * projects. Runs inside the bundled `inkfish-stt` helper (`ai status` /
 * `ai run`, see stt/Sources/InkfishSTT/Intelligence.swift); nothing leaves
 * the Mac. Every caller falls back to the rules engine when it's unavailable.
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
  return {
    provider: p.provider === 'off' ? 'off' : 'apple',
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

/** Availability of the on-device model. Cached for a minute; `fresh` re-checks. */
export async function intelStatus(fresh = false): Promise<IntelStatus> {
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
  /** Overrides for the settings playground; omitted fields use saved prefs. */
  prefs?: Partial<IntelPrefs>
}

/** Run one task on the on-device model. Throws when unavailable — callers fall back. */
export async function intelRun(input: IntelRunInput): Promise<IntelResult> {
  const prefs = { ...loadIntelPrefs(), ...(input.prefs ?? {}) }
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
 * Map the model's project name onto a real project: exact (case-insensitive),
 * then containment. Unknown names return null so the router can fall back.
 */
export function matchProject<T extends { id: string; name: string }>(name: string, projects: T[]): T | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return (
    projects.find((p) => p.name.toLowerCase() === n || p.id.toLowerCase() === n) ??
    projects.find((p) => n.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(n)) ??
    null
  )
}
