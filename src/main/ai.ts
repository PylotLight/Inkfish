import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClassifyResult, NoteKind, Project, SttResult } from '../shared/types'

/**
 * AI abstraction: `transcribe()` / `classify()` / `summarize()` / `speak()`.
 *
 * Provider chain: Apple Intelligence where present → Ollama → rules fallback.
 * No account, offline default. Each result reports which `provider` produced
 * it so the UI can show it and the router can distrust low-confidence rules.
 *
 * Reality check (Electron, P0): Apple Foundation Models have no public API
 * reachable from Electron, and Apple Speech needs native code — so the
 * `apple` provider reports availability only (used for short-dictation
 * hooks later). Classification today = Ollama when reachable, else the
 * built-in rules engine. STT = parakeet-redux sidecar (`stt/`), Apple Speech
 * fallback later.
 */

export interface ProviderStatus {
  id: 'apple' | 'ollama' | 'rules' | 'parakeet'
  available: boolean
  detail: string
}

const OLLAMA_HOST = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env['INKFISH_MODEL'] ?? 'qwen2.5:3b'

async function ollamaAvailable(): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 2500)
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: ctl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

export async function providerStatus(): Promise<ProviderStatus[]> {
  const ollama = await ollamaAvailable()
  return [
    {
      id: 'apple',
      available: process.platform === 'darwin',
      detail:
        process.platform === 'darwin'
          ? 'Apple Silicon detected — Foundation Models hook reserved (rules engine for now)'
          : 'Apple Intelligence needs macOS'
    },
    {
      id: 'ollama',
      available: ollama,
      detail: ollama ? `reachable at ${OLLAMA_HOST} (model ${OLLAMA_MODEL})` : `not reachable at ${OLLAMA_HOST}`
    },
    { id: 'rules', available: true, detail: 'built-in keyword router, always available, offline' },
    {
      id: 'parakeet',
      available: sidecarExists(),
      detail: sidecarExists()
        ? 'stt/transcribe.py present (moondream/parakeet-redux via photon)'
        : 'stt/transcribe.py missing — voice falls back to manual text'
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
    project ??= projects[0] ?? { id: 'general', name: 'general', dir: 'projects/general' }
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

async function ollamaClassify(input: ClassifyInput): Promise<ClassifyResult | null> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 20000)
    const projectList = input.projects.map((p) => p.name).join(', ')
    const prompt = [
      `You route quick-capture notes to projects. Projects: ${projectList || '(none yet)'}.`,
      `Reply with ONLY compact JSON: {"project": "<exact project name or a new short lowercase name>", "title": "<=80 chars>", "tags": ["kebab-case"], "markdown": "<formatted GitHub-flavored markdown body>"}.`,
      `Note kind: ${input.kind}. Raw note:`,
      input.raw.slice(0, 4000)
    ].join('\n')
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: 'json' })
    })
    clearTimeout(t)
    if (!res.ok) return null
    const data = (await res.json()) as { response?: string }
    const parsed = JSON.parse(data.response ?? '{}') as Partial<ClassifyResult> & {
      project?: string
    }
    const name = String(parsed.project ?? '').trim()
    const match =
      input.projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
    return {
      projectId: match?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-') ?? 'general',
      projectName: match?.name ?? name ?? 'general',
      title: String(parsed.title ?? titleFromRaw(input.raw)).slice(0, 80),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 8) : [],
      markdown: String(parsed.markdown ?? input.raw),
      provider: 'ollama',
      confidence: 0.85
    }
  } catch {
    return null
  }
}

export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  if (input.projectHint && input.projectHint !== 'auto') return rulesClassify(input)
  return (await ollamaClassify(input)) ?? rulesClassify(input)
}

// --- summarize --------------------------------------------------------------------

export function summarizeExtractive(text: string, maxSentences = 3): string {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [text]
  return sentences.slice(0, maxSentences).join(' ').trim()
}

export async function summarize(text: string, maxSentences = 3): Promise<{ text: string; provider: string }> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 20000)
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `Summarize in at most ${maxSentences} sentences:\n${text.slice(0, 4000)}`,
        stream: false
      })
    })
    clearTimeout(t)
    if (res.ok) {
      const data = (await res.json()) as { response?: string }
      if (data.response?.trim()) return { text: data.response.trim(), provider: 'ollama' }
    }
  } catch {
    // fall through to extractive
  }
  return { text: summarizeExtractive(text, maxSentences), provider: 'rules' }
}

// --- transcribe (parakeet-redux sidecar) --------------------------------------------

function sidecarPath(): string {
  // out/main in prod and dev alike → ../../stt/transcribe.py from repo root.
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '../../stt/transcribe.py'),
    join(process.cwd(), 'stt/transcribe.py')
  ]
  return candidates.find((c) => existsSync(c)) ?? candidates[1] ?? ''
}

function sidecarExists(): boolean {
  const p = sidecarPath()
  return !!p && existsSync(p)
}

/** wav → segments via the photon/parakeet sidecar. Rejects when unavailable. */
export function transcribe(wavPath: string, timeoutMs = 120_000): Promise<SttResult> {
  return new Promise((resolve, reject) => {
    const script = sidecarPath()
    if (!existsSync(script)) {
      reject(new Error('STT sidecar missing (stt/transcribe.py) — import transcript text instead'))
      return
    }
    const py = spawn('python3', [script, '--wav', wavPath, '--json'], { timeout: timeoutMs })
    let out = ''
    let err = ''
    py.stdout.on('data', (d: Buffer) => (out += d.toString()))
    py.stderr.on('data', (d: Buffer) => (err += d.toString()))
    py.on('error', (e) => reject(new Error(`STT sidecar failed to start: ${e.message}`)))
    py.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`STT sidecar exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`))
        return
      }
      try {
        const parsed = JSON.parse(out) as { text: string; segments?: SttResult['segments'] }
        resolve({ text: parsed.text ?? '', provider: 'parakeet', segments: parsed.segments ?? [] })
      } catch {
        resolve({ text: out.trim(), provider: 'parakeet', segments: [] })
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
