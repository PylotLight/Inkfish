/**
 * Readable AI request errors, shared main ↔ utility ↔ renderer.
 *
 * Why this exists: Electron 45's local AI handler (shell/utility/ai/utility_ai_language_model.cc)
 * turns ANY rejection from `LanguageModelUtility.prompt()` or its ReadableStream into
 * `ModelStreamingResponseStatus::kErrorUnknown` and drops the error object, so the renderer only
 * ever sees "An unknown error occurred: kErrorUnknown". No name, message or cause survives.
 *
 * So the handler doesn't error the stream for Inkfish's own sessions: it ends it with one sentinel
 * chunk carrying the scrubbed `AiErrorDetail` as JSON (`encodeErrorSentinel`), and the renderer
 * turns that back into a real error (`splitErrorSentinel`). Belt and braces: the handler also posts
 * the last error to main (`ai-api:last-error`) for the case where Electron itself fails the stream.
 */

export type AiApiKind = 'chat' | 'responses' | 'messages'

export interface AiErrorDetail {
  /** Short provider label: "OpenAI", "Anthropic", or the base URL's host. */
  provider: string
  /** HTTP status when the server answered with one. */
  status?: number
  /** Provider error code / type (`unsupported_api_for_model`, `invalid_request_error`…). */
  code?: string
  type?: string
  /** The provider's own message (scrubbed). */
  message: string
  /** `POST /chat/completions`, `POST /responses`, `POST /v1/messages`. */
  endpoint?: string
  model?: string
  /** http | stream (error event mid-stream) | network | timeout | incomplete | parse */
  kind: 'http' | 'stream' | 'network' | 'timeout' | 'incomplete' | 'parse'
  /** Short fix hint ("check the API key"). */
  hint?: string
  /** Earlier attempts in the same run (Auto API fallback). */
  attempts?: AiErrorDetail[]
}

const KEY_PATTERNS: RegExp[] = [
  /\b(sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{8,})/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:api[_-]?key|x-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi
]

/** Remove `secret` and anything that looks like an API key / bearer token. */
export function scrubText(text: string, secret?: string | null): string {
  let out = text
  if (secret && secret.length >= 4) out = out.split(secret).join('***')
  out = out.replace(KEY_PATTERNS[0]!, '***')
  out = out.replace(KEY_PATTERNS[1]!, '$1***')
  out = out.replace(KEY_PATTERNS[2]!, '$1***')
  return out
}

export function scrubDetail(d: AiErrorDetail, secret?: string | null): AiErrorDetail {
  const s = (v: string | undefined): string | undefined => (v === undefined ? v : scrubText(v, secret))
  const out: AiErrorDetail = {
    ...d,
    provider: scrubText(d.provider, secret),
    message: scrubText(d.message, secret).slice(0, 2000)
  }
  for (const k of ['code', 'type', 'endpoint', 'model', 'hint'] as const) if (d[k] !== undefined) out[k] = s(d[k])
  if (d.attempts?.length) out.attempts = d.attempts.map((a) => scrubDetail(a, secret))
  return out
}

/** "OpenAI 400: This model is only supported in v1/responses… (POST /chat/completions, gpt-x)" */
export function formatAiError(d: AiErrorDetail): string {
  const head = d.status ? `${d.provider} ${d.status}` : d.kind === 'network' ? `${d.provider} unreachable` : d.provider
  const where = [d.endpoint, d.model].filter(Boolean).join(', ')
  const msg = d.message.length > 400 ? `${d.message.slice(0, 400)}…` : d.message
  let out = `${head}: ${msg || '(no message)'}${where ? ` (${where})` : ''}`
  if (d.hint) out += ` — ${d.hint}`
  if (d.attempts?.length)
    out += ` [after: ${d.attempts.map((a) => `${a.endpoint ?? '?'} ${a.status ?? a.kind}`).join('; ')}]`
  return out
}

/** Error thrown by providers; carries the structured detail. */
export class AiRequestError extends Error {
  readonly detail: AiErrorDetail
  constructor(detail: AiErrorDetail) {
    super(formatAiError(detail))
    this.name = 'AiRequestError'
    this.detail = detail
  }
}

export function isAiRequestError(e: unknown): e is AiRequestError {
  return e instanceof Error && 'detail' in e && typeof (e as { detail?: unknown }).detail === 'object'
}

/** Any thrown value → detail (non-provider errors become a `parse`/`network` detail). */
export function toErrorDetail(e: unknown, fallback: Partial<AiErrorDetail> = {}): AiErrorDetail {
  if (isAiRequestError(e)) return e.detail
  const err = e instanceof Error ? e : new Error(String(e))
  const timeout = err.name === 'TimeoutError' || /timed? ?out/i.test(err.message)
  const cause = (err as { cause?: { code?: string; message?: string } }).cause
  const network =
    !timeout && (err.name === 'TypeError' || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(err.message))
  const message =
    cause?.message && cause.message !== err.message ? `${err.message} (${cause.code ?? cause.message})` : err.message
  const kind = timeout ? 'timeout' : network ? 'network' : (fallback.kind ?? 'parse')
  return { provider: 'AI provider', ...fallback, kind, message: timeout ? 'Timed out' : message }
}

// --- the sentinel chunk across the Prompt API ---------------------------------------------------

/** U+2063 (invisible separator) + tag: never typed, survives Electron's UTF-8 chunk path. */
export const ERROR_SENTINEL = '\u2063[[inkfish-error '
const SENTINEL_RE = /^\u2063\[\[inkfish-error (\{[\s\S]*\})\]\]\s*$/

export function encodeErrorSentinel(d: AiErrorDetail): string {
  return `${ERROR_SENTINEL}${JSON.stringify(d)}]]`
}

/** Split a reply into its text and the error the handler reported (if any). */
export function splitErrorSentinel(out: string): { text: string; error: AiErrorDetail | null } {
  const idx = out.indexOf(ERROR_SENTINEL)
  if (idx < 0) return { text: out, error: null }
  const m = SENTINEL_RE.exec(out.slice(idx))
  let error: AiErrorDetail | null = null
  if (m) {
    try {
      const j = JSON.parse(m[1] ?? '{}') as AiErrorDetail
      if (j && typeof j.message === 'string')
        error = { ...j, provider: String(j.provider ?? 'AI provider'), kind: j.kind ?? 'parse' }
    } catch {
      // malformed: report a generic error below
    }
  }
  return {
    text: out.slice(0, idx),
    error: error ?? { provider: 'AI provider', kind: 'parse', message: 'The AI handler reported an error.' }
  }
}

/** Text safe to show while streaming: everything before a (possibly partial) sentinel. */
export function visibleText(out: string): string {
  const idx = out.indexOf(ERROR_SENTINEL)
  if (idx >= 0) return out.slice(0, idx)
  // A sentinel split across chunks: hide a trailing prefix of it.
  for (let n = Math.min(ERROR_SENTINEL.length - 1, out.length); n > 0; n--) {
    if (ERROR_SENTINEL.startsWith(out.slice(out.length - n))) return out.slice(0, out.length - n)
  }
  return out
}

/** Electron's flattened Prompt API error (any failure inside the handler). */
export function isElectronUnknownError(e: unknown): boolean {
  return e instanceof Error && (/kErrorUnknown|unknown error occurred/i.test(e.message) || e.name === 'UnknownError')
}

/** What "Copy details" puts on the clipboard. */
export function errorDetailsText(
  d: AiErrorDetail | null,
  message: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({ message, ...(d ? { detail: d } : {}), ...extra, at: new Date().toISOString() }, null, 2)
}
