import { describe, expect, test } from 'bun:test'
import {
  getLfmModelForRuntime,
  intelRuntime,
  isIntelRuntimeId,
  isSupportedLfm3TextModelId,
  isSupportedLfmModelId
} from './intel-runtime'

describe('local runtime model selection', () => {
  test('accepts exact official LFM3 text and vision ONNX model IDs only for ONNX', () => {
    expect(getLfmModelForRuntime('onnx-managed', 'LiquidAI/LFM3-1.7B-ONNX')?.key).toBe('lfm3-1.7b')
    expect(getLfmModelForRuntime('onnx-managed', 'LiquidAI/LFM3-VL-2B-ONNX')?.key).toBe('lfm3-vl-2b')
    expect(getLfmModelForRuntime('llama.cpp-managed', 'LiquidAI/LFM3-1.7B-ONNX')).toBeUndefined()
    expect(getLfmModelForRuntime('llama.cpp', 'LiquidAI/LFM3-VL-2B-ONNX')).toBeUndefined()
    expect(isSupportedLfmModelId('onnx-managed', 'LiquidAI/LFM3-1.7B-ONNX')).toBe(true)
    expect(isSupportedLfmModelId('onnx-managed', 'LiquidAI/LFM3-VL-2B-ONNX')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B-ONNX')).toBe(true)
  })

  test('accepts only the exact native LFM3 checkpoint IDs for experimental MLX-VLM', () => {
    expect(getLfmModelForRuntime('mlx-vlm', 'LiquidAI/LFM3-1.7B')?.key).toBe('lfm3-1.7b')
    expect(getLfmModelForRuntime('mlx-vlm', 'LiquidAI/LFM3-VL-2B')?.key).toBe('lfm3-vl-2b')
    expect(isSupportedLfmModelId('mlx-vlm', 'LiquidAI/LFM3-1.7B')).toBe(true)
    expect(isSupportedLfmModelId('mlx-vlm', 'LiquidAI/LFM3-VL-2B')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B')).toBe(true)
    expect(isSupportedLfmModelId('mlx-vlm', 'LiquidAI/LFM3-1.7B-ONNX')).toBe(false)
    expect(isSupportedLfmModelId('mlx-vlm', 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M')).toBe(false)
    expect(isSupportedLfmModelId('llama.cpp', 'LiquidAI/LFM3-1.7B')).toBe(false)
    expect(isSupportedLfmModelId('llama.cpp-managed', 'LiquidAI/LFM3-1.7B')).toBe(false)
    expect(isIntelRuntimeId('uzu')).toBe(false)
  })

  test('labels MLX-VLM experimental and states its external Apple-silicon runtime limit', () => {
    const runtime = intelRuntime('mlx-vlm')
    expect(runtime.name).toContain('experimental')
    expect(runtime.platform).toContain('macOS Apple silicon')
    expect(runtime.hint).toContain('not bundled')
    expect(runtime.hint).toContain('validated with native Apple-silicon inference')
  })

  test('documents managed ONNX as an in-process CPU engine rather than an API server', () => {
    const runtime = intelRuntime('onnx-managed')
    expect(runtime.name).toBe('ONNX Runtime (managed)')
    expect(runtime.platform).toBe('macOS Apple silicon · ONNX Runtime CPU')
    expect(runtime.hint).toContain('in-process')
    expect(runtime.hint).not.toContain('OpenAI-compatible API')
  })
})
