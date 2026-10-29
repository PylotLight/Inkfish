import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LFM_CATALOG, type LfmArtifact, type LfmModelKey } from '../shared/lfm-catalog'
import { createManagedLfmRuntime, llamaServerArgs, verifyArtifactFile } from './llama-managed'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

const BUNDLE_HASH = 'd618da5e7bbb19077f086e6a7e1d77eab55b9bfd481f7531aadada86d13db9ed'

class MockChild extends EventEmitter {
  pid = 43210
  exitCode: number | null = null
  readonly stderr = new EventEmitter()

  kill(signal?: NodeJS.Signals): boolean {
    setTimeout(() => {
      this.exitCode = 0
      this.emit('exit', 0, signal ?? 'SIGTERM')
    }, 0)
    return true
  }
}

function sparseFile(path: string, size: number): void {
  const fd = openSync(path, 'w')
  try {
    ftruncateSync(fd, size)
  } finally {
    closeSync(fd)
  }
}

describe('managed LFM3 llama.cpp runtime', () => {
  test('builds loopback-only server arguments for text and vision models', () => {
    const text = LFM_CATALOG['lfm3-1.7b']
    const textArgs = llamaServerArgs(text, '/models/text.gguf', null, 40001, 20)
    expect(textArgs).toContain('127.0.0.1')
    expect(textArgs).toContain('--no-mmproj')
    expect(textArgs).toContain('--alias')
    expect(textArgs[textArgs.indexOf('--alias') + 1]).toBe(text.apiModelId)
    expect(textArgs[textArgs.indexOf('--threads') + 1]).toBe('8')
    expect(textArgs[textArgs.indexOf('--ctx-size') + 1]).toBe('8192')
    expect(textArgs[textArgs.indexOf('--parallel') + 1]).toBe('1')
    expect(textArgs).toContain('--no-webui')

    const vision = LFM_CATALOG['lfm3-vl-2b']
    const visionArgs = llamaServerArgs(vision, '/models/vl.gguf', '/models/mmproj.gguf', 40002)
    expect(visionArgs).toContain('--mmproj')
    expect(visionArgs[visionArgs.indexOf('--mmproj') + 1]).toBe('/models/mmproj.gguf')
  })

  test('verifies downloaded artifact byte size and SHA-256', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkfish-model-hash-'))
    const file = join(root, 'tiny.gguf')
    const bytes = Buffer.from('checked model')
    const artifact: LfmArtifact = {
      file: 'tiny.gguf',
      repo: 'LiquidAI/test',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    try {
      writeFileSync(file, bytes)
      await expect(verifyArtifactFile(file, artifact)).resolves.toBeUndefined()
      await expect(verifyArtifactFile(file, { ...artifact, sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256')
      await expect(verifyArtifactFile(file, { ...artifact, bytes: bytes.length + 1 })).rejects.toThrow('expected')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('requires explicit license acceptance before starting any model download', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkfish-model-license-'))
    try {
      const runtime = createManagedLfmRuntime({
        getUserDataDir: () => root,
        supportedPlatform: () => true
      })
      await expect(runtime.downloadModel('lfm3-1.7b', false)).rejects.toThrow('accept the LFM Open License')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('loads a verified local model on demand and stops its child server cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkfish-model-run-'))
    const bundle = join(root, 'bundle')
    const modelKey: LfmModelKey = 'lfm3-1.7b'
    const model = LFM_CATALOG[modelKey]
    const modelDir = join(root, 'lfm-models', modelKey)
    const modelPath = join(modelDir, model.artifacts.model.file)
    mkdirSync(bundle, { recursive: true })
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(bundle, 'llama-server'), 'mock executable')
    writeFileSync(join(bundle, 'VERSION'), `tag=b11946\nsha256=${BUNDLE_HASH}\n`)
    sparseFile(modelPath, model.artifacts.model.bytes)
    const child = new MockChild()
    let spawnedArgs: string[] = []
    let spawnedOptions: SpawnOptions | undefined
    let ownerChecks = 0
    try {
      const runtime = createManagedLfmRuntime({
        getBinaryPath: () => join(bundle, 'llama-server'),
        getUserDataDir: () => root,
        supportedPlatform: () => true,
        platformName: () => 'darwin-arm64',
        freeMemoryBytes: () => 8_000_000_000, // tests must not depend on the machine's free RAM
        verifyArtifact: async () => undefined,
        spawnChild: (_command, args, options) => {
          spawnedArgs = args
          spawnedOptions = options
          return child as unknown as ChildProcess
        },
        portOwnedByPid: (pid, port) => {
          ownerChecks++
          return pid === child.pid && port > 0
        },
        fetcher: async (input) =>
          String(input).endsWith('/health')
            ? new Response('{"status":"ok"}', { status: 200 })
            : new Response(JSON.stringify({ data: [{ id: model.apiModelId }] }), { status: 200 })
      })
      expect(runtime.status()).toMatchObject({ supportedPlatform: true, binaryReady: true, running: false })
      const endpoint = await runtime.withServer(modelKey, async (started) => {
        await expect(runtime.stopServer()).rejects.toThrow('active local intelligence request')
        return started
      })
      expect(endpoint).toMatchObject({ model: model.apiModelId, modelKey, pid: child.pid })
      expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      expect(spawnedArgs[spawnedArgs.indexOf('--model') + 1]).toBe(modelPath)
      expect(spawnedOptions?.env?.OPENAI_API_KEY).toBeUndefined()
      expect(spawnedOptions?.env?.LLAMA_API_KEY).toBeUndefined()
      expect(spawnedOptions?.env?.PATH).toBeDefined()
      expect(ownerChecks).toBe(1)
      expect(runtime.status()).toMatchObject({ running: true, runningModelKey: modelKey, pid: child.pid })
      await runtime.stopServer()
      expect(runtime.status().running).toBe(false)
      await runtime.shutdown()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a healthy listener that is not owned by the launched process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkfish-model-port-race-'))
    const bundle = join(root, 'bundle')
    const modelKey: LfmModelKey = 'lfm3-1.7b'
    const model = LFM_CATALOG[modelKey]
    const modelDir = join(root, 'lfm-models', modelKey)
    mkdirSync(bundle, { recursive: true })
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(bundle, 'llama-server'), 'mock executable')
    writeFileSync(join(bundle, 'VERSION'), `tag=b11946\nsha256=${BUNDLE_HASH}\n`)
    sparseFile(join(modelDir, model.artifacts.model.file), model.artifacts.model.bytes)
    const child = new MockChild()
    const requests: string[] = []
    try {
      const runtime = createManagedLfmRuntime({
        getBinaryPath: () => join(bundle, 'llama-server'),
        getUserDataDir: () => root,
        supportedPlatform: () => true,
        freeMemoryBytes: () => 8_000_000_000, // tests must not depend on the machine's free RAM
        verifyArtifact: async () => undefined,
        spawnChild: () => child as unknown as ChildProcess,
        portOwnedByPid: () => false,
        fetcher: async (input) => {
          requests.push(String(input))
          return new Response('{"status":"ok"}', { status: 200 })
        }
      })
      await expect(runtime.ensureServer(modelKey)).rejects.toThrow('not owned by the launched llama-server process')
      expect(requests.some((url) => url.endsWith('/v1/models'))).toBe(false)
      expect(runtime.status().running).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a launched server that does not advertise the selected model ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkfish-model-id-check-'))
    const bundle = join(root, 'bundle')
    const modelKey: LfmModelKey = 'lfm3-1.7b'
    const model = LFM_CATALOG[modelKey]
    const modelDir = join(root, 'lfm-models', modelKey)
    mkdirSync(bundle, { recursive: true })
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(bundle, 'llama-server'), 'mock executable')
    writeFileSync(join(bundle, 'VERSION'), `tag=b11946\nsha256=${BUNDLE_HASH}\n`)
    sparseFile(join(modelDir, model.artifacts.model.file), model.artifacts.model.bytes)
    const child = new MockChild()
    try {
      const runtime = createManagedLfmRuntime({
        getBinaryPath: () => join(bundle, 'llama-server'),
        getUserDataDir: () => root,
        supportedPlatform: () => true,
        freeMemoryBytes: () => 8_000_000_000, // tests must not depend on the machine's free RAM
        verifyArtifact: async () => undefined,
        spawnChild: () => child as unknown as ChildProcess,
        portOwnedByPid: (pid) => pid === child.pid,
        fetcher: async (input) =>
          String(input).endsWith('/health')
            ? new Response('{"status":"ok"}', { status: 200 })
            : new Response(JSON.stringify({ data: [{ id: 'different-model' }] }), { status: 200 })
      })
      await expect(runtime.ensureServer(modelKey)).rejects.toThrow('did not advertise the selected model ID')
      expect(runtime.status().running).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
