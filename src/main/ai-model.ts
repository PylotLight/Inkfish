import { estimateTokens, toChat, type ChatMessage, type PromptMessage } from '../shared/ai-api'
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

export function createLanguageModelClass<B extends LanguageModelBase>(Base: B, getProvider: () => AiProvider | null) {
  class InkfishLanguageModel extends Base {
    history: ChatMessage[] = []
    aborter = new AbortController()

    static async create(options?: { initialPrompts?: PromptMessage[] }): Promise<InkfishLanguageModel> {
      if (!getProvider()) throw new Error('No AI provider connected. Open Settings › AI.')
      const model = new InkfishLanguageModel({ contextUsage: 0, contextWindow: CONTEXT_WINDOW })
      model.history = toChat(options?.initialPrompts ?? [])
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
      const iterator = provider.stream(messages, signal)
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
            controller.error(err instanceof Error ? err : new Error(String(err)))
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
      return copy
    }

    destroy(): void {
      this.aborter.abort()
      this.history = []
    }
  }
  return InkfishLanguageModel
}
