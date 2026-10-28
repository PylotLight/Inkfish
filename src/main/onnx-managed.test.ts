import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedOnnxRuntime, formatOnnxMemoryAllocationError, isOnnxMemoryAllocationError } from './onnx-managed'

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'inkfish-onnx-test-'))
}

describe('managed ONNX lifecycle and safety', () => {
  test('requires explicit license acceptance before any download proxy is created', async () => {
    const root = tempDataDir()
    let proxyCalls = 0
    const runtime = createManagedOnnxRuntime({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: () => root,
      createProxy: async () => {
        proxyCalls++
        throw new Error('must not be reached')
      }
    })
    try {
      await expect(runtime.downloadModel('lfm3-1.7b', false)).rejects.toThrow('Review and accept the LFM Open License')
      expect(proxyCalls).toBe(0)
    } finally {
      await runtime.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses model installation on unsupported platforms before network access', async () => {
    const root = tempDataDir()
    let proxyCalls = 0
    const runtime = createManagedOnnxRuntime({
      platform: 'linux',
      arch: 'x64',
      userDataDir: () => root,
      createProxy: async () => {
        proxyCalls++
        throw new Error('must not be reached')
      }
    })
    try {
      await expect(runtime.downloadModel('lfm3-vl-2b', true)).rejects.toThrow('supported platform: macOS Apple silicon')
      expect(proxyCalls).toBe(0)
    } finally {
      await runtime.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports the exact LFM3 model set and keeps unsupported platform state explicit', () => {
    const runtime = createManagedOnnxRuntime({ platform: 'win32', arch: 'x64', userDataDir: () => null })
    const status = runtime.status()
    expect(status).toMatchObject({ supportedPlatform: false, platform: 'win32 x64', loaded: false })
    expect(status.models.map(({ modelKey, modelId, installed }) => ({ modelKey, modelId, installed }))).toEqual([
      { modelKey: 'lfm3-1.7b', modelId: 'LiquidAI/LFM3-1.7B-ONNX', installed: false },
      { modelKey: 'lfm3-vl-2b', modelId: 'LiquidAI/LFM3-VL-2B-ONNX', installed: false }
    ])
  })

  test('identifies Intel Macs as unsupported instead of implying a memory problem', () => {
    const runtime = createManagedOnnxRuntime({ platform: 'darwin', arch: 'x64', userDataDir: () => null })
    const status = runtime.status()

    expect(status).toMatchObject({
      supportedPlatform: false,
      platform: 'macOS Intel (x64)',
      detail: expect.stringContaining('macOS Intel (x64)')
    })
  })

  test('recognizes allocator failures without classifying unrelated ONNX errors as memory failures', () => {
    expect(isOnnxMemoryAllocationError(new Error('Failed to allocate memory for tensor'))).toBe(true)
    expect(isOnnxMemoryAllocationError({ code: 'ENOMEM', message: 'native runtime error' })).toBe(true)
    expect(isOnnxMemoryAllocationError(new Error('Invalid graph input name'))).toBe(false)
  })

  test('formats an actionable memory error and retains the native cause', () => {
    const cause = new Error('std::bad_alloc')
    const formatted = formatOnnxMemoryAllocationError('lfm3-vl-2b', 'vision encoder', cause)

    expect(formatted.message).toContain('could not allocate enough memory')
    expect(formatted.message).toContain('vision encoder')
    expect(formatted.message).toContain('6.5 GB')
    expect(formatted.message).toContain('try the smaller LFM3 1.7B text model')
    expect((formatted as Error & { cause?: unknown }).cause).toBe(cause)
  })

  test('pauses before downloading when network routing is changing', async () => {
    const root = tempDataDir()
    let proxyCalls = 0
    const runtime = createManagedOnnxRuntime({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: () => root,
      proxyTransitioning: () => true,
      createProxy: async () => {
        proxyCalls++
        throw new Error('must not be reached')
      }
    })
    try {
      await expect(runtime.downloadModel('lfm3-1.7b', true)).rejects.toThrow('network routing changes')
      expect(proxyCalls).toBe(0)
    } finally {
      await runtime.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('removes only the selected model folder below the configured app-data root', async () => {
    const root = tempDataDir()
    const runtime = createManagedOnnxRuntime({ platform: 'darwin', arch: 'arm64', userDataDir: () => root })
    try {
      await runtime.removeModel('lfm3-vl-2b')
      expect(await Bun.file(join(root, 'lfm-onnx-models', 'lfm3-vl-2b')).exists()).toBe(false)
    } finally {
      await runtime.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses to traverse a symlinked model folder during removal', async () => {
    const root = tempDataDir()
    const outside = tempDataDir()
    const keep = join(outside, 'keep.txt')
    const modelParent = join(root, 'lfm-onnx-models')
    mkdirSync(modelParent)
    writeFileSync(keep, 'keep this file')
    symlinkSync(outside, join(modelParent, 'lfm3-vl-2b'), 'dir')
    const runtime = createManagedOnnxRuntime({ platform: 'darwin', arch: 'arm64', userDataDir: () => root })
    try {
      await expect(runtime.removeModel('lfm3-vl-2b')).rejects.toThrow('unsafe symlink')
      expect(readFileSync(keep, 'utf8')).toBe('keep this file')
    } finally {
      await runtime.shutdown()
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
