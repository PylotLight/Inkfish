import { describe, expect, test } from 'bun:test'
import { createLanguageModelClass, CONTEXT_WINDOW } from './ai-model'
import type { AiProvider } from './ai-providers'
import type { ChatMessage, PromptMessage } from '../shared/ai-api'
import { tagImages, tagSystemPrompt } from '../shared/ai-models'

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

describe('per-run model + context window', () => {
  test('the model tag is stripped from the system prompt, the run reaches the provider, contextWindow follows the model', async () => {
    const runs: unknown[] = []
    const seen: ChatMessage[][] = []
    const provider: AiProvider = {
      kind: 'openai',
      async *stream(messages, _signal, run) {
        seen.push(messages)
        runs.push(run)
        yield 'ok'
      }
    }
    const LM = createLanguageModelClass(
      FakeBase,
      () => provider,
      (run) => (run.model === 'small' ? { contextWindow: 8192 } : null)
    )
    const sys: PromptMessage = {
      role: 'system',
      content: [{ type: 'text', value: tagSystemPrompt('Be terse.', { model: 'small' }) }]
    }
    const m = await LM.create({ initialPrompts: [sys] })
    expect(m.contextWindow).toBe(8192)
    expect(await drain(await m.prompt([user('hi')]))).toBe('ok')
    expect(seen[0]?.[0]).toEqual({ role: 'system', content: 'Be terse.' })
    expect(runs[0]).toEqual({ model: 'small' })
    const plain = await LM.create({ initialPrompts: [{ role: 'system', content: [{ type: 'text', value: 'x' }] }] })
    expect(plain.contextWindow).toBe(CONTEXT_WINDOW)
    expect((await plain.clone()).run).toEqual({})
  })

  test('images: tagged data URLs (and encoded byte parts) become ChatMessage images; raw pixels are dropped', async () => {
    const seen: ChatMessage[][] = []
    const provider: AiProvider = {
      kind: 'openai',
      async *stream(messages) {
        seen.push(messages)
        yield 'ok'
      }
    }
    const LM = createLanguageModelClass(FakeBase, () => provider)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer
    const m = await LM.create()
    await drain(
      await m.prompt([
        {
          role: 'user',
          content: [
            { type: 'text', value: 'look' },
            { type: 'image', value: png }
          ]
        }
      ])
    )
    expect(seen[0]?.[0]).toEqual({
      role: 'user',
      content: 'look',
      images: [{ mime: 'image/png', data: 'iVBORw0KGgoAAAAN' }]
    })
    await drain(await m.prompt([user(tagImages('see', ['data:image/jpeg;base64,/9j/4AAQ']))]))
    expect(seen[1]?.at(-1)).toEqual({
      role: 'user',
      content: 'see',
      images: [{ mime: 'image/jpeg', data: '/9j/4AAQ' }]
    })
    await drain(
      await m.prompt([
        {
          role: 'user',
          content: [
            { type: 'text', value: 'raw' },
            { type: 'image', value: new ArrayBuffer(64) }
          ]
        }
      ])
    )
    expect(seen[2]?.at(-1)).toEqual({ role: 'user', content: 'raw' })
  })
})
