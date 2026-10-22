import { scrubSecret, type AiProviderKind } from '../shared/ai-api'
import {
  DEFAULT_REASONING_LEVELS,
  META_FIELDS,
  normalizeModality,
  type DiscoveredModel,
  type DiscoveryResult,
  type Modality,
  type ModelMeta
} from '../shared/ai-models'

/**
 * "Find models" (Settings › AI › Models). Runs in main only: the key never reaches the renderer.
 * Electron-free with an injectable fetch, so every format is unit-tested against fixtures.
 *
 * OpenAI-compatible base URL:
 *   GET  {base}/models                      the list (required). OpenRouter / Groq / Together / vLLM add
 *                                           context_length, max_completion_tokens, architecture
 *                                           modalities, supported_parameters, max_model_len …
 *   GET  {base}/model/info, {root}/model/info   LiteLLM proxy: max_input/output_tokens, supports_* flags
 *   GET  {root}/api/tags + POST /api/show   Ollama: context_length, capabilities (vision/tools/thinking)
 *   GET  {root}/api/v0/models               LM Studio: max_context_length, type vlm, capabilities
 * Anthropic:
 *   GET  {base}/v1/models                   id + display_name (+ limits if the API reports them);
 *                                           context/output filled from known per-family defaults.
 * The extra probes are best-effort: a 404 just means "not that kind of server".
 */

type Fetch = (input: string, init: RequestInit) => Promise<Response>

export interface DiscoveryConfig {
  kind: AiProviderKind
  baseUrl: string
  apiKey: string | null
}

const TIMEOUT_MS = 10_000
const OLLAMA_SHOW_LIMIT = 40

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}
function mods(list: unknown): Modality[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out = new Set<Modality>()
  for (const x of list) {
    const m = typeof x === 'string' ? normalizeModality(x) : null
    if (m) out.add(m)
  }
  return out.size ? [...out] : undefined
}
/**
 * Responses-only models: LiteLLM `mode: "responses"`, or a `supported_endpoints` list (LiteLLM cost
 * map, some proxies' /models) that has /responses but not /chat/completions. Chat is the default,
 * so only `responses` is reported.
 */
export function endpointFrom(mode: unknown, endpoints: unknown): 'responses' | undefined {
  if (typeof mode === 'string' && mode.trim().toLowerCase() === 'responses') return 'responses'
  const list = arr(endpoints)
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.toLowerCase())
  if (!list.length) return undefined
  const responses = list.some((x) => /(^|\/)responses$/.test(x))
  const chat = list.some((x) => /chat\/completions$/.test(x))
  return responses && !chat ? 'responses' : undefined
}

function withText(m: Modality[]): Modality[] {
  return m.includes('text') ? m : ['text', ...m]
}

/** Drop undefined fields. */
function clean(meta: ModelMeta): ModelMeta {
  const out: ModelMeta = {}
  for (const f of META_FIELDS) if (meta[f] !== undefined) (out as unknown as Json)[f] = meta[f]
  return out
}

// --- OpenAI-compatible GET /models (incl. OpenRouter / Groq / Together / vLLM extras) -------------

export function parseOpenAIModels(body: unknown): DiscoveredModel[] {
  const root = obj(body)
  const list = Array.isArray(body) ? body : arr(root.data ?? root.models)
  const out: DiscoveredModel[] = []
  for (const item of list) {
    const m = obj(item)
    const id = str(m.id) ?? str(m.name)
    if (!id) continue
    const arch = obj(m.architecture)
    const top = obj(m.top_provider)
    const params = arr(m.supported_parameters).filter((x): x is string => typeof x === 'string')
    const modality = typeof arch.modality === 'string' ? arch.modality.split('->') : null
    const input = mods(arch.input_modalities) ?? (modality ? mods(modality[0]?.split('+')) : undefined)
    const output = mods(arch.output_modalities) ?? (modality ? mods(modality[1]?.split('+')) : undefined)
    const type = str(m.type)?.toLowerCase()
    const name = str(m.name) && str(m.name) !== id ? str(m.name) : str(m.display_name)
    const meta: ModelMeta = {
      name,
      contextWindow: num(m.context_length) ?? num(m.context_window) ?? num(m.max_model_len) ?? num(top.context_length),
      maxOutputTokens: num(top.max_completion_tokens) ?? num(m.max_completion_tokens) ?? num(m.max_output_tokens),
      input,
      output,
      toolCalls: params.length ? params.includes('tools') || params.includes('tool_choice') : undefined,
      reasoningLevels:
        params.includes('reasoning') || params.includes('reasoning_effort') || params.includes('include_reasoning')
          ? [...DEFAULT_REASONING_LEVELS]
          : undefined,
      endpoint: endpointFrom(m.mode, m.supported_endpoints ?? m.endpoints)
    }
    const nonChat =
      type === 'embedding' ||
      type === 'embeddings' ||
      /(^|[-_/.])(embed|embedding|rerank|tts|whisper|dall-e|moderation)/i.test(id)
    out.push({ id, ...clean(meta), sources: ['models'], ...(nonChat ? { nonChat } : {}) })
  }
  return out
}

// --- LiteLLM GET /model/info --------------------------------------------------------------------

export function parseLiteLLMInfo(body: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const item of arr(obj(body).data)) {
    const m = obj(item)
    const id = str(m.model_name)
    if (!id) continue
    const info = obj(m.model_info)
    const input: Modality[] = ['text']
    if (info.supports_vision === true) input.push('image')
    if (info.supports_audio_input === true) input.push('audio')
    if (info.supports_video_input === true) input.push('video')
    if (info.supports_pdf_input === true) input.push('pdf')
    const output: Modality[] = ['text']
    if (info.supports_audio_output === true) output.push('audio')
    if (info.supports_image_output === true || str(info.mode) === 'image_generation') output.push('image')
    const mode = str(info.mode)
    // LiteLLM reports false for flags of models it has no cost-map entry for, so only trust the
    // capability flags when it knows the model (it then has a provider / token limits).
    const known = Boolean(info.key || info.litellm_provider || info.max_input_tokens || info.max_tokens)
    const meta: ModelMeta = {
      contextWindow: num(info.max_input_tokens) ?? num(info.max_tokens),
      maxOutputTokens: num(info.max_output_tokens),
      input: known ? input : undefined,
      output: known ? output : undefined,
      toolCalls:
        known && typeof info.supports_function_calling === 'boolean' ? info.supports_function_calling : undefined,
      reasoningLevels: info.supports_reasoning === true ? [...DEFAULT_REASONING_LEVELS] : known ? [] : undefined,
      endpoint: endpointFrom(mode, info.supported_endpoints ?? obj(m.litellm_params).supported_endpoints)
    }
    const nonChat = !!mode && mode !== 'chat' && mode !== 'responses' && mode !== 'completion'
    out.push({ id, ...clean(meta), sources: ['litellm'], ...(nonChat ? { nonChat } : {}) })
  }
  return out
}

// --- Ollama /api/tags + /api/show ----------------------------------------------------------------

export function parseOllamaTags(body: unknown): string[] {
  return arr(obj(body).models)
    .map((m) => str(obj(m).model) ?? str(obj(m).name))
    .filter((x): x is string => !!x)
}

export function parseOllamaShow(id: string, body: unknown): DiscoveredModel {
  const b = obj(body)
  const info = obj(b.model_info)
  let ctx: number | undefined
  for (const [k, v] of Object.entries(info)) if (k.endsWith('.context_length')) ctx = num(v) ?? ctx
  // A Modelfile `PARAMETER num_ctx` is what the server actually runs with; prefer it when set.
  const numCtx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(typeof b.parameters === 'string' ? b.parameters : '')
  if (numCtx) ctx = num(numCtx[1]) ?? ctx
  const caps = arr(b.capabilities).filter((x): x is string => typeof x === 'string')
  const input: Modality[] = ['text']
  if (caps.includes('vision')) input.push('image')
  if (caps.includes('audio')) input.push('audio')
  const meta: ModelMeta = {
    contextWindow: ctx,
    input: caps.length ? input : undefined,
    output: caps.length ? ['text'] : undefined,
    toolCalls: caps.length ? caps.includes('tools') : undefined,
    reasoningLevels: caps.length ? (caps.includes('thinking') ? [...DEFAULT_REASONING_LEVELS] : []) : undefined
  }
  const nonChat = caps.length > 0 && caps.includes('embedding') && !caps.includes('completion')
  return { id, ...clean(meta), sources: ['ollama'], ...(nonChat ? { nonChat } : {}) }
}

// --- LM Studio /api/v0/models --------------------------------------------------------------------

export function parseLMStudioModels(body: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const item of arr(obj(body).data)) {
    const m = obj(item)
    const id = str(m.id)
    if (!id) continue
    const type = str(m.type)
    const caps = arr(m.capabilities).filter((x): x is string => typeof x === 'string')
    const meta: ModelMeta = {
      contextWindow: num(m.loaded_context_length) ?? num(m.max_context_length),
      input: type === 'vlm' ? ['text', 'image'] : type === 'llm' ? ['text'] : undefined,
      output: type === 'vlm' || type === 'llm' ? ['text'] : undefined,
      toolCalls: caps.length ? caps.includes('tool_use') : undefined
    }
    out.push({ id, ...clean(meta), sources: ['lmstudio'], ...(type === 'embeddings' ? { nonChat: true } : {}) })
  }
  return out
}

// --- Anthropic GET /v1/models + known defaults ---------------------------------------------------

/**
 * Conservative limits for Claude families (Anthropic's published model table). The API's list has
 * id and display_name; any limits it does report win over these. All editable in the Models form.
 */
export function anthropicDefaults(id: string): ModelMeta {
  const s = id.toLowerCase()
  const meta: ModelMeta = { contextWindow: 200_000, input: ['text', 'image', 'pdf'], output: ['text'], toolCalls: true }
  if (/claude-3-(?:haiku|opus|sonnet)/.test(s)) meta.maxOutputTokens = 4096
  else if (/claude-3-5/.test(s)) meta.maxOutputTokens = 8192
  else if (/claude-3-7/.test(s)) meta.maxOutputTokens = 64_000
  else if (/claude-opus-4(?:-[01])?(?:-\d{8})?$/.test(s)) meta.maxOutputTokens = 32_000
  else if (/claude-(?:sonnet|haiku|opus)-\d/.test(s)) meta.maxOutputTokens = 64_000
  else meta.maxOutputTokens = 4096
  // Extended thinking: Claude 3.7 and every 4.x+ model.
  meta.reasoningLevels = /claude-3-7|claude-(?:sonnet|haiku|opus)-[4-9]/.test(s) ? [...DEFAULT_REASONING_LEVELS] : []
  return meta
}

export function parseAnthropicModels(body: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const item of arr(obj(body).data)) {
    const m = obj(item)
    const id = str(m.id)
    if (!id) continue
    const defaults = anthropicDefaults(id)
    const meta: ModelMeta = {
      ...defaults,
      name: str(m.display_name),
      contextWindow: num(m.max_input_tokens) ?? num(m.context_window) ?? defaults.contextWindow,
      maxOutputTokens: num(m.max_tokens) ?? num(m.max_output_tokens) ?? defaults.maxOutputTokens
    }
    out.push({ id, ...clean(meta), sources: ['anthropic'] })
  }
  return out
}

// --- merge -----------------------------------------------------------------------------------------

/** Source priority per field: server-specific metadata beats the generic list. */
const PRIORITY = ['litellm', 'ollama', 'lmstudio', 'anthropic', 'models']

/** Combine what each endpoint said about each model; the list decides which ids exist. */
export function mergeDiscovered(list: DiscoveredModel[], extras: DiscoveredModel[][]): DiscoveredModel[] {
  const byId = new Map<string, DiscoveredModel[]>()
  for (const d of [...list, ...extras.flat()]) {
    const all = byId.get(d.id) ?? []
    all.push(d)
    byId.set(d.id, all)
  }
  const rank = (d: DiscoveredModel): number => {
    const i = PRIORITY.indexOf(d.sources[0] ?? '')
    return i < 0 ? PRIORITY.length : i
  }
  const out: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const base of list) {
    if (seen.has(base.id)) continue
    seen.add(base.id)
    const all = [...(byId.get(base.id) ?? [base])].sort((a, b) => rank(a) - rank(b))
    const merged: DiscoveredModel = { id: base.id, sources: [] }
    for (const d of all) {
      for (const f of META_FIELDS)
        if (merged[f] === undefined && d[f] !== undefined) (merged as unknown as Json)[f] = d[f]
      for (const s of d.sources) if (!merged.sources.includes(s)) merged.sources.push(s)
      if (d.nonChat) merged.nonChat = true
    }
    if (merged.input) merged.input = withText(merged.input)
    out.push(merged)
  }
  return out
}

// --- network -------------------------------------------------------------------------------------

/** `http://host:4000/v1` → `http://host:4000` (Ollama / LM Studio / LiteLLM native routes live at the root). */
export function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/(?:api\/)?v\d+$/, '')
}

const SOURCE_LABEL = {
  models: 'GET /models',
  litellm: 'GET /model/info (LiteLLM)',
  ollama: 'GET /api/tags + POST /api/show (Ollama)',
  lmstudio: 'GET /api/v0/models (LM Studio)',
  anthropic: 'GET /v1/models (Anthropic) + known Claude limits'
}

async function getJson(
  fetchFn: Fetch,
  url: string,
  headers: Record<string, string>,
  init: RequestInit = {}
): Promise<unknown> {
  const res = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS), ...init })
  if (!res.ok) {
    let detail = ''
    try {
      const t = await res.text()
      try {
        const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string }
        detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? '')
      } catch {
        detail = t.slice(0, 200)
      }
    } catch {
      // unreadable body
    }
    const hint =
      res.status === 401 || res.status === 403
        ? ' (check the API key)'
        : res.status === 404
          ? ' (check the base URL)'
          : ''
    throw new Error(`HTTP ${res.status}${hint}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
  return res.json()
}

async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch {
    return null
  }
}

async function discoverOpenAI(cfg: DiscoveryConfig, fetchFn: Fetch): Promise<DiscoveryResult> {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const root = rootOf(base)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
  const sources: string[] = []

  const infoUrls = [...new Set([`${base}/model/info`, `${root}/model/info`, `${root}/v1/model/info`])]
  const [listBody, liteInfo, tags, lms] = await Promise.all([
    getJson(fetchFn, `${base}/models`, headers).then(
      (b) => ({ ok: true as const, b }),
      (e: unknown) => ({ ok: false as const, e })
    ),
    (async () => {
      for (const u of infoUrls) {
        const r = await optional(getJson(fetchFn, u, headers))
        if (r && Array.isArray(obj(r).data)) return parseLiteLLMInfo(r)
      }
      return null
    })(),
    optional(getJson(fetchFn, `${root}/api/tags`, headers)),
    optional(getJson(fetchFn, `${root}/api/v0/models`, headers))
  ])

  let list = listBody.ok ? parseOpenAIModels(listBody.b) : []
  if (listBody.ok) sources.push(SOURCE_LABEL.models)
  const extras: DiscoveredModel[][] = []
  if (liteInfo?.length) {
    extras.push(liteInfo)
    sources.push(SOURCE_LABEL.litellm)
  }
  const ollamaNames = tags ? parseOllamaTags(tags) : []
  if (ollamaNames.length) {
    const shows = await Promise.all(
      ollamaNames.slice(0, OLLAMA_SHOW_LIMIT).map(async (name): Promise<DiscoveredModel> => {
        const b = await optional(
          getJson(
            fetchFn,
            `${root}/api/show`,
            { ...headers, 'content-type': 'application/json' },
            { method: 'POST', body: JSON.stringify({ model: name }) }
          )
        )
        return b ? parseOllamaShow(name, b) : { id: name, sources: ['ollama'] }
      })
    )
    extras.push(shows)
    sources.push(SOURCE_LABEL.ollama)
    // Ollama without /v1/models (very old builds): the tags are the list.
    if (!list.length) list = shows.map((s) => ({ id: s.id, sources: ['ollama'] }))
  }
  const lmsModels = lms ? parseLMStudioModels(lms) : []
  if (lmsModels.length) {
    extras.push(lmsModels)
    sources.push(SOURCE_LABEL.lmstudio)
  }
  if (!list.length && !listBody.ok) {
    const e = listBody.e
    return {
      models: [],
      sources,
      error: scrubSecret(`Could not list models: ${e instanceof Error ? e.message : String(e)}`, cfg.apiKey)
    }
  }
  return { models: mergeDiscovered(list, extras), sources }
}

async function discoverAnthropic(cfg: DiscoveryConfig, fetchFn: Fetch): Promise<DiscoveryResult> {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = { accept: 'application/json', 'anthropic-version': '2023-06-01' }
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey
  const models: DiscoveredModel[] = []
  try {
    let after = ''
    for (let page = 0; page < 5; page++) {
      const q = after ? `&after_id=${encodeURIComponent(after)}` : ''
      const body = obj(await getJson(fetchFn, `${base}/v1/models?limit=1000${q}`, headers))
      models.push(...parseAnthropicModels(body))
      const last = str(body.last_id)
      if (body.has_more !== true || !last) break
      after = last
    }
  } catch (e) {
    return {
      models: [],
      sources: [],
      error: scrubSecret(`Could not list models: ${e instanceof Error ? e.message : String(e)}`, cfg.apiKey)
    }
  }
  return { models: mergeDiscovered(models, []), sources: [SOURCE_LABEL.anthropic] }
}

export async function discoverModels(
  cfg: DiscoveryConfig,
  fetchFn: Fetch = (input, init) => fetch(input, init)
): Promise<DiscoveryResult> {
  return cfg.kind === 'anthropic' ? discoverAnthropic(cfg, fetchFn) : discoverOpenAI(cfg, fetchFn)
}
