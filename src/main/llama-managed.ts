import { createHash } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, freemem } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProxySettings } from '../shared/proxy-settings'
import { getLfmModelByKey, LFM_CATALOG, type LfmArtifact, type LfmModel, type LfmModelKey } from '../shared/lfm-catalog'
import type { ManagedLfmDownloadProgress, ManagedLfmModelStatus, ManagedLfmStatus } from '../shared/managed-llm'
import { createModelDownloadProxy, type ModelDownloadProxy } from './model-download-proxy'
import { getProxySettings, isProxyTransitioning, onProxyChanging } from './proxy-state'
import { modelDownloadEnvironment } from './stt'
import { appDataDir } from './vault'
import { loopbackPortOwnedByPid } from './loopback-owner'

const BUNDLE_TAG = 'b11946'
const BUNDLE_SHA256 = 'd618da5e7bbb19077f086e6a7e1d77eab55b9bfd481f7531aadada86d13db9ed'
const IDLE_STOP_MS = 10 * 60 * 1000
const START_TIMEOUT_MS = 120_000
const MAX_IMAGE_CONTEXT = 8192
const FREE_SPACE_RESERVE = 256 * 1024 * 1024
const TEXT_RAM_ESTIMATE = 4_000_000_000
const VISION_RAM_ESTIMATE = 6_000_000_000
const MIN_TEXT_FREE_RAM = 2_500_000_000
const MIN_VISION_FREE_RAM = 4_000_000_000

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>
type SpawnChild = (command: string, args: string[], options?: SpawnOptions) => ChildProcess
type ArtifactVerifier = (filePath: string, artifact: LfmArtifact) => Promise<void>

type DownloadProxyFactory = (settings: ProxySettings, isBlocked: () => boolean) => Promise<ModelDownloadProxy>

export interface ManagedLfmEndpoint {
  baseUrl: string
  model: string
  modelKey: LfmModelKey
  pid: number
}

export interface ManagedLfmRuntimeDependencies {
  getBinaryPath?: () => string | null
  getUserDataDir?: () => string | null
  supportedPlatform?: () => boolean
  platformName?: () => string
  spawnChild?: SpawnChild
  fetcher?: Fetcher
  verifyArtifact?: ArtifactVerifier
  curlCommand?: string
  getProxySettings?: () => ProxySettings
  isProxyTransitioning?: () => boolean
  createDownloadProxy?: DownloadProxyFactory
  portOwnedByPid?: (pid: number, port: number) => boolean
}

interface RunningServer extends ManagedLfmEndpoint {
  child: ChildProcess
  stderr: string
}

interface ActiveDownload {
  child?: ChildProcess
  closeProxy?: () => void
  paused: boolean
  progress: ManagedLfmDownloadProgress
  promise?: Promise<void>
}

function artifactList(model: LfmModel): LfmArtifact[] {
  return [model.artifacts.model, ...(model.artifacts.projector ? [model.artifacts.projector] : [])]
}

function modelBytes(model: LfmModel): number {
  return artifactList(model).reduce((sum, artifact) => sum + artifact.bytes, 0)
}

export function llamaServerArgs(
  model: LfmModel,
  modelPath: string,
  projectorPath: string | null,
  port: number,
  threadCount = 4
): string[] {
  const args = [
    '--model',
    modelPath,
    '--alias',
    model.apiModelId,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--ctx-size',
    String(MAX_IMAGE_CONTEXT),
    '--parallel',
    '1',
    '--threads',
    String(Math.max(1, Math.min(8, Math.round(threadCount)))),
    '--n-gpu-layers',
    'auto',
    '--no-webui'
  ]
  if (projectorPath) args.push('--mmproj', projectorPath)
  else args.push('--no-mmproj')
  return args
}

export function llamaServerPath(
  resourcesPath: string | undefined = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  cwd = process.cwd(),
  exists: (path: string) => boolean = existsSync
): string | null {
  const candidates = [
    resourcesPath ? join(resourcesPath, 'bin', 'llama', 'llama-server') : '',
    join(cwd, 'llm', 'bin', 'llama-server')
  ].filter(Boolean)
  return candidates.find(exists) ?? null
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function verifyArtifactFile(filePath: string, artifact: LfmArtifact): Promise<void> {
  if (!existsSync(filePath)) throw new Error(`Missing model file ${artifact.file}`)
  const size = statSync(filePath).size
  if (size !== artifact.bytes) throw new Error(`${artifact.file} has ${size} bytes; expected ${artifact.bytes}`)
  const actual = await sha256File(filePath)
  if (actual.toLowerCase() !== artifact.sha256.toLowerCase())
    throw new Error(`${artifact.file} failed SHA-256 verification`)
}

function isModelKey(value: unknown): value is LfmModelKey {
  return typeof value === 'string' && Object.hasOwn(LFM_CATALOG, value)
}

function processPlatformName(): string {
  return `${process.platform}-${process.arch}`
}

function defaultDataDir(): string | null {
  return appDataDir()
}

function defaultSupportedPlatform(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64'
}

function safeLastError(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' · ')
    .slice(-600)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

async function findLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not reserve a local llama-server port')
  }
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

async function hashIfComplete(filePath: string, artifact: LfmArtifact): Promise<boolean> {
  try {
    await verifyArtifactFile(filePath, artifact)
    return true
  } catch {
    return false
  }
}

export function createManagedLfmRuntime(dependencies: ManagedLfmRuntimeDependencies = {}) {
  const getBinaryPath = dependencies.getBinaryPath ?? (() => llamaServerPath())
  const getUserDataDir = dependencies.getUserDataDir ?? defaultDataDir
  const supportedPlatform = dependencies.supportedPlatform ?? defaultSupportedPlatform
  const platformName = dependencies.platformName ?? processPlatformName
  const spawnChild = dependencies.spawnChild ?? (spawn as SpawnChild)
  const fetcher = dependencies.fetcher ?? ((input, init) => fetch(input, init))
  const verifyArtifact = dependencies.verifyArtifact ?? verifyArtifactFile
  const curlCommand = dependencies.curlCommand ?? 'curl'
  const getProxy = dependencies.getProxySettings ?? getProxySettings
  const proxyTransitioning = dependencies.isProxyTransitioning ?? isProxyTransitioning
  const createProxy = dependencies.createDownloadProxy ?? createModelDownloadProxy
  const portOwnedByPid = dependencies.portOwnedByPid ?? loopbackPortOwnedByPid

  let running: RunningServer | null = null
  let starting: Promise<ManagedLfmEndpoint> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let inFlightRequests = 0
  const downloads = new Map<LfmModelKey, ActiveDownload>()

  function userDataDir(): string {
    const value = getUserDataDir()
    if (!value) throw new Error('Inkfish app data is not initialized yet')
    return value
  }

  function modelDirectory(key: LfmModelKey): string {
    if (!isModelKey(key)) throw new Error('Unknown LFM3 model')
    return join(userDataDir(), 'lfm-models', key)
  }

  function artifactPath(key: LfmModelKey, artifact: LfmArtifact): string {
    return join(modelDirectory(key), artifact.file)
  }

  function installedBytes(key: LfmModelKey): number {
    const model = getLfmModelByKey(key)
    if (!model) return 0
    return artifactList(model).reduce((sum, artifact) => {
      const file = artifactPath(key, artifact)
      try {
        return sum + Math.min(statSync(file).size, artifact.bytes)
      } catch {
        return sum
      }
    }, 0)
  }

  function installed(key: LfmModelKey): boolean {
    const model = getLfmModelByKey(key)
    if (!model) return false
    return artifactList(model).every((artifact) => {
      try {
        return statSync(artifactPath(key, artifact)).size === artifact.bytes
      } catch {
        return false
      }
    })
  }

  function status(): ManagedLfmStatus {
    const supported = supportedPlatform()
    const binary = getBinaryPath()
    let dir: string | null = null
    try {
      dir = getUserDataDir()
    } catch {
      dir = null
    }
    const models = (Object.keys(LFM_CATALOG) as LfmModelKey[]).map((key): ManagedLfmModelStatus => {
      const model = LFM_CATALOG[key]
      let currentProgress: ManagedLfmDownloadProgress | undefined
      try {
        currentProgress = downloads.get(key)?.progress
      } catch {
        currentProgress = undefined
      }
      let downloadedBytes = 0
      let isInstalled = false
      if (dir) {
        try {
          downloadedBytes = installedBytes(key)
          isInstalled = installed(key)
        } catch {
          // An unavailable app-data path is reported in `detail` below.
        }
      }
      return {
        modelKey: key,
        apiModelId: model.apiModelId,
        name: model.name,
        installed: isInstalled,
        downloadedBytes,
        totalBytes: modelBytes(model),
        estimatedRamBytes: key === 'lfm3-vl-2b' ? VISION_RAM_ESTIMATE : TEXT_RAM_ESTIMATE,
        ...(currentProgress ? { progress: currentProgress } : {})
      }
    })
    let version: string | undefined
    let bundleDigest: string | undefined
    if (binary) {
      try {
        const marker = readFileSync(join(dirname(binary), 'VERSION'), 'utf8')
        version = marker.match(/^tag=(.+)$/m)?.[1]
        bundleDigest = marker.match(/^sha256=(.+)$/m)?.[1]
      } catch {
        version = undefined
        bundleDigest = undefined
      }
    }
    const binaryReady = Boolean(binary && version === BUNDLE_TAG && bundleDigest === BUNDLE_SHA256)
    const base = running?.baseUrl
    const detail = !supported
      ? `Managed llama.cpp is bundled for macOS Apple silicon only; this device is ${platformName()}.`
      : !binary
        ? 'The pinned llama-server bundle is missing. Rebuild or run the llama:fetch script on macOS Apple silicon.'
        : !binaryReady
          ? `The llama-server bundle is not the verified ${BUNDLE_TAG} build. Rebuild or run the llama:fetch script.`
          : !dir
            ? 'Inkfish app data is not initialized yet.'
            : running
              ? `llama.cpp ${version ?? BUNDLE_TAG} is running locally on port ${new URL(base as string).port}.`
              : `llama.cpp ${version ?? BUNDLE_TAG} is ready; the server starts on demand and stops after 10 minutes idle.`
    return {
      supportedPlatform: supported,
      platform: platformName(),
      binaryReady,
      ...(version ? { binaryVersion: version } : {}),
      running: Boolean(running),
      ...(running ? { runningModelKey: running.modelKey, pid: running.pid, baseUrl: running.baseUrl } : {}),
      detail,
      models
    }
  }

  function emitProgress(
    download: ActiveDownload,
    onProgress: (progress: ManagedLfmDownloadProgress) => void,
    patch: Partial<ManagedLfmDownloadProgress>
  ): void {
    download.progress = { ...download.progress, ...patch }
    onProgress(download.progress)
  }

  async function downloadOneArtifact(
    key: LfmModelKey,
    artifact: LfmArtifact,
    download: ActiveDownload,
    proxyUrl: string,
    onProgress: (progress: ManagedLfmDownloadProgress) => void,
    completedBefore: number,
    totalBytes: number
  ): Promise<boolean> {
    const directory = modelDirectory(key)
    mkdirSync(directory, { recursive: true })
    const destination = artifactPath(key, artifact)
    if (await hashIfComplete(destination, artifact)) return true
    rmSync(destination, { force: true })
    const part = `${destination}.part`
    try {
      if (statSync(part).size > artifact.bytes) rmSync(part, { force: true })
    } catch {
      // Partial file doesn't exist yet.
    }
    try {
      if (statSync(part).size === artifact.bytes) {
        if (await hashIfComplete(part, artifact)) {
          renameSync(part, destination)
          return true
        }
        rmSync(part, { force: true })
      }
    } catch {
      // Partial is absent; curl will create it.
    }

    const url = `https://huggingface.co/${artifact.repo}/resolve/main/${encodeURIComponent(artifact.file)}?download=true`
    const env = modelDownloadEnvironment(safeChildEnvironment(), proxyUrl)
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
      url
    ]
    let stderr = ''
    let settled = false
    const progressBytes = (): number => {
      try {
        return Math.min(statSync(part).size, artifact.bytes)
      } catch {
        return 0
      }
    }
    const update = (): void => {
      const bytes = Math.min(totalBytes, completedBefore + progressBytes())
      emitProgress(download, onProgress, {
        state: 'downloading',
        bytes,
        fraction: totalBytes ? bytes / totalBytes : 0,
        file: artifact.file
      })
    }
    update()
    const timer = setInterval(update, 400)
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawnChild(curlCommand, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
        download.child = child
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8000)
        })
        child.once('error', (error) => reject(new Error(`Could not start the model downloader: ${error.message}`)))
        child.once('close', (code, signal) => {
          download.child = undefined
          if (download.paused) resolve()
          else if (code === 0) resolve()
          else reject(new Error(safeLastError(stderr) || `curl exited ${code ?? signal ?? 'unknown'}`))
        })
      })
      settled = true
      if (download.paused) return false
      if (!(await hashIfComplete(part, artifact))) {
        const current = existsSync(part) ? statSync(part).size : 0
        throw new Error(`${artifact.file} failed size/SHA-256 verification after download (${current} bytes)`)
      }
      renameSync(part, destination)
      emitProgress(download, onProgress, {
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
    onProgress: (progress: ManagedLfmDownloadProgress) => void = () => {}
  ): Promise<void> {
    if (!isModelKey(modelKey)) throw new Error('Choose a supported LFM3 model')
    if (!acceptedLicense) throw new Error('Review and accept the LFM Open License before downloading model weights')
    if (!supportedPlatform())
      throw new Error(
        `Managed llama.cpp is not available on ${platformName()}; supported platform: macOS Apple silicon`
      )
    if (proxyTransitioning())
      throw new Error('Model downloads are paused while network routing changes. Retry after saving Network settings.')
    const model = getLfmModelByKey(modelKey)!
    const existing = downloads.get(modelKey)
    if (existing && existing.progress.state === 'downloading' && existing.promise) return existing.promise
    const pending = [...downloads.values()].find((item) => item.promise)
    if (pending?.progress.state === 'downloading')
      throw new Error('Only one managed LFM model can download at a time. Pause the current download first.')
    if (pending?.promise) await pending.promise.catch(() => undefined)
    if ([...downloads.values()].some((item) => item.progress.state === 'downloading'))
      throw new Error('Only one managed LFM model can download at a time. Pause the current download first.')
    const totalBytes = modelBytes(model)
    const dataDir = userDataDir()
    mkdirSync(dataDir, { recursive: true })
    let required = FREE_SPACE_RESERVE
    for (const artifact of artifactList(model)) {
      const destination = artifactPath(modelKey, artifact)
      if (await hashIfComplete(destination, artifact)) continue
      let destinationBytes = 0
      let partialBytes = 0
      try {
        destinationBytes = statSync(destination).size
      } catch {
        // Missing final artifact.
      }
      try {
        partialBytes = statSync(`${destination}.part`).size
      } catch {
        // No resumable partial yet.
      }
      required += Math.max(
        0,
        artifact.bytes - Math.min(artifact.bytes, destinationBytes) - Math.min(artifact.bytes, partialBytes)
      )
    }
    let free: number
    try {
      const fileSystem = statfsSync(dataDir)
      free = fileSystem.bavail * fileSystem.bsize
    } catch {
      throw new Error('Could not check free disk space for the model download.')
    }
    if (free < required)
      throw new Error(
        `Not enough free disk space: need about ${(required / 1e9).toFixed(1)} GB, have ${(free / 1e9).toFixed(1)} GB.`
      )

    const download: ActiveDownload = {
      paused: false,
      progress: {
        modelKey,
        state: 'downloading',
        fraction: 0,
        bytes: installedBytes(modelKey),
        totalBytes
      }
    }
    downloads.set(modelKey, download)

    const promise = (async (): Promise<void> => {
      let proxy: ModelDownloadProxy | undefined
      try {
        proxy = await createProxy(getProxy(), () => download.paused || proxyTransitioning())
        download.closeProxy = proxy.close
        const items = artifactList(model)
        let completed = 0
        for (const artifact of items) {
          if (download.paused || proxyTransitioning()) {
            emitProgress(download, onProgress, { state: 'paused' })
            return
          }
          const done = await downloadOneArtifact(
            modelKey,
            artifact,
            download,
            proxy.url,
            onProgress,
            completed,
            totalBytes
          )
          if (!done) {
            emitProgress(download, onProgress, { state: 'paused' })
            return
          }
          completed += artifact.bytes
        }
        emitProgress(download, onProgress, {
          state: 'done',
          fraction: 1,
          bytes: totalBytes,
          file: undefined,
          error: undefined
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emitProgress(download, onProgress, {
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
    download.progress = { ...download.progress, state: 'paused' }
  }

  function pauseAllDownloads(): void {
    for (const modelKey of downloads.keys()) pauseDownload(modelKey)
  }

  function cancelIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  function scheduleIdleStop(): void {
    cancelIdleTimer()
    if (!running || inFlightRequests > 0) return
    idleTimer = setTimeout(() => {
      void stopServer()
    }, IDLE_STOP_MS)
    idleTimer.unref?.()
  }

  async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return true
    return new Promise((resolve) => {
      let done = false
      const finish = (exited: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        child.removeListener('exit', onExit)
        resolve(exited)
      }
      const onExit = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      child.once('exit', onExit)
    })
  }

  async function stopServer(force = false): Promise<void> {
    if (inFlightRequests > 0 && !force)
      throw new Error('Wait for the active local intelligence request to finish before stopping llama-server.')
    cancelIdleTimer()
    const old = running
    if (!old) return
    old.child.kill('SIGTERM')
    if (!(await waitForExit(old.child, 3000))) {
      old.child.kill('SIGKILL')
      if (!(await waitForExit(old.child, 1000)))
        throw new Error(`llama-server process ${old.pid} did not exit after SIGKILL; Inkfish will stay open.`)
    }
    if (running?.child === old.child) running = null
  }

  async function launch(modelKey: LfmModelKey): Promise<ManagedLfmEndpoint> {
    const model = getLfmModelByKey(modelKey)
    if (!model) throw new Error('Choose a supported LFM3 model')
    if (!supportedPlatform())
      throw new Error(
        `Managed llama.cpp is not available on ${platformName()}; supported platform: macOS Apple silicon`
      )
    const binary = getBinaryPath()
    if (!binary || !status().binaryReady)
      throw new Error(
        'The verified llama-server bundle is missing. Rebuild or run `bun run llama:fetch` on macOS Apple silicon, then restart Inkfish.'
      )
    if (!installed(modelKey)) throw new Error(`${model.name} weights are not fully downloaded. Download them first.`)
    for (const artifact of artifactList(model)) await verifyArtifact(artifactPath(modelKey, artifact), artifact)
    const minimumFreeRam = modelKey === 'lfm3-vl-2b' ? MIN_VISION_FREE_RAM : MIN_TEXT_FREE_RAM
    if (freemem() < minimumFreeRam)
      throw new Error(
        `At least ${(minimumFreeRam / 1e9).toFixed(1)} GB of free memory is recommended for this model. Close other apps and retry.`
      )
    const modelPath = artifactPath(modelKey, model.artifacts.model)
    const projectorPath = model.artifacts.projector ? artifactPath(modelKey, model.artifacts.projector) : null
    const port = await findLoopbackPort()
    const args = llamaServerArgs(model, modelPath, projectorPath, port, cpus().length)
    const child = spawnChild(binary, args, {
      cwd: dirname(binary),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: safeChildEnvironment()
    })
    if (!child.pid) {
      child.kill('SIGKILL')
      throw new Error('Could not determine the managed llama-server process ID.')
    }
    const endpoint: ManagedLfmEndpoint = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: model.apiModelId,
      modelKey,
      pid: child.pid
    }
    const current: RunningServer = { ...endpoint, child, stderr: '' }
    running = current
    child.stderr?.on('data', (chunk: Buffer) => {
      current.stderr = (current.stderr + chunk.toString()).slice(-16_000)
    })
    child.once('exit', () => {
      if (running?.child === child) {
        running = null
        cancelIdleTimer()
      }
    })
    child.once('error', () => {
      if (running?.child === child) running = null
    })

    const startedAt = Date.now()
    let ready = false
    let readinessError = ''
    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (child.exitCode !== null) break
      try {
        const response = await fetcher(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          if (!portOwnedByPid(endpoint.pid, port)) {
            readinessError = `Refusing to use port ${port}: it is not owned by the launched llama-server process ${endpoint.pid}.`
            break
          }
          const modelsResponse = await fetcher(`http://127.0.0.1:${port}/v1/models`, {
            signal: AbortSignal.timeout(1000)
          })
          if (modelsResponse.ok) {
            const body = (await modelsResponse.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null
            const advertised = body?.data?.some(
              (item) => typeof item.id === 'string' && item.id.toLowerCase() === model.apiModelId.toLowerCase()
            )
            if (!advertised) {
              readinessError = `The launched llama-server did not advertise the selected model ID ${model.apiModelId}.`
              break
            }
            ready = true
            break
          }
        }
      } catch {
        // The local model is still loading or the health endpoint is not ready yet.
      }
      await wait(300)
    }
    if (!ready) {
      const message = safeLastError(current.stderr)
      await stopServer()
      throw new Error(
        readinessError ||
          (message
            ? `llama-server did not become ready: ${message}`
            : 'llama-server did not become ready within 2 minutes')
      )
    }
    scheduleIdleStop()
    return endpoint
  }

  async function ensureServer(modelKey: LfmModelKey): Promise<ManagedLfmEndpoint> {
    if (!isModelKey(modelKey)) throw new Error('Choose a supported LFM3 model')
    if (running?.modelKey === modelKey && running.child.exitCode === null) {
      scheduleIdleStop()
      return running
    }
    if (running && inFlightRequests > 0)
      throw new Error(
        'llama-server is busy processing another model; wait for that request to finish before switching models'
      )
    if (starting) await starting.catch(() => undefined)
    if (running?.modelKey === modelKey && running.child.exitCode === null) return running
    if (running) await stopServer()
    starting = launch(modelKey)
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  async function withServer<T>(modelKey: LfmModelKey, fn: (endpoint: ManagedLfmEndpoint) => Promise<T>): Promise<T> {
    const endpoint = await ensureServer(modelKey)
    inFlightRequests++
    cancelIdleTimer()
    try {
      return await fn(endpoint)
    } finally {
      inFlightRequests = Math.max(0, inFlightRequests - 1)
      scheduleIdleStop()
    }
  }

  async function removeModel(modelKey: LfmModelKey): Promise<void> {
    if (!isModelKey(modelKey)) throw new Error('Choose a supported LFM3 model')
    if (running?.modelKey === modelKey && inFlightRequests > 0)
      throw new Error('Wait for the active local intelligence request to finish before removing this model.')
    const download = downloads.get(modelKey)
    pauseDownload(modelKey)
    await download?.promise?.catch(() => undefined)
    if (running?.modelKey === modelKey) await stopServer()
    downloads.delete(modelKey)
    rmSync(modelDirectory(modelKey), { recursive: true, force: true })
  }

  async function shutdown(): Promise<void> {
    const pendingDownloads = [...downloads.values()]
      .map((download) => download.promise)
      .filter(Boolean) as Promise<void>[]
    pauseAllDownloads()
    cancelIdleTimer()
    if (pendingDownloads.length) await Promise.allSettled(pendingDownloads)
    await stopServer(true)
  }

  return {
    status,
    downloadModel,
    pauseDownload,
    pauseAllDownloads,
    ensureServer,
    withServer,
    stopServer,
    removeModel,
    shutdown
  }
}

export const managedLfmRuntime = createManagedLfmRuntime()
export const getManagedLfmStatus = managedLfmRuntime.status
export const downloadManagedLfmModel = managedLfmRuntime.downloadModel
export const pauseManagedLfmDownload = managedLfmRuntime.pauseDownload
export const startManagedLfmServer = managedLfmRuntime.ensureServer
export const stopManagedLfmServer = managedLfmRuntime.stopServer
export const removeManagedLfmModel = managedLfmRuntime.removeModel
export const withManagedLfmServer = managedLfmRuntime.withServer
export const shutdownManagedLfm = managedLfmRuntime.shutdown

onProxyChanging(() => managedLfmRuntime.pauseAllDownloads())
