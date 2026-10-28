import { describe, expect, test } from 'bun:test'
import {
  getLfmModelByApiModelId,
  getLfmModelByKey,
  isLfmModelKey,
  LFM_CATALOG,
  LFM_NON_INTEGRATED_CANDIDATES,
  LFM_RUNTIME_KEYS,
  LFM_SUPPORT_MATRIX
} from './lfm-catalog'

describe('LFM catalog', () => {
  test('uses stable keys distinct from the exact API model IDs', () => {
    expect(Object.keys(LFM_CATALOG)).toEqual(['lfm3-1.7b', 'lfm3-vl-2b'])
    expect(LFM_CATALOG['lfm3-1.7b'].apiModelId).toBe('LiquidAI/LFM3-1.7B-GGUF:Q4_K_M')
    expect(LFM_CATALOG['lfm3-vl-2b'].apiModelId).toBe('LiquidAI/LFM3-VL-2B-GGUF:Q4_K_M')
    expect(getLfmModelByKey('lfm3-1.7b')).toBe(LFM_CATALOG['lfm3-1.7b'])
    expect(getLfmModelByApiModelId('LiquidAI/LFM3-VL-2B-GGUF:Q4_K_M')).toBe(LFM_CATALOG['lfm3-vl-2b'])
    expect(getLfmModelByApiModelId('lfm3-vl-2b')).toBeUndefined()
    expect(isLfmModelKey('lfm3-vl-2b')).toBe(true)
    expect(isLfmModelKey('lfm3-3b')).toBe(false)
    expect(isLfmModelKey({})).toBe(false)
  })

  test('declares exact current per-runtime support', () => {
    expect(LFM_RUNTIME_KEYS).toEqual([
      'llama.cpp-managed',
      'llama.cpp',
      'ollama',
      'lm-studio',
      'vllm',
      'sglang',
      'custom'
    ])
    expect(LFM_CATALOG['lfm3-1.7b'].supportedRuntimes).toEqual([
      'llama.cpp-managed',
      'llama.cpp',
      'ollama',
      'lm-studio',
      'vllm',
      'sglang',
      'custom'
    ])
    expect(LFM_SUPPORT_MATRIX['lfm3-1.7b']).toEqual({
      'llama.cpp-managed': true,
      'llama.cpp': true,
      ollama: true,
      'lm-studio': true,
      vllm: true,
      sglang: true,
      custom: true
    })
    expect(LFM_CATALOG['lfm3-vl-2b'].supportedRuntimes).toEqual(['llama.cpp-managed', 'llama.cpp'])
    expect(LFM_SUPPORT_MATRIX['lfm3-vl-2b']).toEqual({
      'llama.cpp-managed': true,
      'llama.cpp': true,
      ollama: false,
      'lm-studio': false,
      vllm: false,
      sglang: false,
      custom: false
    })
  })

  test('records exact model and projector artifact sizes and hashes', () => {
    expect(LFM_CATALOG['lfm3-1.7b'].artifacts.model).toEqual({
      file: 'LFM3-1.7B-Q4_K_M.gguf',
      repo: 'LiquidAI/LFM3-1.7B-GGUF',
      bytes: 1099627808,
      sha256: '3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4'
    })
    expect(LFM_CATALOG['lfm3-vl-2b'].artifacts.model).toEqual({
      file: 'LFM3-VL-2B-Q4_K_M.gguf',
      repo: 'LiquidAI/LFM3-VL-2B-GGUF',
      bytes: 1099627808,
      sha256: '56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb'
    })
    expect(LFM_CATALOG['lfm3-vl-2b'].artifacts.projector).toEqual({
      file: 'mmproj-LFM3-VL-2B-Q8_0.gguf',
      repo: 'LiquidAI/LFM3-VL-2B-GGUF',
      bytes: 203031872,
      sha256: 'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab'
    })
  })

  test('keeps UZU blocked and non-integrated candidates non-runnable', () => {
    expect(LFM_NON_INTEGRATED_CANDIDATES.uzu).toEqual({
      status: 'blocked',
      reason: 'No verified LFM3 model or converter specification.'
    })
    expect(LFM_NON_INTEGRATED_CANDIDATES.mlx.status).toBe('not-enabled')
    expect(LFM_NON_INTEGRATED_CANDIDATES.onnx.status).toBe('not-enabled')
    expect(LFM_NON_INTEGRATED_CANDIDATES.sglangVl.status).toBe('not-enabled')
    expect(LFM_NON_INTEGRATED_CANDIDATES.vllmVl.status).toBe('not-enabled')
  })
})
