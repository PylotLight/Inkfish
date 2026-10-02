import { app, ipcMain, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import * as os from 'node:os'
import { getGlassState, getMainWindow, setGlassVibrancy, showWindow } from './window'
import type { GlassState, SysInfo, VibrancyName } from '../shared/types'

const isMac = process.platform === 'darwin'

/** Materials offered in the Glass tab. All are valid on current Electron. */
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

function notify(title: string, body: string): boolean {
  if (!Notification.isSupported()) return false
  new Notification({ title, body }).show()
  return true
}

/**
 * All renderer → main calls. To add a tool:
 * 1. add an `ipcMain.handle('domain:action', …)` here,
 * 2. expose it in `src/preload/index.ts`,
 * 3. call it from the renderer via `window.api`.
 */
export function registerIpc(): void {
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
    (_event: IpcMainInvokeEvent, payload: { title: string; body: string }): boolean =>
      notify(payload.title, payload.body)
  )

  ipcMain.handle('dock:set-badge', (_event: IpcMainInvokeEvent, count: number): boolean => {
    if (isMac) app.setBadgeCount(count)
    return isMac
  })

  ipcMain.handle('win:hide', () => getMainWindow()?.hide())
  ipcMain.handle('win:show', () => showWindow())
  ipcMain.handle('win:minimize', () => getMainWindow()?.minimize())
  ipcMain.handle('win:flash', () => getMainWindow()?.flashFrame(true))

  // Hide the whole app (macOS: Cmd+H behavior — window + dock indicator go away).
  ipcMain.handle('app:hide', (): boolean => {
    if (isMac) app.hide()
    else getMainWindow()?.hide()
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

  ipcMain.handle('glass:get', (): GlassState => getGlassState())
  ipcMain.handle(
    'glass:set',
    (_event: IpcMainInvokeEvent, name: VibrancyName | null): GlassState => {
      if (name !== null && !VIBRANCY_OPTIONS.includes(name)) return getGlassState()
      return setGlassVibrancy(name)
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
