import { describe, expect, test } from 'bun:test'
import { getLfmModelForRuntime, intelRuntime, isSupportedLfm3TextModelId, isSupportedLfmModelId } from './intel-runtime'

describe('managed ONNX runtime model selection', () => {
  test('accepts exact official LFM3 text and vision ONNX model IDs only for ONNX', () => {
    expect(getLfmModelForRuntime('onnx-managed', 'LiquidAI/LFM3-1.7B-ONNX')?.key).toBe('lfm3-1.7b')
    expect(getLfmModelForRuntime('onnx-managed', 'LiquidAI/LFM3-VL-2B-ONNX')?.key).toBe('lfm3-vl-2b')
    expect(getLfmModelForRuntime('llama.cpp-managed', 'LiquidAI/LFM3-1.7B-ONNX')).toBeUndefined()
    expect(getLfmModelForRuntime('llama.cpp', 'LiquidAI/LFM3-VL-2B-ONNX')).toBeUndefined()
    expect(isSupportedLfmModelId('onnx-managed', 'LiquidAI/LFM3-1.7B-ONNX')).toBe(true)
    expect(isSupportedLfmModelId('onnx-managed', 'LiquidAI/LFM3-VL-2B-ONNX')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B-ONNX')).toBe(true)
  })

  test('documents managed ONNX as an in-process CPU engine rather than an API server', () => {
    const runtime = intelRuntime('onnx-managed')
    expect(runtime.name).toBe('ONNX Runtime (managed)')
    expect(runtime.platform).toBe('macOS Apple silicon · ONNX Runtime CPU')
    expect(runtime.hint).toContain('in-process')
    expect(runtime.hint).not.toContain('OpenAI-compatible API')
  })
})
