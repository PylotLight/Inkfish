import { BrowserWindow, app, screen, shell } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { WINDOW } from '../shared/config'
import type { GlassState, VibrancyName } from '../shared/types'
import { fitBoundsToDisplays, parseSavedWindowState, type SavedWindowState } from '../shared/window-geometry'

const isMac = process.platform === 'darwin'

let mainWindow: BrowserWindow | null = null

const DEFAULT_VIBRANCY: VibrancyName = 'fullscreen-ui'
let currentVibrancy: VibrancyName | null = isMac ? DEFAULT_VIBRANCY : null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** electron-vite emits out/preload/index.js or index.mjs depending on config — accept both. */
function resolvePreload(): string {
  const base = join(__dirname, '../preload/index')
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
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => {
    if (saved?.maximized) win.maximize()
    if (saved?.fullScreen) win.setFullScreen(true)
    win.show()
  })
  trackWindowState(win)

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  mainWindow = win
  return win
}

export function showWindow(): void {
  // app.hide()/dock.hide() on macOS also require re-showing the app itself.
  if (isMac) app.show()
  const win = mainWindow
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function hideWindow(): void {
  mainWindow?.hide()
}

export function getGlassState(): GlassState {
  return { platform: process.platform, vibrancy: currentVibrancy, transparent: isMac }
}

export function setGlassVibrancy(name: VibrancyName | null): GlassState {
  currentVibrancy = isMac ? name : null
  mainWindow?.setVibrancy(currentVibrancy)
  return getGlassState()
}
