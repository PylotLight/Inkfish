import {
  getLfmModelByApiModelId,
  getLfmModelIdForRuntime,
  LFM_CATALOG,
  LFM_MLX_MODEL_IDS,
  LFM_SUPPORT_MATRIX,
  type LfmModel,
  type LfmModelKey
} from './lfm-catalog'

/**
 * Local inference runtimes currently available in Inkfish. MLX-VLM is explicitly
 * experimental; managed entries bundle their own in-process/child runtime.
 */
export const INTEL_RUNTIMES = [
  {
    id: 'llama.cpp-managed',
    name: 'llama.cpp (managed)',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    modelExample: LFM_CATALOG['lfm3-1.7b'].apiModelId,
    formats: 'LFM3-1.7B text and LFM3-VL-2B vision · GGUF Q4_K_M',
    platform: 'Managed binary: macOS Apple silicon',
    hint: 'Inkfish manages the pinned llama.cpp server and downloads weights only after you accept the model license. The server runs on loopback and stops after 10 minutes idle.'
  },
  {
    id: 'onnx-managed',
    name: 'ONNX Runtime (managed)',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    modelExample: getLfmModelIdForRuntime('lfm3-1.7b', 'onnx-managed')!,
    formats: 'LFM3-1.7B Q4 text; LFM3-VL-2B Q4 decoder + Q8 vision encoder',
    platform: 'macOS Apple silicon · ONNX Runtime CPU',
    hint: 'Inkfish manages official ONNX artifacts and runs tokenizer, vision encoder and generation in-process on this Mac. Downloads are license-gated; the model unloads after 10 minutes idle.'
  },
  {
    id: 'mlx-vlm',
    name: 'MLX-VLM (experimental)',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    modelExample: getLfmModelIdForRuntime('lfm3-1.7b', 'mlx-vlm')!,
    formats: 'LFM3-1.7B text and LFM3-VL-2B image · native MLX',
    platform: 'macOS Apple silicon (arm64) · external Python runtime',
    hint: 'Experimental, not bundled or validated with native Apple-silicon inference. Install the exact upstream MLX-VLM commit pinned in docs/lfm3.md, run its server on loopback, and select the exact LiquidAI model ID. The external server downloads and caches model weights; select LFM3-VL-2B for images.'
  },
  {
    id: 'llama.cpp',
    name: 'llama.cpp',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    modelExample: LFM_CATALOG['lfm3-1.7b'].apiModelId,
    formats: 'LFM3-1.7B text and LFM3-VL-2B vision · GGUF',
    platform: 'macOS, Windows and Linux',
    hint: 'Use an LFM3-compatible llama-server build with the exact model ID advertised by its local /models endpoint. VL requires a matching mmproj projector.'
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
    modelExample: LFM_CATALOG['lfm3-1.7b'].apiModelId,
    formats: 'Server-dependent LFM3-1.7B text model',
    platform: 'Any supported by the server',
    hint: 'Use a loopback server that advertises a verified LFM3-1.7B text model and implements OpenAI Chat Completions.'
  }
] as const

export type IntelRuntimeId = (typeof INTEL_RUNTIMES)[number]['id']

const TEXT_KEY: LfmModelKey = 'lfm3-1.7b'
const VISION_KEY: LfmModelKey = 'lfm3-vl-2b'
const TEXT_MODEL = LFM_CATALOG[TEXT_KEY]
const VISION_MODEL = LFM_CATALOG[VISION_KEY]
const TEXT_ONNX_ID = TEXT_MODEL.onnx!.modelId.toLowerCase()
const VISION_ONNX_ID = VISION_MODEL.onnx!.modelId.toLowerCase()
const TEXT_MLX_ID = LFM_MLX_MODEL_IDS[TEXT_KEY].toLowerCase()
const VISION_MLX_ID = LFM_MLX_MODEL_IDS[VISION_KEY].toLowerCase()
const TEXT_ALIASES = new Set([
  TEXT_MODEL.apiModelId.toLowerCase(),
  TEXT_ONNX_ID,
  TEXT_MLX_ID,
  'liquidai/lfm3-1.7b-gguf',
  'liquidai/lfm3-1.7b',
  'lfm3-1.7b',
  'lfm3',
  'lfm3:latest',
  'lfm3:1.7b',
  'lfm3-1.7b-q4_k_m.gguf',
  'lfm3-1.7b-q4_0.gguf'
])
const VISION_ALIASES = new Set([
  VISION_MODEL.apiModelId.toLowerCase(),
  VISION_ONNX_ID,
  VISION_MLX_ID,
  'liquidai/lfm3-vl-2b-gguf',
  'liquidai/lfm3-vl-2b',
  'lfm3-vl-2b-q4_k_m.gguf'
])

function knownModelKey(value: string, runtime?: IntelRuntimeId): LfmModelKey | undefined {
  const id = value.trim().toLowerCase()
  if (runtime === 'mlx-vlm') {
    if (id === TEXT_MLX_ID) return TEXT_KEY
    if (id === VISION_MLX_ID) return VISION_KEY
    return undefined
  }
  const exact = getLfmModelByApiModelId(value.trim())
  if (exact) return exact.key
  if (TEXT_ALIASES.has(id)) {
    const ollamaAlias = /^lfm3(?::(?:latest|1\.7b))?$/.test(id)
    const localGgufFile = /^lfm3-1\.7b-(?:q4_k_m|q4_0)\.gguf$/.test(id)
    if (runtime && id === TEXT_ONNX_ID && runtime !== 'onnx-managed') return undefined
    if (runtime && ollamaAlias && !['ollama', 'custom'].includes(runtime)) return undefined
    if (runtime && localGgufFile && !['llama.cpp', 'custom'].includes(runtime)) return undefined
    if (runtime && id === 'liquidai/lfm3-1.7b' && !['vllm', 'sglang', 'custom'].includes(runtime)) return undefined
    if (runtime && id === 'liquidai/lfm3-1.7b-gguf' && !['llama.cpp', 'lm-studio', 'custom'].includes(runtime))
      return undefined
    return TEXT_KEY
  }
  if (VISION_ALIASES.has(id)) {
    if (runtime && id === VISION_ONNX_ID && runtime !== 'onnx-managed') return undefined
    if (runtime && !['llama.cpp', 'llama.cpp-managed', 'onnx-managed'].includes(runtime)) return undefined
    return VISION_KEY
  }
  const leaf = id.split(/[\\/]/).pop() ?? id
  if (
    runtime &&
    ['llama.cpp', 'custom'].includes(runtime) &&
    /^lfm3-1\.7b-(?:q4_k_m|q4_0|q5_k_m|q6_k|q8_0|f16|bf16)\.gguf$/i.test(leaf)
  )
    return TEXT_KEY
  return undefined
}

export function getLfmModelForRuntime(runtime: IntelRuntimeId, modelId: string): LfmModel | undefined {
  const key = knownModelKey(modelId, runtime)
  if (!key || !LFM_SUPPORT_MATRIX[key][runtime]) return undefined
  return LFM_CATALOG[key]
}

/** Accept only known LFM3-1.7B text checkpoints and documented endpoint aliases. */
export function isSupportedLfm3TextModelId(value: string): boolean {
  const key = knownModelKey(value)
  return key === TEXT_KEY
}

/** Accept model IDs only when the selected engine declares support for that model modality. */
export function isSupportedLfmModelId(runtime: IntelRuntimeId, value: string): boolean {
  return getLfmModelForRuntime(runtime, value) !== undefined
}

export function isVisionLfmModelId(value: string): boolean {
  return knownModelKey(value) === VISION_KEY
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
