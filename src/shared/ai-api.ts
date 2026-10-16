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

export const AI_PROVIDER_KINDS = ['openai', 'anthropic'] as const
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

export interface AiProviderSettings {
  /** User switch. Even when on, nothing is served until the provider is connected (see `isConnected`). */
  enabled: boolean
  kind: AiProviderKind
  /** API root: `https://api.openai.com/v1`, `http://127.0.0.1:11434/v1`, `https://api.anthropic.com`. */
  baseUrl: string
  model: string
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
  model: DEFAULT_MODEL.openai
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

/** Invalid fields fall back to `fallback` (defaults, or current settings when saving a patch). */
export function parseAiSettings(value: unknown, fallback: AiProviderSettings = DEFAULT_AI_SETTINGS): AiProviderSettings {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const kind = AI_PROVIDER_KINDS.includes(raw.kind as AiProviderKind) ? (raw.kind as AiProviderKind) : fallback.kind
  const baseRaw = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : null
  const baseUrl = baseRaw === '' ? DEFAULT_BASE_URL[kind] : baseRaw && isHttpUrl(baseRaw) ? baseRaw : fallback.baseUrl
  const modelRaw = typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : null
  const model = modelRaw === '' ? DEFAULT_MODEL[kind] : (modelRaw ?? fallback.model)
  return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled, kind, baseUrl, model }
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
}

/** The text of a message; image and audio parts are dropped (text-only for now). */
export function messageText(message: PromptMessage): string {
  return message.content
    .filter((part) => part.type === 'text' && typeof part.value === 'string')
    .map((part) => part.value as string)
    .join('')
}

export function toChat(messages: PromptMessage[]): ChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: messageText(m) }))
}

/** Rough token count (≈4 characters a token) for contextUsage / measureContextUsage. */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)
}

/** Replace any occurrence of `secret` in `text` (error bodies can echo headers). */
export function scrubSecret(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 4) return text
  return text.split(secret).join('***')
}
