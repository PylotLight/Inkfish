import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  anthropicDefaults,
  discoverModels,
  parseAnthropicModels,
  parseLiteLLMInfo,
  parseLMStudioModels,
  parseOllamaShow,
  parseOllamaTags,
  parseOpenAIModels,
  rootOf
} from './ai-discovery'

const KEY = 'sk-discovery-secret-42'
const fx = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'ai-discovery', name), 'utf8'))
const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const m = list.find((x) => x.id === id)
  if (!m) throw new Error(`no ${id}`)
  return m
}

/** Routes `METHOD url` → fixture body (or a status). Records every request. */
function server(routes: Record<string, unknown | number>) {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const headers = (init.headers ?? {}) as Record<string, string>
    seen.push({ url, method, headers, body: typeof init.body === 'string' ? init.body : undefined })
    let key = `${method} ${url}`
    if (method === 'POST' && typeof init.body === 'string') key += ` ${(JSON.parse(init.body) as { model?: string }).model ?? ''}`
    const hit = routes[key]
    if (hit === undefined) return new Response('not found', { status: 404 })
    if (typeof hit === 'number') return new Response(JSON.stringify({ error: { message: `nope ${KEY}` } }), { status: hit })
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { seen, fetchFn }
}

describe('parsers', () => {
  test('plain OpenAI /models: ids only; embeddings flagged non-chat', () => {
    const m = parseOpenAIModels(fx('openai-models.json'))
    expect(m.map((x) => x.id)).toEqual(['gpt-4o-mini', 'text-embedding-3-small', 'o4-mini'])
    expect(byId(m, 'gpt-4o-mini')).toEqual({ id: 'gpt-4o-mini', sources: ['models'] })
    expect(byId(m, 'text-embedding-3-small').nonChat).toBe(true)
  })

  test('OpenRouter: context, max completion, modalities (file → pdf), tools, reasoning', () => {
    const m = parseOpenAIModels(fx('openrouter-models.json'))
    expect(byId(m, 'openai/gpt-6.1-sol')).toMatchObject({
      name: 'OpenAI: GPT-6.1 Sol',
      contextWindow: 1_100_000,
      maxOutputTokens: 128_000,
      input: ['text', 'image', 'pdf'],
      output: ['text'],
      toolCalls: true,
      reasoningLevels: ['low', 'medium', 'high']
    })
    const llama = byId(m, 'meta-llama/llama-3.1-8b-instruct')
    expect(llama).toMatchObject({ contextWindow: 131_072, maxOutputTokens: 16_384, toolCalls: false })
    expect(llama.reasoningLevels).toBeUndefined()
  })

  test('Groq context_window / max_completion_tokens, vLLM max_model_len', () => {
    const g = parseOpenAIModels(fx('groq-models.json'))
    expect(byId(g, 'llama-3.3-70b-versatile')).toMatchObject({ contextWindow: 131_072, maxOutputTokens: 32_768 })
    expect(byId(g, 'whisper-large-v3').nonChat).toBe(true)
    expect(byId(parseOpenAIModels(fx('vllm-models.json')), 'Qwen/Qwen2.5-7B-Instruct').contextWindow).toBe(32_768)
  })

  test('LiteLLM /model/info: limits + supports_* flags; unknown models get no capability guesses', () => {
    const m = parseLiteLLMInfo(fx('litellm-model-info.json'))
    expect(byId(m, 'gpt-6.1-sol')).toMatchObject({
      contextWindow: 1_100_000,
      maxOutputTokens: 128_000,
      input: ['text', 'image', 'pdf'],
      output: ['text'],
      toolCalls: true,
      reasoningLevels: ['low', 'medium', 'high'],
      sources: ['litellm']
    })
    const mystery = byId(m, 'local-mystery')
    expect(mystery.input).toBeUndefined()
    expect(mystery.toolCalls).toBeUndefined()
    expect(byId(m, 'embed-small').nonChat).toBe(true)
  })

  test('Ollama tags + show: context_length, num_ctx override, vision/tools/thinking capabilities', () => {
    expect(parseOllamaTags(fx('ollama-tags.json'))).toEqual(['llama3.2:latest', 'llava:13b', 'nomic-embed-text:latest'])
    const llama = parseOllamaShow('llama3.2:latest', fx('ollama-show-llama.json'))
    expect(llama).toMatchObject({ contextWindow: 16_384, input: ['text'], toolCalls: true, reasoningLevels: [] })
    const llava = parseOllamaShow('llava:13b', fx('ollama-show-llava.json'))
    expect(llava).toMatchObject({ contextWindow: 4096, input: ['text', 'image'], toolCalls: false })
    expect(parseOllamaShow('nomic-embed-text:latest', fx('ollama-show-embed.json')).nonChat).toBe(true)
    expect(parseOllamaShow('x', { capabilities: ['completion', 'thinking'] }).reasoningLevels).toEqual(['low', 'medium', 'high'])
  })

  test('LM Studio /api/v0/models: loaded context wins, vlm → image input, tool_use', () => {
    const m = parseLMStudioModels(fx('lmstudio-v0-models.json'))
    expect(byId(m, 'qwen2-vl-7b-instruct')).toMatchObject({ contextWindow: 32_768, input: ['text', 'image'], toolCalls: true })
    expect(byId(m, 'meta-llama-3.1-8b-instruct')).toMatchObject({ contextWindow: 8192, input: ['text'] })
    expect(byId(m, 'text-embedding-nomic-embed-text-v1.5').nonChat).toBe(true)
  })

  test('Anthropic /v1/models: display names + conservative known limits per family', () => {
    const m = parseAnthropicModels(fx('anthropic-models.json'))
    expect(byId(m, 'claude-sonnet-4-5-20250929')).toMatchObject({
      name: 'Claude Sonnet 4.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      input: ['text', 'image', 'pdf'],
      toolCalls: true,
      reasoningLevels: ['low', 'medium', 'high']
    })
    expect(byId(m, 'claude-opus-4-1-20250805').maxOutputTokens).toBe(32_000)
    expect(byId(m, 'claude-3-5-haiku-20241022')).toMatchObject({ maxOutputTokens: 8192, reasoningLevels: [] })
    expect(anthropicDefaults('claude-3-haiku-20240307').maxOutputTokens).toBe(4096)
    expect(anthropicDefaults('claude-opus-4-5').maxOutputTokens).toBe(64_000)
    // Limits the API reports win over the table.
    expect(parseAnthropicModels({ data: [{ id: 'claude-sonnet-9', max_input_tokens: 1_000_000, max_tokens: 128_000 }] })[0]).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000
    })
  })

  test('rootOf strips /v1 (and /api/v1)', () => {
    expect(rootOf('http://nas:4000/v1')).toBe('http://nas:4000')
    expect(rootOf('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434')
    expect(rootOf('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai')
    expect(rootOf('http://proxy:4000')).toBe('http://proxy:4000')
  })
})

describe('discoverModels (end to end, fake servers)', () => {
  test('LiteLLM proxy: /models list enriched by /model/info; bearer key sent; no key in results', async () => {
    const s = server({
      'GET http://proxy:4000/v1/models': fx('litellm-models.json'),
      'GET http://proxy:4000/model/info': fx('litellm-model-info.json')
    })
    const r = await discoverModels({ kind: 'openai', baseUrl: 'http://proxy:4000/v1', apiKey: KEY }, s.fetchFn)
    expect(r.error).toBeUndefined()
    expect(r.sources).toEqual(['GET /models', 'GET /model/info (LiteLLM)'])
    expect(byId(r.models, 'gpt-6.1-sol')).toMatchObject({ contextWindow: 1_100_000, input: ['text', 'image', 'pdf'], sources: ['litellm', 'models'] })
    expect(byId(r.models, 'claude-sonnet').maxOutputTokens).toBe(64_000)
    expect(s.seen.find((x) => x.url.endsWith('/v1/models'))?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  test('Ollama: /v1/models + /api/tags + /api/show per model', async () => {
    const s = server({
      'GET http://127.0.0.1:11434/v1/models': fx('ollama-v1-models.json'),
      'GET http://127.0.0.1:11434/api/tags': fx('ollama-tags.json'),
      'POST http://127.0.0.1:11434/api/show llama3.2:latest': fx('ollama-show-llama.json'),
      'POST http://127.0.0.1:11434/api/show llava:13b': fx('ollama-show-llava.json'),
      'POST http://127.0.0.1:11434/api/show nomic-embed-text:latest': fx('ollama-show-embed.json')
    })
    const r = await discoverModels({ kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: null }, s.fetchFn)
    expect(r.sources).toContain('GET /api/tags + POST /api/show (Ollama)')
    expect(byId(r.models, 'llava:13b')).toMatchObject({ contextWindow: 4096, input: ['text', 'image'] })
    expect(byId(r.models, 'nomic-embed-text:latest').nonChat).toBe(true)
    expect(s.seen.every((x) => !x.headers.authorization)).toBe(true)
  })

  test('LM Studio: /api/v0/models fills context + vlm', async () => {
    const s = server({
      'GET http://localhost:1234/v1/models': { data: [{ id: 'qwen2-vl-7b-instruct' }, { id: 'meta-llama-3.1-8b-instruct' }] },
      'GET http://localhost:1234/api/v0/models': fx('lmstudio-v0-models.json')
    })
    const r = await discoverModels({ kind: 'openai', baseUrl: 'http://localhost:1234/v1', apiKey: null }, s.fetchFn)
    expect(r.models.map((m) => m.id)).toEqual(['qwen2-vl-7b-instruct', 'meta-llama-3.1-8b-instruct'])
    expect(byId(r.models, 'qwen2-vl-7b-instruct').input).toEqual(['text', 'image'])
  })

  test('OpenRouter: the list alone carries the metadata; probes 404 quietly', async () => {
    const s = server({ 'GET https://openrouter.ai/api/v1/models': fx('openrouter-models.json') })
    const r = await discoverModels({ kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY }, s.fetchFn)
    expect(r.error).toBeUndefined()
    expect(r.sources).toEqual(['GET /models'])
    expect(byId(r.models, 'openai/gpt-6.1-sol').maxOutputTokens).toBe(128_000)
  })

  test('list fails (401): clear error, key scrubbed', async () => {
    const s = server({ 'GET https://api.example/v1/models': 401 })
    const r = await discoverModels({ kind: 'openai', baseUrl: 'https://api.example/v1', apiKey: KEY }, s.fetchFn)
    expect(r.models).toEqual([])
    expect(r.error).toContain('HTTP 401 (check the API key)')
    expect(r.error).not.toContain(KEY)
  })

  test('Anthropic: x-api-key + version header, follows pagination', async () => {
    const s = server({
      'GET https://api.anthropic.com/v1/models?limit=1000': fx('anthropic-models.json'),
      'GET https://api.anthropic.com/v1/models?limit=1000&after_id=claude-3-5-haiku-20241022': fx('anthropic-models-page2.json')
    })
    const r = await discoverModels({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: KEY }, s.fetchFn)
    expect(r.models.map((m) => m.id)).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
      'claude-3-5-haiku-20241022',
      'claude-3-haiku-20240307'
    ])
    expect(s.seen[0]?.headers['x-api-key']).toBe(KEY)
    expect(s.seen[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(r.sources[0]).toContain('Anthropic')
  })
})
