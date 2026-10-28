import { createHash } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LfmArtifact, LfmModelKey } from '../shared/lfm-catalog'
import { getLfmModelByKey, isLfmModelKey, LFM_CATALOG } from '../shared/lfm-catalog'
import type { IntelImage, IntelRunStats, IntelRunUpdate, IntelThinkingLevel } from '../shared/intelligence'
import type { ManagedOnnxDownloadProgress, ManagedOnnxModelStatus, ManagedOnnxStatus } from '../shared/managed-onnx'
import { splitLfm3ThinkingText } from '../shared/managed-onnx'
import { createModelDownloadProxy, type ModelDownloadProxy } from './model-download-proxy'
import { onProxyChanging, getProxySettings, isProxyTransitioning } from './proxy-state'
import { appDataDir } from './vault/appdata'

const require = createRequire(import.meta.url)
const IDLE_UNLOAD_MS = 10 * 60 * 1000
const FREE_SPACE_RESERVE = 256 * 1024 * 1024
const TEXT_RAM_ESTIMATE = 4_500_000_000
const VISION_RAM_ESTIMATE = 6_500_000_000
const MIN_FREE_RAM = 1_000_000_000
const MAX_CONTEXT_TOKENS = 8192
const MAX_GENERATION_TOKENS = 1024
const VISION_HIDDEN_SIZE = 2048
const VISION_PIXEL_CHANNELS = 1536
const ONNX_PACKAGE = 'onnxruntime-node'
const SHUTDOWN_GRACE_MS = 30_000

interface TensorLike {
  data: Float32Array | BigInt64Array | Uint8Array
  dims: number[]
}
interface SessionMetadata {
  name: string
  type: string
  shape: Array<number | string>
}
interface OrtSessionLike {
  inputMetadata: SessionMetadata[]
  outputMetadata: SessionMetadata[]
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>
  release(): Promise<void>
}
interface OrtModuleLike {
  Tensor: new (type: string, data: Float32Array | BigInt64Array | Uint8Array, dims: number[]) => TensorLike
  InferenceSession: {
    create(
      path: string,
      options: { executionProviders: string[]; intraOpNumThreads: number; interOpNumThreads: number }
    ): Promise<OrtSessionLike>
  }
}
interface TokenizerLike {
  eos_token_id: number
  apply_chat_template(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: { add_generation_prompt: true; tokenize: false; chat_template: string; enable_thinking: boolean }
  ): string
  (text: string, options: { add_special_tokens: false }): { input_ids: TensorLike }
  decode(tokenIds: number[], options: { skip_special_tokens: boolean }): string
}
interface RawImageLike {
  width: number
  height: number
  channels: number
}
interface ImageProcessorResult {
  pixel_values: TensorLike
  image_grid_thw: { tolist(): Array<Array<number | bigint>> }
}
interface ImageProcessorLike {
  config: { merge_size: number }
  (images: RawImageLike[]): Promise<ImageProcessorResult>
}
interface TransformersModuleLike {
  env: { allowRemoteModels: boolean; allowLocalModels: boolean }
  AutoTokenizer: { from_pretrained(path: string, options: { local_files_only: true }): Promise<TokenizerLike> }
  AutoImageProcessor: {
    from_pretrained(path: string, options: { local_files_only: true }): Promise<ImageProcessorLike>
  }
  RawImage: { fromBlob(blob: Blob): Promise<RawImageLike> }
}
interface RuntimeModules {
  ort: OrtModuleLike
  transformers: TransformersModuleLike
}

interface LoadedModel {
  modelKey: LfmModelKey
  directory: string
  ort: OrtModuleLike
  tokenizer: TokenizerLike
  chatTemplate: string
  decoder: OrtSessionLike
  vision?: OrtSessionLike
  imageProcessor?: ImageProcessorLike
}
interface ActiveDownload {
  paused: boolean
  progress: ManagedOnnxDownloadProgress
  child?: ChildProcess
  closeProxy?: () => void
  promise?: Promise<void>
  onProgress: (progress: ManagedOnnxDownloadProgress) => void
}

export interface ManagedOnnxChatMessage {
  role: 'system' | 'user'
  content: string
  images?: IntelImage[]
}
export interface ManagedOnnxChatOptions {
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  thinkingLevel?: IntelThinkingLevel
  onUpdate?: (update: IntelRunUpdate) => void
}
export interface ManagedOnnxChatResult {
  content: string
  thinking?: string
  ms: number
  promptTokens: number
  completionTokens: number
  thinkingLevel: IntelThinkingLevel
  stats: IntelRunStats
}

export interface ManagedOnnxRuntimeDependencies {
  userDataDir?: () => string | null
  platform?: NodeJS.Platform
  arch?: string
  freeMemory?: () => number
  totalMemory?: () => number
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  createProxy?: (settings: ReturnType<typeof getProxySettings>, blocked: () => boolean) => Promise<ModelDownloadProxy>
  proxySettings?: typeof getProxySettings
  proxyTransitioning?: typeof isProxyTransitioning
  loadRuntime?: () => Promise<RuntimeModules>
}

function safeChildEnvironment(proxyUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  env['http_proxy'] = proxyUrl
  env['https_proxy'] = proxyUrl
  return env
}

function getArtifactList(modelKey: LfmModelKey): readonly LfmArtifact[] {
  return getLfmModelByKey(modelKey)?.onnx?.artifacts ?? []
}

function modelBytes(modelKey: LfmModelKey): number {
  return getArtifactList(modelKey).reduce((total, artifact) => total + artifact.bytes, 0)
}

function safeArtifactPath(directory: string, artifact: LfmArtifact): string {
  if (isAbsolute(artifact.file) || artifact.file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'))
    throw new Error('The managed ONNX catalog contains an unsafe artifact path')
  const path = resolve(directory, artifact.file)
  const rel = relative(directory, path)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel))
    throw new Error('The managed ONNX artifact escaped its model directory')
  const directories = [dirname(directory), directory]
  let current = directory
  for (const part of artifact.file.split('/').slice(0, -1)) {
    current = join(current, part)
    directories.push(current)
  }
  for (const candidate of directories) {
    try {
      const stat = lstatSync(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('The managed ONNX model directory contains an unsafe symlink or non-directory path')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return path
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function verifyArtifactFile(path: string, artifact: LfmArtifact): Promise<boolean> {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes) return false
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) return false
    return (await sha256File(path)).toLowerCase() === artifact.sha256.toLowerCase()
  } catch {
    return false
  }
}

function packageVersion(): string | undefined {
  try {
    const packagePath = require.resolve(`${ONNX_PACKAGE}/package.json`)
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

function runtimePackagesReady(): boolean {
  try {
    const ort = require(ONNX_PACKAGE) as { InferenceSession?: { create?: unknown } }
    if (typeof ort.InferenceSession?.create !== 'function') return false
    require.resolve('@huggingface/transformers')
    return true
  } catch {
    return false
  }
}

function platformLabel(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin' && arch === 'arm64') return 'macOS Apple silicon'
  if (platform === 'darwin' && arch === 'x64') return 'macOS Intel (x64)'
  if (platform === 'darwin') return `macOS ${arch}`
  return `${platform} ${arch}`
}

const ONNX_MEMORY_ERROR_PATTERN =
  /\b(?:out of memory|not enough memory|failed to allocate|allocation failed|memory allocation|cannot allocate memory|bad_alloc|ENOMEM|OOM|array buffer allocation failed)\b/i

export function isOnnxMemoryAllocationError(error: unknown): boolean {
  const candidate = error as { message?: unknown; code?: unknown } | null
  const detail = [candidate?.message, candidate?.code, error]
    .filter((value) => value !== undefined && value !== null)
    .join(' ')
  return ONNX_MEMORY_ERROR_PATTERN.test(detail)
}

export function formatOnnxMemoryAllocationError(modelKey: LfmModelKey, phase: string, cause: unknown): Error {
  const estimatedRam = modelKey === 'lfm3-vl-2b' ? VISION_RAM_ESTIMATE : TEXT_RAM_ESTIMATE
  const imageFallback =
    modelKey === 'lfm3-vl-2b' ? ' If you do not need document images, try the smaller LFM3 1.7B text model.' : ''
  return new Error(
    `ONNX Runtime could not allocate enough memory while loading the ${phase} for ${LFM_CATALOG[modelKey].name} (estimated RAM: ${(estimatedRam / 1e9).toFixed(1)} GB). Close memory-heavy apps and retry.${imageFallback}`,
    { cause }
  )
}

function mimeBytesMatch(mime: IntelImage['mime'], bytes: Buffer): boolean {
  if (mime === 'image/png')
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function chooseToken(logits: Float32Array, offset: number, vocabSize: number, temperature: number): number {
  let maxIndex = 0
  let maxValue = -Infinity
  for (let index = 0; index < vocabSize; index++) {
    const value = logits[offset + index] ?? -Infinity
    if (value > maxValue) {
      maxIndex = index
      maxValue = value
    }
  }
  if (!(temperature > 0.001) || !Number.isFinite(maxValue)) return maxIndex
  let total = 0
  for (let index = 0; index < vocabSize; index++)
    total += Math.exp(((logits[offset + index] ?? -Infinity) - maxValue) / temperature)
  let draw = Math.random() * total
  for (let index = 0; index < vocabSize; index++) {
    draw -= Math.exp(((logits[offset + index] ?? -Infinity) - maxValue) / temperature)
    if (draw <= 0) return index
  }
  return maxIndex
}

export function createManagedOnnxRuntime(deps: ManagedOnnxRuntimeDependencies = {}) {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const freeMemory = deps.freeMemory ?? freemem
  const totalMemory = deps.totalMemory ?? totalmem
  const spawnChild = deps.spawnChild ?? spawn
  const makeProxy = deps.createProxy ?? createModelDownloadProxy
  const getProxy = deps.proxySettings ?? getProxySettings
  const proxyTransitioning = deps.proxyTransitioning ?? isProxyTransitioning
  const downloads = new Map<LfmModelKey, ActiveDownload>()
  let loaded: LoadedModel | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let closing = false
  let shutdownPromise: Promise<void> | null = null
  let queue: Promise<void> = Promise.resolve()
  let runtimeModules: Promise<RuntimeModules> | null = null

  function supportedPlatform(): boolean {
    return platform === 'darwin' && arch === 'arm64'
  }

  function userDataDirectory(): string {
    const value = deps.userDataDir ? deps.userDataDir() : appDataDir()
    if (!value)
      throw new Error('Inkfish data directory is not initialized. Set INKFISH_DATA for a standalone benchmark.')
    return resolve(value)
  }

  function modelDirectory(modelKey: LfmModelKey): string {
    return join(userDataDirectory(), 'lfm-onnx-models', modelKey)
  }

  function artifactBytesOnDisk(modelKey: LfmModelKey): number {
    let total = 0
    const directory = modelDirectory(modelKey)
    for (const artifact of getArtifactList(modelKey)) {
      const finalPath = safeArtifactPath(directory, artifact)
      for (const candidate of [finalPath, `${finalPath}.part`]) {
        try {
          total += Math.min(artifact.bytes, Math.max(0, lstatSync(candidate).size))
        } catch {
          // Missing file.
        }
      }
    }
    return Math.min(modelBytes(modelKey), total)
  }

  function modelInstalled(modelKey: LfmModelKey): boolean {
    try {
      const directory = modelDirectory(modelKey)
      return (
        getArtifactList(modelKey).length > 0 &&
        getArtifactList(modelKey).every((artifact) => {
          const stat = lstatSync(safeArtifactPath(directory, artifact))
          return stat.isFile() && !stat.isSymbolicLink() && stat.size === artifact.bytes
        })
      )
    } catch {
      return false
    }
  }

  function status(): ManagedOnnxStatus {
    const label = platformLabel(platform, arch)
    const packagesReady = runtimePackagesReady()
    const models: ManagedOnnxModelStatus[] = (['lfm3-1.7b', 'lfm3-vl-2b'] as const).map((modelKey) => {
      const model = LFM_CATALOG[modelKey]
      const onnx = model.onnx!
      let downloadedBytes = 0
      try {
        downloadedBytes = artifactBytesOnDisk(modelKey)
      } catch {
        // App data directory is not ready.
      }
      return {
        modelKey,
        modelId: onnx.modelId,
        name: model.name,
        installed: modelInstalled(modelKey),
        downloadedBytes,
        totalBytes: modelBytes(modelKey),
        estimatedRamBytes: modelKey === 'lfm3-vl-2b' ? VISION_RAM_ESTIMATE : TEXT_RAM_ESTIMATE,
        ...(downloads.get(modelKey) ? { progress: { ...downloads.get(modelKey)!.progress } } : {})
      }
    })
    const runtimeVersion = packageVersion()
    let detail: string
    if (!supportedPlatform())
      detail = `Managed ONNX Runtime is supported on macOS Apple silicon only; current platform is ${label}.`
    else if (!packagesReady) detail = 'The bundled ONNX Runtime Node or Transformers.js package is missing.'
    else if (loaded)
      detail = `Loaded ${LFM_CATALOG[loaded.modelKey].name} with ONNX Runtime ${runtimeVersion ?? 'Node'} CPU.`
    else
      detail = `ONNX Runtime ${runtimeVersion ?? 'Node'} is ready on ${label} (CPU). Download and accept the LFM Open License to install a model.`
    return {
      supportedPlatform: supportedPlatform(),
      platform: label,
      runtimeReady: packagesReady,
      ...(runtimeVersion ? { runtimeVersion } : {}),
      loaded: Boolean(loaded),
      ...(loaded ? { loadedModelKey: loaded.modelKey } : {}),
      detail,
      models
    }
  }

  function emitProgress(download: ActiveDownload, patch: Partial<ManagedOnnxDownloadProgress>): void {
    download.progress = { ...download.progress, ...patch }
    download.onProgress(download.progress)
  }

  function cancelIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  function withLock<T>(operation: () => Promise<T>, allowClosing = false): Promise<T> {
    const previous = queue
    let release!: () => void
    queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue
    })
    return previous.then(async () => {
      try {
        if (closing && !allowClosing) throw new Error('Managed ONNX Runtime is shutting down.')
        return await operation()
      } finally {
        release()
      }
    })
  }

  function safeArtifactUrl(artifact: LfmArtifact): string {
    const file = artifact.file
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')
    return `https://huggingface.co/${artifact.repo}/resolve/main/${file}?download=true`
  }

  async function downloadOneArtifact(
    modelKey: LfmModelKey,
    artifact: LfmArtifact,
    download: ActiveDownload,
    proxyUrl: string,
    completedBefore: number,
    totalBytes: number
  ): Promise<boolean> {
    const directory = modelDirectory(modelKey)
    const destination = safeArtifactPath(directory, artifact)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    safeArtifactPath(directory, artifact)
    if (await verifyArtifactFile(destination, artifact)) return true
    rmSync(destination, { recursive: true, force: true })
    const part = `${destination}.part`
    try {
      const stat = lstatSync(part)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > artifact.bytes)
        rmSync(part, { recursive: true, force: true })
    } catch {
      // No partial file yet.
    }
    try {
      const stat = lstatSync(part)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size === artifact.bytes) {
        if (await verifyArtifactFile(part, artifact)) {
          renameSync(part, destination)
          chmodSync(destination, 0o600)
          return true
        }
        rmSync(part, { force: true })
      }
    } catch {
      // No resumable partial yet.
    }
    const env = safeChildEnvironment(proxyUrl)
    const args = [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--retry',
      '3',
      '--retry-all-errors',
      '--continue-at',
      '-',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--output',
      part,
      safeArtifactUrl(artifact)
    ]
    let stderr = ''
    let settled = false
    const currentBytes = (): number => {
      try {
        return Math.min(artifact.bytes, lstatSync(part).size)
      } catch {
        return 0
      }
    }
    const update = (): void => {
      const bytes = Math.min(totalBytes, completedBefore + currentBytes())
      emitProgress(download, {
        state: 'downloading',
        bytes,
        fraction: totalBytes ? bytes / totalBytes : 0,
        file: artifact.file
      })
    }
    update()
    const timer = setInterval(update, 500)
    try {
      await new Promise<void>((resolveChild, rejectChild) => {
        const child = spawnChild('/usr/bin/curl', args, {
          cwd: dirname(destination),
          stdio: ['ignore', 'ignore', 'pipe'],
          env
        })
        download.child = child
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8000)
        })
        child.once('error', (error) =>
          rejectChild(new Error(`Could not start the ONNX model downloader: ${error.message}`))
        )
        child.once('close', (code, signal) => {
          download.child = undefined
          if (download.paused) resolveChild()
          else if (code === 0) resolveChild()
          else rejectChild(new Error(stderr.trim() || `curl exited ${code ?? signal ?? 'unknown'}`))
        })
      })
      settled = true
      if (download.paused) return false
      if (!(await verifyArtifactFile(part, artifact))) {
        const current = existsSync(part) ? lstatSync(part).size : 0
        throw new Error(`${artifact.file} failed size/SHA-256 verification after download (${current} bytes)`)
      }
      renameSync(part, destination)
      chmodSync(destination, 0o600)
      emitProgress(download, {
        state: 'downloading',
        bytes: Math.min(totalBytes, completedBefore + artifact.bytes),
        fraction: Math.min(1, (completedBefore + artifact.bytes) / totalBytes),
        file: artifact.file
      })
      return true
    } finally {
      if (timer) clearInterval(timer)
      if (!settled && download.paused) download.child = undefined
    }
  }

  async function downloadModel(
    modelKey: LfmModelKey,
    acceptedLicense: boolean,
    onProgress: (progress: ManagedOnnxDownloadProgress) => void = () => {}
  ): Promise<void> {
    if (!isLfmModelKey(modelKey) || !getArtifactList(modelKey).length)
      throw new Error('Choose a supported LFM3 ONNX model')
    if (!acceptedLicense) throw new Error('Review and accept the LFM Open License before downloading model weights')
    if (!supportedPlatform())
      throw new Error(
        `Managed ONNX Runtime is not available on ${platformLabel(platform, arch)}; supported platform: macOS Apple silicon`
      )
    if (!runtimePackagesReady())
      throw new Error('The bundled ONNX Runtime Node and Transformers.js packages are not available.')
    if (proxyTransitioning())
      throw new Error('Model downloads are paused while network routing changes. Retry after saving Network settings.')
    const existing = downloads.get(modelKey)
    if (existing?.progress.state === 'downloading' && existing.promise) return existing.promise
    const pending = [...downloads.values()].find((item) => item.promise)
    if (pending?.promise)
      throw new Error('Only one managed model can download at a time. Pause the current download first.')

    const directory = userDataDirectory()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    let required = FREE_SPACE_RESERVE
    for (const artifact of getArtifactList(modelKey)) {
      const path = safeArtifactPath(modelDirectory(modelKey), artifact)
      if (await verifyArtifactFile(path, artifact)) continue
      let finalBytes = 0
      let partialBytes = 0
      try {
        const stat = lstatSync(path)
        if (stat.isFile() && !stat.isSymbolicLink()) finalBytes = stat.size
      } catch {
        /* not present */
      }
      try {
        const part = `${path}.part`
        const stat = lstatSync(part)
        if (stat.isFile() && !stat.isSymbolicLink()) partialBytes = stat.size
        else rmSync(part, { recursive: true, force: true })
      } catch {
        /* not present */
      }
      required += Math.max(
        0,
        artifact.bytes - Math.min(artifact.bytes, finalBytes) - Math.min(artifact.bytes, partialBytes)
      )
    }
    let free: number
    try {
      const fileSystem = statfsSync(directory)
      free = fileSystem.bavail * fileSystem.bsize
    } catch {
      throw new Error('Could not check free disk space for the ONNX model download.')
    }
    if (free < required)
      throw new Error(
        `Not enough free disk space: need about ${(required / 1e9).toFixed(1)} GB, have ${(free / 1e9).toFixed(1)} GB.`
      )

    const totalBytes = modelBytes(modelKey)
    const download: ActiveDownload = {
      paused: false,
      onProgress,
      progress: { modelKey, state: 'downloading', fraction: 0, bytes: artifactBytesOnDisk(modelKey), totalBytes }
    }
    downloads.set(modelKey, download)
    const promise = (async (): Promise<void> => {
      let proxy: ModelDownloadProxy | undefined
      try {
        proxy = await makeProxy(getProxy(), () => download.paused || proxyTransitioning())
        download.closeProxy = proxy.close
        let completed = 0
        for (const artifact of getArtifactList(modelKey)) {
          if (download.paused || proxyTransitioning()) {
            emitProgress(download, { state: 'paused' })
            return
          }
          const done = await downloadOneArtifact(modelKey, artifact, download, proxy.url, completed, totalBytes)
          if (!done) {
            emitProgress(download, { state: 'paused' })
            return
          }
          completed += artifact.bytes
        }
        emitProgress(download, { state: 'done', fraction: 1, bytes: totalBytes, file: undefined, error: undefined })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emitProgress(download, {
          state: download.paused ? 'paused' : 'error',
          error: download.paused ? undefined : message
        })
        if (!download.paused) throw error
      } finally {
        proxy?.close()
        download.closeProxy = undefined
        download.child = undefined
        download.promise = undefined
      }
    })()
    download.promise = promise
    return promise
  }

  function pauseDownload(modelKey: LfmModelKey): void {
    const download = downloads.get(modelKey)
    if (!download || download.progress.state !== 'downloading') return
    download.paused = true
    download.closeProxy?.()
    const child = download.child
    if (child) {
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => {
        if (download.child === child && child.exitCode === null) child.kill('SIGKILL')
      }, 3000)
      killTimer.unref?.()
      child.once('close', () => clearTimeout(killTimer))
    }
    emitProgress(download, { state: 'paused' })
  }

  function pauseAllDownloads(): void {
    for (const modelKey of downloads.keys()) pauseDownload(modelKey)
  }

  function loadRuntime(): Promise<RuntimeModules> {
    if (!runtimeModules) {
      runtimeModules = Promise.all([import('onnxruntime-node'), import('@huggingface/transformers')]).then(
        ([ort, transformers]) => ({
          ort: ort as unknown as OrtModuleLike,
          transformers: transformers as unknown as TransformersModuleLike
        })
      )
    }
    return runtimeModules
  }

  function prepareVisionProcessorConfig(modelDirectoryPath: string): void {
    const source = join(modelDirectoryPath, 'processor_config.json')
    const target = join(modelDirectoryPath, 'preprocessor_config.json')
    const parsed = JSON.parse(readFileSync(source, 'utf8')) as { image_processor?: unknown }
    if (!parsed.image_processor || typeof parsed.image_processor !== 'object')
      throw new Error('The verified LFM3-VL processor_config.json has no image_processor configuration.')
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(parsed.image_processor), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, target)
  }

  async function releaseSession(session?: OrtSessionLike): Promise<void> {
    if (!session) return
    await session.release().catch(() => undefined)
  }

  async function unloadLoadedModel(): Promise<void> {
    cancelIdleTimer()
    const old = loaded
    loaded = null
    if (!old) return
    await releaseSession(old.vision)
    await releaseSession(old.decoder)
  }

  async function ensureLoaded(modelKey: LfmModelKey): Promise<LoadedModel> {
    if (loaded?.modelKey === modelKey) return loaded
    if (!supportedPlatform())
      throw new Error(
        `Managed ONNX Runtime is supported on macOS Apple silicon only; current platform is ${platformLabel(platform, arch)}.`
      )
    if (!runtimePackagesReady())
      throw new Error('The bundled ONNX Runtime Node and Transformers.js packages are missing.')
    if (!modelInstalled(modelKey))
      throw new Error(`${LFM_CATALOG[modelKey].name} ONNX artifacts are not fully downloaded. Download them first.`)
    const ramEstimate = modelKey === 'lfm3-vl-2b' ? VISION_RAM_ESTIMATE : TEXT_RAM_ESTIMATE
    const availableRam = freeMemory()
    const installedRam = totalMemory()
    if (installedRam < ramEstimate || availableRam < MIN_FREE_RAM)
      throw new Error(
        `Not enough memory is available to load ${LFM_CATALOG[modelKey].name}. It is estimated to need ${(ramEstimate / 1e9).toFixed(1)} GB RAM; this Mac has ${(installedRam / 1e9).toFixed(1)} GB total and ${(availableRam / 1e9).toFixed(1)} GB currently free. Close memory-heavy apps and retry.`
      )
    if (loaded) await unloadLoadedModel()

    const directory = modelDirectory(modelKey)
    for (const artifact of getArtifactList(modelKey)) {
      const path = safeArtifactPath(directory, artifact)
      if (!(await verifyArtifactFile(path, artifact))) {
        rmSync(path, { force: true })
        throw new Error(
          `${artifact.file} failed size/SHA-256 verification. The invalid copy was removed; download the model again.`
        )
      }
    }
    let decoder: OrtSessionLike | undefined
    try {
      const modules = await loadRuntime()
      modules.transformers.env.allowRemoteModels = false
      modules.transformers.env.allowLocalModels = true
      if (modelKey === 'lfm3-vl-2b') prepareVisionProcessorConfig(directory)
      const tokenizer = await modules.transformers.AutoTokenizer.from_pretrained(directory, { local_files_only: true })
      const chatTemplate = readFileSync(join(directory, 'chat_template.jinja'), 'utf8')
      const threads = Math.max(1, Math.min(4, cpus().length))
      const sessionOptions = { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1 }
      const decoderPath =
        modelKey === 'lfm3-vl-2b'
          ? join(directory, 'onnx', 'decoder_q4.onnx')
          : join(directory, 'onnx', 'model_q4.onnx')
      decoder = await modules.ort.InferenceSession.create(decoderPath, sessionOptions)
      let imageProcessor: ImageProcessorLike | undefined
      if (modelKey === 'lfm3-vl-2b')
        imageProcessor = await modules.transformers.AutoImageProcessor.from_pretrained(directory, {
          local_files_only: true
        })
      loaded = {
        modelKey,
        directory,
        ort: modules.ort,
        tokenizer,
        chatTemplate,
        decoder,
        ...(imageProcessor ? { imageProcessor } : {})
      }
      return loaded
    } catch (error) {
      await releaseSession(decoder)
      if (isOnnxMemoryAllocationError(error)) throw formatOnnxMemoryAllocationError(modelKey, 'model', error)
      throw error
    }
  }

  async function ensureVision(ready: LoadedModel): Promise<OrtSessionLike> {
    if (ready.modelKey !== 'lfm3-vl-2b') throw new Error('Image inputs require the LFM3-VL-2B ONNX model.')
    if (ready.vision) return ready.vision
    try {
      ready.vision = await ready.ort.InferenceSession.create(join(ready.directory, 'onnx', 'vision_encoder_q8.onnx'), {
        executionProviders: ['cpu'],
        intraOpNumThreads: Math.max(1, Math.min(4, cpus().length)),
        interOpNumThreads: 1
      })
    } catch (error) {
      if (isOnnxMemoryAllocationError(error)) {
        await unloadLoadedModel()
        throw formatOnnxMemoryAllocationError(ready.modelKey, 'vision encoder', error)
      }
      throw error
    }
    return ready.vision
  }

  function scheduleIdleUnload(): void {
    cancelIdleTimer()
    if (!loaded || closing) return
    idleTimer = setTimeout(() => {
      void withLock(() => unloadLoadedModel()).catch(() => undefined)
    }, IDLE_UNLOAD_MS)
    idleTimer.unref?.()
  }

  async function loadModel(modelKey: LfmModelKey): Promise<void> {
    if (!isLfmModelKey(modelKey)) throw new Error('Choose a supported LFM3 ONNX model')
    await withLock(async () => {
      cancelIdleTimer()
      await ensureLoaded(modelKey)
      scheduleIdleUnload()
    })
  }

  async function unloadModel(): Promise<void> {
    await withLock(async () => unloadLoadedModel())
  }

  function emptyCacheTensor(ready: LoadedModel, metadata: SessionMetadata): TensorLike {
    const shape = metadata.shape.map((dimension) => {
      if (typeof dimension === 'number') return dimension
      const lower = dimension.toLowerCase()
      if (lower === 'batch_size') return 1
      if (lower.includes('sequence')) return 0
      throw new Error(`Unsupported dynamic ONNX cache dimension ${dimension} for ${metadata.name}`)
    })
    const size = shape.reduce((left, right) => left * right, 1)
    if (metadata.type === 'float32') return new ready.ort.Tensor('float32', new Float32Array(size), shape)
    if (metadata.type === 'int64') return new ready.ort.Tensor('int64', new BigInt64Array(size), shape)
    if (metadata.type === 'uint8') return new ready.ort.Tensor('uint8', new Uint8Array(size), shape)
    throw new Error(`Unsupported ONNX input type ${metadata.type} for ${metadata.name}`)
  }

  async function encodeImages(
    ready: LoadedModel,
    images: IntelImage[]
  ): Promise<{ tensor: TensorLike; counts: number[] }> {
    const processor = ready.imageProcessor
    if (!processor) throw new Error('The LFM3-VL image processor is not available.')
    const vision = await ensureVision(ready)
    const featureParts: Float32Array[] = []
    const counts: number[] = []
    let totalFeatures = 0
    for (const image of images) {
      if (image.mime !== 'image/png' && image.mime !== 'image/jpeg')
        throw new Error('Only PNG and JPEG images are supported')
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 === 1)
        throw new Error('Image payload is not valid base64')
      const bytes = Buffer.from(image.data, 'base64')
      if (!bytes.length || bytes.length > 4 * 1024 * 1024 || !mimeBytesMatch(image.mime, bytes))
        throw new Error('Image payload is invalid or exceeds the 4 MB per-image limit')
      const rawImage = await (
        await loadRuntime()
      ).transformers.RawImage.fromBlob(new Blob([bytes], { type: image.mime }))
      if (rawImage.width * rawImage.height > 16_000_000)
        throw new Error('Image dimensions exceed the 16-megapixel processing limit')
      const result = await processor([rawImage])
      const grid = result.image_grid_thw.tolist()[0]?.map(Number)
      if (!grid || grid.length !== 3) throw new Error('The LFM3-VL processor returned an invalid image grid')
      const temporal = grid[0]!
      const gridHeight = grid[1]!
      const gridWidth = grid[2]!
      const merge = processor.config.merge_size
      if (temporal !== 1 || !merge || gridHeight % merge !== 0 || gridWidth % merge !== 0)
        throw new Error('The LFM3-VL processor returned an unsupported image grid')
      const pixelShape = [gridHeight / merge, gridWidth / merge, merge, merge, VISION_PIXEL_CHANNELS]
      const expectedPixels = pixelShape.reduce((left, right) => left * right, 1)
      if (result.pixel_values.data.length !== expectedPixels)
        throw new Error('The LFM3-VL processor output does not match the official vision graph layout')
      const encoded = await vision.run({
        pixel_values: new ready.ort.Tensor('float32', result.pixel_values.data, pixelShape)
      })
      const features = encoded['image_features']
      if (
        !features ||
        !(features.data instanceof Float32Array) ||
        features.dims.length !== 2 ||
        features.dims[1] !== VISION_HIDDEN_SIZE
      )
        throw new Error('The LFM3-VL vision graph returned invalid image features')
      const tokenCount = features.dims[0]!
      const expectedCount = (temporal * gridHeight * gridWidth) / (merge * merge)
      if (tokenCount !== expectedCount)
        throw new Error('The LFM3-VL vision graph token count does not match the processor grid')
      featureParts.push(features.data)
      counts.push(tokenCount)
      totalFeatures += tokenCount
    }
    const data = new Float32Array(totalFeatures * VISION_HIDDEN_SIZE)
    let offset = 0
    for (const part of featureParts) {
      data.set(part, offset)
      offset += part.length
    }
    return { tensor: new ready.ort.Tensor('float32', data, [totalFeatures, VISION_HIDDEN_SIZE]), counts }
  }

  async function runDecoder(
    ready: LoadedModel,
    messages: ManagedOnnxChatMessage[],
    options: ManagedOnnxChatOptions
  ): Promise<ManagedOnnxChatResult> {
    const started = Date.now()
    const images = messages.flatMap((message) => message.images ?? [])
    if (images.length > 2) throw new Error('A maximum of 2 images can be sent per request')
    if (images.length && ready.modelKey !== 'lfm3-vl-2b')
      throw new Error('Image inputs require the LFM3-VL-2B ONNX model.')
    const encodedImages = images.length ? await encodeImages(ready, images) : undefined
    let imageIndex = 0
    const templateMessages = messages.map((message) => {
      const placeholders = message.images?.length ?? 0
      const safeContent = message.content.replace(/<\|/g, '&lt;|')
      return {
        role: message.role,
        content: placeholders ? `${safeContent}\n${'<|image|>'.repeat(placeholders)}` : safeContent
      }
    })
    const prompt = ready.tokenizer
      .apply_chat_template(templateMessages, {
        add_generation_prompt: true,
        tokenize: false,
        chat_template: ready.chatTemplate,
        enable_thinking: options.thinkingLevel !== 'off'
      })
      .replaceAll('<|image|>', () => {
        const count = encodedImages?.counts[imageIndex++]
        if (!count) throw new Error('Image placeholder/grid mismatch')
        return '<|image|>'.repeat(count)
      })
    if (imageIndex !== images.length) throw new Error('Image grid/placeholder mismatch')
    const encodedPrompt = ready.tokenizer(prompt, { add_special_tokens: false }).input_ids
    const promptLength = encodedPrompt.dims.at(-1) ?? 0
    if (encodedPrompt.dims.length !== 2 || encodedPrompt.dims[0] !== 1 || promptLength < 1)
      throw new Error('The LFM3 tokenizer returned invalid input IDs')
    if (promptLength > MAX_CONTEXT_TOKENS)
      throw new Error(`Prompt exceeds the managed ONNX context limit of ${MAX_CONTEXT_TOKENS} tokens`)
    if (!(encodedPrompt.data instanceof BigInt64Array))
      throw new Error('The LFM3 tokenizer returned invalid input ID values')
    const remainingContext = MAX_CONTEXT_TOKENS - promptLength
    if (remainingContext < 1) throw new Error('The prompt leaves no room for managed ONNX generation')

    const cache = Object.fromEntries(
      ready.decoder.inputMetadata
        .filter((item) => item.name.startsWith('past_conv.') || item.name.startsWith('past_key_values.'))
        .map((item) => [item.name, emptyCacheTensor(ready, item)])
    )
    const emptyFeatures = new ready.ort.Tensor('float32', new Float32Array(0), [0, VISION_HIDDEN_SIZE])
    const generated: number[] = []
    const requestedTokens =
      typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) ? Math.round(options.maxTokens) : 512
    const maximum = Math.max(1, Math.min(MAX_GENERATION_TOKENS, remainingContext, requestedTokens))
    const requestedTimeout =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000
    const timeout = Math.max(1000, Math.min(120_000, requestedTimeout))
    const requestedTemperature =
      typeof options.temperature === 'number' && Number.isFinite(options.temperature) ? options.temperature : 0.2
    const temperature = Math.max(0, Math.min(1, requestedTemperature))
    const thinkingLevel = options.thinkingLevel === 'off' ? 'off' : 'on'
    const generationStarted = Date.now()
    let timeToFirstTokenMs = 0
    let thinkingTokenCount = 0
    let split = { thinking: '', content: '' }
    for (let step = 0; step < maximum; step++) {
      if (closing) throw new Error('Managed ONNX Runtime is shutting down.')
      if (Date.now() - started > timeout)
        throw new Error(`Managed ONNX inference exceeded its ${Math.round(timeout / 1000)} second timeout`)
      const currentIds =
        step === 0
          ? new BigInt64Array(encodedPrompt.data as BigInt64Array)
          : new BigInt64Array([BigInt(generated[generated.length - 1]!)])
      const currentLength = step === 0 ? promptLength : 1
      const totalLength = promptLength + generated.length
      const attentionMask = new ready.ort.Tensor('int64', new BigInt64Array(totalLength).fill(1n), [1, totalLength])
      const positions =
        step === 0
          ? BigInt64Array.from({ length: promptLength }, (_, index) => BigInt(index))
          : new BigInt64Array([BigInt(promptLength + generated.length - 1)])
      const feeds: Record<string, unknown> = {
        input_ids: new ready.ort.Tensor('int64', currentIds, [1, currentLength]),
        attention_mask: attentionMask,
        position_ids: new ready.ort.Tensor('int64', positions, [1, currentLength]),
        logits_to_keep: new ready.ort.Tensor('int64', new BigInt64Array([1n]), [1]),
        image_features: step === 0 && encodedImages ? encodedImages.tensor : emptyFeatures,
        video_features: emptyFeatures,
        ...cache
      }
      const outputs = await ready.decoder.run(feeds)
      if (Date.now() - started > timeout)
        throw new Error(`Managed ONNX generation exceeded its ${Math.round(timeout / 1000)} second timeout`)
      const logitsTensor = outputs['logits']
      if (!logitsTensor || !(logitsTensor.data instanceof Float32Array) || logitsTensor.dims.length < 2)
        throw new Error('The LFM3 ONNX decoder returned invalid logits')
      const vocabSize = logitsTensor.dims.at(-1) ?? 0
      const rows = logitsTensor.dims[logitsTensor.dims.length - 2] ?? 0
      if (!vocabSize || !rows) throw new Error('The LFM3 ONNX decoder returned empty logits')
      const token = chooseToken(logitsTensor.data, (rows - 1) * vocabSize, vocabSize, temperature)
      generated.push(token)
      if (step === 0) timeToFirstTokenMs = Date.now() - generationStarted
      for (const metadata of ready.decoder.outputMetadata) {
        if (metadata.name.startsWith('present_conv.')) {
          const output = outputs[metadata.name]
          if (output) cache[metadata.name.replace('present_conv.', 'past_conv.')] = output
        } else if (metadata.name.startsWith('present.')) {
          const output = outputs[metadata.name]
          if (output) cache[metadata.name.replace('present.', 'past_key_values.')] = output
        }
      }
      const decoded = ready.tokenizer.decode(generated, { skip_special_tokens: false })
      split = splitLfm3ThinkingText(decoded, thinkingLevel)
      if (thinkingLevel === 'on' && thinkingTokenCount === 0 && decoded.includes('</think>'))
        thinkingTokenCount = generated.length
      const generationMs = Date.now() - generationStarted
      const thinkingTokens = thinkingLevel === 'on' ? thinkingTokenCount || generated.length : 0
      const stats: IntelRunStats = {
        promptTokens: promptLength,
        completionTokens: generated.length,
        thinkingTokens,
        answerTokens: generated.length - thinkingTokens,
        generationMs,
        timeToFirstTokenMs,
        tokensPerSecond: generationMs > 0 ? (generated.length * 1000) / generationMs : 0
      }
      try {
        options.onUpdate?.({ ...split, stats })
      } catch {
        // Renderer progress must not interrupt native inference.
      }
      if (token === ready.tokenizer.eos_token_id) break
    }
    const generationMs = Date.now() - generationStarted
    const thinkingTokens = thinkingLevel === 'on' ? thinkingTokenCount || generated.length : 0
    const stats: IntelRunStats = {
      promptTokens: promptLength,
      completionTokens: generated.length,
      thinkingTokens,
      answerTokens: generated.length - thinkingTokens,
      generationMs,
      timeToFirstTokenMs,
      tokensPerSecond: generationMs > 0 ? (generated.length * 1000) / generationMs : 0
    }
    return {
      content: split.content.trim(),
      ...(split.thinking.trim() ? { thinking: split.thinking.trim() } : {}),
      ms: Date.now() - started,
      promptTokens: promptLength,
      completionTokens: generated.length,
      thinkingLevel,
      stats
    }
  }

  async function completeChat(
    modelKey: LfmModelKey,
    messages: ManagedOnnxChatMessage[],
    options: ManagedOnnxChatOptions = {}
  ): Promise<ManagedOnnxChatResult> {
    if (!isLfmModelKey(modelKey)) throw new Error('Choose a supported LFM3 ONNX model')
    if (!messages.length) throw new Error('At least one prompt message is required')
    return withLock(async () => {
      cancelIdleTimer()
      const ready = await ensureLoaded(modelKey)
      try {
        return await runDecoder(ready, messages, options)
      } finally {
        scheduleIdleUnload()
      }
    })
  }

  async function removeModel(modelKey: LfmModelKey): Promise<void> {
    if (!isLfmModelKey(modelKey)) throw new Error('Choose a supported LFM3 ONNX model')
    pauseDownload(modelKey)
    await downloads.get(modelKey)?.promise?.catch(() => undefined)
    await withLock(async () => {
      if (loaded?.modelKey === modelKey) await unloadLoadedModel()
      const directory = modelDirectory(modelKey)
      const firstArtifact = getArtifactList(modelKey)[0]
      if (firstArtifact) safeArtifactPath(directory, firstArtifact)
      rmSync(directory, { recursive: true, force: true })
      downloads.delete(modelKey)
    })
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    closing = true
    const pendingDownloads = [...downloads.values()].map((item) => item.promise).filter(Boolean) as Promise<void>[]
    pauseAllDownloads()
    cancelIdleTimer()
    const cleanup = (async () => {
      if (pendingDownloads.length) await Promise.allSettled(pendingDownloads)
      await withLock(async () => unloadLoadedModel(), true)
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Managed ONNX shutdown did not finish within ${SHUTDOWN_GRACE_MS / 1000} seconds; a native inference call may still be active.`
            )
          ),
        SHUTDOWN_GRACE_MS
      )
    })
    shutdownPromise = Promise.race([cleanup, deadline])
      .catch((error: unknown) => {
        shutdownPromise = null
        throw error
      })
      .finally(() => {
        if (timer) clearTimeout(timer)
      })
    return shutdownPromise
  }

  return {
    status,
    downloadModel,
    pauseDownload,
    pauseAllDownloads,
    loadModel,
    unloadModel,
    removeModel,
    completeChat,
    shutdown
  }
}

export const managedOnnxRuntime = createManagedOnnxRuntime()
export const getManagedOnnxStatus = managedOnnxRuntime.status
export const downloadManagedOnnxModel = managedOnnxRuntime.downloadModel
export const pauseManagedOnnxDownload = managedOnnxRuntime.pauseDownload
export const loadManagedOnnxModel = managedOnnxRuntime.loadModel
export const unloadManagedOnnxModel = managedOnnxRuntime.unloadModel
export const removeManagedOnnxModel = managedOnnxRuntime.removeModel
export const completeManagedOnnxChat = managedOnnxRuntime.completeChat
export const shutdownManagedOnnx = managedOnnxRuntime.shutdown

onProxyChanging(() => managedOnnxRuntime.pauseAllDownloads())
