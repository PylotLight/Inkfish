import { BrowserWindow, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { VibrancyName } from '../shared/types'

const isMac = process.platform === 'darwin'

let popover: BrowserWindow | null = null

function resolvePreload(): string {
  const base = join(__dirname, '../preload/index')
  if (existsSync(`${base}.js`)) return `${base}.js`
  return `${base}.mjs`
}

/** 380×~500 capture popover: vibrancy `popover`, frameless, floats, hides on blur. */
export function createPopover(): BrowserWindow {
  if (popover) return popover
  const win = new BrowserWindow({
    width: 380,
    height: 520,
    minWidth: 340,
    minHeight: 420,
    maxWidth: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    titleBarStyle: isMac ? 'customButtonsOnHover' : 'default',
    transparent: isMac,
    vibrancy: (isMac ? 'popover' : undefined) as VibrancyName | undefined,
    visualEffectState: isMac ? 'active' : undefined,
    backgroundColor: isMac ? '#00000000' : '#14181d',
    webPreferences: {
      preload: resolvePreload(),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#capture`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'capture' })
  }

  // Clicking away dismisses — popover semantics, input already saved via Cmd-Enter.
  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return
    win.hide()
  })
  win.on('closed', () => {
    if (popover === win) popover = null
  })

  popover = win
  return win
}

export function getPopover(): BrowserWindow | null {
  return popover
}

/** Toggle near the tray icon (left-click): just under the menu bar. */
export function togglePopoverAtTray(x?: number, y?: number, w?: number): void {
  showPopoverAt(x, y, w)
}

function showPopoverAt(x?: number, y?: number, w?: number, hash = 'capture'): void {
  const win = popover ?? createPopover()
  if (win.isVisible()) {
    win.hide()
    return
  }
  if (x !== undefined && y !== undefined) {
    try {
      const display = screen.getDisplayNearestPoint({ x, y })
      const { width } = win.getBounds()
      const px = Math.round(
        Math.min(
          Math.max(x + (w ?? 0) / 2 - width / 2, display.bounds.x),
          display.bounds.x + display.bounds.width - width
        )
      )
      win.setPosition(px, Math.round(y + 8))
    } catch {
      // fall through to default position
    }
  }
  void setPopoverHash(win, hash)
  win.show()
  win.focus()
}

function setPopoverHash(win: BrowserWindow, hash: string): Promise<void> {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  }
  return win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

/** Append-to-today popover: same window, `#capture-daily` hash. */
export function toggleDailyAtTray(x?: number, y?: number, w?: number): void {
  showPopoverAt(x, y, w, 'capture-daily')
}

/** Append-to-today near the cursor (Shift+Alt+Space). */
export function toggleDaily(): void {
  const win = popover ?? createPopover()
  if (win.isVisible()) {
    win.hide()
    return
  }
  try {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { width } = win.getBounds()
    const x = Math.round(display.bounds.x + (display.workArea.width - width) / 2)
    const y = Math.round(display.workArea.y + 48)
    win.setPosition(x, y)
  } catch {
    // headless / no screen module — just show where it was
  }
  void setPopoverHash(win, 'capture-daily')
  win.show()
  win.focus()
}

/** Toggle near the cursor (Opt-Space): show centered on the active display. */
export function togglePopover(): void {
  const win = popover ?? createPopover()
  if (win.isVisible()) {
    win.hide()
    return
  }
  try {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { width, height } = win.getBounds()
    const x = Math.round(display.bounds.x + (display.workArea.width - width) / 2)
    const y = Math.round(display.workArea.y + 48)
    void height
    win.setPosition(x, y)
  } catch {
    // headless / no screen module — just show where it was
  }
  win.show()
  win.focus()
}

export function showPopover(): void {
  const win = popover ?? createPopover()
  win.show()
  win.focus()
}

export function hidePopover(): void {
  popover?.hide()
}
