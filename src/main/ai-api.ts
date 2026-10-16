import { ipcMain, safeStorage, session, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isConnected,
  parseAiSettings,
  type AiApiStatus,
  type AiProviderSettings,
  type AiTestResult
} from '../shared/ai-api'
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

interface StoredAi extends AiProviderSettings {
  /** safeStorage ciphertext, base64. */
  keyEnc?: string
}

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
  const keyEnc = typeof (raw as StoredAi).keyEnc === 'string' ? (raw as StoredAi).keyEnc : undefined
  stored = { ...parseAiSettings(raw), ...(keyEnc ? { keyEnc } : {}) }
  return stored
}

function persist(next: StoredAi): void {
  stored = next
  const p = settingsPath()
  if (!p) return
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 })
}

function settingsOnly(s: StoredAi): AiProviderSettings {
  return { enabled: s.enabled, kind: s.kind, baseUrl: s.baseUrl, model: s.model }
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
  return { kind: s.kind, baseUrl: s.baseUrl, model: s.model, apiKey: await decryptKey() }
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
      old.kill()
    }
  })
  return applying
}

export async function setAiSettings(patch: unknown): Promise<AiApiStatus> {
  const cur = load()
  const next = parseAiSettings(typeof patch === 'object' && patch !== null ? patch : {}, settingsOnly(cur))
  persist({ ...next, ...(cur.keyEnc ? { keyEnc: cur.keyEnc } : {}) })
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

/** One tiny request with the saved (or patched, unsaved) settings. */
export async function testAi(patch?: unknown): Promise<AiTestResult> {
  const cur = load()
  const s = parseAiSettings(typeof patch === 'object' && patch !== null ? patch : {}, settingsOnly(cur))
  const t0 = Date.now()
  try {
    const provider = createProvider({ kind: s.kind, baseUrl: s.baseUrl, model: s.model, apiKey: await decryptKey() })
    const reply = await complete(
      provider,
      [
        { role: 'system', content: 'You are a connection test. Reply with the single word OK.' },
        { role: 'user', content: 'Say OK.' }
      ],
      AbortSignal.timeout(20_000)
    )
    return { ok: true, ms: Date.now() - t0, detail: reply.trim().slice(0, 80) || '(empty reply)' }
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'Timed out after 20 s' : err.message) : String(err)
    return { ok: false, ms: Date.now() - t0, detail: msg }
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

// --- IPC ------------------------------------------------------------------------------------

export function initAiApi(): void {
  ipcMain.handle('ai-api:status', () => aiStatus())
  ipcMain.handle('ai-api:set', (_e: IpcMainInvokeEvent, patch: unknown) => setAiSettings(patch))
  ipcMain.handle('ai-api:set-key', (_e: IpcMainInvokeEvent, key: string) => setAiKey(key))
  ipcMain.handle('ai-api:clear-key', () => clearAiKey())
  ipcMain.handle('ai-api:test', (_e: IpcMainInvokeEvent, patch?: unknown) => testAi(patch))
  ipcMain.handle('ai-api:processed-get', (_e: IpcMainInvokeEvent, noteId: string) => getProcessed(String(noteId)))
  ipcMain.handle('ai-api:processed-set', (_e: IpcMainInvokeEvent, entry: unknown) => setProcessed(entry))
  ipcMain.handle('ai-api:processed-clear', (_e: IpcMainInvokeEvent, noteId: string) => clearProcessed(String(noteId)))
  // Off by default: only forks when a provider is already connected from a previous run.
  void applyAi()
}
