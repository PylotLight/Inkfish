export const LFM_MODEL_KEYS = ['lfm3-1.7b', 'lfm3-vl-2b'] as const
export type LfmModelKey = (typeof LFM_MODEL_KEYS)[number]

export const LFM_RUNTIME_KEYS = [
  'llama.cpp-managed',
  'llama.cpp',
  'ollama',
  'lm-studio',
  'vllm',
  'sglang',
  'custom'
] as const
export type LfmRuntimeKey = (typeof LFM_RUNTIME_KEYS)[number]

export interface LfmArtifact {
  file: string
  repo: string
  bytes: number
  sha256: string
}

export interface LfmModel {
  key: LfmModelKey
  apiModelId: string
  name: string
  modalities: readonly ('text' | 'image')[]
  features: readonly ('chat' | 'vision')[]
  artifacts: {
    model: LfmArtifact
    projector?: LfmArtifact
  }
  supportedRuntimes: readonly LfmRuntimeKey[]
}

export const LFM_CATALOG: Readonly<Record<LfmModelKey, LfmModel>> = {
  'lfm3-1.7b': {
    key: 'lfm3-1.7b',
    apiModelId: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M',
    name: 'LFM3 1.7B',
    modalities: ['text'],
    features: ['chat'],
    artifacts: {
      model: {
        file: 'LFM3-1.7B-Q4_K_M.gguf',
        repo: 'LiquidAI/LFM3-1.7B-GGUF',
        bytes: 1099627808,
        sha256: '3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4'
      }
    },
    supportedRuntimes: ['llama.cpp-managed', 'llama.cpp', 'ollama', 'lm-studio', 'vllm', 'sglang', 'custom']
  },
  'lfm3-vl-2b': {
    key: 'lfm3-vl-2b',
    apiModelId: 'LiquidAI/LFM3-VL-2B-GGUF:Q4_K_M',
    name: 'LFM3 VL 2B',
    modalities: ['text', 'image'],
    features: ['chat', 'vision'],
    artifacts: {
      model: {
        file: 'LFM3-VL-2B-Q4_K_M.gguf',
        repo: 'LiquidAI/LFM3-VL-2B-GGUF',
        bytes: 1099627808,
        sha256: '56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb'
      },
      projector: {
        file: 'mmproj-LFM3-VL-2B-Q8_0.gguf',
        repo: 'LiquidAI/LFM3-VL-2B-GGUF',
        bytes: 203031872,
        sha256: 'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab'
      }
    },
    supportedRuntimes: ['llama.cpp-managed', 'llama.cpp']
  }
}

export const LFM_SUPPORT_MATRIX: Readonly<Record<LfmModelKey, Readonly<Record<LfmRuntimeKey, boolean>>>> = {
  'lfm3-1.7b': {
    'llama.cpp-managed': true,
    'llama.cpp': true,
    ollama: true,
    'lm-studio': true,
    vllm: true,
    sglang: true,
    custom: true
  },
  'lfm3-vl-2b': {
    'llama.cpp-managed': true,
    'llama.cpp': true,
    ollama: false,
    'lm-studio': false,
    vllm: false,
    sglang: false,
    custom: false
  }
}

export interface LfmCandidate {
  status: 'not-enabled' | 'blocked'
  reason: string
}

// Candidates are deliberately metadata only and are not runnable in-app.
export const LFM_NON_INTEGRATED_CANDIDATES = {
  mlx: { status: 'not-enabled', reason: 'Not enabled in-app.' },
  onnx: { status: 'not-enabled', reason: 'Not enabled in-app.' },
  sglangVl: { status: 'not-enabled', reason: 'VL support is not enabled in-app.' },
  vllmVl: { status: 'not-enabled', reason: 'VL support is not enabled in-app.' },
  uzu: { status: 'blocked', reason: 'No verified LFM3 model or converter specification.' }
} as const satisfies Readonly<Record<string, LfmCandidate>>

export function getLfmModelByKey(key: LfmModelKey): LfmModel | undefined {
  return LFM_CATALOG[key]
}

export function getLfmModelByApiModelId(apiModelId: string): LfmModel | undefined {
  return Object.values(LFM_CATALOG).find((model) => model.apiModelId === apiModelId)
}

export function isLfmModelKey(value: unknown): value is LfmModelKey {
  return typeof value === 'string' && (LFM_MODEL_KEYS as readonly string[]).includes(value)
}
