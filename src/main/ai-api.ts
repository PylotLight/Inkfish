import {
  BrowserWindow,
  ipcMain,
  safeStorage,
  session,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess
} from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stopUtilityProcess } from './utility-process'
import { isConnected, parseAiSettings, type AiApiStatus, type AiTestResult } from '../shared/ai-api'
import { AI_APIS, learnEndpoint, type AiApi, type AiEndpoint, type DiscoveryResult } from '../shared/ai-models'
import { formatAiError, scrubDetail, toErrorDetail, type AiErrorDetail } from '../shared/ai-errors'
import { discoverModels } from './ai-discovery'
import { applySettingsPatch, parseStoredAi, settingsOnly, type StoredAi } from './ai-store'
import { parseProcessedEntry, type ProcessedEntry } from '../shared/ai-process'
import { complete, createProvider, type ProviderConfig } from './ai-providers'
import { appDataDir } from './vault'

/**
 * Settings › AI + Electron 45's native AI integration.
 *
 * When connected, main forks one utility process (ai-handler.ts) and registers it on the app
 * session with `session.defaultSession.registerLocalAIHandler(child)`, so the renderer's standard
 * Prompt API (`LanguageModel.create()` / `promptStreaming()`) is answered by the user's provider.
 * Disconnected (the default): `registerLocalAIHandler(null)`, nothing forked.
 *
 * The API key is sealed with the async safeStorage API (OS keychain) in `ai-provider.json` and only
 * decrypted here to hand to the utility process in memory. It is never logged, never sent to a
 * renderer, and never written in plaintext (no keychain = key not saved).
 *
 * Also stores the Processed-view cache (one JSON per note in `ai-processed/`), so a processed
 * version survives restarts and is marked stale when the raw note changes.
 */

const RESPAWN_LIMIT = 3
const RESPAWN_WINDOW_MS = 60_000

let stored: StoredAi | null = null
let child: UtilityProcess | null = null
let respawns: number[] = []

function settingsPath(): string | null {
  const dir = appDataDir()
  return dir ? join(dir, 'ai-provider.json') : null
}

function load(): StoredAi {
  if (stored) return stored
  let raw: unknown = {}
  try {
    const p = settingsPath()
    if (p && existsSync(p)) raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    raw = {}
  }
  stored = parseStoredAi(raw)
  return stored
}

function persist(next: StoredAi): void {
  stored = next
  const p = settingsPath()
  if (!p) return
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 })
}

async function keychain(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    return false
  }
}

async function decryptKey(): Promise<string | null> {
  const s = load()
  if (!s.keyEnc) return null
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(s.keyEnc, 'base64'))
    if (shouldReEncrypt) {
      try {
        persist({ ...load(), keyEnc: (await safeStorage.encryptStringAsync(result)).toString('base64') })
      } catch {
        // keep the readable ciphertext; retry next launch
      }
    }
    return result
  } catch {
    console.warn('[ai] stored API key could not be decrypted (keychain changed?) — re-enter it in Settings › AI')
    return null
  }
}

async function providerConfig(): Promise<ProviderConfig> {
  const s = load()
  return { kind: s.kind, baseUrl: s.baseUrl, model: s.model, models: s.models, api: s.api, apiKey: await decryptKey() }
}

/**
 * Auto API learned that `modelId` needs `endpoint` (a responses-only model): save it on the model
 * so the next request goes straight there. Not a user edit; Re-detect may refine it.
 */
export function rememberEndpoint(modelId: string, endpoint: AiEndpoint): void {
  const cur = load()
  if (!cur.models.some((m) => m.id === modelId)) return
  if (cur.models.find((m) => m.id === modelId)?.endpoint === endpoint) return
  persist({ ...cur, models: learnEndpoint(cur.models, modelId, endpoint) })
  console.log(
    `[ai] ${modelId}: using ${endpoint === 'responses' ? 'the Responses API' : 'Chat Completions'} from now on (Auto)`
  )
  // Keep the handler's copy in step (learned in Test connection, or confirm the child's own),
  // and open Settings windows, so a later save doesn't overwrite what was learned.
  void applyAi()
    .then(() => aiStatus())
    .then((st) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('ai-api:changed', st)
    })
    .catch(() => undefined)
}

/** The handler's last failed request (scrubbed), for a renderer that only got Electron's kErrorUnknown. */
let lastError: { detail: AiErrorDetail; at: number } | null = null
const lastErrorWaiters = new Set<() => void>()

function setLastError(detail: AiErrorDetail, at = Date.now()): void {
  lastError = { detail: scrubDetail(detail), at }
  console.warn(`[ai] request failed: ${formatAiError(lastError.detail)}`)
  for (const w of lastErrorWaiters) w()
  lastErrorWaiters.clear()
}

/** Last error newer than `since` (ms epoch); waits up to `waitMs` for one still in flight. */
export async function getLastError(since = 0, waitMs = 1500): Promise<AiErrorDetail | null> {
  const fresh = (): AiErrorDetail | null => (lastError && lastError.at >= since ? lastError.detail : null)
  if (fresh() || waitMs <= 0) return fresh()
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(t)
      lastErrorWaiters.delete(done)
      resolve()
    }
    const t = setTimeout(done, waitMs)
    lastErrorWaiters.add(done)
  })
  return fresh()
}

export async function aiStatus(): Promise<AiApiStatus> {
  const s = load()
  const hasKey = Boolean(s.keyEnc)
  return { settings: settingsOnly(s), hasKey, connected: isConnected(s, hasKey), keychain: await keychain() }
}

// --- utility process + session registration ------------------------------------------------

function handlerPath(): string | null {
  const p = join(__dirname, 'ai-handler.js')
  return existsSync(p) ? p : null
}

function ensureChild(): UtilityProcess | null {
  if (child) return child
  const path = handlerPath()
  if (!path) {
    console.warn('[ai] handler script missing; AI unavailable')
    return null
  }
  const now = Date.now()
  respawns = respawns.filter((at) => now - at < RESPAWN_WINDOW_MS)
  if (respawns.length >= RESPAWN_LIMIT) {
    console.warn('[ai] handler keeps exiting; AI stays off until settings change')
    return null
  }
  respawns.push(now)
  const forked = utilityProcess.fork(path, [], { serviceName: 'Inkfish AI', stdio: 'inherit' })
  forked.on(
    'message',
    (msg: { type?: string; model?: unknown; endpoint?: unknown; detail?: AiErrorDetail; at?: number }) => {
      if (
        msg?.type === 'learned' &&
        typeof msg.model === 'string' &&
        (msg.endpoint === 'chat' || msg.endpoint === 'responses')
      )
        rememberEndpoint(msg.model, msg.endpoint)
      else if (msg?.type === 'error' && msg.detail && typeof msg.detail.message === 'string')
        setLastError(msg.detail, Number(msg.at) || Date.now())
    }
  )
  forked.once('exit', (code) => {
    if (child !== forked) return
    child = null
    console.warn(`[ai] handler exited (${code})`)
    void applyAi()
  })
  child = forked
  return forked
}

let applying: Promise<void> = Promise.resolve()

/** Bring the handler in line with the settings: fork + register when connected, tear down when not. */
export function applyAi(): Promise<void> {
  applying = applying.then(async () => {
    const status = await aiStatus()
    const handler = status.connected ? ensureChild() : null
    if (handler) handler.postMessage({ type: 'config', config: await providerConfig() })
    try {
      session.defaultSession.registerLocalAIHandler(handler)
    } catch (err) {
      console.warn('[ai] registerLocalAIHandler failed:', err instanceof Error ? err.message : String(err))
    }
    if (!handler && child) {
      const old = child
      child = null
      stopUtilityProcess(old)
    }
  })
  return applying
}

export async function setAiSettings(patch: unknown): Promise<AiApiStatus> {
  persist(applySettingsPatch(load(), patch))
  respawns = []
  await applyAi()
  return aiStatus()
}

/** Seal and store the key; saving one also switches AI on (the user just connected it). */
export async function setAiKey(key: string): Promise<AiApiStatus> {
  const trimmed = String(key ?? '').trim()
  if (!trimmed) throw new Error('API key is empty')
  if (!(await keychain())) throw new Error('The OS keychain is unavailable, so the key was not saved.')
  const keyEnc = (await safeStorage.encryptStringAsync(trimmed)).toString('base64')
  persist({ ...load(), keyEnc, enabled: true })
  respawns = []
  await applyAi()
  return aiStatus()
}

export async function clearAiKey(): Promise<AiApiStatus> {
  const { keyEnc: _drop, ...rest } = load()
  persist(rest)
  await applyAi()
  return aiStatus()
}

/**
 * One tiny request with the saved (or patched, unsaved) settings. `patch.testModel` picks the model
 * (default: the active one) and `patch.testApi` forces an API for this test; otherwise the model's
 * own setting applies (Auto may switch to Responses and remember it, like a real run).
 */
export async function testAi(patch?: unknown): Promise<AiTestResult> {
  const cur = load()
  const p = typeof patch === 'object' && patch !== null ? (patch as Record<string, unknown>) : {}
  const s = parseAiSettings(p, settingsOnly(cur))
  const modelId = typeof p.testModel === 'string' && p.testModel ? p.testModel : s.model
  const forced = AI_APIS.includes(p.testApi as AiApi) ? (p.testApi as AiApi) : undefined
  const t0 = Date.now()
  const cfg: ProviderConfig = {
    kind: s.kind,
    baseUrl: s.baseUrl,
    model: modelId,
    models: s.models.map((m) => ({ ...m })),
    api: s.api,
    apiKey: await decryptKey(),
    onLearn: (id, endpoint) => rememberEndpoint(id, endpoint)
  }
  const provider = createProvider(cfg)
  const endpointLabel = (): string | undefined => {
    const e = provider.lastRequest?.endpoint
    return e === 'responses'
      ? 'Responses'
      : e === 'chat'
        ? 'Chat Completions'
        : e === 'messages'
          ? 'Messages'
          : undefined
  }
  const run = forced && forced !== 'auto' ? { model: modelId, api: forced } : { model: modelId }
  try {
    const reply = await complete(
      provider,
      [
        { role: 'system', content: 'You are a connection test. Reply with the single word OK.' },
        { role: 'user', content: 'Say OK.' }
      ],
      AbortSignal.timeout(30_000),
      run
    )
    return {
      ok: true,
      ms: Date.now() - t0,
      detail: reply.trim().slice(0, 80) || '(empty reply)',
      model: modelId,
      endpoint: endpointLabel()
    }
  } catch (err) {
    const detail = scrubDetail(
      toErrorDetail(err, { provider: s.kind === 'anthropic' ? 'Anthropic' : 'AI provider', model: modelId }),
      cfg.apiKey
    )
    return {
      ok: false,
      ms: Date.now() - t0,
      detail: formatAiError(detail),
      model: modelId,
      endpoint: endpointLabel(),
      error: detail
    }
  }
}

/** Find models: query the provider (saved settings, or a patched kind/base URL) from main. */
export async function discoverAi(patch?: unknown): Promise<DiscoveryResult> {
  const cur = load()
  const s = parseAiSettings(typeof patch === 'object' && patch !== null ? patch : {}, settingsOnly(cur))
  try {
    return await discoverModels({ kind: s.kind, baseUrl: s.baseUrl, apiKey: await decryptKey() })
  } catch (err) {
    return { models: [], sources: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// --- processed-view cache ------------------------------------------------------------------

function processedPath(noteId: string): string | null {
  const dir = appDataDir()
  if (!dir) return null
  return join(dir, 'ai-processed', `${createHash('sha1').update(noteId).digest('hex')}.json`)
}

export function getProcessed(noteId: string): ProcessedEntry | null {
  try {
    const p = processedPath(noteId)
    if (!p || !existsSync(p)) return null
    const entry = parseProcessedEntry(JSON.parse(readFileSync(p, 'utf8')))
    return entry && entry.noteId === noteId ? entry : null
  } catch {
    return null
  }
}

export function setProcessed(entry: unknown): boolean {
  const e = parseProcessedEntry(entry)
  if (!e) return false
  const p = processedPath(e.noteId)
  if (!p) return false
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(e))
  return true
}

export function clearProcessed(noteId: string): boolean {
  const p = processedPath(noteId)
  if (p && existsSync(p)) rmSync(p, { force: true })
  return true
}

// --- routing -------------------------------------------------------------------------------

/** A provider is set up (no key decrypt — cheap enough for the capture's live route preview). */
export function aiConfigured(): boolean {
  const s = load()
  return isConnected(settingsOnly(s), Boolean(s.keyEnc))
}

/**
 * One short completion for the capture router (main process, no renderer). Null when no provider
 * is connected (switched off, or no key for a remote server) — the router then stays on rules.
 */
export async function routeCompletion(system: string, user: string): Promise<string | null> {
  const s = load()
  const apiKey = await decryptKey()
  if (!isConnected(settingsOnly(s), Boolean(apiKey))) return null
  const provider = createProvider({ ...(await providerConfig()), onLearn: (id, e) => rememberEndpoint(id, e) })
  return complete(
    provider,
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    AbortSignal.timeout(20_000)
  )
}

// --- IPC ------------------------------------------------------------------------------------

export function initAiApi(): void {
  ipcMain.handle('ai-api:status', () => aiStatus())
  ipcMain.handle('ai-api:set', (_e: IpcMainInvokeEvent, patch: unknown) => setAiSettings(patch))
  ipcMain.handle('ai-api:set-key', (_e: IpcMainInvokeEvent, key: string) => setAiKey(key))
  ipcMain.handle('ai-api:clear-key', () => clearAiKey())
  ipcMain.handle('ai-api:test', (_e: IpcMainInvokeEvent, patch?: unknown) => testAi(patch))
  ipcMain.handle('ai-api:last-error', (_e: IpcMainInvokeEvent, since?: number) => getLastError(Number(since) || 0))
  ipcMain.handle('ai-api:discover', (_e: IpcMainInvokeEvent, patch?: unknown) => discoverAi(patch))
  ipcMain.handle('ai-api:processed-get', (_e: IpcMainInvokeEvent, noteId: string) => getProcessed(String(noteId)))
  ipcMain.handle('ai-api:processed-set', (_e: IpcMainInvokeEvent, entry: unknown) => setProcessed(entry))
  ipcMain.handle('ai-api:processed-clear', (_e: IpcMainInvokeEvent, noteId: string) => clearProcessed(String(noteId)))
  // Off by default: only forks when a provider is already connected from a previous run.
  void applyAi()
}
