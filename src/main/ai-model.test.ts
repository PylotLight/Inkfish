import { describe, expect, test } from 'bun:test'
import { createLanguageModelClass, CONTEXT_WINDOW } from './ai-model'
import type { AiProvider } from './ai-providers'
import type { ChatMessage, PromptMessage } from '../shared/ai-api'

/** Stand-in for Electron's LanguageModelUtility base class. */
class FakeBase {
  contextUsage: number
  contextWindow: number
  constructor(v: { contextUsage: number; contextWindow: number }) {
    this.contextUsage = v.contextUsage
    this.contextWindow = v.contextWindow
  }
}

const user = (text: string): PromptMessage => ({ role: 'user', content: [{ type: 'text', value: text }] })

async function drain(s: ReadableStream<string>): Promise<string> {
  const r = s.getReader()
  let out = ''
  while (true) {
    const { done, value } = await r.read()
    if (done) return out
    out += value
  }
}

function fakeProvider(seen: ChatMessage[][]): AiProvider {
  return {
    kind: 'openai',
    async *stream(messages) {
      seen.push(messages)
      yield 'Hello '
      yield 'there'
    }
  }
}

describe('local AI handler model (handler wiring)', () => {
  test('no provider connected: unavailable, create rejects with a Settings hint', async () => {
    const M = createLanguageModelClass(FakeBase, () => null)
    expect(await M.availability()).toBe('unavailable')
    await expect(M.create({})).rejects.toThrow(/Settings › AI/)
  })

  test('connected: streams the provider reply and keeps the conversation', async () => {
    const seen: ChatMessage[][] = []
    const M = createLanguageModelClass(FakeBase, () => fakeProvider(seen))
    expect(await M.availability()).toBe('available')
    const m = await M.create({ initialPrompts: [{ role: 'system', content: [{ type: 'text', value: 'be brief' }] }] })
    expect(m.contextWindow).toBe(CONTEXT_WINDOW)
    expect(await drain(await m.prompt([user('hi')]))).toBe('Hello there')
    expect(seen[0]).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' }
    ])
    await drain(await m.prompt([user('again')]))
    expect(seen[1]?.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(m.contextUsage).toBeGreaterThan(0)
    const copy = await m.clone()
    expect(copy.history.length).toBe(m.history.length)
  })

  test('provider error surfaces through the stream', async () => {
    const M = createLanguageModelClass(FakeBase, () => ({
      kind: 'openai',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('AI provider: HTTP 401 (check the API key)')
      }
    }))
    const m = await M.create({})
    await expect(drain(await m.prompt([user('x')]))).rejects.toThrow(/HTTP 401/)
  })

  test('destroy aborts the in-flight request', async () => {
    let signal: AbortSignal | undefined
    const M = createLanguageModelClass(FakeBase, () => ({
      kind: 'openai',
      async *stream(_m, s) {
        signal = s
        yield 'a'
      }
    }))
    const m = await M.create({})
    await drain(await m.prompt([user('x')]))
    m.destroy()
    expect(signal?.aborted).toBe(true)
  })
})
