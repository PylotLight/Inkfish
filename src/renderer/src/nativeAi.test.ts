import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_AI_SETTINGS, parseAiSettings, type AiProviderSettings } from '../../shared/ai-api'
import { untagImages, untagSystemPrompt } from '../../shared/ai-models'
import { AiNotConnectedError, AiRunError, aiErrorDetails, runAiProcess } from './nativeAi'

type G = { window?: unknown; LanguageModel?: unknown; fetch: typeof fetch }
const g = globalThis as unknown as G
const realFetch = g.fetch

function setStatus(connected: boolean, settings: AiProviderSettings = DEFAULT_AI_SETTINGS): void {
  g.window = { api: { aiApi: { status: async () => ({ connected, settings }) } } }
}

afterEach(() => {
  delete g.window
  delete g.LanguageModel
  g.fetch = realFetch
})

interface Call {
  system: string
  input: unknown
  expectedInputs?: unknown
}

/** A LanguageModel mock that records each create() + prompt and answers with `reply(userText)`. */
function recorder(reply: (user: string) => string): Call[] {
  const calls: Call[] = []
  g.LanguageModel = {
    availability: async () => 'available',
    create: async (opts: { initialPrompts: Array<{ content: string }>; expectedInputs?: unknown }) => {
      const call: Call = {
        system: opts.initialPrompts[0]?.content ?? '',
        input: null,
        expectedInputs: opts.expectedInputs
      }
      calls.push(call)
      return {
        promptStreaming: (input: unknown) => {
          call.input = input
          const text =
            typeof input === 'string'
              ? input
              : ((input as Array<{ content: Array<{ value: unknown }> }>)[0]?.content[0]?.value as string)
          return new ReadableStream<string>({
            start(c) {
              c.enqueue(reply(text))
              c.close()
            }
          })
        },
        destroy: () => undefined
      }
    }
  }
  return calls
}

describe('Prompt API path (renderer)', () => {
  test('no API connected: clear error, the Prompt API is never called', async () => {
    setStatus(false)
    let created = false
    g.LanguageModel = { availability: async () => 'available', create: async () => ((created = true), {}) }
    const err = await runAiProcess({ action: 'tidy', text: '# hi' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiNotConnectedError)
    expect(String((err as Error).message)).toContain('Settings › AI')
    expect(created).toBe(false)
  })

  test('connected: system prompt via initialPrompts, reply streamed through promptStreaming', async () => {
    setStatus(true)
    let initial: unknown
    let destroyed = false
    g.LanguageModel = {
      availability: async () => 'available',
      create: async (opts: { initialPrompts: unknown }) => {
        initial = opts.initialPrompts
        return {
          promptStreaming: () =>
            new ReadableStream<string>({
              start(c) {
                c.enqueue('# Hi\n\n')
                c.enqueue('- item')
                c.close()
              }
            }),
          destroy: () => (destroyed = true)
        }
      }
    }
    const chunks: string[] = []
    const r = await runAiProcess({
      action: 'tidy',
      text: '---\na: 1\n---\n# hi\n* item',
      onChunk: (c) => chunks.push(c)
    })
    expect(r.text).toBe('---\na: 1\n---\n# Hi\n\n- item\n')
    expect(chunks).toEqual(['# Hi\n\n', '# Hi\n\n- item'])
    expect((initial as Array<{ role: string }>)[0]?.role).toBe('system')
    expect(destroyed).toBe(true)
  })

  test('handler registered but unavailable: says so', async () => {
    setStatus(true)
    g.LanguageModel = { availability: async () => 'unavailable', create: async () => ({}) }
    await expect(runAiProcess({ action: 'tidy', text: 'x' })).rejects.toThrow(/unavailable/)
  })

  test('per-action model: the run is tagged with that model id (the handler strips the tag)', async () => {
    setStatus(
      true,
      parseAiSettings({ model: 'big', models: [{ id: 'big' }, { id: 'small' }], actionModels: { typos: 'small' } })
    )
    const calls = recorder((u) => u)
    await runAiProcess({ action: 'typos', text: 'teh cat' })
    await runAiProcess({ action: 'tidy', text: 'teh cat' })
    expect(untagSystemPrompt(calls[0]!.system).run.model).toBe('small')
    expect(untagSystemPrompt(calls[1]!.system).run.model).toBe('big')
    expect(untagSystemPrompt(calls[0]!.system).system).toContain('Fix spelling')
  })

  test('model limits drive chunking: a long note is processed in parts and a notice says so', async () => {
    setStatus(
      true,
      parseAiSettings({ model: 'tiny', models: [{ id: 'tiny', contextWindow: 2000, maxOutputTokens: 600 }] })
    )
    const calls = recorder((u) => u.toUpperCase())
    const para = 'word '.repeat(100).trim()
    const text = Array.from({ length: 12 }, (_, i) => `${para} ${i}`).join('\n\n')
    const r = await runAiProcess({ action: 'typos', text })
    expect(calls.length).toBeGreaterThan(1)
    expect(r.notices[0]).toMatch(/processed in \d+ parts/)
    expect(r.text.trim()).toBe(text.toUpperCase())
  })

  test('images go along only when Include images is on AND the model takes image input', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const fetched: string[] = []
    g.fetch = (async (url: string) => {
      fetched.push(String(url))
      return new Response(new Blob([png], { type: 'image/png' }))
    }) as unknown as typeof fetch
    const note = 'See ![](assets/a.png)'
    const vision = [{ id: 'v', input: ['text', 'image'] }]

    setStatus(true, parseAiSettings({ model: 'v', models: vision, includeImages: false }))
    let calls = recorder((u) => u)
    await runAiProcess({ action: 'summarize', text: note }, undefined, { notePath: 'inbox/n.md' })
    expect(typeof calls[0]!.input).toBe('string')

    setStatus(true, parseAiSettings({ model: 't', models: [{ id: 't', input: ['text'] }], includeImages: true }))
    calls = recorder((u) => u)
    await runAiProcess({ action: 'summarize', text: note }, undefined, { notePath: 'inbox/n.md' })
    expect(typeof calls[0]!.input).toBe('string')
    expect(fetched).toEqual([])

    setStatus(true, parseAiSettings({ model: 'v', models: vision, includeImages: true }))
    calls = recorder((u) => u)
    await runAiProcess({ action: 'summarize', text: note }, undefined, { notePath: 'inbox/n.md' })
    const u = untagImages(calls[0]!.input as string)
    expect(u.text).toBe(note)
    expect(u.dataUrls).toEqual(['data:image/png;base64,iVBORw0KGgoAAAAA'])
    expect(fetched[0]).toBe('asset://vault/assets/a.png')
  })
})

describe('Prompt API errors (renderer)', () => {
  const detail = {
    provider: 'OpenAI',
    status: 400,
    kind: 'http' as const,
    message: 'This model is only supported in v1/responses and not in v1/chat/completions.',
    endpoint: 'POST /chat/completions',
    model: 'openai.gpt-6-luna'
  }
  const streaming = (chunks: string[] | (() => never)) => ({
    availability: async () => 'available',
    create: async (opts: { initialPrompts: Array<{ content: string }> }) => ({
      system: opts.initialPrompts[0]?.content,
      promptStreaming: () =>
        new ReadableStream<string>({
          start(c) {
            if (typeof chunks === 'function') {
              c.error(new DOMException('An unknown error occurred: kErrorUnknown', 'UnknownError'))
              return
            }
            for (const x of chunks) c.enqueue(x)
            c.close()
          }
        }),
      destroy: () => undefined
    })
  })

  test('the handler sentinel becomes a readable AiRunError (never shown as text) + Copy details', async () => {
    setStatus(true)
    const { encodeErrorSentinel } = await import('../../shared/ai-errors')
    const sentinel = encodeErrorSentinel(detail)
    let systemSeen = ''
    const lm = streaming(['# par', sentinel.slice(0, 4), sentinel.slice(4)])
    const create = lm.create
    lm.create = async (o) => {
      const m = await create(o)
      systemSeen = m.system ?? ''
      return m
    }
    g.LanguageModel = lm
    const chunks: string[] = []
    const err = await runAiProcess({ action: 'tidy', text: '# hi', onChunk: (c) => chunks.push(c) }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(AiRunError)
    expect((err as Error).message).toBe(
      'OpenAI 400: This model is only supported in v1/responses and not in v1/chat/completions. (POST /chat/completions, openai.gpt-6-luna)'
    )
    expect(chunks.every((c) => !c.includes('inkfish-error'))).toBe(true)
    expect(untagSystemPrompt(systemSeen).run.errors).toBe('inline')
    const copied = JSON.parse(aiErrorDetails(err))
    expect(copied.detail).toMatchObject({ status: 400, endpoint: 'POST /chat/completions', model: 'openai.gpt-6-luna' })
  })

  test("Electron's bare kErrorUnknown → the handler's last error from main", async () => {
    let asked = 0
    g.window = {
      api: {
        aiApi: {
          status: async () => ({ connected: true, settings: DEFAULT_AI_SETTINGS }),
          lastError: async () => (asked++, detail)
        }
      }
    }
    g.LanguageModel = streaming(() => {
      throw new Error('unreachable')
    })
    const err = await runAiProcess({ action: 'tidy', text: '# hi' }).catch((e: unknown) => e)
    expect(asked).toBe(1)
    expect(err).toBeInstanceOf(AiRunError)
    expect((err as Error).message).toContain('OpenAI 400')
  })

  test('kErrorUnknown and nothing in main: says so instead of the raw Chromium text', async () => {
    g.window = {
      api: {
        aiApi: { status: async () => ({ connected: true, settings: DEFAULT_AI_SETTINGS }), lastError: async () => null }
      }
    }
    g.LanguageModel = streaming(() => {
      throw new Error('unreachable')
    })
    const err = await runAiProcess({ action: 'tidy', text: '# hi' }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('without details (Electron: kErrorUnknown)')
  })
})
