import { estimateTokens, scrubSecret, type AiProviderKind, type ChatMessage } from '../shared/ai-api'
import { outputBudget, supportsInput, type AiModel, type RunOptions } from '../shared/ai-models'

/**
 * Remote AI providers behind Inkfish's local AI handler. Electron-free so it runs in the utility
 * process (src/main/ai-handler.ts), in main (Test connection) and under `bun test`.
 *
 * Provider seam: an `AiProvider` streams text for a chat. To add an embedded local model later
 * (llama.cpp / MLX in the utility process), add a kind to AI_PROVIDER_KINDS
 * (src/shared/ai-api.ts) and a branch in `createProvider` returning an object with the same shape.
 * Nothing above this file changes.
 */

export interface AiProvider {
  readonly kind: AiProviderKind
  /**
   * Streams text deltas for `messages` (system first, then alternating turns). `run.model` picks a
   * model from `ProviderConfig.models` (per-action models); default is `ProviderConfig.model`.
   */
  stream(messages: ChatMessage[], signal?: AbortSignal, run?: RunOptions): AsyncGenerator<string>
}

export interface ProviderConfig {
  kind: AiProviderKind
  baseUrl: string
  /** Default model id. */
  model: string
  /** Decrypted in main, held in memory only. Never logged. */
  apiKey: string | null
  /** Per-model config (limits, reasoning level, input capabilities) from Settings › AI › Models. */
  models?: AiModel[]
}

/** The model config for a request: `run.model` if known, else the default (bare id when not in the list). */
export function modelFor(cfg: ProviderConfig, run?: RunOptions): AiModel {
  const id = run?.model || cfg.model
  return cfg.models?.find((m) => m.id === id) ?? { id }
}

/** Anthropic extended-thinking budget for a reasoning level (a number is taken as tokens). */
export function thinkingBudget(level: string): number {
  const n = Number(level)
  if (Number.isFinite(n) && n > 0) return Math.round(n)
  const table: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16_384, xhigh: 32_000, max: 32_000 }
  return table[level] ?? 8192
}

function isOpenAIHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

/** The JSON body for an OpenAI-compatible `/chat/completions` request. Exported for tests. */
export function openAIBody(cfg: ProviderConfig, messages: ChatMessage[], run?: RunOptions): Record<string, unknown> {
  const m = modelFor(cfg, run)
  const vision = supportsInput(m, 'image')
  const wire = messages.map((msg) =>
    vision && msg.images?.length
      ? {
          role: msg.role,
          content: [
            { type: 'text', text: msg.content },
            ...msg.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } }))
          ]
        }
      : { role: msg.role, content: msg.content }
  )
  const body: Record<string, unknown> = { ...(m.id ? { model: m.id } : {}), messages: wire, stream: true }
  // Reasoning models reject a custom temperature; only send one when no reasoning level is set.
  if (m.reasoning) body.reasoning_effort = m.reasoning
  else body.temperature = 0.2
  const budget = outputBudget(m, estimateTokens(vision ? messages : messages.map((x) => ({ ...x, images: undefined }))))
  // api.openai.com wants max_completion_tokens (reasoning models refuse max_tokens); other
  // OpenAI-compatible servers (LiteLLM, OpenRouter, Ollama, LM Studio, vLLM) take max_tokens.
  if (budget) body[isOpenAIHost(cfg.baseUrl) ? 'max_completion_tokens' : 'max_tokens'] = budget
  return body
}

/** The JSON body for an Anthropic `/v1/messages` request. Exported for tests. */
export function anthropicBody(cfg: ProviderConfig, messages: ChatMessage[], run?: RunOptions): Record<string, unknown> {
  const m = modelFor(cfg, run)
  const vision = supportsInput(m, 'image')
  const system = messages
    .filter((x) => x.role === 'system')
    .map((x) => x.content)
    .join('\n\n')
  const turns = messages
    .filter((x) => x.role !== 'system')
    .map((x) =>
      vision && x.images?.length
        ? {
            role: x.role,
            content: [
              ...x.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })),
              { type: 'text', text: x.content }
            ]
          }
        : { role: x.role, content: x.content }
    )
  let maxTokens = outputBudget(m, estimateTokens(messages)) ?? 8192
  const body: Record<string, unknown> = { model: m.id, ...(system ? { system } : {}), messages: turns, stream: true }
  let thinking = m.reasoning ? thinkingBudget(m.reasoning) : 0
  if (thinking) {
    // budget_tokens must be ≥ 1024 and below max_tokens; leave room for the visible answer.
    const cap = m.maxOutputTokens ?? Math.max(maxTokens, thinking + 4096)
    if (maxTokens <= thinking + 1024) maxTokens = Math.min(cap, thinking + 4096)
    if (thinking >= maxTokens) thinking = maxTokens - 1024
    if (thinking < 1024) thinking = 0
  }
  body.max_tokens = maxTokens
  // Extended thinking requires the default temperature.
  if (thinking) body.thinking = { type: 'enabled', budget_tokens: thinking }
  else body.temperature = 0.2
  return body
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Concatenate a whole stream (Test connection, non-streaming callers). */
export async function complete(provider: AiProvider, messages: ChatMessage[], signal?: AbortSignal, run?: RunOptions): Promise<string> {
  let out = ''
  for await (const delta of provider.stream(messages, signal, run)) out += delta
  return out
}

/** Server-sent events from a fetch body: yields `{ event, data }` per blank-line-terminated block. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const flush = function* (block: string): Generator<{ event: string; data: string }> {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) yield { event, data: data.join('\n') }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        yield* flush(block)
      }
    }
    buf += decoder.decode()
    if (buf.trim()) yield* flush(buf)
  } finally {
    reader.releaseLock()
  }
}

async function httpError(res: Response, label: string, key: string | null): Promise<Error> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
      detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? '')
    } catch {
      detail = text
    }
  } catch {
    // body unreadable
  }
  const hint = res.status === 401 || res.status === 403 ? ' (check the API key)' : res.status === 404 ? ' (check the base URL and model)' : ''
  const msg = `${label}: HTTP ${res.status}${hint}${detail ? ` — ${detail.slice(0, 200)}` : ''}`
  return new Error(scrubSecret(msg, key))
}

function openAICompatible(cfg: ProviderConfig, fetchFn: Fetch): AiProvider {
  return {
    kind: 'openai',
    async *stream(messages, signal, run) {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
      const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(openAIBody(cfg, messages, run)),
        signal
      })
      if (!res.ok) throw await httpError(res, 'AI provider', cfg.apiKey)
      if (!res.body) throw new Error('AI provider: empty response')
      // Some servers ignore stream:true and answer with plain JSON.
      if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
        const content = j.choices?.[0]?.message?.content
        if (typeof content !== 'string') throw new Error('AI provider: no message in the response')
        yield content
        return
      }
      for await (const { data } of readSse(res.body)) {
        if (data === '[DONE]') return
        let j: { choices?: Array<{ delta?: { content?: unknown } }>; error?: { message?: string } }
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        if (j.error) throw new Error(scrubSecret(`AI provider: ${j.error.message ?? 'error'}`, cfg.apiKey))
        const delta = j.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) yield delta
      }
    }
  }
}

function anthropic(cfg: ProviderConfig, fetchFn: Fetch): AiProvider {
  return {
    kind: 'anthropic',
    async *stream(messages, signal, run) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream'
      }
      if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey
      const res = await fetchFn(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(anthropicBody(cfg, messages, run)),
        signal
      })
      if (!res.ok) throw await httpError(res, 'Anthropic', cfg.apiKey)
      if (!res.body) throw new Error('Anthropic: empty response')
      for await (const { event, data } of readSse(res.body)) {
        if (event === 'message_stop') return
        let j: { type?: string; delta?: { type?: string; text?: unknown }; error?: { message?: string } }
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        if (event === 'error' || j.type === 'error') throw new Error(scrubSecret(`Anthropic: ${j.error?.message ?? 'error'}`, cfg.apiKey))
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && typeof j.delta.text === 'string') yield j.delta.text
      }
    }
  }
}

export function createProvider(cfg: ProviderConfig, fetchFn: Fetch = (input, init) => fetch(input, init)): AiProvider {
  switch (cfg.kind) {
    case 'anthropic':
      return anthropic(cfg, fetchFn)
    case 'openai':
      return openAICompatible(cfg, fetchFn)
  }
}
