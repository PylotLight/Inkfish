import { imagePart, resolveModel } from '../../shared/ai-api'
import { supportsInput, tagImages, tagSystemPrompt } from '../../shared/ai-models'
import { imageCandidates } from '../../shared/images'
import { processText, type Complete, type ProcessInput, type ProcessResult } from '../../shared/ai-process'
import {
  errorDetailsText,
  formatAiError,
  isElectronUnknownError,
  splitErrorSentinel,
  visibleText,
  type AiErrorDetail
} from '../../shared/ai-errors'

/**
 * The renderer side of Electron 45's native AI integration: the standard Prompt API
 * (`LanguageModel`, Chromium's built-in AI global). Inkfish's main process registers a local AI
 * handler on the app session when a provider is connected (Settings › AI), so these calls are
 * answered by the user's provider through a utility process. No provider = no handler, and we say
 * so before calling anything.
 */

interface PromptModel {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>
  destroy(): void
}
interface LanguageModelStatic {
  availability(options?: unknown): Promise<string>
  create(options?: {
    initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    signal?: AbortSignal
  }): Promise<PromptModel>
}

/** Per-run options for `promptApiComplete`. */
export interface CompleteOptions {
  /** Model id for this run (per-action models); the handler strips the tag. */
  model?: string
  /** Vault-relative path of the note, to resolve its image refs. */
  notePath?: string | null
}

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * Load a note's images (asset:// refs) as data: URLs; ones that fail, are too big or aren't
 * PNG/JPEG/GIF/WebP are skipped.
 */
async function loadImages(refs: string[], notePath?: string | null): Promise<string[]> {
  const out: string[] = []
  for (const src of refs.slice(0, MAX_IMAGES)) {
    for (const url of imageCandidates(src, notePath)) {
      if (/^https?:/i.test(url)) break // remote images are not fetched
      try {
        const res = await fetch(url)
        if (!res.ok) continue
        const blob = await res.blob()
        if (blob.size > 0 && blob.size <= MAX_IMAGE_BYTES) {
          const img = imagePart(new Uint8Array(await blob.arrayBuffer()))
          if (img) out.push(`data:${img.mime};base64,${img.data}`)
        }
        break
      } catch {
        // try the next candidate
      }
    }
  }
  return out
}

/** A failed provider request with the handler's structured detail (status, endpoint, model). */
export class AiRunError extends Error {
  constructor(readonly detail: AiErrorDetail | null, message = detail ? formatAiError(detail) : 'The AI request failed.') {
    super(message)
    this.name = 'AiRunError'
  }
}

/**
 * Electron flattened a handler failure to kErrorUnknown (no sentinel arrived, e.g. the handler
 * crashed or failed before streaming): ask main for the handler's last error since `since`.
 */
async function explainUnknown(err: unknown, since: number): Promise<never> {
  if (!isElectronUnknownError(err)) throw err
  const detail = await window.api.aiApi.lastError(since).catch(() => null)
  if (detail) throw new AiRunError(detail)
  throw new AiRunError(
    null,
    'The AI handler failed without details (Electron: kErrorUnknown). Run Settings › AI › Test on this model to see the provider error.'
  )
}

/** Thrown when no provider is connected; the UI offers a link to Settings › AI. */
export class AiNotConnectedError extends Error {
  constructor(message = 'No AI provider connected. Connect one in Settings › AI.') {
    super(message)
    this.name = 'AiNotConnectedError'
  }
}

function languageModel(): LanguageModelStatic | null {
  const lm = (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel
  return lm ?? null
}

/** Ready to prompt? Checks the saved settings first (clear error), then the Prompt API itself. */
export async function ensureAiReady(): Promise<void> {
  const status = await window.api.aiApi.status()
  if (!status.connected) throw new AiNotConnectedError()
  const lm = languageModel()
  if (!lm) throw new AiNotConnectedError('This build has no Prompt API (LanguageModel). Update Inkfish.')
  const availability = await lm.availability()
  if (availability !== 'available') throw new AiNotConnectedError(`AI provider is ${availability}. Check Settings › AI.`)
}

/** `Complete` over the Prompt API: one session per call, streamed, cancelled by `signal`. */
export function promptApiComplete(signal?: AbortSignal, opts: CompleteOptions = {}): Complete {
  return async (prompt, onChunk) => {
    await ensureAiReady()
    const lm = languageModel() as LanguageModelStatic
    const images = prompt.imageRefs?.length ? await loadImages(prompt.imageRefs, opts.notePath) : []
    const since = Date.now() - 50
    // errors: 'inline' → the handler reports a failed request as a sentinel chunk with the real
    // provider error, since Electron only passes kErrorUnknown through (shared/ai-errors.ts).
    const model = await lm
      .create({
        initialPrompts: [{ role: 'system', content: tagSystemPrompt(prompt.system, { model: opts.model, errors: 'inline' }) }],
        signal
      })
      .catch((e: unknown) => explainUnknown(e, since))
    try {
      // Images ride as tagged data: URLs (see tagImages in shared/ai-models.ts); the handler lifts them out.
      const reader = model.promptStreaming(tagImages(prompt.user, images), { signal }).getReader()
      let out = ''
      let shown = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          out += value
          const vis = visibleText(out)
          if (vis !== shown) {
            shown = vis
            onChunk?.(vis)
          }
        }
      } catch (e) {
        if (signal?.aborted) throw e
        return await explainUnknown(e, since)
      }
      const { text, error } = splitErrorSentinel(out)
      if (error) throw new AiRunError(error)
      return text
    } finally {
      model.destroy()
    }
  }
}

/**
 * Run a Process action with the model it resolves to (per-action model, else the active one): its
 * limits drive chunking, and its image input (plus Settings › AI › Include images) decides whether
 * the note's images go along.
 */
export async function runAiProcess(
  input: ProcessInput,
  signal?: AbortSignal,
  ctx: { notePath?: string | null } = {}
): Promise<ProcessResult> {
  const status = await window.api.aiApi.status()
  if (!status.connected) throw new AiNotConnectedError()
  const model = resolveModel(status.settings, input.action)
  const includeImages = status.settings.includeImages && supportsInput(model, 'image')
  return processText({ ...input, model, includeImages }, promptApiComplete(signal, { model: model.id, notePath: ctx.notePath }))
}

/** Plain message for any error from a run (abort is not an error to show). */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return String(err)
}

/** "Copy details": the message plus the structured provider detail (scrubbed in the handler). */
export function aiErrorDetails(err: unknown): string {
  const detail = err instanceof AiRunError ? err.detail : null
  return errorDetailsText(detail, aiErrorMessage(err), {
    ...(err instanceof Error && !(err instanceof AiRunError) ? { name: err.name } : {}),
    app: 'Inkfish'
  })
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted|signal timed out/i.test(err.message))
}

/** App-wide commands from ⌘K, the note menu and shortcuts → the open NoteEditor's AI panel. */
export type AiCommand = 'toggle-view' | 'process-note' | 'process-selection'
export const AI_COMMAND_EVENT = 'inkfish:ai'
export function sendAiCommand(cmd: AiCommand): void {
  window.dispatchEvent(new CustomEvent<AiCommand>(AI_COMMAND_EVENT, { detail: cmd }))
}
