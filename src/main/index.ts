import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Notification,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createAppTray, destroyTray } from './tray'

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null

export type VibrancyName = NonNullable<Parameters<BrowserWindow['setVibrancy']>[0]>

const VIBRANCY_OPTIONS: readonly VibrancyName[] = [
  'fullscreen-ui',
  'under-window',
  'sidebar',
  'hud',
  'content',
  'popover',
  'menu',
  'titlebar'
]

const DEFAULT_VIBRANCY: VibrancyName = 'fullscreen-ui'
let currentVibrancy: VibrancyName | null = isMac ? DEFAULT_VIBRANCY : null

// Single instance: second launch focuses the existing window instead of forking.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

/** electron-vite emits out/preload/index.js or index.mjs depending on config — accept both. */
function resolvePreload(): string {
  const base = join(__dirname, '../preload/index')
  if (existsSync(`${base}.js`)) return `${base}.js`
  return `${base}.mjs`
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
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

  win.on('ready-to-show', () => win.show())

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

function showWindow(): void {
  // app.hide()/dock.hide() on macOS also require re-showing the app itself.
  if (isMac) app.show()
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.example.bun-electron-app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()
  createAppTray({
    onShow: showWindow,
    onHide: () => mainWindow?.hide(),
    onQuit: () => app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => showWindow())

// On macOS the app stays alive in the tray after the window closes.
app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => destroyTray())

export interface SysInfo {
  platform: NodeJS.Platform
  arch: string
  release: string
  hostname: string
  cpus: number
  totalMem: number
  freeMem: number
}

export interface GlassState {
  platform: NodeJS.Platform
  vibrancy: VibrancyName | null
  transparent: boolean
}

function registerIpc(): void {
  ipcMain.handle('ping', () => 'pong')

  ipcMain.handle('sys:info', (): SysInfo => {
    return {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMem: os.totalmem(),
      freeMem: os.freemem()
    }
  })

  ipcMain.handle(
    'notify:send',
    (_event: IpcMainInvokeEvent, payload: { title: string; body: string }): boolean => {
      if (!Notification.isSupported()) return false
      new Notification({ title: payload.title, body: payload.body }).show()
      return true
    }
  )

  ipcMain.handle('dock:set-badge', (_event: IpcMainInvokeEvent, count: number): boolean => {
    if (isMac) app.setBadgeCount(count)
    return isMac
  })

  ipcMain.handle('win:hide', () => mainWindow?.hide())
  ipcMain.handle('win:show', () => showWindow())
  ipcMain.handle('win:minimize', () => mainWindow?.minimize())
  ipcMain.handle('win:flash', () => mainWindow?.flashFrame(true))

  // Hide the whole app (macOS: Cmd+H behavior — window + dock indicator go away).
  ipcMain.handle('app:hide', (): boolean => {
    if (isMac) app.hide()
    else mainWindow?.hide()
    return true
  })

  // Tray-only mode: remove the dock icon entirely (macOS). Restore with dock:show.
  ipcMain.handle('dock:hide', (): boolean => {
    if (isMac) app.dock?.hide()
    return isMac
  })
  ipcMain.handle('dock:show', (): boolean => {
    if (isMac) app.dock?.show()
    return isMac
  })

  ipcMain.handle('glass:get', (): GlassState => {
    return { platform: process.platform, vibrancy: currentVibrancy, transparent: isMac }
  })
  ipcMain.handle(
    'glass:set',
    (_event: IpcMainInvokeEvent, name: VibrancyName | null): GlassState => {
      const next = name === null || VIBRANCY_OPTIONS.includes(name) ? name : currentVibrancy
      currentVibrancy = isMac ? next : null
      mainWindow?.setVibrancy(currentVibrancy)
      return { platform: process.platform, vibrancy: currentVibrancy, transparent: isMac }
    }
  )
  ipcMain.handle('glass:options', (): readonly VibrancyName[] => VIBRANCY_OPTIONS)

  ipcMain.handle('shell:open', (_event: IpcMainInvokeEvent, url: string): boolean => {
    if (!url.startsWith('https://')) return false
    void shell.openExternal(url)
    return true
  })

  ipcMain.handle('app:quit', () => app.quit())
}
