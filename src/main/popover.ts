import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { VibrancyName } from '../shared/types'
import { menuBarPopoutBounds } from '../shared/menubar'

const isMac = process.platform === 'darwin'

let popover: BrowserWindow | null = null

/**
 * macOS: the popover is a non-activating NSPanel (`type: 'panel'`, Spotlight-style). A plain
 * BrowserWindow's show()/focus() calls [NSApp activateIgnoringOtherApps:YES], which activates
 * Inkfish and raises EVERY Inkfish window — so the main window jumped in front of whatever you
 * were in, and when Esc hid the popover the main window was left sitting there ("Esc shows the
 * main app"). A panel takes key focus without activating the app, and Electron's panel also joins
 * all Spaces + full-screen apps, so the shortcut no longer drags you to the Space the main window
 * lives on. INKFISH_POPOVER_PANEL=0 falls back to the old window (plus the app.hide() handback below).
 */
const USE_PANEL = isMac && process.env['INKFISH_POPOVER_PANEL'] !== '0'
/** Was some Inkfish window focused when the popover opened? (i.e. was Inkfish the active app) */
let inkfishWasActive = true
let revealedAt = 0
const EARLY_BLUR_GRACE_MS = 200

function resolvePreload(): string {
  const base = join(__dirname, '../preload/index')
  if (existsSync(`${base}.cjs`)) return `${base}.cjs`
  if (existsSync(`${base}.js`)) return `${base}.js`
  return `${base}.mjs`
}

/** 380×300 capture popover: vibrancy `popover`, frameless, floats, hides on blur. */
export function createPopover(): BrowserWindow {
  if (popover && !popover.isDestroyed()) return popover
  const win = new BrowserWindow({
    width: 380,
    height: 300,
    minWidth: 340,
    minHeight: 240,
    maxWidth: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    ...(USE_PANEL ? { type: 'panel' } : {}),
    skipTaskbar: true,
    hiddenInMissionControl: true,
    titleBarStyle: isMac ? 'customButtonsOnHover' : 'default',
    transparent: isMac,
    vibrancy: (isMac ? 'popover' : undefined) as VibrancyName | undefined,
    visualEffectState: isMac ? 'active' : undefined,
    backgroundColor: isMac ? '#00000000' : '#14181d',
    webPreferences: {
      preload: resolvePreload(),
      sandbox: true,
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
    // Early blur right after a show (seen with macOS panels when the shortcut fires while another
    // app is mid-activation): take focus back instead of vanishing the moment it appeared.
    if (Date.now() - revealedAt < EARLY_BLUR_GRACE_MS) {
      if (win.isVisible()) win.focus()
      return
    }
    win.hide()
  })
  win.on('closed', () => {
    if (popover === win) popover = null
  })

  popover = win
  return win
}

export function getPopover(): BrowserWindow | null {
  if (popover && popover.isDestroyed()) popover = null
  return popover
}

function popoverWindow(): BrowserWindow {
  return getPopover() ?? createPopover()
}

/** Show + focus the popover, remembering whether Inkfish was the active app beforehand. */
function revealPopover(win: BrowserWindow): void {
  const focused = BrowserWindow.getFocusedWindow()
  inkfishWasActive = focused !== null && focused !== win
  revealedAt = Date.now()
  win.show()
  win.focus()
}

/**
 * Dismiss (Esc, toggle shortcut, after save). Only hides the popover: never shows or focuses the
 * main window. On the non-panel fallback, showing it activated Inkfish, so hand focus back to the
 * app you came from (app.hide) instead of leaving the main window in front.
 */
function dismissPopover(win: BrowserWindow): void {
  if (win.isDestroyed() || !win.isVisible()) return
  const wasKey = win.isFocused()
  win.hide()
  if (isMac && !USE_PANEL && wasKey && !inkfishWasActive) app.hide()
}

/** Toggle near the tray icon (left-click): just under the menu bar. */
export function togglePopoverAtTray(x?: number, y?: number, w?: number, h?: number): void {
  showPopoverAt(x, y, w, h)
}

function showPopoverAt(x?: number, y?: number, w?: number, h?: number, hash = 'capture'): void {
  const win = popoverWindow()
  if (win.isVisible()) {
    dismissPopover(win)
    return
  }
  if (x !== undefined && y !== undefined) {
    try {
      // Centred under the icon, or above it when the tray sits at the bottom (Windows/Linux taskbar).
      const anchor = { x, y, width: w ?? 0, height: h ?? 0 }
      const display = screen.getDisplayNearestPoint({ x, y })
      const { width, height } = win.getBounds()
      const { bounds } = menuBarPopoutBounds(anchor, screen.getCursorScreenPoint(), { width, height }, display)
      win.setPosition(bounds.x, bounds.y)
    } catch {
      // fall through to default position
    }
  }
  void setPopoverHash(win, hash)
  revealPopover(win)
}

function setPopoverHash(win: BrowserWindow, hash: string): Promise<void> {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  }
  return win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

/** Append-to-today popover: same window, `#capture-daily` hash. */
export function toggleDailyAtTray(x?: number, y?: number, w?: number, h?: number): void {
  showPopoverAt(x, y, w, h, 'capture-daily')
}

/** Append-to-today near the cursor (Shift+Alt+Space). */
export function toggleDaily(): void {
  const win = popoverWindow()
  if (win.isVisible()) {
    dismissPopover(win)
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
  revealPopover(win)
}

/** Toggle near the cursor (Opt-Space): show centered on the active display. */
export function togglePopover(): void {
  const win = popoverWindow()
  if (win.isVisible()) {
    dismissPopover(win)
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
  revealPopover(win)
}

export function showPopover(): void {
  revealPopover(popoverWindow())
}

export function hidePopover(): void {
  const win = getPopover()
  if (win) dismissPopover(win)
}
