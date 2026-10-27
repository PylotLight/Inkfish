import { BrowserWindow, app, screen, shell } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { WINDOW } from '../shared/config'
import type { GlassState, VibrancyName } from '../shared/types'
import {
  boundsToShow,
  fitBoundsToDisplays,
  parseSavedWindowState,
  planMainWindow,
  sameRect,
  type SavedWindowState
} from '../shared/window-geometry'

const isMac = process.platform === 'darwin'

let mainWindow: BrowserWindow | null = null
let mainWindowHiddenToBackground = false

const DEFAULT_VIBRANCY: VibrancyName = 'fullscreen-ui'
let currentVibrancy: VibrancyName | null = isMac ? DEFAULT_VIBRANCY : null

/**
 * The live main window, or null. Never hands out a destroyed BrowserWindow: a stale ref (closed
 * with ⌘W / the red button, or torn down some other way) is dropped here so callers can't call
 * show()/send() on a dead object. Use ensureMainWindow() when you actually want one to exist.
 */
export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && mainWindow.isDestroyed()) mainWindow = null
  return mainWindow
}

/**
 * Self-healing getter: always returns a usable main window. Missing/destroyed → recreated;
 * renderer crashed → reloaded. `created` tells the caller it'll show itself on ready-to-show.
 */
export function ensureMainWindow(): { win: BrowserWindow; created: boolean } {
  const win = getMainWindow()
  const plan = planMainWindow({
    exists: win !== null,
    destroyed: win?.isDestroyed() ?? true,
    crashed: win ? win.webContents.isDestroyed() || win.webContents.isCrashed() : false
  })
  if (plan === 'create' || !win) return { win: createWindow(), created: true }
  if (plan === 'reload') {
    console.warn('[window] main renderer was dead — reloading')
    loadRenderer(win)
  }
  return { win, created: false }
}

/** Send to the main window once its renderer is loaded (a just-recreated window would drop it). */
export function sendToMain(channel: string, ...args: unknown[]): void {
  const win = getMainWindow()
  if (!win) return
  const wc = win.webContents
  const send = (): void => {
    if (!wc.isDestroyed()) wc.send(channel, ...args)
  }
  // After load, give React a beat to mount its listeners (same 150 ms the old callers used).
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(send, 150))
  else send()
}

/** The sandboxed preload builds as index.cjs; keep fallbacks for legacy build layouts. */
function resolvePreload(): string {
  const base = join(__dirname, '../preload/index')
  if (existsSync(`${base}.cjs`)) return `${base}.cjs`
  if (existsSync(`${base}.js`)) return `${base}.js`
  return `${base}.mjs`
}

// Window state (ported from Surffish): the main window reopens where you left it — size,
// position, maximized, full screen — fitted back onto a display that still exists.
const WINDOW_STATE_FILE = 'window-state.json'
const SAVE_DELAY_MS = 500

function windowStatePath(): string {
  return join(app.getPath('userData'), WINDOW_STATE_FILE)
}

function loadWindowState(): SavedWindowState | null {
  try {
    const path = windowStatePath()
    if (!existsSync(path)) return null
    const saved = parseSavedWindowState(JSON.parse(readFileSync(path, 'utf8')))
    if (!saved) return null
    const areas = screen.getAllDisplays().map((d) => d.workArea)
    const bounds = fitBoundsToDisplays(saved.bounds, areas, { width: WINDOW.minWidth, height: WINDOW.minHeight })
    return bounds ? { ...saved, bounds } : null
  } catch (err) {
    console.warn('[window] could not read window state:', err instanceof Error ? err.message : String(err))
    return null
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const state: SavedWindowState = {
    // Normal bounds, so un-maximizing after a relaunch goes back to the size you had.
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen()
  }
  try {
    const path = windowStatePath()
    writeFileSync(`${path}.tmp`, JSON.stringify(state))
    renameSync(`${path}.tmp`, path)
  } catch (err) {
    console.warn('[window] could not save window state:', err instanceof Error ? err.message : String(err))
  }
}

function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      saveWindowState(win)
    }, SAVE_DELAY_MS)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(event as 'resize', schedule)
  }
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    timer = null
    saveWindowState(win)
  })
}

export function createWindow(): BrowserWindow {
  const saved = loadWindowState()
  // Linux/Windows have no bundle icon — point the window at the squid logo.
  // (macOS uses build/icon.icns from the app bundle instead.)
  const logoIcon = !isMac ? join(__dirname, '../../build/icon.png') : undefined
  const win = new BrowserWindow({
    width: saved?.bounds.width ?? WINDOW.width,
    height: saved?.bounds.height ?? WINDOW.height,
    ...(saved ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    show: false,
    autoHideMenuBar: true,
    icon: logoIcon !== undefined && existsSync(logoIcon) ? logoIcon : undefined,
    // macOS glass: native vibrancy + transparent window + inset traffic lights.
    // The renderer MUST stay translucent (see index.css) or the blur is covered up.
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    transparent: isMac,
    vibrancy: currentVibrancy ?? undefined,
    visualEffectState: isMac ? 'active' : undefined,
    backgroundColor: isMac ? '#00000000' : '#101418',
    webPreferences: {
      preload: resolvePreload(),
      sandbox: true,
      contextIsolation: true,
      // Prompt API (`LanguageModel`), answered by the local AI handler (src/main/ai-api.ts).
      enableBlinkFeatures: 'AIPromptAPI'
    }
  })

  win.on('ready-to-show', () => {
    if (saved?.maximized) win.maximize()
    if (saved?.fullScreen) win.setFullScreen(true)
    if (!mainWindowHiddenToBackground) win.show()
  })
  // A page that fails to load never fires ready-to-show, which left an invisible window that
  // "Show" kept finding — reveal it so the user at least gets something (and can reload).
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED: a newer navigation replaced it */) return
    console.warn(`[window] main renderer failed to load (${code} ${desc})`)
    if (!mainWindowHiddenToBackground && !win.isDestroyed() && !win.isVisible()) win.show()
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn(`[window] main renderer gone: ${details.reason}`)
    // Reload right away if it's on screen; a hidden one is reloaded by the next showWindow().
    if (details.reason !== 'clean-exit' && !win.isDestroyed() && win.isVisible()) loadRenderer(win)
  })
  trackWindowState(win)

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(win)

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  watchDisplays()
  mainWindow = win
  return win
}

function loadRenderer(win: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Put the main window back on a display that exists (no-op when it already is, or full screen). */
function keepOnScreen(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return
  try {
    const current = win.getBounds()
    const next = boundsToShow(
      current,
      screen.getAllDisplays().map((d) => d.workArea),
      { width: WINDOW.minWidth, height: WINDOW.minHeight },
      screen.getPrimaryDisplay().workArea
    )
    if (!sameRect(current, next)) {
      console.warn('[window] main window was off screen — recentring', current, '→', next)
      win.setBounds(next)
    }
  } catch {
    // no screen info (headless) — leave it
  }
}

let watchingDisplays = false
/** Monitor unplugged / arrangement changed while running: pull a visible main window back on. */
function watchDisplays(): void {
  if (watchingDisplays) return
  watchingDisplays = true
  const recheck = (): void => {
    const win = getMainWindow()
    if (win?.isVisible()) keepOnScreen(win)
  }
  screen.on('display-removed', recheck)
  screen.on('display-metrics-changed', recheck)
}

export function showWindow(): void {
  mainWindowHiddenToBackground = false
  // app.hide()/dock.hide() on macOS also require re-showing the app itself.
  if (isMac) app.show()
  const { win, created } = ensureMainWindow()
  // A fresh window shows itself on ready-to-show (showing earlier flashes an unpainted frame).
  if (created) return
  if (win.isMinimized()) win.restore()
  keepOnScreen(win)
  win.show()
  win.focus()
}

export function hideWindow(): void {
  getMainWindow()?.hide()
}

/** Hide without quitting or closing the window; global capture shortcuts stay registered. */
export function hideToBackground(): void {
  mainWindowHiddenToBackground = true
  getMainWindow()?.hide()
}

export function getGlassState(): GlassState {
  return { platform: process.platform, vibrancy: currentVibrancy, transparent: isMac }
}

export function setGlassVibrancy(name: VibrancyName | null): GlassState {
  currentVibrancy = isMac ? name : null
  getMainWindow()?.setVibrancy(currentVibrancy)
  return getGlassState()
}
