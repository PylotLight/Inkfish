import { app, webContents as allWebContents, type WebContents } from 'electron'
import {
  countStabilityEvent,
  emptyStabilityCounters,
  errorSignature,
  LogThrottle,
  RecoveryBudget,
  stabilityFailureTotal,
  type StabilityCounters
} from '../shared/stability'

/**
 * Main-process crash guard, ported from Surffish (PR #174). Imported first in index.ts.
 *
 * - Uncaught exceptions and unhandled rejections are logged (throttled per message) and counted
 *   instead of Electron's modal "A JavaScript error occurred in the main process" dialog, which
 *   blocks the app until dismissed. One failed handler must not take capture down with it.
 * - Every app window (main window, capture popover, mini windows) reloads when its renderer
 *   dies, or when it has been hung for HANG_RECOVERY_MS, at most 3 times a minute per window.
 * - After a GPU process crash every window is repainted (Chromium relaunches the GPU process,
 *   but views it doesn't know are dirty can stay blank until something invalidates them).
 *
 * Counters live on `globalThis.__inkfishStability` and print once at quit if anything happened.
 */

const counters: StabilityCounters = emptyStabilityCounters()
const throttle = new LogThrottle()
let installed = false

const HANG_RECOVERY_MS = 15_000
const RELOAD_DELAY_MS = 250
const GPU_REPAINT_DELAY_MS = 750

function logThrottled(kind: string, error: unknown): void {
  const occurrence = throttle.shouldLog(`${kind} ${errorSignature(error)}`)
  if (!occurrence) return
  const suffix = occurrence > 1 ? ` (seen ${occurrence}×)` : ''
  try {
    console.error(`[crash guard] ${kind}${suffix}:`, error)
  } catch {
    // stdout/stderr closed (the parent terminal went away): nothing more to do.
  }
}

function describe(contents: WebContents): string {
  try {
    if (contents.isDestroyed()) return 'destroyed'
    const url = contents.getURL()
    const hash = /#([a-z-]+)/i.exec(url)?.[1]
    return hash ? `window:${hash}` : 'window:main'
  } catch {
    return 'window'
  }
}

/** Reload an app window's renderer when it dies, restart it when it hangs. */
export function watchAppWindow(contents: WebContents): void {
  const budget = new RecoveryBudget(3, 60_000)
  let hangTimer: ReturnType<typeof setTimeout> | null = null
  const clearHang = (): void => {
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
  }
  const recover = (why: string): void => {
    if (contents.isDestroyed()) return
    if (!budget.tryTake()) {
      console.error(`[crash guard] ${describe(contents)} ${why} again; not reloading it (more than 3 times in a minute).`)
      return
    }
    setTimeout(() => {
      if (contents.isDestroyed()) return
      countStabilityEvent(counters, 'rendererReloads', `${describe(contents)} after ${why}`)
      try {
        contents.reload()
      } catch (error) {
        console.error(`[crash guard] could not reload ${describe(contents)}:`, error)
      }
    }, RELOAD_DELAY_MS)
  }
  contents.on('render-process-gone', (_event, details) => {
    clearHang()
    if (details.reason === 'clean-exit') return
    countStabilityEvent(counters, 'rendererGone', `${describe(contents)} ${details.reason} (exit ${details.exitCode})`)
    console.warn(`[crash guard] ${describe(contents)} renderer gone (${details.reason}, exit ${details.exitCode}); reloading it`)
    recover(details.reason)
  })
  contents.on('unresponsive', () => {
    countStabilityEvent(counters, 'unresponsive', describe(contents))
    if (hangTimer) return
    hangTimer = setTimeout(() => {
      hangTimer = null
      // Paused in a debugger is not a hang.
      if (contents.isDestroyed() || contents.isDevToolsOpened()) return
      console.warn(`[crash guard] ${describe(contents)} unresponsive for ${HANG_RECOVERY_MS / 1000}s; restarting it`)
      // render-process-gone ('killed') follows and reloads it through the budget above.
      try {
        contents.forcefullyCrashRenderer()
      } catch (error) {
        console.error('[crash guard] could not restart the hung window:', error)
      }
    }, HANG_RECOVERY_MS)
    hangTimer.unref?.()
  })
  contents.on('responsive', clearHang)
  contents.once('destroyed', clearHang)
}

function repaintEverything(): void {
  for (const contents of allWebContents.getAllWebContents()) {
    try {
      if (!contents.isDestroyed() && !contents.isOffscreen()) contents.invalidate()
    } catch {
      // Being torn down.
    }
  }
}

export function getStabilityCounters(): StabilityCounters {
  return counters
}

export function installCrashGuard(): void {
  if (installed) return
  installed = true
  ;(globalThis as { __inkfishStability?: StabilityCounters }).__inkfishStability = counters

  process.on('uncaughtException', (error) => {
    countStabilityEvent(counters, 'uncaughtExceptions', errorSignature(error))
    logThrottled('uncaught exception in the main process', error)
  })
  process.on('unhandledRejection', (reason) => {
    countStabilityEvent(counters, 'unhandledRejections', errorSignature(reason))
    logThrottled('unhandled promise rejection in the main process', reason)
  })

  try {
    app.on('browser-window-created', (_event, window) => watchAppWindow(window.webContents))
    app.on('child-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return
      const summary = `${details.type}${details.name ? ` ${details.name}` : ''} ${details.reason} (exit ${details.exitCode})`
      console.warn(`[crash guard] child process gone: ${summary}`)
      if (details.type === 'GPU') {
        countStabilityEvent(counters, 'gpuGone', summary)
        setTimeout(repaintEverything, GPU_REPAINT_DELAY_MS)
      } else {
        countStabilityEvent(counters, 'childGone', summary)
      }
    })
    app.on('will-quit', () => {
      if (stabilityFailureTotal(counters) === 0) return
      const { recent: _recent, ...totals } = counters
      console.warn('[crash guard] this session:', JSON.stringify(totals))
    })
  } catch {
    // Unit tests import modules without a live Electron app.
  }
}

// Installed on import: index.ts imports this module first, so even errors thrown while other
// modules load are caught and logged.
installCrashGuard()
