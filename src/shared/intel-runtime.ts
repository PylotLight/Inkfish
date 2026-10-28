/**
 * Local inference endpoints verified for the LFM3-1.7B text model.
 * These are endpoint presets only: Inkfish does not bundle the engine binaries or model weights.
 */
export const INTEL_RUNTIMES = [
  {
    id: 'llama.cpp',
    name: 'llama.cpp',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    modelExample: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M',
    formats: 'LFM3-1.7B GGUF',
    platform: 'macOS, Windows and Linux',
    hint: 'Use an LFM3-compatible llama-server build with the LFM3-1.7B GGUF checkpoint.'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    modelExample: 'lfm3',
    formats: 'LFM3-1.7B GGUF model package',
    platform: 'macOS, Windows and Linux',
    hint: 'The official Ollama library provides the LFM3-1.7B `lfm3` model and a local OpenAI-compatible API.'
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    modelExample: 'LiquidAI/LFM3-1.7B-GGUF',
    formats: 'LFM3-1.7B GGUF',
    platform: 'macOS, Windows and Linux',
    hint: 'The official LFM3-1.7B card lists LM Studio for the GGUF checkpoint; start its local server.'
  },
  {
    id: 'vllm',
    name: 'vLLM',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    modelExample: 'LiquidAI/LFM3-1.7B',
    formats: 'LFM3-1.7B BF16',
    platform: 'Local GPU server',
    hint: 'The official LFM3-1.7B card documents vLLM serving with OpenAI-compatible Chat Completions.'
  },
  {
    id: 'sglang',
    name: 'SGLang',
    defaultBaseUrl: 'http://127.0.0.1:30000/v1',
    modelExample: 'LiquidAI/LFM3-1.7B',
    formats: 'LFM3-1.7B BF16, FP8 or NVFP4 (card-dependent)',
    platform: 'Local GPU server',
    hint: 'The official LFM3-1.7B card documents SGLang serving with OpenAI-compatible Chat Completions.'
  },
  {
    id: 'custom',
    name: 'Custom local server',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    modelExample: 'LiquidAI/LFM3-1.7B',
    formats: 'Server-dependent LFM3-1.7B text model',
    platform: 'Any supported by the server',
    hint: 'Use a loopback server that advertises an LFM3-1.7B text model and implements OpenAI Chat Completions.'
  }
] as const

export type IntelRuntimeId = (typeof INTEL_RUNTIMES)[number]['id']

/** Accept only identifiers for the text-only LFM3-1.7B checkpoint (including its official Ollama alias). */
export function isSupportedLfm3TextModelId(value: string): boolean {
  const id = value.trim()
  if (/^lfm3(?::(?:latest|1\.7b))?$/i.test(id)) return true
  return id
    .split(/[\\/]/)
    .some((segment) =>
      /^lfm3-1\.7b(?:-(?:gguf|base|instruct|fp8|nvfp4|mlx(?:-4bit)?|onnx)(?:-[a-z0-9._-]+)?)?(?::[a-z0-9._-]+)?(?:\.gguf)?$/i.test(
        segment
      )
    )
}

export function isIntelRuntimeId(value: unknown): value is IntelRuntimeId {
  return INTEL_RUNTIMES.some((runtime) => runtime.id === value)
}

export function intelRuntime(id: IntelRuntimeId): (typeof INTEL_RUNTIMES)[number] {
  return INTEL_RUNTIMES.find((runtime) => runtime.id === id)!
}

/** Only loopback HTTP(S) URLs are accepted, so the embedded-model path cannot silently become cloud AI. */
export function isLoopbackIntelUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password || url.search || url.hash) return false
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function normalizeIntelBaseUrl(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return isLoopbackIntelUrl(trimmed) ? trimmed : fallback
}
