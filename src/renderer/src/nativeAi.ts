import { processText, type Complete, type ProcessInput, type ProcessResult } from '../../shared/ai-process'

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
export function promptApiComplete(signal?: AbortSignal): Complete {
  return async (prompt, onChunk) => {
    await ensureAiReady()
    const lm = languageModel() as LanguageModelStatic
    const model = await lm.create({ initialPrompts: [{ role: 'system', content: prompt.system }], signal })
    try {
      const reader = model.promptStreaming(prompt.user, { signal }).getReader()
      let out = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        out += value
        onChunk?.(out)
      }
      return out
    } finally {
      model.destroy()
    }
  }
}

export function runAiProcess(input: ProcessInput, signal?: AbortSignal): Promise<ProcessResult> {
  return processText(input, promptApiComplete(signal))
}

/** Plain message for any error from a run (abort is not an error to show). */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return String(err)
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
