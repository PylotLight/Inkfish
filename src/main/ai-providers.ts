import { scrubSecret, type AiProviderKind, type ChatMessage } from '../shared/ai-api'

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
  /** Streams text deltas for `messages` (system first, then alternating turns). */
  stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string>
}

export interface ProviderConfig {
  kind: AiProviderKind
  baseUrl: string
  model: string
  /** Decrypted in main, held in memory only. Never logged. */
  apiKey: string | null
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Concatenate a whole stream (Test connection, non-streaming callers). */
export async function complete(provider: AiProvider, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  let out = ''
  for await (const delta of provider.stream(messages, signal)) out += delta
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
    async *stream(messages, signal) {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
      const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...(cfg.model ? { model: cfg.model } : {}), messages, stream: true, temperature: 0.2 }),
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
    async *stream(messages, signal) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
      const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream'
      }
      if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey
      const res = await fetchFn(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 8192,
          temperature: 0.2,
          ...(system ? { system } : {}),
          messages: turns,
          stream: true
        }),
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
