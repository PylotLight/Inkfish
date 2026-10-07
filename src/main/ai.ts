import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import type { ClassifyResult, NoteKind, Project } from '../shared/types'
import { listEngines } from './stt'

/**
 * AI abstraction: `transcribe()` / `classify()` / `summarize()` / `speak()`.
 *
 * Provider chain: Apple Intelligence where present → rules engine.
 * No account, offline default. Each result reports which `provider` produced
 * it so the UI can show it and the router can distrust low-confidence rules.
 *
 * Reality check (Electron, P0): Apple Foundation Models have no public API
 * reachable from Electron, so classification today = the built-in rules
 * engine. Apple Speech runs through the bundled `inkfish-stt` Swift CLI
 * (`stt/inkfish-stt.swift`, on-device `SFSpeechRecognizer`).
 * STT = native binaries only (`$INKFISH_STT_BIN`, `parakeet-cli`,
 * `inkfish-stt` Apple Speech CLI) — never python/pip. See `stt/README.md`.
 */

export interface ProviderStatus {
  id: 'apple' | 'rules' | 'stt'
  available: boolean
  detail: string
}

export async function providerStatus(): Promise<ProviderStatus[]> {
  const engines = await listEngines()
  const ready = engines.filter((e) => e.ready)
  const apple = engines.find((e) => e.id === 'apple-analyzer' && e.available) ?? engines.find((e) => e.id === 'apple-speech')
  return [
    {
      id: 'apple',
      available: apple?.available ?? false,
      detail: process.platform !== 'darwin' ? 'Apple Speech needs macOS' : apple ? `${apple.name}: ${apple.detail}` : 'not built'
    },
    { id: 'rules', available: true, detail: 'built-in keyword router, always available, offline' },
    {
      id: 'stt',
      available: ready.length > 0,
      detail: ready.length
        ? `ready: ${ready.map((e) => e.name).join(', ')}`
        : 'no transcription engine ready — Settings › Transcription'
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

// --- transcribe: see ./stt.ts ------------------------------------------------

export { transcribe } from './stt'

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
