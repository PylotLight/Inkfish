/**
 * AI provider (Settings › AI) contracts, shared main ↔ utility ↔ renderer. Safe to import anywhere.
 *
 * The renderer talks to the standard Prompt API (`LanguageModel`). Electron 45 hands those calls to
 * Inkfish's local AI handler (a utility process, src/main/ai-handler.ts) registered on the app
 * session with `ses.registerLocalAIHandler()`; that handler forwards each prompt to the provider
 * configured here. Off until a provider is connected: no handler, nothing forked.
 *
 * `kind` is the provider seam. 'openai' (any OpenAI-compatible `/chat/completions` server) and
 * 'anthropic' are implemented in src/main/ai-providers.ts; a future on-device kind
 * (embedded llama.cpp / MLX model) slots in as one more `AiProviderKind` + factory branch there.
 */

import { AI_ACTIONS, type AiAction } from './ai-process'
import { parseModels, untagImages, type AiModel } from './ai-models'

export const AI_PROVIDER_KINDS = ['openai', 'anthropic'] as const
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

export interface AiProviderSettings {
  /** User switch. Even when on, nothing is served until the provider is connected (see `isConnected`). */
  enabled: boolean
  kind: AiProviderKind
  /** API root: `https://api.openai.com/v1`, `http://127.0.0.1:11434/v1`, `https://api.anthropic.com`. */
  baseUrl: string
  /** Active (default) model id. Always one of `models` (parse adds it if missing). */
  model: string
  /** Models the user keeps for this provider (Settings › AI › Models). */
  models: AiModel[]
  /** Optional per-action model ids; unset = the active model. */
  actionModels: Partial<Record<AiAction, string>>
  /** Send a note's images to vision models in Process actions. Off by default. */
  includeImages: boolean
}

export const DEFAULT_BASE_URL: Record<AiProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com'
}

export const DEFAULT_MODEL: Record<AiProviderKind, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5'
}

export const DEFAULT_AI_SETTINGS: AiProviderSettings = {
  enabled: false,
  kind: 'openai',
  baseUrl: DEFAULT_BASE_URL.openai,
  model: DEFAULT_MODEL.openai,
  models: [{ id: DEFAULT_MODEL.openai }],
  actionModels: {},
  includeImages: false
}

/** What the renderer sees: settings plus key presence. The key itself never leaves main. */
export interface AiApiStatus {
  settings: AiProviderSettings
  hasKey: boolean
  /** True when prompts are actually being served (enabled + key, or a keyless loopback server). */
  connected: boolean
  /** OS keychain encryption (safeStorage) is available, so a key can be saved. */
  keychain: boolean
}

export interface AiTestResult {
  ok: boolean
  ms: number
  /** First characters of the reply, or the error message. Never contains the key. */
  detail: string
}

/** http(s) on 127.0.0.1 / localhost / ::1 — a local server (Ollama, LM Studio) that may need no key. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Invalid fields fall back to `fallback` (defaults, or current settings when saving a patch).
 *
 * Migration: settings saved before the Models list had only `model`; it becomes the list's first
 * entry. The active model is always in the list, and per-action ids that left the list are dropped.
 */
export function parseAiSettings(value: unknown, fallback: AiProviderSettings = DEFAULT_AI_SETTINGS): AiProviderSettings {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const kind = AI_PROVIDER_KINDS.includes(raw.kind as AiProviderKind) ? (raw.kind as AiProviderKind) : fallback.kind
  const baseRaw = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : null
  const baseUrl = baseRaw === '' ? DEFAULT_BASE_URL[kind] : baseRaw && isHttpUrl(baseRaw) ? baseRaw : fallback.baseUrl
  // No list: a patch keeps the current list; a stored file from before the Models list (parsed
  // against the defaults) starts from its single `model` alone.
  const models = Array.isArray(raw.models)
    ? parseModels(raw.models)
    : fallback === DEFAULT_AI_SETTINGS
      ? []
      : fallback.models.map((m) => ({ ...m }))
  const modelRaw = typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : null
  // Empty = the provider's default model (as before the Models list).
  const model = modelRaw === '' ? DEFAULT_MODEL[kind] : modelRaw || fallback.model || models[0]?.id || DEFAULT_MODEL[kind]
  if (!models.some((m) => m.id === model)) models.unshift({ id: model })
  const ids = new Set(models.map((m) => m.id))
  const actionRaw =
    typeof raw.actionModels === 'object' && raw.actionModels !== null
      ? (raw.actionModels as Record<string, unknown>)
      : (fallback.actionModels as Record<string, unknown>)
  const actionModels: Partial<Record<AiAction, string>> = {}
  for (const a of AI_ACTIONS) {
    const id = actionRaw[a]
    if (typeof id === 'string' && ids.has(id)) actionModels[a] = id
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    kind,
    baseUrl,
    model,
    models,
    actionModels,
    includeImages: typeof raw.includeImages === 'boolean' ? raw.includeImages : fallback.includeImages
  }
}

/** The model config a run uses: the action's own model if set, else the active one. */
export function resolveModel(settings: AiProviderSettings, action?: AiAction): AiModel {
  const id = (action && settings.actionModels[action]) || settings.model
  return settings.models.find((m) => m.id === id) ?? { id }
}

/** Whether prompts should be served: switched on, and a key saved (or a keyless loopback server). */
export function isConnected(settings: AiProviderSettings, hasKey: boolean): boolean {
  return settings.enabled && (hasKey || isLoopbackUrl(settings.baseUrl))
}

/**
 * Origins allowed a Prompt API session: Inkfish's own renderer only — the packaged `file://` page
 * and the electron-vite dev server on loopback. `data:` pages (opaque "null" origin) are refused.
 */
export function isAppOrigin(origin: string): boolean {
  if (/^file:/.test(origin)) return true
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(origin)
}

/** One Prompt API message as Electron hands it to the utility process (`LanguageModelMessage`). */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: Array<{ type: 'text' | 'image' | 'audio'; value: unknown }>
  prefix?: boolean
}

/** Plain chat turn the providers send. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Image parts (vision models only; providers drop them when the model has no image input). */
  images?: ChatImage[]
}

export interface ChatImage {
  mime: string
  /** base64, no data: prefix. */
  data: string
}

/** Sniff an image's MIME type from its first bytes (the Prompt API hands images over as bytes). */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  return null
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** An image part's value (bytes, or a data: URL) → `ChatImage`; unknown formats are dropped. */
export function imagePart(value: unknown): ChatImage | null {
  if (typeof value === 'string') {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value)
    return m ? { mime: (m[1] ?? '').toLowerCase(), data: m[2] ?? '' } : null
  }
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null
  if (!bytes || bytes.length < 12) return null
  const mime = sniffImageMime(bytes)
  return mime ? { mime, data: toBase64(bytes) } : null
}

/** The text of a message (image parts are carried separately by `toChat`; audio is dropped). */
export function messageText(message: PromptMessage): string {
  return message.content
    .filter((part) => part.type === 'text' && typeof part.value === 'string')
    .map((part) => part.value as string)
    .join('')
}

/**
 * Prompt API messages → provider chat turns. Images come from `[[inkfish-image data:…]]` tags in a
 * user turn (see `untagImages`), or from image parts that arrive as encoded bytes; raw pixel buffers
 * (what Electron 45 passes for Blob/canvas images) can't be encoded and are dropped.
 */
export function toChat(messages: PromptMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const parts = m.content
      .filter((p) => p.type === 'image')
      .map((p) => imagePart(p.value))
      .filter((x): x is ChatImage => !!x)
    let content = messageText(m)
    if (m.role === 'user') {
      const u = untagImages(content)
      content = u.text
      for (const url of u.dataUrls) {
        const img = imagePart(url)
        if (img) parts.push(img)
      }
    }
    return parts.length ? { role: m.role, content, images: parts } : { role: m.role, content }
  })
}

/** Rough token count (≈4 characters a token) for contextUsage / measureContextUsage. */
export function estimateTokens(messages: ChatMessage[]): number {
  // ~4 characters a token; an image counts as ~1000 tokens (rough, provider-dependent).
  return Math.ceil(messages.reduce((n, m) => n + m.content.length + (m.images?.length ?? 0) * 4000, 0) / 4)
}

/** Replace any occurrence of `secret` in `text` (error bodies can echo headers). */
export function scrubSecret(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 4) return text
  return text.split(secret).join('***')
}
