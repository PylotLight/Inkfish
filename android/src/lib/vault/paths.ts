import * as FileSystem from 'expo-file-system/legacy'
import { APP, ASSETS, DAILY, INBOX, STAGING, UNDONE, VAULT } from './state'

let atomicWriteSequence = 0

/** Write into a hidden sibling temp file, then atomically rename it over the target. */
export async function writeAtomically(uri: string, text: string, encoding: 'utf8' | 'base64'): Promise<void> {
  const slash = uri.lastIndexOf('/')
  const parent = uri.slice(0, slash + 1)
  const name = uri.slice(slash + 1)
  const tmp = `${parent}.${name}.${Date.now().toString(36)}-${(++atomicWriteSequence).toString(36)}.inkfish-tmp`
  try {
    await FileSystem.writeAsStringAsync(tmp, text, { encoding })
    // Android's file:// move uses File.renameTo within app-private storage. Keep
    // source and destination together so replacement is one same-filesystem rename.
    await FileSystem.moveAsync({ from: tmp, to: uri })
  } catch (error) {
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {})
    throw error
  }
}

export function vaultRootUri(): string {
  return VAULT
}
export function stagingUri(): string {
  return STAGING
}
/** Roots the sync layer maps `inbox/`, `daily/` and vault paths onto. */
export function syncRoots(): { app: string; vault: string; inbox: string; daily: string } {
  return { app: APP, vault: VAULT, inbox: INBOX, daily: DAILY }
}

/** Dirs that are staging/app-owned, never projects (same set as Mac). */
export const RESERVED = new Set(['inbox', 'daily', 'assets'])

export async function mkdir(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri)
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true })
}

let ensureTreeTask: Promise<void> | null = null
let treeMade = false

/**
 * Make the app's folders (once per launch). Cheap: no vault walk. Case-duplicate
 * healing used to run here on EVERY call — a full sequential stat walk of the
 * vault, images included, before every list, open and save. Now it runs only
 * when an index scan (below) or the sync walk actually sees a case-duplicate.
 */
export function ensureTree(): Promise<void> {
  if (treeMade) return Promise.resolve()
  if (ensureTreeTask) return ensureTreeTask
  const task = (async () => {
    await Promise.all([VAULT, INBOX, DAILY, ASSETS, UNDONE].map((d) => mkdir(d)))
    treeMade = true
  })()
  ensureTreeTask = task
  task
    .finally(() => {
      if (ensureTreeTask === task) ensureTreeTask = null
    })
    .catch(() => undefined)
  return task
}

/**
 * Names that are certainly files, not folders (images, audio, docs): listing
 * code records them without a stat. Saves one bridge call per attachment.
 */
export const SKIP_STAT =
  /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg|avif|tiff?|m4a|mp3|wav|ogg|opus|aac|flac|mp4|mov|webm|pdf|zip|json|txt|csv)$/i

export async function writeText(uri: string, text: string): Promise<void> {
  await writeAtomically(uri, text, 'utf8')
}

export async function readText(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 })
}

/** Reset the tree memo (tests only — keeps `ensureTree` honest after fs resets). */
export function resetTreeForTests(): void {
  treeMade = false
  ensureTreeTask = null
}
