import { app, BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_MENU_BAR_SETTINGS,
  MENU_BAR_SETTINGS_FILE,
  backgroundMenuBarPatch,
  menuBarPopoutBounds,
  parseMenuBarSettings,
  type MenuBarRect,
  type MenuBarSettings
} from '../shared/menubar'
import { createAppTray, destroyTray, hasTray, type TrayCallbacks } from './tray'
import { getMainWindow, hideToBackground, showWindow } from './window'

/**
 * Menu bar mode (shared/menubar.ts): owns whether the Tray exists, what its click opens, and the
 * macOS Dock icon (menu-bar-only mode). The Tray itself stays in tray.ts and keeps its existing
 * behaviour by default (left click = quick capture under the icon, right click = menu).
 */

const IS_MAC = process.platform === 'darwin'

let callbacks: TrayCallbacks | null = null
let cached: MenuBarSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), MENU_BAR_SETTINGS_FILE)
}

export function getMenuBarSettings(): MenuBarSettings {
  if (cached) return cached
  try {
    const p = settingsPath()
    cached = parseMenuBarSettings(existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined)
  } catch {
    cached = { ...DEFAULT_MENU_BAR_SETTINGS }
  }
  return cached
}

function saveMenuBarSettings(next: MenuBarSettings): void {
  cached = next
  try {
    const p = settingsPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.warn('[menubar] could not save settings:', err)
  }
}

function anchorOf(x?: number, y?: number, w?: number, h?: number): MenuBarRect | null {
  return x !== undefined && y !== undefined ? { x, y, width: w ?? 0, height: h ?? 0 } : null
}

/** Show the main window dropped under the menu bar icon (click again while it's focused: hide it). */
function toggleWindowAt(anchor: MenuBarRect | null): void {
  const win = getMainWindow()
  if (win && win.isVisible() && win.isFocused()) {
    win.hide()
    return
  }
  if (!getMenuBarSettings().anchorWindow || !win) {
    showWindow()
    return
  }
  try {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(anchor ? { x: anchor.x, y: anchor.y } : cursor)
    const { width, height } = win.getBounds()
    const { bounds } = menuBarPopoutBounds(anchor, cursor, { width, height }, display)
    win.setBounds(bounds)
  } catch {
    // no screen info — show where it was
  }
  showWindow()
}

function onTrayClick(x?: number, y?: number, w?: number, h?: number): void {
  if (!callbacks) return
  const click = getMenuBarSettings().click
  if (click === 'today') callbacks.onDailyAt(x, y, w, h)
  else if (click === 'window') toggleWindowAt(anchorOf(x, y, w, h))
  else callbacks.onCaptureAt(x, y, w, h)
}

/** Extra right-click menu items: the Dock toggle (macOS) so menu-bar-only mode is one click to undo. */
function menuExtras(): MenuItemConstructorOptions[] {
  if (!IS_MAC) return []
  const s = getMenuBarSettings()
  return [
    {
      label: 'Hide Dock icon',
      type: 'checkbox',
      checked: s.hideDock,
      click: () => updateMenuBarSettings({ hideDock: !s.hideDock })
    }
  ]
}

function applyDock(s: MenuBarSettings): void {
  if (!IS_MAC || !app.dock) return
  if (s.hideDock) {
    app.dock.hide()
  } else if (!app.dock.isVisible()) {
    void app.dock.show()
  }
}

function applyTray(s: MenuBarSettings): void {
  if (!callbacks) return
  if (s.showIcon && !hasTray()) {
    createAppTray({ ...callbacks, onCaptureAt: onTrayClick, menuExtras })
  } else if (!s.showIcon && hasTray()) {
    destroyTray()
  }
}

export function updateMenuBarSettings(patch: Partial<MenuBarSettings>): MenuBarSettings {
  const prev = getMenuBarSettings()
  const next = parseMenuBarSettings({ ...prev, ...patch })
  saveMenuBarSettings(next)
  applyTray(next)
  if (next.hideDock !== prev.hideDock) {
    applyDock(next)
    // Dock hidden: macOS makes the app an accessory and can drop the main window behind others.
    const win = getMainWindow()
    if (next.hideDock && win?.isVisible()) showWindow()
  }
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('menubar:changed', next)
  return next
}

/** Keep Inkfish running for quick capture while removing the main window from view. */
export function sendToBackground(): void {
  const patch = backgroundMenuBarPatch(process.platform)
  if (patch) updateMenuBarSettings(patch)
  hideToBackground()
}

/**
 * Start-up: create the Tray (unless turned off) with the app's callbacks, and hide the Dock icon in
 * menu-bar-only mode. Replaces calling createAppTray directly.
 */
export function startMenuBar(cb: TrayCallbacks): void {
  callbacks = cb
  const s = getMenuBarSettings()
  applyDock(s)
  applyTray(s)

  ipcMain.handle('menubar:settings', (): { settings: MenuBarSettings; platform: NodeJS.Platform } => ({
    settings: getMenuBarSettings(),
    platform: process.platform
  }))
  ipcMain.handle('menubar:set', (_e: IpcMainInvokeEvent, patch: unknown): MenuBarSettings =>
    updateMenuBarSettings(typeof patch === 'object' && patch !== null ? (patch as Partial<MenuBarSettings>) : {})
  )
  ipcMain.handle('menubar:background', () => sendToBackground())
}
