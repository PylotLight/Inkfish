export const LFM_MODEL_KEYS = ['lfm3-1.7b', 'lfm3-vl-2b'] as const
export type LfmModelKey = (typeof LFM_MODEL_KEYS)[number]

export const LFM_RUNTIME_KEYS = [
  'llama.cpp-managed',
  'onnx-managed',
  'mlx-vlm',
  'llama.cpp',
  'ollama',
  'lm-studio',
  'vllm',
  'sglang',
  'custom'
] as const
export type LfmRuntimeKey = (typeof LFM_RUNTIME_KEYS)[number]

/** Exact Liquid AI model IDs loaded through the experimental MLX-VLM adapter. */
export const LFM_MLX_MODEL_IDS = {
  'lfm3-1.7b': 'LiquidAI/LFM3-1.7B',
  'lfm3-vl-2b': 'LiquidAI/LFM3-VL-2B'
} as const satisfies Readonly<Record<LfmModelKey, string>>

export interface LfmArtifact {
  file: string
  repo: string
  bytes: number
  sha256: string
}

export interface LfmOnnxPackage {
  modelId: string
  artifacts: readonly LfmArtifact[]
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
  /** Official Liquid AI ONNX Q4 decoder package (VL uses its paired Q8 vision encoder). */
  onnx?: LfmOnnxPackage
  supportedRuntimes: readonly LfmRuntimeKey[]
}

const textOnnxArtifacts: readonly LfmArtifact[] = [
  {
    file: 'onnx/model_q4.onnx',
    repo: 'LiquidAI/LFM3-1.7B-ONNX',
    bytes: 352630,
    sha256: '20cacb31ad9c25a28ecb0b0a88937f0033b4d0171ba137596a2305b1e66bf00f'
  },
  {
    file: 'onnx/model_q4.onnx_data',
    repo: 'LiquidAI/LFM3-1.7B-ONNX',
    bytes: 1625944064,
    sha256: 'aad5286be89c40c53106bc1ca29d20a2dda57e1806df5244c09da852f77b43e8'
  },
  {
    file: 'tokenizer.json',
    repo: 'LiquidAI/LFM3-1.7B-ONNX',
    bytes: 17908634,
    sha256: '41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44'
  },
  {
    file: 'config.json',
    repo: 'LiquidAI/LFM3-1.7B-ONNX',
    bytes: 1657,
    sha256: '09b5a4ee2057e03f7773f19181415d7e701030e14e66c594afd1c8d0a476d176'
  },
  {
    file: 'tokenizer_config.json',
    repo: 'LiquidAI/LFM3-1.7B-ONNX',
    bytes: 14574,
    sha256: 'e51ed3e47fe9150f6635ab00b9cb41658faf9cbd0dccbcddb55e7eb391bcf7a1'
  },
  {
    file: 'chat_template.jinja',
    repo: 'LiquidAI/LFM3-1.7B-ONNX',
    bytes: 12129,
    sha256: 'f45005c50cd2a97329722bf3a2dee9f16c04cdf825a589b280fb7e99e6827818'
  },
  {
    file: 'generation_config.json',
    repo: 'LiquidAI/LFM3-1.7B-ONNX',
    bytes: 146,
    sha256: 'e5e1e91829a9ae65809b578bff350dca876febbda88a9e36f415b002f6b3ddf0'
  }
]

const vlOnnxArtifacts: readonly LfmArtifact[] = [
  {
    file: 'onnx/decoder_q4.onnx',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 357620,
    sha256: 'dbb7b5c7a9e6b9076f80d356d72f0ba10aa238118886fb248630391f862d6719'
  },
  {
    file: 'onnx/decoder_q4.onnx_data',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 1488580608,
    sha256: '8f729007b1bff9368d5801ae165ebcc32801e537e98e53af94ad1d75a31dcd65'
  },
  {
    file: 'onnx/vision_encoder_q8.onnx',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 126353,
    sha256: 'ea9421f2a7fa8bc401bee96b1077be522b8d448e82e46c9117f2bc90eb01caac'
  },
  {
    file: 'onnx/vision_encoder_q8.onnx_data',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 196153344,
    sha256: '0339112e074698c5e895b53114467fbfe17f0f0ee6577c316b02ccbcd44694f4'
  },
  {
    file: 'tokenizer.json',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 17908258,
    sha256: 'a39eed58008cbcbc09e5b629b81338a654269c64cd13348aaa6090f4db75c7e7'
  },
  {
    file: 'config.json',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 2905,
    sha256: '18a02e8b5963e38c98683e2c948705ea45220d75f017e9b4bdd9cf54692e6dc3'
  },
  {
    file: 'tokenizer_config.json',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 1759,
    sha256: '0117c195c81c937dbef42e384fa2850aebd066d14b7ea8345cabfbb5c05e584c'
  },
  {
    file: 'chat_template.jinja',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 12129,
    sha256: 'f45005c50cd2a97329722bf3a2dee9f16c04cdf825a589b280fb7e99e6827818'
  },
  {
    file: 'generation_config.json',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 323,
    sha256: '30b1115bcdc4e5671567a5b1255a2f3d2f5a912a79292051c6f1e9db81b5e8c4'
  },
  {
    file: 'processor_config.json',
    repo: 'LiquidAI/LFM3-VL-2B-ONNX',
    bytes: 1535,
    sha256: 'd3d5c3f9dc3d3f25c3177ba8bb05938b53c51799244af1ca6406cde78924b84e'
  }
]

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
    onnx: { modelId: 'LiquidAI/LFM3-1.7B-ONNX', artifacts: textOnnxArtifacts },
    supportedRuntimes: [
      'llama.cpp-managed',
      'onnx-managed',
      'mlx-vlm',
      'llama.cpp',
      'ollama',
      'lm-studio',
      'vllm',
      'sglang',
      'custom'
    ]
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
    onnx: { modelId: 'LiquidAI/LFM3-VL-2B-ONNX', artifacts: vlOnnxArtifacts },
    supportedRuntimes: ['llama.cpp-managed', 'onnx-managed', 'mlx-vlm', 'llama.cpp']
  }
}

export const LFM_SUPPORT_MATRIX: Readonly<Record<LfmModelKey, Readonly<Record<LfmRuntimeKey, boolean>>>> = {
  'lfm3-1.7b': {
    'llama.cpp-managed': true,
    'onnx-managed': true,
    'mlx-vlm': true,
    'llama.cpp': true,
    ollama: true,
    'lm-studio': true,
    vllm: true,
    sglang: true,
    custom: true
  },
  'lfm3-vl-2b': {
    'llama.cpp-managed': true,
    'onnx-managed': true,
    'mlx-vlm': true,
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

export function getLfmModelIdForRuntime(modelKey: LfmModelKey, runtime: LfmRuntimeKey): string | undefined {
  const model = LFM_CATALOG[modelKey]
  if (!model || !model.supportedRuntimes.includes(runtime)) return undefined
  if (runtime === 'onnx-managed') return model.onnx?.modelId
  if (runtime === 'mlx-vlm') return LFM_MLX_MODEL_IDS[modelKey]
  return model.apiModelId
}

export function isLfmModelKey(value: unknown): value is LfmModelKey {
  return typeof value === 'string' && (LFM_MODEL_KEYS as readonly string[]).includes(value)
}
