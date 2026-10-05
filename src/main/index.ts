import { app, BrowserWindow, globalShortcut } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from '../shared/config'
import { registerIpc } from './ipc'
import { createAppTray, destroyTray } from './tray'
import { createWindow, showWindow } from './window'
import { createPopover, togglePopover } from './popover'
import { openDb, reindexVault } from './db'
import { ensureSeedProjects, ensureVault, vaultPaths } from './vault'

// Single instance: a second launch focuses the existing window instead of forking.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function initVault(): void {
  try {
    const paths = ensureVault()
    ensureSeedProjects(paths)
    const kind = openDb(paths.dbPath)
    const n = reindexVault(paths.root)
    console.log(`[inkfish] vault ${paths.root} — index ${kind}, ${n} notes`)
  } catch (err) {
    console.error('[inkfish] vault init failed:', err)
  }
}

export function vaultRoot(): string {
  return vaultPaths().root
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initVault()
  registerIpc()
  createWindow()
  createPopover()
  createAppTray({
    onShow: showWindow,
    onCapture: togglePopover,
    onQuit: () => app.quit()
  })

  // Opt-Space capture shortcut (Alt+Space). Unregisters automatically on quit.
  const ok = globalShortcut.register('Alt+Space', togglePopover)
  if (!ok) console.warn('[inkfish] Alt+Space already taken — capture via tray menu')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => showWindow())

// On macOS the app stays alive in the tray after the window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  destroyTray()
})
