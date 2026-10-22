import { estimateTokens, type AiProviderKind, type ChatMessage } from '../shared/ai-api'
import {
  AiRequestError,
  isAiRequestError,
  scrubDetail,
  toErrorDetail,
  type AiApiKind,
  type AiErrorDetail
} from '../shared/ai-errors'
import {
  learnEndpoint,
  outputBudget,
  resolveApi,
  supportsInput,
  type AiApi,
  type AiEndpoint,
  type AiModel,
  type RunOptions
} from '../shared/ai-models'

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
  stream(messages: ChatMessage[], signal?: AbortSignal, run?: RunOptions & { api?: AiApi }): AsyncGenerator<string>
  /** The endpoint + model of the most recent request (Test connection shows it). */
  lastRequest?: { endpoint: AiApiKind; model: string }
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
  /** OpenAI-compatible: default API for models without their own setting (default `auto`). */
  api?: AiApi
  /** Auto switched a model to the other API and it answered: persist it (main). */
  onLearn?: (modelId: string, endpoint: AiEndpoint) => void
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
  const table: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16_384,
    xhigh: 32_000,
    max: 32_000
  }
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
            ...msg.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.data}` }
            }))
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
              ...x.images.map((img) => ({
                type: 'image',
                source: { type: 'base64', media_type: img.mime, data: img.data }
              })),
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
export async function complete(
  provider: AiProvider,
  messages: ChatMessage[],
  signal?: AbortSignal,
  run?: RunOptions & { api?: AiApi }
): Promise<string> {
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

// --- errors ------------------------------------------------------------------------------------

/** "OpenAI", "Anthropic", "OpenRouter", else the base URL's host (LiteLLM on a NAS: "nas:4000"). */
export function providerLabel(cfg: Pick<ProviderConfig, 'kind' | 'baseUrl'>): string {
  if (cfg.kind === 'anthropic') return 'Anthropic'
  try {
    const host = new URL(cfg.baseUrl).host
    if (host === 'api.openai.com') return 'OpenAI'
    if (host.endsWith('openrouter.ai')) return 'OpenRouter'
    return host || 'AI provider'
  } catch {
    return 'AI provider'
  }
}

interface ErrorCtx {
  provider: string
  endpoint: string
  model: string
  key: string | null
}

/** Pull message / code / type out of the many error body shapes (OpenAI, LiteLLM, FastAPI, plain text). */
export function parseErrorBody(text: string): { message: string; code?: string; type?: string } {
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const e = j.error
    if (typeof e === 'string') return { message: e }
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>
      const message = typeof o.message === 'string' ? o.message : JSON.stringify(o).slice(0, 500)
      const code = o.code !== undefined && o.code !== null ? String(o.code) : undefined
      const type = typeof o.type === 'string' ? o.type : undefined
      return { message, ...(code ? { code } : {}), ...(type ? { type } : {}) }
    }
    if (typeof j.message === 'string')
      return { message: j.message, ...(typeof j.code === 'string' ? { code: j.code } : {}) }
    if (typeof j.detail === 'string') return { message: j.detail }
    if (j.detail !== undefined) return { message: JSON.stringify(j.detail).slice(0, 500) }
    return { message: text.slice(0, 500) }
  } catch {
    return { message: text.replace(/\s+/g, ' ').trim().slice(0, 500) }
  }
}

function hintFor(status: number, endpoint: string): string | undefined {
  if (status === 401 || status === 403) return 'check the API key'
  if (status === 404)
    return endpoint.includes('/responses')
      ? 'check the base URL; this server may not have /responses'
      : 'check the base URL and model'
  if (status === 429) return 'rate limited or out of credit'
  return undefined
}

async function httpError(res: Response, ctx: ErrorCtx): Promise<AiRequestError> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    // body unreadable
  }
  const body = text ? parseErrorBody(text) : { message: res.statusText || '' }
  const hint = hintFor(res.status, ctx.endpoint)
  return new AiRequestError(
    scrubDetail(
      {
        provider: ctx.provider,
        status: res.status,
        ...body,
        endpoint: ctx.endpoint,
        model: ctx.model,
        kind: 'http',
        ...(hint ? { hint } : {})
      },
      ctx.key
    )
  )
}

function streamError(
  ctx: ErrorCtx,
  e: { message?: unknown; code?: unknown; type?: unknown } | undefined,
  kind: AiErrorDetail['kind'] = 'stream'
): AiRequestError {
  const message = typeof e?.message === 'string' && e.message ? e.message : 'The provider reported an error mid-stream.'
  const code = e?.code !== undefined && e?.code !== null ? String(e.code) : undefined
  const type = typeof e?.type === 'string' ? e.type : undefined
  return new AiRequestError(
    scrubDetail(
      {
        provider: ctx.provider,
        message,
        ...(code ? { code } : {}),
        ...(type ? { type } : {}),
        endpoint: ctx.endpoint,
        model: ctx.model,
        kind
      },
      ctx.key
    )
  )
}

function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (e instanceof Error && e.name === 'AbortError')
}

/** fetch with network failures turned into a readable `AiRequestError` (aborts pass through). */
async function send(fetchFn: Fetch, url: string, init: RequestInit, ctx: ErrorCtx): Promise<Response> {
  try {
    return await fetchFn(url, init)
  } catch (e) {
    if (isAbortError(e, init.signal ?? undefined) && !(e instanceof Error && e.name === 'TimeoutError')) throw e
    throw new AiRequestError(
      scrubDetail(
        toErrorDetail(e, { provider: ctx.provider, endpoint: ctx.endpoint, model: ctx.model, kind: 'network' }),
        ctx.key
      )
    )
  }
}

/**
 * A Chat Completions error that means "this model only works on the Responses API"
 * (OpenAI: "This model is only supported in v1/responses and not in v1/chat/completions.",
 * code `unsupported_api_for_model`; LiteLLM wraps the same text in a BadRequestError).
 */
export function isResponsesOnlyError(d: AiErrorDetail): boolean {
  if (d.kind !== 'http' && d.kind !== 'stream') return false
  if (d.status && d.status < 400) return false
  const text = `${d.message} ${d.code ?? ''} ${d.type ?? ''}`
  return (
    /unsupported_api_for_model/i.test(text) ||
    /v1\/responses|\/responses\b|responses api|responses endpoint/i.test(text) ||
    /only (?:be )?(?:supported|available|usable)\b.{0,40}\bresponses\b/i.test(text) ||
    /(?:not supported|unsupported|does not support|doesn't support|not available)\b.{0,40}\bchat[ /_.-]?completions?/i.test(
      text
    ) ||
    /chat[ /_.-]?completions?\b.{0,40}(?:not supported|unsupported|is not available)/i.test(text)
  )
}

/** A Responses error that means the server has no /responses route (fall back to chat once). */
export function isNoResponsesRoute(d: AiErrorDetail): boolean {
  if (d.kind !== 'http') return false
  if (d.status === 404 || d.status === 405 || d.status === 501)
    return !/model/i.test(d.message) || /route|path|endpoint|url/i.test(d.message)
  return /no route|unknown (?:url|route|endpoint)|invalid url|not implemented/i.test(d.message)
}

// --- OpenAI-compatible: Chat Completions ------------------------------------------------------

type Json = Record<string, unknown>

async function* chatStream(res: Response, ctx: ErrorCtx): AsyncGenerator<string> {
  if (!res.body) throw streamError(ctx, { message: 'empty response body' }, 'parse')
  // Some servers ignore stream:true and answer with plain JSON.
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    const j = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>
      error?: Json
    } | null
    if (j?.error) throw streamError(ctx, j.error)
    const content = j?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw streamError(ctx, { message: 'no message in the response' }, 'parse')
    yield content
    return
  }
  for await (const { data } of readSse(res.body)) {
    if (data === '[DONE]') return
    let j: { choices?: Array<{ delta?: { content?: unknown } }>; error?: Json }
    try {
      j = JSON.parse(data)
    } catch {
      continue
    }
    if (j.error) throw streamError(ctx, j.error)
    const delta = j.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) yield delta
  }
}

// --- OpenAI-compatible: Responses API ---------------------------------------------------------

/**
 * The JSON body for `POST {base}/responses`. System turns → `instructions`; the rest → `input`
 * message items (`input_text` / `input_image` for user turns, plain text for assistant turns).
 * No temperature (reasoning models reject it); `store: false` so nothing is kept server-side.
 */
export function responsesBody(cfg: ProviderConfig, messages: ChatMessage[], run?: RunOptions): Record<string, unknown> {
  const m = modelFor(cfg, run)
  const vision = supportsInput(m, 'image')
  const instructions = messages
    .filter((x) => x.role === 'system')
    .map((x) => x.content)
    .join('\n\n')
  const input = messages
    .filter((x) => x.role !== 'system')
    .map((x) =>
      x.role === 'assistant'
        ? { role: 'assistant', content: x.content }
        : {
            role: 'user',
            content: [
              { type: 'input_text', text: x.content },
              ...(vision && x.images?.length
                ? x.images.map((img) => ({ type: 'input_image', image_url: `data:${img.mime};base64,${img.data}` }))
                : [])
            ]
          }
    )
  const body: Record<string, unknown> = {
    ...(m.id ? { model: m.id } : {}),
    ...(instructions ? { instructions } : {}),
    input,
    stream: true,
    store: false
  }
  const budget = outputBudget(m, estimateTokens(vision ? messages : messages.map((x) => ({ ...x, images: undefined }))))
  if (budget) body.max_output_tokens = Math.max(16, budget)
  if (m.reasoning) body.reasoning = { effort: m.reasoning }
  return body
}

/** Text of a non-streamed Responses object (`output_text`, or the output message parts). */
export function responsesOutputText(r: Json | null | undefined): string {
  if (!r) return ''
  if (typeof r.output_text === 'string') return r.output_text
  let out = ''
  for (const item of Array.isArray(r.output) ? r.output : []) {
    const content = (item as Json)?.content
    for (const part of Array.isArray(content) ? content : []) {
      const p = part as Json
      if ((p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') out += p.text
    }
  }
  return out
}

function incompleteError(ctx: ErrorCtx, r: Json | undefined): AiRequestError {
  const details = (r?.incomplete_details ?? {}) as Json
  const reason = typeof details.reason === 'string' ? details.reason : 'unknown reason'
  const hint =
    reason === 'max_output_tokens'
      ? 'raise Max output tokens for this model (Settings › AI › Models) or lower its reasoning level'
      : reason === 'content_filter'
        ? 'the provider filtered the reply'
        : undefined
  return new AiRequestError(
    scrubDetail(
      {
        provider: ctx.provider,
        message: `Response incomplete: ${reason}`,
        code: reason,
        endpoint: ctx.endpoint,
        model: ctx.model,
        kind: 'incomplete',
        ...(hint ? { hint } : {})
      },
      ctx.key
    )
  )
}

/**
 * Responses API server-sent events → text deltas. Handles `response.output_text.delta`,
 * `response.completed`, `response.incomplete` (an error: a cut-off rewrite would lose text),
 * `response.failed`, `error`, refusals, and proxies that only send `*.done` events or drop the
 * final event. Exported for tests.
 */
export async function* parseResponsesEvents(
  events: AsyncIterable<{ event: string; data: string }>,
  ctx: ErrorCtx
): AsyncGenerator<string> {
  let emitted = 0
  let refusal = ''
  for await (const { event, data } of events) {
    if (data === '[DONE]') break
    let j: Json
    try {
      j = JSON.parse(data) as Json
    } catch {
      continue
    }
    const type = typeof j.type === 'string' ? j.type : event
    switch (type) {
      case 'response.output_text.delta':
        if (typeof j.delta === 'string' && j.delta) {
          emitted += j.delta.length
          yield j.delta
        }
        break
      case 'response.output_text.done':
        if (!emitted && typeof j.text === 'string' && j.text) {
          emitted += j.text.length
          yield j.text
        }
        break
      case 'response.refusal.delta':
        if (typeof j.delta === 'string') refusal += j.delta
        break
      case 'response.refusal.done':
        if (typeof j.refusal === 'string') refusal = j.refusal
        break
      case 'response.completed': {
        if (!emitted) {
          const text = responsesOutputText(j.response as Json)
          if (text) {
            emitted += text.length
            yield text
          }
        }
        if (!emitted && refusal) throw streamError(ctx, { message: `The model refused: ${refusal}`, code: 'refusal' })
        return
      }
      case 'response.incomplete':
        throw incompleteError(ctx, j.response as Json)
      case 'response.failed': {
        const r = (j.response ?? {}) as Json
        throw streamError(ctx, (r.error as Json) ?? { message: 'The response failed.' })
      }
      case 'error':
        throw streamError(ctx, (j.error as Json) ?? j)
      default:
        break
    }
  }
  if (!emitted) {
    if (refusal) throw streamError(ctx, { message: `The model refused: ${refusal}`, code: 'refusal' })
    throw streamError(ctx, { message: 'The stream ended before the response completed (no text received).' }, 'parse')
  }
}

async function* responsesStream(res: Response, ctx: ErrorCtx): AsyncGenerator<string> {
  if (!res.body) throw streamError(ctx, { message: 'empty response body' }, 'parse')
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    const j = (await res.json().catch(() => null)) as Json | null
    if (!j) throw streamError(ctx, { message: 'unreadable response' }, 'parse')
    if (j.error && typeof j.error === 'object') throw streamError(ctx, j.error as Json)
    if (j.status === 'incomplete') throw incompleteError(ctx, j)
    if (j.status === 'failed') throw streamError(ctx, (j.error as Json) ?? { message: 'The response failed.' })
    const text = responsesOutputText(j)
    if (!text) throw streamError(ctx, { message: 'no output text in the response' }, 'parse')
    yield text
    return
  }
  yield* parseResponsesEvents(readSse(res.body), ctx)
}

// --- OpenAI-compatible provider (Chat Completions / Responses, Auto fallback) ------------------

const ENDPOINT_PATH: Record<AiEndpoint, string> = { chat: '/chat/completions', responses: '/responses' }

function openAICompatible(cfg: ProviderConfig, fetchFn: Fetch): AiProvider {
  const provider = providerLabel(cfg)
  const self: AiProvider = {
    kind: 'openai',
    async *stream(messages, signal, run) {
      const m = modelFor(cfg, run)
      // An explicit per-request API (Test connection) wins; else the model's / provider's setting.
      const plan = run?.api && run.api !== 'auto' ? { endpoint: run.api, auto: false } : resolveApi(m, cfg.api)
      const call = async function* (endpoint: AiEndpoint): AsyncGenerator<string> {
        const path = ENDPOINT_PATH[endpoint]
        const ctx: ErrorCtx = { provider, endpoint: `POST ${path}`, model: m.id, key: cfg.apiKey }
        self.lastRequest = { endpoint, model: m.id }
        const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
        if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
        const body = endpoint === 'responses' ? responsesBody(cfg, messages, run) : openAIBody(cfg, messages, run)
        const res = await send(
          fetchFn,
          `${cfg.baseUrl}${path}`,
          { method: 'POST', headers, body: JSON.stringify(body), signal },
          ctx
        )
        if (!res.ok) throw await httpError(res, ctx)
        yield* endpoint === 'responses' ? responsesStream(res, ctx) : chatStream(res, ctx)
      }
      let yielded = false
      try {
        for await (const d of call(plan.endpoint)) {
          yielded = true
          yield d
        }
        return
      } catch (e) {
        if (!plan.auto || yielded || isAbortError(e, signal) || !isAiRequestError(e)) throw e
        const other: AiEndpoint | null =
          plan.endpoint === 'chat' && isResponsesOnlyError(e.detail)
            ? 'responses'
            : plan.endpoint === 'responses' && isNoResponsesRoute(e.detail)
              ? 'chat'
              : null
        if (!other) throw e
        try {
          let learned = false
          for await (const d of call(other)) {
            if (!learned) {
              // The other API answered: remember it for this model (Auto only).
              learned = true
              cfg.models = learnEndpoint(cfg.models ?? [], m.id, other)
              cfg.onLearn?.(m.id, other)
            }
            yield d
          }
        } catch (e2) {
          if (isAiRequestError(e2)) throw new AiRequestError({ ...e2.detail, attempts: [e.detail] })
          throw e2
        }
      }
    }
  }
  return self
}

function anthropic(cfg: ProviderConfig, fetchFn: Fetch): AiProvider {
  const self: AiProvider = {
    kind: 'anthropic',
    async *stream(messages, signal, run) {
      const m = modelFor(cfg, run)
      const ctx: ErrorCtx = { provider: 'Anthropic', endpoint: 'POST /v1/messages', model: m.id, key: cfg.apiKey }
      self.lastRequest = { endpoint: 'messages', model: m.id }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream'
      }
      if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey
      const res = await send(
        fetchFn,
        `${cfg.baseUrl}/v1/messages`,
        { method: 'POST', headers, body: JSON.stringify(anthropicBody(cfg, messages, run)), signal },
        ctx
      )
      if (!res.ok) throw await httpError(res, ctx)
      if (!res.body) throw streamError(ctx, { message: 'empty response body' }, 'parse')
      for await (const { event, data } of readSse(res.body)) {
        if (event === 'message_stop') return
        let j: { type?: string; delta?: { type?: string; text?: unknown }; error?: Json }
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        if (event === 'error' || j.type === 'error') throw streamError(ctx, j.error)
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && typeof j.delta.text === 'string')
          yield j.delta.text
      }
    }
  }
  return self
}

export function createProvider(cfg: ProviderConfig, fetchFn: Fetch = (input, init) => fetch(input, init)): AiProvider {
  switch (cfg.kind) {
    case 'anthropic':
      return anthropic(cfg, fetchFn)
    case 'openai':
      return openAICompatible(cfg, fetchFn)
  }
}
