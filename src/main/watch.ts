import { watch, type FSWatcher } from 'node:fs'
import { BrowserWindow } from 'electron'
import { reindexStaging, reindexVault } from './db'
import { vaultConfigured, vaultPaths } from './vault'

/**
 * Vault file watcher — keeps app state matched to files changed outside the
 * app (Obsidian/Finder edits, synced drops, scripts). Electron has no
 * built-in FS watcher; `fs.watch(recursive)` is native on macOS/Windows.
 *
 * Debounced: a save burst becomes one reindex + one UI refresh. Our own
 * writes also trip it — harmless, the reindex is idempotent.
 */

let watchers: FSWatcher[] = []
let timer: NodeJS.Timeout | null = null

function arm(ms: number, fire: () => void): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    try {
      fire()
    } catch (err) {
      console.warn('[watch] rescan failed:', err instanceof Error ? err.message : String(err))
    }
  }, ms)
  // Never keep the app alive for the debounce alone.
  if (typeof timer.unref === 'function') timer.unref()
}

/** Watch dirs (vault root + staging). No-op when nothing exists yet. */
export function startVaultWatch(dirs: string[], onChange: () => void): void {
  stopVaultWatch()
  const onEvent = (file: string | Buffer | null): void => {
    const name = String(file ?? '')
    const base = name.split('/').pop() ?? ''
    if (!base || base.startsWith('.') || base.endsWith('.tmp')) return
    arm(800, onChange)
  }
  for (const dir of new Set(dirs)) {
    const spawn = (recursive: boolean): FSWatcher | null => {
      try {
        const w = watch(dir, { recursive }, (_event, file) => onEvent(file))
        w.on('error', (err) => console.warn(`[watch] ${dir}:`, err.message))
        return w
      } catch {
        return null
      }
    }
    // Linux has no recursive watch — fall back to the top level rather than
    // crashing; subdirs are still covered on the next boot/reindex.
    const w = spawn(true) ?? spawn(false)
    if (w) watchers.push(w)
    else console.warn(`[watch] cannot watch ${dir}`)
  }
  if (watchers.length > 0) console.log(`[watch] watching ${watchers.length} dir(s)`)
}

export function stopVaultWatch(): void {
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // already closed
    }
  }
  watchers = []
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Reindex from disk and tell the UI to refresh (watcher + sync entry point). */
export function rescanVaultFromDisk(): void {
  try {
    if (!vaultConfigured()) return
    const paths = vaultPaths()
    reindexVault(paths.root)
    reindexStaging(paths)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('inkfish:vault-changed')
  } catch (err) {
    console.warn('[watch] rescan failed:', err instanceof Error ? err.message : String(err))
  }
}
