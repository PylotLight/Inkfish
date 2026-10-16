/**
 * Settings › AI › Models: the per-model config the user keeps (found with "Find models" or added by
 * hand), how detected values merge with the user's edits, and the request limits a model implies.
 * Pure and Electron-free: shared by main (discovery, provider requests), the utility handler and
 * the renderer (Settings UI, chunking long notes).
 *
 * Every metadata field is optional: a model with nothing detected just has an id, and requests then
 * behave as before (no max_tokens, no chunking).
 *
 * Detected vs edited: `detected` keeps the last values discovery reported, `edited` lists the fields
 * the user changed by hand. Re-detect overwrites only fields not in `edited` unless forced.
 */

export const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const
export type Modality = (typeof MODALITIES)[number]

/**
 * Which OpenAI-compatible endpoint a model is called on. `auto` = Chat Completions unless the model
 * is known (discovery, or a previous responses-only error) to need the Responses API; an Auto request
 * that fails with a "responses only" error is retried once on `/responses` and remembered.
 */
export const AI_APIS = ['auto', 'chat', 'responses'] as const
export type AiApi = (typeof AI_APIS)[number]
export type AiEndpoint = Exclude<AiApi, 'auto'>
export const AI_API_LABEL: Record<AiApi, string> = { auto: 'Auto', chat: 'Chat Completions', responses: 'Responses' }

/** What discovery can report for a model (and what the user can override). */
export interface ModelMeta {
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoningLevels?: string[]
  input?: Modality[]
  output?: Modality[]
  toolCalls?: boolean
  /** The endpoint Auto uses: detected (LiteLLM `mode: "responses"`, `supported_endpoints`) or learned. */
  endpoint?: AiEndpoint
}

export const META_FIELDS = ['name', 'contextWindow', 'maxOutputTokens', 'reasoningLevels', 'input', 'output', 'toolCalls', 'endpoint'] as const
export type MetaField = (typeof META_FIELDS)[number]

export interface AiModel extends ModelMeta {
  /** The id the provider expects in requests (`model`). Unique within the list. */
  id: string
  /** Reasoning level to send with requests; unset = send nothing (provider default). */
  reasoning?: string
  /** API to call this model on; unset / `auto` = the provider's default (Settings › AI). */
  api?: AiApi
  /** Last values discovery reported (internal). */
  detected?: ModelMeta
  /** Fields the user set by hand; Re-detect leaves them alone unless forced (internal). */
  edited?: MetaField[]
}

/** One model as discovery found it, before the user adds it. `sources` names the endpoints that said so. */
export interface DiscoveredModel extends ModelMeta {
  id: string
  sources: string[]
  /** Embedding / rerank / image-generation models: not useful for note processing; hidden by default. */
  nonChat?: boolean
}

export interface DiscoveryResult {
  models: DiscoveredModel[]
  /** Endpoints that answered (e.g. `GET /models`, `GET /model/info (LiteLLM)`). */
  sources: string[]
  /** Set when the model list itself failed (key wrong, URL wrong). Optional probes failing is normal. */
  error?: string
}

export const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high']

// --- parsing / validation ---------------------------------------------------------------------

const MAX_TOKENS_SANE = 100_000_000

function posInt(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_TOKENS_SANE) return undefined
  return Math.round(n)
}

function modalities(v: unknown): Modality[] | undefined {
  if (!Array.isArray(v)) return undefined
  const set = new Set<Modality>()
  for (const x of v) {
    const m = typeof x === 'string' ? normalizeModality(x) : null
    if (m) set.add(m)
  }
  return MODALITIES.filter((m) => set.has(m))
}

/** Provider spellings → ours (`file` is how OpenRouter says pdf). */
export function normalizeModality(v: string): Modality | null {
  const s = v.trim().toLowerCase()
  if (s === 'file' || s === 'pdf' || s === 'document') return 'pdf'
  if (s === 'vision' || s === 'images') return 'image'
  return (MODALITIES as readonly string[]).includes(s) ? (s as Modality) : null
}

/** `"low, medium, high"` or an array → trimmed, de-duplicated, lowercase list. */
export function parseLevels(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null
  if (!raw) return undefined
  const out: string[] = []
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const s = x.trim().toLowerCase().slice(0, 32)
    if (s && !out.includes(s)) out.push(s)
  }
  return out.slice(0, 12)
}

export function parseMeta(v: unknown): ModelMeta {
  const raw = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const meta: ModelMeta = {}
  if (typeof raw.name === 'string' && raw.name.trim()) meta.name = raw.name.trim().slice(0, 120)
  const ctx = posInt(raw.contextWindow)
  if (ctx) meta.contextWindow = ctx
  const out = posInt(raw.maxOutputTokens)
  if (out) meta.maxOutputTokens = out
  const levels = parseLevels(raw.reasoningLevels)
  if (levels) meta.reasoningLevels = levels
  const input = modalities(raw.input)
  if (input) meta.input = input
  const output = modalities(raw.output)
  if (output) meta.output = output
  if (typeof raw.toolCalls === 'boolean') meta.toolCalls = raw.toolCalls
  if (raw.endpoint === 'chat' || raw.endpoint === 'responses') meta.endpoint = raw.endpoint
  return meta
}

export function parseModel(v: unknown): AiModel | null {
  if (typeof v !== 'object' || v === null) return null
  const raw = v as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 200) : ''
  if (!id) return null
  const model: AiModel = { id, ...parseMeta(raw) }
  if (typeof raw.reasoning === 'string' && raw.reasoning.trim()) model.reasoning = raw.reasoning.trim().toLowerCase().slice(0, 32)
  if (raw.api === 'chat' || raw.api === 'responses') model.api = raw.api
  if (raw.detected && typeof raw.detected === 'object') model.detected = parseMeta(raw.detected)
  if (Array.isArray(raw.edited)) {
    const edited = META_FIELDS.filter((f) => (raw.edited as unknown[]).includes(f))
    if (edited.length) model.edited = edited
  }
  return model
}

/** Valid, unique-by-id list (first wins), capped. */
export function parseModels(v: unknown): AiModel[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: AiModel[] = []
  for (const x of v) {
    const m = parseModel(x)
    if (!m || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
    if (out.length >= 500) break
  }
  return out
}

// --- merge / edit -----------------------------------------------------------------------------

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function pickMeta(src: ModelMeta): ModelMeta {
  const out: ModelMeta = {}
  for (const f of META_FIELDS) if (src[f] !== undefined) (out as unknown as Record<string, unknown>)[f] = src[f]
  return out
}

/**
 * Apply a discovery result to a model in the list (or create it). Fields the user edited keep
 * their value unless `force`; with `force` the edits are dropped and detected values win. A field
 * discovery did not report keeps its current value either way.
 */
export function applyDetection(existing: AiModel | undefined, found: DiscoveredModel, opts: { force?: boolean } = {}): AiModel {
  const detected = pickMeta(found)
  if (!existing) return { id: found.id, ...detected, detected }
  const edited = opts.force ? [] : (existing.edited ?? [])
  const next: AiModel = { ...existing, detected }
  for (const f of META_FIELDS) {
    if (edited.includes(f)) continue
    if (detected[f] !== undefined) (next as unknown as Record<string, unknown>)[f] = detected[f]
  }
  if (edited.length) next.edited = edited
  else delete next.edited
  // A reasoning level the model no longer lists is dropped.
  if (next.reasoning && next.reasoningLevels && !next.reasoningLevels.includes(next.reasoning)) delete next.reasoning
  return next
}

/** User edit from the Models form. Marks a field edited when it differs from what was detected. */
export function editModel(model: AiModel, patch: Partial<AiModel>): AiModel {
  const next: AiModel = { ...model }
  const edited = new Set(model.edited ?? [])
  const clean = parseMeta({ ...pickMeta(model), ...patch })
  for (const f of META_FIELDS) {
    if (!(f in patch)) continue
    const value = clean[f]
    if (value === undefined) delete (next as unknown as Record<string, unknown>)[f]
    else (next as unknown as Record<string, unknown>)[f] = value
    if (model.detected && same(value, model.detected[f])) edited.delete(f)
    else edited.add(f)
  }
  if ('reasoning' in patch) {
    const r = typeof patch.reasoning === 'string' ? patch.reasoning.trim().toLowerCase() : ''
    if (r) next.reasoning = r
    else delete next.reasoning
  }
  if (next.reasoning && !(next.reasoningLevels ?? []).includes(next.reasoning)) delete next.reasoning
  if ('api' in patch) {
    if (patch.api === 'chat' || patch.api === 'responses') next.api = patch.api
    else delete next.api
  }
  if (edited.size) next.edited = META_FIELDS.filter((f) => edited.has(f))
  else delete next.edited
  return next
}

/** Add discovered models not already in the list (by id); returns the new list. */
export function addDiscovered(list: AiModel[], picked: DiscoveredModel[]): AiModel[] {
  const have = new Set(list.map((m) => m.id))
  const out = [...list]
  for (const d of picked) {
    if (have.has(d.id)) continue
    have.add(d.id)
    out.push(applyDetection(undefined, d))
  }
  return out
}

/** Re-detect: update models that discovery found again, leave the rest untouched. */
export function redetect(list: AiModel[], found: DiscoveredModel[], opts: { force?: boolean } = {}): AiModel[] {
  const byId = new Map(found.map((d) => [d.id, d]))
  return list.map((m) => {
    const d = byId.get(m.id)
    return d ? applyDetection(m, d, opts) : m
  })
}

// --- display ----------------------------------------------------------------------------------

/** 1_100_000 → "1.1M", 128_000 → "128K", 8192 → "8.2K", 512 → "512". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim1(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim1(n / 1_000)}K`
  return String(n)
}

function trim1(x: number): string {
  const s = x >= 100 ? Math.round(x).toString() : x.toFixed(1)
  return s.replace(/\.0$/, '')
}

/** "Context 1.1M · Output 128K · image, pdf" — empty when nothing is known. */
export function modelSubtitle(m: ModelMeta): string {
  const parts: string[] = []
  if (m.contextWindow) parts.push(`Context ${formatTokens(m.contextWindow)}`)
  if (m.maxOutputTokens) parts.push(`Output ${formatTokens(m.maxOutputTokens)}`)
  const extra = (m.input ?? []).filter((x) => x !== 'text')
  if (extra.length) parts.push(extra.join(', '))
  const api = (m as AiModel).api ?? m.endpoint
  if (api === 'responses') parts.push('Responses API')
  return parts.join(' · ')
}

export function supportsInput(m: ModelMeta | null | undefined, kind: Modality): boolean {
  return kind === 'text' ? true : Boolean(m?.input?.includes(kind))
}

// --- request limits ---------------------------------------------------------------------------

/** Tokens kept free for the chat template / estimation error. */
export const CONTEXT_MARGIN = 256

/** Rough token count (≈4 characters a token). */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Output tokens to request for a prompt of `promptTokens`: the model's max output, clamped so prompt
 * + output fits the context window. `undefined` = don't send a limit (nothing known).
 */
export function outputBudget(m: ModelMeta | null | undefined, promptTokens: number): number | undefined {
  if (!m) return undefined
  const room = m.contextWindow ? Math.max(256, m.contextWindow - promptTokens - CONTEXT_MARGIN) : undefined
  if (m.maxOutputTokens && room) return Math.min(m.maxOutputTokens, room)
  return m.maxOutputTokens ?? room
}

/**
 * Largest input (tokens) one request should carry for an action. Rewrite actions (tidy, typos,
 * checklist) answer with about as much as they get, so the input also has to fit the output limit;
 * summarise / custom reserve a smaller answer. `undefined` = unlimited (nothing known).
 */
export function inputBudget(m: ModelMeta | null | undefined, systemTokens: number, rewrite: boolean): number | undefined {
  if (!m || (!m.contextWindow && !m.maxOutputTokens)) return undefined
  const ctx = m.contextWindow
  if (rewrite) {
    // Output ≈ input × 1.1: input ≤ (ctx − system − margin) / 2.1, and ≤ maxOutput / 1.1.
    const byCtx = ctx ? Math.floor((ctx - systemTokens - CONTEXT_MARGIN) / 2.1) : Infinity
    const byOut = m.maxOutputTokens ? Math.floor(m.maxOutputTokens / 1.1) : Infinity
    const n = Math.min(byCtx, byOut)
    return Number.isFinite(n) ? Math.max(64, n) : undefined
  }
  if (!ctx) return undefined
  const reserve = Math.min(m.maxOutputTokens ?? 4096, Math.floor(ctx / 4))
  return Math.max(64, ctx - systemTokens - reserve - CONTEXT_MARGIN)
}

// --- per-run model selection across the Prompt API ---------------------------------------------

/**
 * The Prompt API has no "model" option, so the renderer tags the system prompt with the model a run
 * should use (per-action models). The handler strips the tag before anything reaches the provider.
 * Only Inkfish's own pages reach the handler (origin-gated), so this is an internal contract.
 */
export interface RunOptions {
  model?: string
  /**
   * `inline`: report a failed request as a sentinel chunk (see shared/ai-errors.ts) instead of
   * erroring the stream, because Electron reduces stream errors to a bare `kErrorUnknown`.
   */
  errors?: 'inline'
}

const RUN_TAG_RE = /^\[\[inkfish-run (\{[^\n]*\})\]\]\n?/

export function tagSystemPrompt(system: string, run: RunOptions): string {
  if (!run.model && !run.errors) return system
  const tag: RunOptions = {}
  if (run.model) tag.model = run.model
  if (run.errors) tag.errors = run.errors
  return `[[inkfish-run ${JSON.stringify(tag)}]]\n${system}`
}

export function untagSystemPrompt(system: string): { system: string; run: RunOptions } {
  const m = RUN_TAG_RE.exec(system)
  if (!m) return { system, run: {} }
  let run: RunOptions = {}
  try {
    const j = JSON.parse(m[1] ?? '{}') as { model?: unknown; errors?: unknown }
    if (typeof j.model === 'string' && j.model) run = { model: j.model.slice(0, 200) }
    if (j.errors === 'inline') run.errors = 'inline'
  } catch {
    // malformed tag: drop it, use the default model
  }
  return { system: system.slice(m[0].length), run }
}

/**
 * Images across the Prompt API. Electron 45 hands `{ type: 'image' }` parts to the utility process as
 * decoded pixels without dimensions, which can't be re-encoded for a provider. So the renderer sends a
 * note's images as tagged data: URLs inside the user turn, and the handler lifts them back out into
 * `ChatMessage.images` (then dropped by the provider unless the model has image input).
 */
const IMAGE_TAG_RE = /\n?\[\[inkfish-image (data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\]\]/gi

export function tagImages(text: string, dataUrls: string[]): string {
  return dataUrls.length ? `${text}${dataUrls.map((u) => `\n[[inkfish-image ${u}]]`).join('')}` : text
}

export function untagImages(text: string): { text: string; dataUrls: string[] } {
  const dataUrls: string[] = []
  const out = text.replace(IMAGE_TAG_RE, (_m, url: string) => {
    dataUrls.push(url)
    return ''
  })
  return { text: out, dataUrls }
}

// --- which API a request uses ----------------------------------------------------------------

/**
 * The endpoint for a model: its own API setting, else the provider default; `auto` resolves to the
 * detected/learned endpoint, else Chat Completions. `auto: true` allows the one-time fallback.
 */
export function resolveApi(m: AiModel | null | undefined, providerDefault: AiApi = 'auto'): { endpoint: AiEndpoint; auto: boolean } {
  const mode: AiApi = m?.api && m.api !== 'auto' ? m.api : providerDefault
  if (mode !== 'auto') return { endpoint: mode, auto: false }
  return { endpoint: m?.endpoint ?? 'chat', auto: true }
}

/** Record a learned endpoint on a model in the list (not marked as a user edit). */
export function learnEndpoint(list: AiModel[], id: string, endpoint: AiEndpoint): AiModel[] {
  let found = false
  const out = list.map((m) => {
    if (m.id !== id) return m
    found = true
    return { ...m, endpoint }
  })
  return found ? out : [...out, { id, endpoint }]
}
