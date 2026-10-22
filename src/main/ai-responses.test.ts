import { describe, expect, test } from 'bun:test'
import {
  complete,
  createProvider,
  isNoResponsesRoute,
  isResponsesOnlyError,
  parseErrorBody,
  parseResponsesEvents,
  providerLabel,
  responsesBody,
  type ProviderConfig
} from './ai-providers'
import { endpointFrom, parseLiteLLMInfo, parseOpenAIModels } from './ai-discovery'
import { createLanguageModelClass } from './ai-model'
import type { AiProvider } from './ai-providers'
import {
  AiRequestError,
  encodeErrorSentinel,
  formatAiError,
  scrubText,
  splitErrorSentinel,
  visibleText,
  type AiErrorDetail
} from '../shared/ai-errors'
import {
  learnEndpoint,
  parseModel,
  resolveApi,
  tagSystemPrompt,
  untagSystemPrompt,
  type AiModel
} from '../shared/ai-models'
import { parseAiSettings } from '../shared/ai-api'
import type { PromptMessage } from '../shared/ai-api'

const KEY = 'sk-test-secret-123456'
const CTX = { provider: 'nas:4000', endpoint: 'POST /responses', model: 'openai.gpt-6-luna', key: KEY }

function sseResponse(blocks: string[]): Response {
  const enc = new TextEncoder()
  const all = blocks.join('')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        // Split mid-event to exercise buffering.
        c.enqueue(enc.encode(all.slice(0, 11)))
        c.enqueue(enc.encode(all.slice(11)))
        c.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}
const ev = (type: string, extra: Record<string, unknown> = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`

async function* events(list: Array<Record<string, unknown>>): AsyncGenerator<{ event: string; data: string }> {
  for (const j of list) yield { event: String(j.type), data: JSON.stringify(j) }
}
async function collect(g: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const d of g) out.push(d)
  return out
}
async function failure(p: Promise<unknown>): Promise<AiRequestError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(AiRequestError)
  return e as AiRequestError
}

// --- SSE parser fixtures ---------------------------------------------------------------------

describe('Responses SSE parser', () => {
  test('output_text deltas until response.completed', async () => {
    const out = await collect(
      parseResponsesEvents(
        events([
          { type: 'response.created', response: { id: 'r1' } },
          { type: 'response.output_item.added' },
          { type: 'response.output_text.delta', delta: '# Ti' },
          { type: 'response.output_text.delta', delta: 'dy' },
          { type: 'response.output_text.done', text: '# Tidy' },
          { type: 'response.completed', response: { status: 'completed', output_text: '# Tidy' } },
          { type: 'response.output_text.delta', delta: 'IGNORED after completed' }
        ]),
        CTX
      )
    )
    expect(out).toEqual(['# Ti', 'dy'])
  })

  test('proxy without deltas: text from output_text.done, or from the completed response', async () => {
    expect(
      await collect(
        parseResponsesEvents(
          events([{ type: 'response.output_text.done', text: 'A' }, { type: 'response.completed' }]),
          CTX
        )
      )
    ).toEqual(['A'])
    const completedOnly = events([
      {
        type: 'response.completed',
        response: {
          output: [
            { type: 'reasoning', summary: [] },
            { type: 'message', content: [{ type: 'output_text', text: 'B' }] }
          ]
        }
      }
    ])
    expect(await collect(parseResponsesEvents(completedOnly, CTX))).toEqual(['B'])
  })

  test('response.failed → readable error with code', async () => {
    const e = await failure(
      collect(
        parseResponsesEvents(
          events([
            { type: 'response.output_text.delta', delta: 'x' },
            {
              type: 'response.failed',
              response: { status: 'failed', error: { code: 'server_error', message: 'The model crashed' } }
            }
          ]),
          CTX
        )
      )
    )
    expect(e.detail).toMatchObject({
      kind: 'stream',
      code: 'server_error',
      message: 'The model crashed',
      endpoint: 'POST /responses'
    })
    expect(e.message).toContain('The model crashed (POST /responses, openai.gpt-6-luna)')
  })

  test('response.incomplete (max_output_tokens) is an error with a hint, not a silently cut reply', async () => {
    const e = await failure(
      collect(
        parseResponsesEvents(
          events([
            { type: 'response.output_text.delta', delta: 'half a no' },
            {
              type: 'response.incomplete',
              response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
            }
          ]),
          CTX
        )
      )
    )
    expect(e.detail.kind).toBe('incomplete')
    expect(e.detail.code).toBe('max_output_tokens')
    expect(e.message).toContain('Max output tokens')
  })

  test('error event (top-level and nested), refusal, and a stream that ends with no text', async () => {
    const top = await failure(
      collect(parseResponsesEvents(events([{ type: 'error', code: 'rate_limit_exceeded', message: 'Slow down' }]), CTX))
    )
    expect(top.detail).toMatchObject({ code: 'rate_limit_exceeded', message: 'Slow down' })
    const nested = await failure(
      collect(parseResponsesEvents(events([{ type: 'error', error: { message: 'boom', type: 'server_error' } }]), CTX))
    )
    expect(nested.detail).toMatchObject({ message: 'boom', type: 'server_error' })
    const refusal = await failure(
      collect(
        parseResponsesEvents(
          events([
            { type: 'response.refusal.delta', delta: 'I can' },
            { type: 'response.refusal.done', refusal: "I can't help" },
            { type: 'response.completed' }
          ]),
          CTX
        )
      )
    )
    expect(refusal.message).toContain("The model refused: I can't help")
    const empty = await failure(collect(parseResponsesEvents(events([{ type: 'response.created' }]), CTX)))
    expect(empty.detail.kind).toBe('parse')
  })

  test('a proxy that drops the final event still returns the text it streamed', async () => {
    expect(
      await collect(parseResponsesEvents(events([{ type: 'response.output_text.delta', delta: 'ok' }]), CTX))
    ).toEqual(['ok'])
  })
})

// --- request body --------------------------------------------------------------------------------

describe('Responses request body', () => {
  const base: ProviderConfig = { kind: 'openai', baseUrl: 'http://nas:4000/v1', model: 'm', apiKey: null }
  const msgs = [
    { role: 'system' as const, content: 'rules' },
    { role: 'user' as const, content: 'hello', images: [{ mime: 'image/png', data: 'iVBORw0K' }] },
    { role: 'assistant' as const, content: 'hi' },
    { role: 'user' as const, content: 'again' }
  ]

  test('system → instructions; turns → input items; no temperature; store false', () => {
    const b = responsesBody(base, msgs)
    expect(b).toEqual({
      model: 'm',
      instructions: 'rules',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: [{ type: 'input_text', text: 'again' }] }
      ],
      stream: true,
      store: false
    })
  })

  test('vision model: input_image data URLs; reasoning → reasoning.effort; limits → max_output_tokens', () => {
    const cfg = {
      ...base,
      models: [
        {
          id: 'm',
          input: ['text', 'image'] as AiModel['input'],
          reasoning: 'high',
          contextWindow: 1000,
          maxOutputTokens: 4096
        }
      ]
    }
    const b = responsesBody(cfg, msgs.slice(0, 2))
    expect((b.input as unknown[])[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'hello' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0K' }
      ]
    })
    expect(b.reasoning).toEqual({ effort: 'high' })
    expect(b.max_output_tokens).toBeGreaterThan(0)
    expect(b.max_output_tokens).toBeLessThanOrEqual(1000)
    expect(b.temperature).toBeUndefined()
    expect(b.max_tokens).toBeUndefined()
  })

  test('per-run model picks its config', () => {
    const cfg = { ...base, models: [{ id: 'm' }, { id: 'r', maxOutputTokens: 300 }] }
    expect(responsesBody(cfg, [{ role: 'user', content: 'x' }], { model: 'r' })).toMatchObject({
      model: 'r',
      max_output_tokens: 300
    })
  })
})

// --- provider: which endpoint, Auto fallback + learning --------------------------------------------

const RESPONSES_ONLY = {
  error: {
    message:
      'litellm.BadRequestError: OpenAIException - This model is only supported in v1/responses and not in v1/chat/completions.',
    type: 'invalid_request_error',
    param: 'model',
    code: '400'
  }
}

function server(handler: (path: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth?: string }> = []
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path, body, auth: (init.headers as Record<string, string>).authorization })
    return handler(path, body)
  }
  return { calls, fetchFn }
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const responsesOk = (): Response =>
  sseResponse([
    ev('response.created'),
    ev('response.output_text.delta', { delta: 'O' }),
    ev('response.output_text.delta', { delta: 'K' }),
    ev('response.completed')
  ])
const chatOk = (): Response =>
  sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`, 'data: [DONE]\n\n'])

describe('OpenAI-compatible provider: API selection', () => {
  const user = [{ role: 'user' as const, content: 'hi' }]

  test('model API = Responses → POST /responses with the bearer key', async () => {
    const s = server((path) => (path.endsWith('/responses') ? responsesOk() : json(500, {})))
    const p = createProvider(
      {
        kind: 'openai',
        baseUrl: 'http://nas:4000/v1',
        model: 'luna',
        apiKey: KEY,
        models: [{ id: 'luna', api: 'responses' }]
      },
      s.fetchFn
    )
    expect(await complete(p, user)).toBe('OK')
    expect(s.calls.map((c) => c.path)).toEqual(['/v1/responses'])
    expect(s.calls[0]!.auth).toBe(`Bearer ${KEY}`)
    expect(p.lastRequest).toEqual({ endpoint: 'responses', model: 'luna' })
  })

  test('provider default Responses applies to models without their own setting; a model can opt back to chat', async () => {
    const s = server((path) => (path.endsWith('/responses') ? responsesOk() : chatOk()))
    const p = createProvider(
      {
        kind: 'openai',
        baseUrl: 'http://x/v1',
        model: 'a',
        api: 'responses',
        apiKey: null,
        models: [{ id: 'a' }, { id: 'b', api: 'chat' }]
      },
      s.fetchFn
    )
    await complete(p, user)
    await complete(p, user, undefined, { model: 'b' })
    expect(s.calls.map((c) => c.path)).toEqual(['/v1/responses', '/v1/chat/completions'])
  })

  test('Auto: chat says responses-only → retried once on /responses, learned, next run goes straight there', async () => {
    const s = server((path) => (path.endsWith('/responses') ? responsesOk() : json(400, RESPONSES_ONLY)))
    const learned: Array<[string, string]> = []
    const cfg: ProviderConfig = {
      kind: 'openai',
      baseUrl: 'http://nas:4000/v1',
      model: 'openai.gpt-6-luna',
      apiKey: KEY,
      models: [{ id: 'openai.gpt-6-luna' }],
      onLearn: (id, endpoint) => learned.push([id, endpoint])
    }
    const p = createProvider(cfg, s.fetchFn)
    expect(await complete(p, user)).toBe('OK')
    expect(s.calls.map((c) => c.path)).toEqual(['/v1/chat/completions', '/v1/responses'])
    expect(learned).toEqual([['openai.gpt-6-luna', 'responses']])
    expect(cfg.models?.[0]?.endpoint).toBe('responses')
    expect(await complete(p, user)).toBe('OK')
    expect(s.calls.map((c) => c.path)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/responses'])
    expect(learned.length).toBe(1)
  })

  test('Auto: an unrelated 400 is not retried; explicit Chat never falls back', async () => {
    const s = server(() => json(400, { error: { message: 'context_length_exceeded: too long' } }))
    const p = createProvider({ kind: 'openai', baseUrl: 'http://x/v1', model: 'm', apiKey: null }, s.fetchFn)
    await failure(complete(p, user))
    expect(s.calls.length).toBe(1)
    const s2 = server((path) => (path.endsWith('/responses') ? responsesOk() : json(400, RESPONSES_ONLY)))
    const p2 = createProvider(
      { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', apiKey: null, models: [{ id: 'm', api: 'chat' }] },
      s2.fetchFn
    )
    const e = await failure(complete(p2, user))
    expect(s2.calls.length).toBe(1)
    expect(e.message).toContain('only supported in v1/responses')
    expect(e.message).toContain('(POST /chat/completions, m)')
  })

  test('Auto: both endpoints fail → the last error, with the first attempt attached', async () => {
    const s = server((path) =>
      path.endsWith('/responses') ? json(401, { error: { message: 'bad key' } }) : json(400, RESPONSES_ONLY)
    )
    const p = createProvider({ kind: 'openai', baseUrl: 'http://x/v1', model: 'm', apiKey: null }, s.fetchFn)
    const e = await failure(complete(p, user))
    expect(e.detail).toMatchObject({ status: 401, endpoint: 'POST /responses', hint: 'check the API key' })
    expect(e.detail.attempts?.[0]).toMatchObject({ status: 400, endpoint: 'POST /chat/completions' })
    expect(e.message).toContain('[after: POST /chat/completions 400]')
  })

  test('Auto with a detected Responses endpoint on a server without /responses → falls back to chat', async () => {
    const s = server((path) => (path.endsWith('/responses') ? new Response('Not Found', { status: 404 }) : chatOk()))
    const learned: string[] = []
    const p = createProvider(
      {
        kind: 'openai',
        baseUrl: 'http://x/v1',
        model: 'm',
        apiKey: null,
        models: [{ id: 'm', endpoint: 'responses' }],
        onLearn: (_i, e) => learned.push(e)
      },
      s.fetchFn
    )
    expect(await complete(p, user)).toBe('OK')
    expect(s.calls.map((c) => c.path)).toEqual(['/v1/responses', '/v1/chat/completions'])
    expect(learned).toEqual(['chat'])
  })

  test('a per-request API (Test connection) overrides the model setting', async () => {
    const s = server((path) => (path.endsWith('/responses') ? responsesOk() : chatOk()))
    const p = createProvider(
      { kind: 'openai', baseUrl: 'http://x/v1', model: 'm', apiKey: null, models: [{ id: 'm', api: 'chat' }] },
      s.fetchFn
    )
    await complete(p, user, undefined, { model: 'm', api: 'responses' })
    expect(s.calls.map((c) => c.path)).toEqual(['/v1/responses'])
  })

  test('network failure → readable "unreachable" error, not a bare TypeError', async () => {
    const p = createProvider({ kind: 'openai', baseUrl: 'http://nas:4000/v1', model: 'm', apiKey: KEY }, async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.2:4000' }
      })
    })
    const e = await failure(complete(p, user))
    expect(e.detail.kind).toBe('network')
    expect(e.message).toContain('nas:4000 unreachable: fetch failed (ECONNREFUSED)')
  })

  test('an abort is passed through untouched (no fallback, no wrapping)', async () => {
    const ac = new AbortController()
    ac.abort()
    let n = 0
    const p = createProvider({ kind: 'openai', baseUrl: 'http://x/v1', model: 'm', apiKey: null }, async () => {
      n++
      throw new DOMException('aborted', 'AbortError')
    })
    const e = await complete(p, user, ac.signal).catch((x: Error) => x)
    expect((e as Error).name).toBe('AbortError')
    expect(n).toBe(1)
  })
})

describe('responses-only detection', () => {
  const d = (message: string, extra: Partial<AiErrorDetail> = {}): AiErrorDetail => ({
    provider: 'p',
    kind: 'http',
    status: 400,
    message,
    ...extra
  })
  test('matches OpenAI / LiteLLM / proxy phrasings', () => {
    expect(
      isResponsesOnlyError(d('This model is only supported in v1/responses and not in v1/chat/completions.'))
    ).toBe(true)
    expect(isResponsesOnlyError(d(RESPONSES_ONLY.error.message))).toBe(true)
    expect(isResponsesOnlyError(d('bad', { code: 'unsupported_api_for_model' }))).toBe(true)
    expect(isResponsesOnlyError(d('The chat completions API is not supported for this model'))).toBe(true)
    expect(isResponsesOnlyError(d('Model does not support chat completions; use the Responses API'))).toBe(true)
    expect(isResponsesOnlyError(d('Use the /responses endpoint for gpt-6-luna', { status: 404 }))).toBe(true)
  })
  test('does not match unrelated errors', () => {
    expect(isResponsesOnlyError(d('Invalid API key', { status: 401 }))).toBe(false)
    expect(isResponsesOnlyError(d('context length exceeded'))).toBe(false)
    expect(isResponsesOnlyError(d('model not found', { status: 404 }))).toBe(false)
    expect(isResponsesOnlyError({ provider: 'p', kind: 'network', message: 'v1/responses' })).toBe(false)
  })
  test('no /responses route on the server', () => {
    expect(isNoResponsesRoute(d('Not Found', { status: 404 }))).toBe(true)
    expect(isNoResponsesRoute(d('model xyz not found', { status: 404 }))).toBe(false)
    expect(isNoResponsesRoute(d('Method Not Allowed', { status: 405 }))).toBe(true)
  })
})

// --- error formatting / scrubbing ---------------------------------------------------------------

describe('error messages', () => {
  test('format: provider + status, message, endpoint + model, hint', () => {
    expect(
      formatAiError({
        provider: 'OpenAI',
        status: 400,
        kind: 'http',
        message: 'model only supported on /v1/responses',
        endpoint: 'POST /chat/completions',
        model: 'openai.gpt-6-luna'
      })
    ).toBe('OpenAI 400: model only supported on /v1/responses (POST /chat/completions, openai.gpt-6-luna)')
    expect(formatAiError({ provider: 'nas:4000', kind: 'network', message: 'fetch failed' })).toBe(
      'nas:4000 unreachable: fetch failed'
    )
  })

  test('scrub: the configured key, sk- keys, bearer tokens, api_key=…', () => {
    const t = scrubText(`key ${KEY} other sk-ant-abcdefghijklmnop Bearer abc.def.ghijkl api_key=supersecretvalue`, KEY)
    expect(t).not.toContain(KEY)
    expect(t).not.toContain('sk-ant-abcdefghijklmnop')
    expect(t).not.toContain('abc.def.ghijkl')
    expect(t).not.toContain('supersecretvalue')
    expect(t).toContain('Bearer ***')
  })

  test('HTTP error bodies: key echoed by the server never reaches the message or detail', async () => {
    const p = createProvider(
      { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: KEY },
      async () =>
        json(401, {
          error: {
            message: `Incorrect API key provided: ${KEY}`,
            type: 'invalid_request_error',
            code: 'invalid_api_key'
          }
        })
    )
    const e = await failure(complete(p, [{ role: 'user', content: 'x' }]))
    expect(e.message).toStartWith('OpenAI 401: Incorrect API key provided: ***')
    expect(JSON.stringify(e.detail)).not.toContain(KEY)
    expect(e.detail.code).toBe('invalid_api_key')
  })

  test('error body shapes', () => {
    expect(parseErrorBody('{"detail":"Not Found"}')).toEqual({ message: 'Not Found' })
    expect(parseErrorBody('{"error":"nope"}')).toEqual({ message: 'nope' })
    expect(parseErrorBody('<html> 502 Bad Gateway </html>')).toEqual({ message: '<html> 502 Bad Gateway </html>' })
    expect(providerLabel({ kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' })).toBe('OpenRouter')
    expect(providerLabel({ kind: 'openai', baseUrl: 'http://nas:4000/v1' })).toBe('nas:4000')
  })
})

// --- across the Prompt API: the sentinel chunk -----------------------------------------------------

class FakeBase {
  contextUsage: number
  contextWindow: number
  constructor(v: { contextUsage: number; contextWindow: number }) {
    this.contextUsage = v.contextUsage
    this.contextWindow = v.contextWindow
  }
}
async function drain(s: ReadableStream<string>): Promise<string> {
  const r = s.getReader()
  let out = ''
  for (;;) {
    const { done, value } = await r.read()
    if (done) return out
    out += value
  }
}
const sys = (text: string): PromptMessage => ({ role: 'system', content: [{ type: 'text', value: text }] })
const userMsg: PromptMessage = { role: 'user', content: [{ type: 'text', value: 'hi' }] }

describe('error sentinel across the Prompt API', () => {
  const failing: AiProvider = {
    kind: 'openai',
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new AiRequestError({
        provider: 'OpenAI',
        status: 400,
        kind: 'http',
        message: `bad ${KEY}`,
        endpoint: 'POST /chat/completions',
        model: 'luna'
      })
    }
  }

  test('inline sessions end with a sentinel carrying the scrubbed detail; main is told too', async () => {
    const posted: AiErrorDetail[] = []
    const M = createLanguageModelClass(
      FakeBase,
      () => failing,
      () => null,
      (d) => posted.push(d)
    )
    const m = await M.create({ initialPrompts: [sys(tagSystemPrompt('s', { errors: 'inline' }))] })
    const out = await drain(await m.prompt([userMsg]))
    const { text, error } = splitErrorSentinel(out)
    expect(text).toBe('')
    expect(error).toMatchObject({ status: 400, endpoint: 'POST /chat/completions', model: 'luna' })
    expect(out).not.toContain(KEY)
    expect(posted.length).toBe(1)
    expect(m.history.length).toBe(1) // the failed turn is not kept
  })

  test('sessions without the flag still error the stream (what Electron turns into kErrorUnknown)', async () => {
    const M = createLanguageModelClass(FakeBase, () => failing)
    const m = await M.create({ initialPrompts: [sys('s')] })
    await expect(drain(await m.prompt([userMsg]))).rejects.toThrow(/OpenAI 400/)
  })

  test('encode / split / visibleText (incl. a sentinel split across chunks)', () => {
    const d: AiErrorDetail = { provider: 'p', kind: 'stream', message: 'x ]] y' }
    const out = `partial${encodeErrorSentinel(d)}`
    expect(splitErrorSentinel(out)).toEqual({ text: 'partial', error: d })
    expect(splitErrorSentinel('plain').error).toBeNull()
    expect(visibleText(out)).toBe('partial')
    expect(visibleText(`abc${encodeErrorSentinel(d).slice(0, 5)}`)).toBe('abc')
    expect(visibleText('abc\n\n')).toBe('abc\n\n')
  })

  test('run tag carries errors: inline alongside the model', () => {
    const t = tagSystemPrompt('s', { model: 'm', errors: 'inline' })
    expect(untagSystemPrompt(t)).toEqual({ system: 's', run: { model: 'm', errors: 'inline' } })
    expect(untagSystemPrompt(tagSystemPrompt('s', { errors: 'inline' })).run).toEqual({ errors: 'inline' })
  })
})

// --- settings / discovery ------------------------------------------------------------------------

describe('API settings and discovery', () => {
  test('resolveApi: model setting > provider default > detected/learned endpoint > chat', () => {
    expect(resolveApi({ id: 'm' })).toEqual({ endpoint: 'chat', auto: true })
    expect(resolveApi({ id: 'm', endpoint: 'responses' })).toEqual({ endpoint: 'responses', auto: true })
    expect(resolveApi({ id: 'm', endpoint: 'responses' }, 'chat')).toEqual({ endpoint: 'chat', auto: false })
    expect(resolveApi({ id: 'm', api: 'responses' }, 'chat')).toEqual({ endpoint: 'responses', auto: false })
  })

  test('parse + persist: api / endpoint survive, junk dropped; learnEndpoint is not a user edit', () => {
    expect(parseModel({ id: 'm', api: 'responses', endpoint: 'responses' })).toMatchObject({
      api: 'responses',
      endpoint: 'responses'
    })
    expect(parseModel({ id: 'm', api: 'weird', endpoint: 'x' })).toEqual({ id: 'm' })
    expect(parseAiSettings({ api: 'responses' }).api).toBe('responses')
    expect(parseAiSettings({ api: 'nope' }).api).toBe('auto')
    const list = learnEndpoint([{ id: 'a' }, { id: 'b', edited: ['name'] }], 'b', 'responses')
    expect(list[1]).toEqual({ id: 'b', edited: ['name'], endpoint: 'responses' })
  })

  test('LiteLLM mode "responses" and supported_endpoints prefill Responses', () => {
    const models = parseLiteLLMInfo({
      data: [
        {
          model_name: 'openai.gpt-6-luna',
          model_info: { mode: 'responses', max_input_tokens: 400000, litellm_provider: 'openai' }
        },
        {
          model_name: 'pro',
          model_info: { mode: 'chat', supported_endpoints: ['/v1/responses'], max_input_tokens: 1000 }
        },
        {
          model_name: 'chatty',
          model_info: { mode: 'chat', supported_endpoints: ['/v1/chat/completions', '/v1/responses'] }
        }
      ]
    })
    expect(models.map((m) => [m.id, m.endpoint, !!m.nonChat])).toEqual([
      ['openai.gpt-6-luna', 'responses', false],
      ['pro', 'responses', false],
      ['chatty', undefined, false]
    ])
    expect(parseOpenAIModels({ data: [{ id: 'x', supported_endpoints: ['responses'] }] })[0]?.endpoint).toBe(
      'responses'
    )
    expect(endpointFrom(undefined, ['/v1/chat/completions'])).toBeUndefined()
  })
})
