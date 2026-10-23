import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import type { ClassifyResult, NoteKind, Project } from '../shared/types'
import { intelRun, intelStatus, loadIntelPrefs } from './intelligence'
import {
  DEFAULT_ROUTING_PREFS,
  aiCandidates,
  aiRoutePrompt,
  applyAiRoute,
  decideRoute,
  parseAiRoute,
  tagVocab,
  type RouteDecision,
  type RouteDoc,
  type RouteFolder,
  type RouteInput,
  type RouteNoteMeta,
  type RoutingPrefs
} from '../shared/routing'
import { slugify } from './vault'
import { listEngines } from './stt'

/**
 * AI abstraction: `transcribe()` / `classify()` / `summarize()` / `speak()`.
 *
 * Provider chain: Apple Intelligence where present → rules engine.
 * No account, offline default. Each result reports which `provider` produced
 * it so the UI can show it and the router can distrust low-confidence rules.
 *
 * Apple Intelligence = the on-device Foundation Models LLM (macOS 26), reached
 * through the bundled `inkfish-stt` helper (`ai run`, see ./intelligence.ts).
 * It cleans up and files captures when enabled in Settings › Apple
 * Intelligence; anything it can't do (off, unavailable, error, unknown
 * project) falls back to the rules engine, so capture never blocks on it.
 * STT = bundled native helper only (see ./stt.ts, stt/README.md) — never python/pip.
 */

export interface ProviderStatus {
  id: 'apple' | 'intelligence' | 'rules' | 'stt'
  available: boolean
  detail: string
}

export async function providerStatus(): Promise<ProviderStatus[]> {
  const engines = await listEngines()
  const ready = engines.filter((e) => e.ready)
  const apple =
    engines.find((e) => e.id === 'apple-analyzer' && e.available) ?? engines.find((e) => e.id === 'apple-speech')
  return [
    {
      id: 'apple',
      available: apple?.available ?? false,
      detail:
        process.platform !== 'darwin'
          ? 'Apple Speech needs macOS'
          : apple
            ? `${apple.name}: ${apple.detail}`
            : 'not built'
    },
    await intelStatus().then((s) => ({ id: 'intelligence' as const, available: s.available, detail: s.detail })),
    { id: 'rules', available: true, detail: 'built-in router (vault content + tags), always available, offline' },
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

/** The user's AI provider, when connected: (system, user) → reply text, or null when unavailable. */
export type RouteLlm = (system: string, user: string) => Promise<string | null>

export interface ClassifyInput {
  raw: string
  kind: NoteKind
  projects: Project[]
  /** Explicit picker choice; 'auto' (or omitted) = let the router decide. */
  projectHint?: string
  /** Vault evidence: every note's metadata + the notes matching the capture (see ./routing.ts). */
  corpus?: { notes: RouteNoteMeta[]; docs: RouteDoc[]; totalDocs?: number }
  /** Settings › Routing (defaults when omitted). */
  prefs?: RoutingPrefs
  llm?: RouteLlm | null
}

function titleFromRaw(raw: string): string {
  const first =
    raw
      .split('\n')
      .map((l) => l.trim().replace(/^#+\s*/, ''))
      .find((l) => l.length > 0) ?? 'Untitled'
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first
  return sentence.slice(0, 80).trim() || 'Untitled'
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

const foldersOf = (projects: Project[]): RouteFolder[] => projects.map((p) => ({ id: p.id, name: p.name, dir: p.dir }))

function routeInput(input: ClassifyInput, prefs: RoutingPrefs): RouteInput {
  return {
    raw: input.raw,
    kind: input.kind,
    folders: foldersOf(input.projects),
    notes: input.corpus?.notes ?? [],
    docs: input.corpus?.docs ?? [],
    totalDocs: input.corpus?.totalDocs,
    prefs,
    hint: input.projectHint
  }
}

function toResult(d: RouteDecision, input: ClassifyInput): ClassifyResult {
  const p = d.folder ? input.projects.find((x) => x.dir === d.folder) : undefined
  return {
    projectId: p?.id ?? (d.folder ? slugify(d.folder, 32) : ''),
    projectName: d.folder ?? '',
    title: titleFromRaw(input.raw),
    tags: d.tags,
    markdown: formatBody(input.raw, input.kind),
    provider: d.provider,
    confidence: d.confidence,
    action: d.action,
    targetRel: d.target,
    targetTitle: d.targetTitle,
    reason: d.reason
  }
}

/** Offline router only (no models). */
export function rulesRoute(input: ClassifyInput): { decision: RouteDecision; result: ClassifyResult } {
  const decision = decideRoute(routeInput(input, input.prefs ?? DEFAULT_ROUTING_PREFS))
  return { decision, result: toResult(decision, input) }
}

/** Notes the model shouldn't rewrite or file: empty, or already-formatted meeting transcripts. */
function intelEligible(input: ClassifyInput): boolean {
  return input.kind !== 'meeting' && input.kind !== 'image' && input.raw.trim().length >= 12
}

/**
 * Route one capture. Rules first (offline, vault content), then the user's AI provider when it is
 * connected and allowed, else Apple Intelligence when on — both only pick between the candidates the
 * rules found (exact matches), and an explicit picker choice always wins.
 */
export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  const prefs = input.prefs ?? DEFAULT_ROUTING_PREFS
  const { decision } = rulesRoute(input)
  let routed = decision
  let out = toResult(decision, input)
  const vocab = tagVocab(input.corpus?.notes ?? [])
  const fixed = decision.provider === 'picker' || decision.reason.startsWith('meeting →')
  const cand = aiCandidates(decision, foldersOf(input.projects))
  let aiDone = false

  // 1. The user's own AI provider (Settings › AI provider), when connected.
  if (!fixed && input.llm && prefs.useAiProvider && intelEligible(input) && cand.folders.length) {
    try {
      const { system, user } = aiRoutePrompt(input.raw, cand, prefs.allowAppend)
      const reply = await input.llm(system, user)
      const ai = reply ? parseAiRoute(reply, cand) : null
      if (ai) {
        routed = applyAiRoute(decision, ai, 'api', prefs, vocab)
        out = { ...toResult(routed, input), title: ai.title || out.title }
        aiDone = true
      }
    } catch (err) {
      console.warn('[route] AI provider failed, using rules:', err instanceof Error ? err.message : String(err))
    }
  }

  // 2. Apple Intelligence: cleanup, and organise when the provider didn't answer.
  const intel = loadIntelPrefs()
  if (intel.provider !== 'apple' || (!intel.cleanup && !intel.organize) || !intelEligible(input)) return out
  try {
    if (!(await intelStatus()).available) return out
    const organize = intel.organize && !aiDone
    const r = await intelRun({ task: organize ? 'organize' : 'cleanup', text: input.raw, projects: cand.folders })
    if (intel.cleanup && r.text.trim()) out.markdown = r.text.trim()
    if (organize) {
      if (r.title.trim()) out.title = r.title.trim().slice(0, 80)
      // Exact candidate only (no loose containment); picker / meetings folder are never overridden.
      const folder = fixed ? null : cand.folders.find((f) => f.toLowerCase() === r.project.trim().toLowerCase())
      const ai = {
        action: 'new' as const,
        folder: folder ?? '',
        targetNote: null,
        title: '',
        tags: r.tags,
        // No score from the on-device model: a valid pick counts as just above the default bar.
        confidence: folder ? Math.max(prefs.minConfidence, 0.6) : 0
      }
      // Keep a rules append (the model can't see notes); otherwise take its folder.
      if (routed.action !== 'append') routed = applyAiRoute(routed, ai, 'apple', prefs, vocab)
      const { title, markdown } = out
      out = { ...toResult(routed, input), title, markdown }
      if (intel.actionItems && r.actionItems.length) {
        const todos = r.actionItems.map((a) => a.trim()).filter(Boolean)
        const missing = todos.filter((a) => !out.markdown.includes(a))
        if (missing.length) out.markdown += `\n\n## Action items\n${missing.map((a) => `- [ ] ${a}`).join('\n')}`
      }
    }
    if (out.provider === 'rules') out.provider = 'apple'
    return out
  } catch {
    return out
  }
}

// --- summarize --------------------------------------------------------------------

export function summarizeExtractive(text: string, maxSentences = 3): string {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [text]
  return sentences.slice(0, maxSentences).join(' ').trim()
}

export async function summarize(text: string, maxSentences = 3): Promise<{ text: string; provider: string }> {
  if (loadIntelPrefs().provider === 'apple' && text.trim()) {
    try {
      if ((await intelStatus()).available) {
        const r = await intelRun({ task: 'summarize', text })
        if (r.summary.trim()) return { text: r.summary.trim(), provider: 'apple' }
      }
    } catch {
      // fall through to extractive
    }
  }
  return { text: summarizeExtractive(text, maxSentences), provider: 'rules' }
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
