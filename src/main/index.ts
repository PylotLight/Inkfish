import { app, BrowserWindow, globalShortcut, protocol } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from '../shared/config'
import { registerIpc } from './ipc'
import { createAppTray, destroyTray } from './tray'
import { createWindow, getMainWindow, showWindow } from './window'
import { createPopover, toggleDaily, toggleDailyAtTray, togglePopover, togglePopoverAtTray } from './popover'
import { registerAssetProtocol } from './assets-protocol'
import { openDb, reindexStaging, reindexVault } from './db'
import { ensureSeedProjects, ensureVault, setConfigDir, vaultConfigured } from './vault'

// Custom protocols must be privileged before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

// Single instance: a second launch focuses the existing window instead of forking.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function initVault(): void {
  try {
    const paths = ensureVault()
    ensureSeedProjects(paths)
    const kind = openDb(paths.dbPath)
    const n = reindexVault(paths.root) + reindexStaging(paths)
    console.log(`[inkfish] vault ${paths.root} — index ${kind}, ${n} notes`)
  } catch (err) {
    console.error('[inkfish] vault init failed:', err)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setConfigDir(app.getPath('userData'))
  if (vaultConfigured()) {
    initVault()
  } else {
    // True first run: do NOTHING yet — the onboarding wizard picks the vault
    // location first, then the renderer drives setup via `vault:set-root`.
    console.log('[inkfish] first run — waiting for vault selection')
  }
  registerIpc()
  registerAssetProtocol()
  createWindow()
  createPopover()
  createAppTray({
    onShow: showWindow,
    onCapture: togglePopover,
    onCaptureAt: (x, y, w) => togglePopoverAtTray(x, y, w),
    onDailyAt: (x, y, w) => toggleDailyAtTray(x, y, w),
    onOpenToday: () => {
      showWindow()
      getMainWindow()?.webContents.send('inkfish:open-today')
    },
    onQuit: () => app.quit()
  })

  // Opt-Space capture shortcut (Alt+Space). Unregisters automatically on quit.
  const ok = globalShortcut.register('Alt+Space', togglePopover)
  if (!ok) console.warn('[inkfish] Alt+Space already taken — capture via tray menu')
  // Shift+Opt-Space appends to today's day-log.
  const okDaily = globalShortcut.register('Shift+Alt+Space', toggleDaily)
  if (!okDaily) console.warn('[inkfish] Shift+Alt+Space already taken — append via tray menu')

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
