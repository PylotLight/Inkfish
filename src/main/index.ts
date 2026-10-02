import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from '../shared/config'
import { registerIpc } from './ipc'
import { createAppTray, destroyTray } from './tray'
import { createWindow, hideWindow, showWindow } from './window'

// Single instance: a second launch focuses the existing window instead of forking.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()
  createAppTray({
    onShow: showWindow,
    onHide: hideWindow,
    onQuit: () => app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => showWindow())

// On macOS the app stays alive in the tray after the window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => destroyTray())
