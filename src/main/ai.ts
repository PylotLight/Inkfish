import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { ClassifyResult, NoteKind, Project, SttResult } from '../shared/types'

/**
 * AI abstraction: `transcribe()` / `classify()` / `summarize()` / `speak()`.
 *
 * Provider chain: Apple Intelligence where present → rules engine.
 * No account, offline default. Each result reports which `provider` produced
 * it so the UI can show it and the router can distrust low-confidence rules.
 *
 * Reality check (Electron, P0): Apple Foundation Models have no public API
 * reachable from Electron, and Apple Speech needs native code — so the
 * `apple` provider reports availability only (used for short-dictation
 * hooks later). Classification today = the built-in rules engine.
 * STT = native binaries only (`$INKFISH_STT_BIN`, `parakeet-cli`,
 * `inkfish-stt` Apple Speech CLI) — never python/pip. See `stt/README.md`.
 */

export interface ProviderStatus {
  id: 'apple' | 'rules' | 'stt'
  available: boolean
  detail: string
}

async function nativeSttBin(): Promise<string | null> {
  const override = process.env['INKFISH_STT_BIN']?.trim()
  if (override && existsSync(override)) return override
  const execFileAsync = promisify(execFile)
  for (const bin of ['parakeet-cli', 'inkfish-stt']) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const { stdout } = await execFileAsync(cmd, [bin])
      const hit = stdout.split('\n').map((l) => l.trim()).find(Boolean)
      if (hit) return bin
    } catch {
      // not on PATH — try next
    }
  }
  return null
}

export async function providerStatus(): Promise<ProviderStatus[]> {
  const stt = await nativeSttBin()
  return [
    {
      id: 'apple',
      available: process.platform === 'darwin',
      detail:
        process.platform === 'darwin'
          ? 'Apple Silicon detected — Foundation Models hook reserved (rules engine for now)'
          : 'Apple Intelligence needs macOS'
    },
    { id: 'rules', available: true, detail: 'built-in keyword router, always available, offline' },
    {
      id: 'stt',
      available: stt !== null,
      detail: stt
        ? `native STT ready (${stt}) — no python`
        : 'no native STT binary (parakeet-cli / inkfish-stt) — voice falls back to manual text'
    }
  ]
}

// --- classify -------------------------------------------------------------------

export interface ClassifyInput {
  raw: string
  kind: NoteKind
  projects: Project[]
  /** Explicit picker choice; 'auto' (or omitted) = let the router decide. */
  projectHint?: string
}

function titleFromRaw(raw: string): string {
  const first = raw
    .split('\n')
    .map((l) => l.trim().replace(/^#+\s*/, ''))
    .find((l) => l.length > 0) ?? 'Untitled'
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first
  return sentence.slice(0, 80).trim() || 'Untitled'
}

function tagsFromRaw(raw: string, kind: NoteKind): string[] {
  const tags = new Set<string>()
  for (const m of raw.matchAll(/#([a-z0-9][a-z0-9-_]*)/gi)) {
    const t = m[1]?.toLowerCase()
    if (t) tags.add(t)
  }
  if (kind !== 'text') tags.add(kind)
  return [...tags].slice(0, 8)
}

function formatBody(raw: string, kind: NoteKind): string {
  const text = raw.trim()
  if (kind === 'meeting') return text // meeting import already formats
  // Normalize: collapse 3+ blank lines, ensure list markers are `- `.
  return text
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => (/^\s*[*•]\s+/.test(l) ? l.replace(/^\s*[*•]\s+/, '- ') : l))
    .join('\n')
}

function rulesClassify(input: ClassifyInput): ClassifyResult {
  const { raw, kind, projects } = input
  const hint = input.projectHint && input.projectHint !== 'auto' ? input.projectHint : null
  let project = hint ? (projects.find((p) => p.id === hint || p.name === hint) ?? null) : null
  let confidence = hint ? 1 : 0
  if (!project) {
    const hay = raw.toLowerCase()
    let best = 0
    for (const p of projects) {
      const name = p.name.toLowerCase()
      // Whole-word hits count more than substrings.
      const words = name.split(/[^a-z0-9]+/).filter(Boolean)
      let score = 0
      for (const w of words) {
        if (w.length < 3) continue
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
        score += (hay.match(re) ?? []).length * 2
        if (hay.includes(w)) score += 0.5
      }
      if (score > best) {
        best = score
        project = p
      }
    }
    confidence = best >= 2 ? 0.7 : best > 0 ? 0.45 : 0.25
    project ??= projects[0] ?? { id: 'general', name: 'general', dir: 'general' }
  }
  return {
    projectId: project.id,
    projectName: project.name,
    title: titleFromRaw(raw),
    tags: tagsFromRaw(raw, kind),
    markdown: formatBody(raw, kind),
    provider: 'rules',
    confidence
  }
}

export function classify(input: ClassifyInput): Promise<ClassifyResult> {
  return Promise.resolve(rulesClassify(input))
}

// --- summarize --------------------------------------------------------------------

export function summarizeExtractive(text: string, maxSentences = 3): string {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [text]
  return sentences.slice(0, maxSentences).join(' ').trim()
}

export function summarize(text: string, maxSentences = 3): Promise<{ text: string; provider: string }> {
  return Promise.resolve({ text: summarizeExtractive(text, maxSentences), provider: 'rules' })
}

// --- transcribe (native STT binaries only — never python) -------------------------------

/** wav → `{ text, segments }` via a native STT binary. Rejects when unavailable. */
export async function transcribe(wavPath: string, timeoutMs = 120_000): Promise<SttResult> {
  const bin = await nativeSttBin()
  if (!bin) {
    throw new Error('STT unavailable (no native engine — install parakeet-cli or import transcript text instead)')
  }
  return new Promise((resolve, reject) => {
    // Contract: binary takes the wav path and prints
    // `{"text": "...", "segments": [{"start": 0, "end": 1.2, "text": "..."}]}`
    // on stdout. Both `parakeet-cli --json` and the Apple `inkfish-stt` CLI
    // follow it; anything else is surfaced as plain text when parseable.
    const args = bin === 'parakeet-cli'
      ? ['transcribe', '--input', wavPath, '--json']
      : [wavPath, '--json']
    const child = spawn(bin, args, { timeout: timeoutMs })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => reject(new Error(`STT engine failed to start (${bin}): ${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`STT engine exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`))
        return
      }
      try {
        const parsed = JSON.parse(out) as { text: string; segments?: SttResult['segments'] }
        resolve({ text: parsed.text ?? '', provider: 'stt', segments: parsed.segments ?? [] })
      } catch {
        const text = out.trim()
        if (!text) {
          reject(new Error(`STT engine returned no transcript (${bin})`))
          return
        }
        resolve({ text, provider: 'stt', segments: [] })
      }
    })
  })
}

// --- speak (TTS later; `say`/espeak first) ---------------------------------------------

const speakChild: { proc: ReturnType<typeof spawn> | null } = { proc: null }

/** Fire-and-forget speech. Resolves false when no backend exists. */
export function speak(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    stopSpeak()
    const cmd = process.platform === 'darwin' ? 'say' : 'espeak'
    try {
      const proc = spawn(cmd, [text.slice(0, 2000)], { stdio: 'ignore' })
      speakChild.proc = proc
      proc.on('error', () => resolve(false))
      proc.on('close', () => {
        speakChild.proc = null
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

export function stopSpeak(): void {
  try {
    speakChild.proc?.kill()
  } catch {
    // already gone
  }
  speakChild.proc = null
}
