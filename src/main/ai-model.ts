import { estimateTokens, toChat, type ChatMessage, type PromptMessage } from '../shared/ai-api'
import { untagSystemPrompt, type ModelMeta, type RunOptions } from '../shared/ai-models'
import { encodeErrorSentinel, scrubDetail, toErrorDetail, type AiErrorDetail } from '../shared/ai-errors'
import type { AiProvider } from './ai-providers'

/**
 * The `LanguageModelUtility` subclass Inkfish's local AI handler hands to Electron. Built by a
 * factory over the base class so it is unit-testable without Electron (src/main/ai-handler.ts
 * passes the real `LanguageModelUtility` from 'electron/utility').
 *
 * Each Prompt API session keeps its conversation; `prompt()` returns a ReadableStream of text
 * deltas from the provider, which Electron serves to both `model.prompt()` (concatenated) and
 * `model.promptStreaming()` in the renderer.
 */

export const CONTEXT_WINDOW = 128_000

interface BaseInstance {
  contextUsage: number
  contextWindow: number
}

/** `LanguageModelUtility`'s shape: `new (initialState: { contextUsage, contextWindow })`. */
export interface LanguageModelBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]): BaseInstance
}

export function createLanguageModelClass<B extends LanguageModelBase>(
  Base: B,
  getProvider: () => AiProvider | null,
  /** The model config a run resolves to (its context window becomes `contextWindow`). */
  getModel: (run: RunOptions) => ModelMeta | null = () => null,
  /** Called with every failed request's detail (handler → main `last-error`). */
  onError: (detail: AiErrorDetail) => void = () => undefined
) {
  class InkfishLanguageModel extends Base {
    history: ChatMessage[] = []
    aborter = new AbortController()
    run: RunOptions = {}

    static async create(options?: { initialPrompts?: PromptMessage[] }): Promise<InkfishLanguageModel> {
      if (!getProvider()) throw new Error('No AI provider connected. Open Settings › AI.')
      const history = toChat(options?.initialPrompts ?? [])
      // The renderer may tag the system prompt with a per-action model; strip it here.
      let run: RunOptions = {}
      const first = history[0]
      if (first?.role === 'system') {
        const u = untagSystemPrompt(first.content)
        run = u.run
        history[0] = { ...first, content: u.system }
      }
      const model = new InkfishLanguageModel({
        contextUsage: 0,
        contextWindow: getModel(run)?.contextWindow ?? CONTEXT_WINDOW
      })
      model.run = run
      model.history = history
      model.contextUsage = estimateTokens(model.history)
      return model
    }

    static async availability(): Promise<string> {
      return getProvider() ? 'available' : 'unavailable'
    }

    async prompt(input: PromptMessage[], options?: { signal?: AbortSignal }): Promise<ReadableStream<string>> {
      const provider = getProvider()
      if (!provider) throw new Error('No AI provider connected. Open Settings › AI.')
      const turn = toChat(input)
      const messages = [...this.history, ...turn]
      const signal = options?.signal ? AbortSignal.any([options.signal, this.aborter.signal]) : this.aborter.signal
      const iterator = provider.stream(messages, signal, this.run)
      let answer = ''
      return new ReadableStream<string>({
        pull: async (controller) => {
          try {
            const { done, value } = await iterator.next()
            if (done) {
              this.history.push(...turn, { role: 'assistant', content: answer })
              this.contextUsage = estimateTokens(this.history)
              controller.close()
              return
            }
            answer += value
            controller.enqueue(value)
          } catch (err) {
            const aborted = signal.aborted || (err instanceof Error && err.name === 'AbortError')
            if (aborted) {
              controller.error(err instanceof Error ? err : new Error(String(err)))
              return
            }
            // Electron reduces a stream error to kErrorUnknown, so Inkfish's own sessions get the
            // real error as a sentinel chunk instead (see shared/ai-errors.ts).
            const detail = scrubDetail(
              toErrorDetail(err, { provider: provider.kind === 'anthropic' ? 'Anthropic' : 'AI provider' })
            )
            onError(detail)
            if (this.run.errors === 'inline') {
              controller.enqueue(encodeErrorSentinel(detail))
              controller.close()
            } else controller.error(err instanceof Error ? err : new Error(String(err)))
          }
        },
        cancel: async () => {
          await iterator.return(undefined)
        }
      })
    }

    async append(input: PromptMessage[]): Promise<undefined> {
      this.history.push(...toChat(input))
      this.contextUsage = estimateTokens(this.history)
      return undefined
    }

    async measureContextUsage(input: PromptMessage[]): Promise<number> {
      return estimateTokens(toChat(input))
    }

    async clone(): Promise<InkfishLanguageModel> {
      const copy = new InkfishLanguageModel({ contextUsage: this.contextUsage, contextWindow: this.contextWindow })
      copy.history = [...this.history]
      copy.run = { ...this.run }
      return copy
    }

    destroy(): void {
      this.aborter.abort()
      this.history = []
    }
  }
  return InkfishLanguageModel
}
