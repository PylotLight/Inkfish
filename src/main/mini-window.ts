import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  systemPreferences,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import {
  DEFAULT_MINI_WINDOW_SETTINGS,
  MINI_WINDOW_GEOMETRY_FILE,
  MINI_WINDOW_MIN_SIZE,
  MINI_WINDOW_SETTINGS_FILE,
  cascadeMiniBounds,
  clampMiniBounds,
  freeMiniSlot,
  initialMiniBounds,
  miniDisplayKey,
  miniHash,
  parseMiniGeometry,
  parseMiniSlots,
  parseMiniWindowSettings,
  shortcutClash,
  snapMiniToCorner,
  withMiniSlot,
  type MiniRect,
  type MiniWindowSettings
} from '../shared/mini-window'
import {
  MINI_DOCK_RELEASE_DISTANCE,
  MINI_DOCK_SLIDE_MS,
  MINI_WINDOW_DOCK_FILE,
  dockArrow,
  dockEdgeForDrop,
  dockFor,
  dockedBounds,
  dockEdgeSpan,
  dockHandleAlong,
  dockHandleAt,
  dockHandleBounds,
  distanceFromDockEdge,
  dragDockOffset,
  nearestDockEdge,
  parseMiniDocks,
  reconcileDock,
  spreadDockHandles,
  type MiniDisplay,
  type MiniDock,
  type MiniDockEdge
} from '../shared/mini-window-dock'
import { createPeekDriver, type PeekDriver, type PeekPoint } from '../shared/mini-window-peek'
import { tearOutBounds } from '../shared/mini-window-tear'
import { lerpRect, motionDuration } from '../shared/mini-window-motion'
import { motion, placeWindow } from './mini-window-motion'
import { MINI_WINDOW_HANDLE_HTML } from './mini-window-handle-page'
import { getMainWindow, showWindow } from './window'
import { profile } from './profile'
import { getShortcutSettings } from './shortcuts'
import { knownShortcutsWith } from '../shared/shortcuts'

/**
 * Mini windows (shared/mini-window.ts): one note per small frameless window that floats over every
 * app, on every Space and over full-screen apps (an NSPanel on macOS), without activating Inkfish
 * when it pops out. Ported from Surffish's mini window: per-display size/position memory per slot,
 * corner snap, opacity, tuck-to-edge behind a handle tab (click to slide back, hover to peek, drag
 * along the edge), several at once (cascaded), and a global show/hide shortcut.
 *
 * Unlike Surffish there's no web view to move between windows: a mini loads the renderer at
 * `#mini?id=<note>` and the windows keep the note in sync by relaying drafts (`mini:draft` →
 * `inkfish:note-draft`) and saves (`inkfish:note-saved`, sent by notes:save).
 */

const IS_MAC = process.platform === 'darwin'

interface Mini {
  win: BrowserWindow
  slot: number
  noteId: string
  dock: MiniDock | null
  displayId: number | null
  tucked: boolean
  sliding: boolean
  /** Moves made by us (slides, snaps) aren't user drops. */
  ownMoveUntil: number
  handle: BrowserWindow | null
  handleReady: boolean
  /** Settled place along the edge while tucked beside other handles (null = centred on the window). */
  along: number | null
  drag: { startCursor: PeekPoint; startOffset: number } | null
  peek: PeekDriver
  geometryTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

const minis: Mini[] = []
let lastActive: Mini | null = null
/** The note the main window has open (reported by its renderer) — what the global toggle pops out when no mini is open. */
let activeNoteId: string | null = null

// --- persistence ------------------------------------------------------------------

function file(name: string): string {
  return join(app.getPath('userData'), name)
}

function readJson(name: string): unknown {
  try {
    const p = file(name)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

function writeJson(name: string, value: unknown): void {
  try {
    const p = file(name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(value, null, 2), 'utf8')
  } catch (err) {
    console.warn(`[mini] could not write ${name}:`, err)
  }
}

let settingsCache: MiniWindowSettings | null = null
/** A dev profile starts with no global toggle so it can't fight the release app for ⌃⌥M. */
const profileDefaults: MiniWindowSettings = { ...DEFAULT_MINI_WINDOW_SETTINGS, shortcut: profile.miniShortcutDefault }
export function getMiniSettings(): MiniWindowSettings {
  if (!settingsCache) settingsCache = parseMiniWindowSettings(readJson(MINI_WINDOW_SETTINGS_FILE), profileDefaults)
  return settingsCache
}

function geometrySlots(): Array<Record<string, MiniRect>> {
  return parseMiniSlots(readJson(MINI_WINDOW_GEOMETRY_FILE), parseMiniGeometry)
}

function dockSlots(): Array<Record<string, MiniDock>> {
  return parseMiniSlots(readJson(MINI_WINDOW_DOCK_FILE), parseMiniDocks)
}

function saveGeometry(m: Mini): void {
  if (m.closed || m.win.isDestroyed() || m.dock) return
  const rect = m.win.getBounds()
  const display = screen.getDisplayMatching(rect)
  const slots = geometrySlots()
  writeJson(
    MINI_WINDOW_GEOMETRY_FILE,
    withMiniSlot(slots, m.slot, { ...(slots[m.slot] ?? {}), [miniDisplayKey(display.workArea)]: rect })
  )
}

function scheduleGeometrySave(m: Mini): void {
  if (m.geometryTimer) clearTimeout(m.geometryTimer)
  m.geometryTimer = setTimeout(() => {
    m.geometryTimer = null
    saveGeometry(m)
  }, 400)
}

function writeDock(slot: number, display: Display, dock: MiniDock | null): void {
  const slots = dockSlots()
  const record = { ...(slots[slot] ?? {}) }
  const key = miniDisplayKey(display.workArea)
  if (dock) record[key] = dock
  else delete record[key]
  writeJson(MINI_WINDOW_DOCK_FILE, withMiniSlot(slots, slot, record))
}

// --- displays -----------------------------------------------------------------------

function displayInfo(d: Display): MiniDisplay {
  return { bounds: d.bounds, workArea: d.workArea }
}
function allDisplays(): MiniDisplay[] {
  return screen.getAllDisplays().map(displayInfo)
}
function dockDisplay(m: Mini): Display {
  const byId = m.displayId !== null ? screen.getAllDisplays().find((d) => d.id === m.displayId) : undefined
  return byId ?? screen.getDisplayMatching(m.win.getBounds())
}
function reducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}
function alive(m: Mini): boolean {
  return !m.closed && !m.win.isDestroyed()
}
function sameRect(a: MiniRect, b: MiniRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
function within(p: PeekPoint, r: MiniRect): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}

function rendererUrl(hash: string): { url?: string; file?: string; hash: string } {
  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    return { url: `${process.env['ELECTRON_RENDERER_URL']}#${hash}`, hash }
  return { file: join(__dirname, '../renderer/index.html'), hash }
}

function preloadPath(): string {
  const base = join(__dirname, '../preload/index')
  if (existsSync(`${base}.cjs`)) return `${base}.cjs`
  return existsSync(`${base}.js`) ? `${base}.js` : `${base}.mjs`
}

function setFloating(win: BrowserWindow): void {
  if (IS_MAC) {
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  } else {
    win.setAlwaysOnTop(true)
  }
}

// --- state to the mini's header -------------------------------------------------------

export interface MiniHeaderState {
  docked: boolean
  tucked: boolean
  edge: MiniDockEdge | null
  /** Which way the tuck button would move the window. */
  arrow: 'left' | 'right' | 'up' | 'down' | null
  tuckEnabled: boolean
}

function headerState(m: Mini): MiniHeaderState {
  const s = getMiniSettings()
  let arrow: MiniHeaderState['arrow'] = null
  if (m.dock) arrow = dockArrow(m.dock.edge, m.tucked)
  else if (s.tuckToEdge && alive(m)) {
    const display = screen.getDisplayMatching(m.win.getBounds())
    const edge = nearestDockEdge(m.win.getBounds(), displayInfo(display), allDisplays())
    arrow = edge ? dockArrow(edge, false) : null
  }
  return { docked: m.dock !== null, tucked: m.tucked, edge: m.dock?.edge ?? null, arrow, tuckEnabled: s.tuckToEdge }
}

function sendState(m: Mini): void {
  if (!alive(m)) return
  m.win.webContents.send('mini:state', headerState(m))
  sendHandleState(m)
}

// --- handle tab ---------------------------------------------------------------------

function sendHandleState(m: Mini): void {
  if (!m.handle || m.handle.isDestroyed() || !m.handleReady || !m.dock) return
  m.handle.webContents.send('mini:handle-state', {
    edge: m.dock.edge,
    arrow: dockArrow(m.dock.edge, m.tucked),
    label: m.tucked ? 'Show Mini Window' : 'Tuck Mini Window'
  })
}

function ensureHandle(m: Mini): BrowserWindow {
  if (m.handle && !m.handle.isDestroyed()) return m.handle
  const h = new BrowserWindow({
    width: 20,
    height: 64,
    title: 'Inkfish Mini Handle',
    ...(IS_MAC ? { type: 'panel' } : {}),
    frame: false,
    transparent: true,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    hasShadow: false,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: preloadPath(), sandbox: true, contextIsolation: true }
  })
  setFloating(h)
  h.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  h.webContents.on('will-navigate', (e) => e.preventDefault())
  m.handleReady = false
  h.webContents.once('did-finish-load', () => {
    m.handleReady = true
    sendHandleState(m)
  })
  void h.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(MINI_WINDOW_HANDLE_HTML)}`).catch(() => undefined)
  h.on('closed', () => {
    if (m.handle === h) {
      m.handle = null
      m.handleReady = false
    }
  })
  m.handle = h
  return h
}

function closeHandle(m: Mini): void {
  const h = m.handle
  m.handle = null
  m.handleReady = false
  if (h && !h.isDestroyed()) h.close()
}

function placeHandle(m: Mini, rect: MiniRect): void {
  if (!m.dock) return closeHandle(m)
  const h = ensureHandle(m)
  const bounds =
    m.tucked && m.along !== null && !m.sliding && !m.drag
      ? dockHandleAt(rect, m.dock.edge, m.along)
      : dockHandleBounds(rect, m.dock.edge)
  placeWindow(h, bounds)
  if (!h.isVisible()) {
    h.showInactive()
    if (IS_MAC) h.setAlwaysOnTop(true, 'floating')
  }
}

/** Tucked handles on the same display edge spread out so they never overlap. */
function relayoutHandles(): void {
  const groups = new Map<string, Mini[]>()
  for (const m of minis) {
    if (!alive(m) || !m.dock || !m.tucked) {
      m.along = null
      continue
    }
    const key = `${dockDisplay(m).id}:${m.dock.edge}`
    groups.set(key, [...(groups.get(key) ?? []), m])
  }
  for (const group of groups.values()) {
    const first = group[0] as Mini
    const edge = (first.dock as MiniDock).edge
    const [min, max] = dockEdgeSpan(dockDisplay(first).workArea, edge)
    const rects = group.map((m) => dockedBounds(m.win.getBounds(), m.dock as MiniDock, dockDisplay(m).workArea, true))
    const spread = spreadDockHandles(
      rects.map((r) => dockHandleAlong(r, edge)),
      min,
      max
    )
    group.forEach((m, i) => {
      m.along = spread[i] ?? null
      if (!m.sliding) placeHandle(m, rects[i] as MiniRect)
    })
  }
}

// --- sliding / docking ------------------------------------------------------------------

function setOwnBounds(m: Mini, rect: MiniRect): void {
  m.ownMoveUntil = Date.now() + 300
  placeWindow(m.win, rect)
}

function slide(m: Mini, from: MiniRect, to: MiniRect, done: () => void): void {
  const key = m
  motion.cancel(key)
  m.ownMoveUntil = Number.POSITIVE_INFINITY
  const finish = (): void => {
    motion.cancel(key)
    m.sliding = false
    if (!alive(m)) return
    setOwnBounds(m, to)
    if (m.dock) placeHandle(m, to)
    done()
  }
  const full = m.dock?.edge === 'top' || m.dock?.edge === 'bottom' ? to.height : to.width
  const duration = reducedMotion() ? 0 : motionDuration(from, to, full, MINI_DOCK_SLIDE_MS)
  if (duration === 0) return finish()
  const start = performance.now()
  m.sliding = true
  motion.run(key, (now) => {
    if (!alive(m)) {
      m.sliding = false
      return false
    }
    const t = (now - start) / duration
    if (t >= 1) {
      finish()
      return false
    }
    const frame = lerpRect(from, to, t)
    placeWindow(m.win, frame)
    if (m.dock) placeHandle(m, frame)
    return true
  })
}

function size(m: Mini): { width: number; height: number } {
  const b = m.win.getBounds()
  return { width: b.width, height: b.height }
}

function dockTo(m: Mini, edge: MiniDockEdge, display: Display): void {
  m.dock = dockFor(m.win.getBounds(), edge, display.workArea)
  m.displayId = display.id
  writeDock(m.slot, display, m.dock)
}

function tuck(m: Mini): boolean {
  if (!alive(m) || !getMiniSettings().tuckToEdge) return false
  if (!m.dock) {
    const bounds = m.win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const edge = nearestDockEdge(bounds, displayInfo(display), allDisplays())
    if (!edge) return false
    dockTo(m, edge, display)
  }
  m.peek.cancel()
  const dock = m.dock as MiniDock
  m.tucked = true
  const wa = dockDisplay(m).workArea
  const target = dockedBounds(size(m), dock, wa, true)
  const from = m.win.isVisible() ? m.win.getBounds() : target
  slide(m, from, target, () => {
    // Off-screen: hide so nothing paints on a neighbouring display. The handle stays.
    if (m.tucked && m.win.isVisible()) m.win.hide()
    relayoutHandles()
    sendState(m)
  })
  sendState(m)
  return true
}

function slideOut(m: Mini, focus: boolean): void {
  if (!alive(m) || !m.dock) return
  const wa = dockDisplay(m).workArea
  const target = dockedBounds(size(m), m.dock, wa, false)
  if (!m.tucked && m.win.isVisible() && !m.sliding && sameRect(m.win.getBounds(), target)) {
    if (focus) m.win.focus()
    return
  }
  m.tucked = false
  const shown = m.win.isVisible()
  const from = shown ? m.win.getBounds() : dockedBounds(size(m), m.dock, wa, true)
  if (!shown) {
    setOwnBounds(m, from)
    m.win.showInactive()
    setFloating(m.win)
  }
  m.along = null
  relayoutHandles()
  slide(m, from, target, () => {
    if (focus && !m.tucked) m.win.focus()
    sendState(m)
  })
  sendState(m)
}

function undock(m: Mini): void {
  if (!m.dock) return
  const display = dockDisplay(m)
  m.peek.cancel()
  m.drag = null
  motion.cancel(m)
  const wasTucked = m.tucked
  m.tucked = false
  writeDock(m.slot, display, null)
  m.dock = null
  m.displayId = null
  closeHandle(m)
  relayoutHandles()
  if (wasTucked && alive(m)) {
    setOwnBounds(m, clampMiniBounds(m.win.getBounds(), display.workArea))
    m.win.showInactive()
  }
  sendState(m)
}

/** The user let go of the window after dragging it: dock / undock / snap, then remember. */
function dropped(m: Mini): void {
  if (!alive(m) || m.sliding || Date.now() < m.ownMoveUntil) return
  const s = getMiniSettings()
  const rect = m.win.getBounds()
  const display = screen.getDisplayMatching(rect)
  const wa = display.workArea
  if (s.tuckToEdge) {
    const edge = dockEdgeForDrop(rect, screen.getCursorScreenPoint(), displayInfo(display), allDisplays())
    if (edge) {
      dockTo(m, edge, display)
      tuck(m)
      return
    }
  }
  if (m.dock) {
    if (distanceFromDockEdge(rect, m.dock.edge, wa) > MINI_DOCK_RELEASE_DISTANCE) {
      undock(m)
      saveGeometry(m)
    } else {
      // Nudged along its edge: settle flush again at the new place.
      dockTo(m, m.dock.edge, display)
      slide(m, rect, dockedBounds(size(m), m.dock, wa, false), () => sendState(m))
    }
    return
  }
  const snapped = s.snapToCorners ? snapMiniToCorner(rect, wa) : null
  if (snapped) slide(m, rect, snapped, () => saveGeometry(m))
  else saveGeometry(m)
  sendState(m)
}

// --- handle input -------------------------------------------------------------------------

function onHandleClick(m: Mini): void {
  if (!alive(m) || !m.dock) return
  if (m.peek.phase() === 'out') {
    m.peek.pin()
    m.win.focus()
    return
  }
  m.peek.cancel()
  if (m.tucked) slideOut(m, true)
  else tuck(m)
}

function onHandleDrag(m: Mini, active: boolean): void {
  const key = { drag: m }
  if (!alive(m) || !m.dock) return
  if (!active) {
    m.drag = null
    motion.cancel(dragKeys.get(m))
    writeDock(m.slot, dockDisplay(m), m.dock)
    relayoutHandles()
    return
  }
  m.peek.cancel()
  const state = { startCursor: screen.getCursorScreenPoint(), startOffset: m.dock.offset }
  m.drag = state
  dragKeys.set(m, key)
  motion.run(key, () => {
    if (m.drag !== state || !alive(m) || !m.dock) return false
    const cursor = screen.getCursorScreenPoint()
    const horizontal = m.dock.edge === 'top' || m.dock.edge === 'bottom'
    const delta = horizontal ? cursor.x - state.startCursor.x : cursor.y - state.startCursor.y
    const { width, height } = size(m)
    const wa = dockDisplay(m).workArea
    const offset = dragDockOffset(state.startOffset, delta, horizontal ? width : height, m.dock.edge, wa)
    if (offset === m.dock.offset) return true
    m.dock = { ...m.dock, offset }
    const rect = dockedBounds(size(m), m.dock, wa, m.tucked)
    setOwnBounds(m, rect)
    placeHandle(m, rect)
    return true
  })
}
const dragKeys = new WeakMap<Mini, object>()

function miniForSender(sender: WebContents): Mini | null {
  return minis.find((m) => alive(m) && (m.win.webContents === sender || m.handle?.webContents === sender)) ?? null
}

// --- windows ------------------------------------------------------------------------------

function openingBounds(slot: number): { bounds: MiniRect; display: Display } {
  const near = lastActive && alive(lastActive) ? lastActive.win.getBounds() : null
  const display = near ? screen.getDisplayMatching(near) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const saved = geometrySlots()[slot]?.[miniDisplayKey(display.workArea)]
  const base = initialMiniBounds(display.workArea, saved)
  const others = minis.filter(alive).map((m) => m.win.getBounds())
  return { bounds: cascadeMiniBounds(base, others, display.workArea), display }
}

function present(m: Mini, focus: boolean): void {
  if (!alive(m)) return
  if (m.tucked) return slideOut(m, focus)
  if (focus) {
    m.win.show()
    m.win.focus()
  } else if (!m.win.isVisible()) {
    m.win.showInactive()
  }
  setFloating(m.win)
  if (m.dock) placeHandle(m, m.win.getBounds())
}

/** A tab torn out of the main window: the slot's usual size, under the pointer on that display. */
function tearOutOpening(slot: number, at: PeekPoint): { bounds: MiniRect; display: Display } {
  const display = screen.getDisplayNearestPoint(at)
  const saved = geometrySlots()[slot]?.[miniDisplayKey(display.workArea)]
  const base = initialMiniBounds(display.workArea, saved)
  return { bounds: tearOutBounds(at, base, display.workArea), display }
}

/**
 * Pop `noteId` out into a mini window (already in one: bring that one up). `focus`: take the
 * keyboard (global shortcut); pop-out from the main window shows it inactive so focus stays put.
 * `at`: a tab torn out of the main window — open at that screen point, not docked.
 */
export function openMini(noteId: string, focus = false, at?: PeekPoint): boolean {
  const existing = minis.find((m) => alive(m) && m.noteId === noteId)
  if (existing) {
    lastActive = existing
    if (at && !existing.dock && !existing.tucked) {
      const display = screen.getDisplayNearestPoint(at)
      setOwnBounds(existing, tearOutBounds(at, size(existing), display.workArea))
      scheduleGeometrySave(existing)
    }
    present(existing, focus)
    return true
  }
  const slot = freeMiniSlot(minis.filter(alive).map((m) => m.slot))
  if (slot === null) return false
  const { bounds: opening, display } = at ? tearOutOpening(slot, at) : openingBounds(slot)
  const s = getMiniSettings()
  // Torn out to a spot the user picked: open there, not back in the slot's saved dock.
  const savedDock = s.tuckToEdge && !at ? dockSlots()[slot]?.[miniDisplayKey(display.workArea)] : undefined
  const dock = savedDock ? reconcileDock(savedDock, opening, displayInfo(display), allDisplays()) : null
  const bounds = dock ? dockedBounds(opening, dock, display.workArea, false) : opening
  const win = new BrowserWindow({
    ...bounds,
    title: 'Inkfish Mini',
    // An NSPanel floats over other apps and full-screen Spaces without activating Inkfish.
    ...(IS_MAC ? { type: 'panel' } : {}),
    frame: false,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    hasShadow: true,
    minWidth: MINI_WINDOW_MIN_SIZE.width,
    minHeight: MINI_WINDOW_MIN_SIZE.height,
    transparent: IS_MAC,
    vibrancy: IS_MAC ? 'popover' : undefined,
    visualEffectState: IS_MAC ? 'active' : undefined,
    roundedCorners: true,
    backgroundColor: IS_MAC ? '#00000000' : '#14181d',
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      enableBlinkFeatures: 'AIPromptAPI'
    }
  })
  setFloating(win)
  if (process.platform !== 'linux') win.setOpacity(s.opacity)
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  const m: Mini = {
    win,
    slot,
    noteId,
    dock,
    displayId: dock ? display.id : null,
    tucked: false,
    sliding: false,
    ownMoveUntil: 0,
    handle: null,
    handleReady: false,
    along: null,
    drag: null,
    geometryTimer: null,
    closed: false,
    peek: null as unknown as PeekDriver
  }
  m.peek = createPeekDriver({
    now: () => Date.now(),
    cursor: () => screen.getCursorScreenPoint(),
    overHandle: (p) => !!m.handle && !m.handle.isDestroyed() && within(p, m.handle.getBounds()),
    overWindow: (p) => alive(m) && m.win.isVisible() && within(p, m.win.getBounds()),
    blocked: () => m.sliding || m.drag !== null,
    enabled: () => getMiniSettings().peekOnHover && m.tucked,
    delayMs: () => getMiniSettings().peekDelayMs,
    slideOut: () => slideOut(m, false),
    tuck: () => {
      tuck(m)
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
  })
  minis.push(m)
  lastActive = m

  const target = rendererUrl(miniHash(noteId))
  if (target.url) void win.loadURL(target.url)
  else void win.loadFile(target.file as string, { hash: target.hash })
  win.once('ready-to-show', () => {
    present(m, focus)
    sendState(m)
  })
  win.on('focus', () => {
    lastActive = m
    // Clicked into a peeked window: it stays out.
    m.peek.pin()
  })
  win.on('resize', () => {
    if (m.sliding || Date.now() < m.ownMoveUntil) return
    if (m.dock) placeHandle(m, win.getBounds())
    scheduleGeometrySave(m)
  })
  // macOS/Windows say when a drag ends ('moved'); Linux only streams 'move', so act after it settles.
  if (process.platform === 'linux') {
    let settle: ReturnType<typeof setTimeout> | null = null
    win.on('move', () => {
      if (m.sliding || Date.now() < m.ownMoveUntil) return
      if (m.dock) placeHandle(m, win.getBounds())
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        settle = null
        dropped(m)
      }, 350)
    })
  } else {
    win.on('move', () => {
      if (m.sliding || Date.now() < m.ownMoveUntil) return
      if (m.dock) placeHandle(m, win.getBounds())
    })
    win.on('moved', () => dropped(m))
  }
  win.on('closed', () => {
    m.closed = true
    m.peek.cancel()
    motion.cancel(m)
    if (m.geometryTimer) clearTimeout(m.geometryTimer)
    closeHandle(m)
    const i = minis.indexOf(m)
    if (i >= 0) minis.splice(i, 1)
    if (lastActive === m) lastActive = minis[minis.length - 1] ?? null
    relayoutHandles()
  })
  return true
}

/**
 * A note (or a folder holding it) moved/renamed on disk: ids are vault paths by default, so every
 * mini showing something under `oldRel` follows it to `newRel` and is told (`mini:note-moved`) to
 * reload from the new id. Returns how many minis followed.
 */
export function remapMiniNotes(oldRel: string, newRel: string): number {
  const follow = (id: string): string | null =>
    id === oldRel ? newRel : oldRel && id.startsWith(`${oldRel}/`) ? newRel + id.slice(oldRel.length) : null
  let n = 0
  for (const m of minis) {
    const next = follow(m.noteId)
    if (!next || !alive(m)) continue
    const from = m.noteId
    m.noteId = next
    m.win.webContents.send('mini:note-moved', { from, to: next })
    n++
  }
  if (activeNoteId) activeNoteId = follow(activeNoteId) ?? activeNoteId
  return n
}

/** Close the note's mini and open it in the main window. */
function returnToMain(m: Mini): void {
  const id = m.noteId
  showWindow()
  const main = getMainWindow()
  const send = (): void => main?.webContents.send('inkfish:open-note', id)
  if (main && main.webContents.isLoading()) main.webContents.once('did-finish-load', send)
  else send()
  if (alive(m)) m.win.close()
}

/**
 * Global shortcut: no mini open → pop out the main window's open note (or show the main window);
 * any mini showing → tuck or hide them all; all hidden/tucked → bring them back (focus the last).
 */
export function toggleMinis(): void {
  const live = minis.filter(alive)
  if (live.length === 0) {
    if (activeNoteId) openMini(activeNoteId, true)
    else showWindow()
    return
  }
  const showing = live.filter((m) => m.win.isVisible() && !m.tucked)
  if (showing.length > 0) {
    for (const m of showing) {
      if (!(m.dock && tuck(m))) m.win.hide()
    }
    return
  }
  for (const m of live) if (m !== lastActive) present(m, false)
  const last = lastActive && alive(lastActive) ? lastActive : (live[live.length - 1] as Mini)
  present(last, true)
}

function applySettings(s: MiniWindowSettings): void {
  for (const m of minis.filter(alive)) {
    if (process.platform !== 'linux') m.win.setOpacity(s.opacity)
    if (!s.tuckToEdge && m.dock) undock(m)
    if (!s.peekOnHover) m.peek.cancel()
    sendState(m)
  }
}

// --- global shortcut ------------------------------------------------------------------------

let registeredShortcut: string | null = null
let shortcutError: string | null = null

function registerShortcut(shortcut: string): void {
  if (registeredShortcut) {
    try {
      globalShortcut.unregister(registeredShortcut)
    } catch {
      // already gone
    }
    registeredShortcut = null
  }
  shortcutError = null
  if (!shortcut) return
  let ok = false
  try {
    ok = globalShortcut.register(shortcut, toggleMinis)
  } catch (err) {
    shortcutError = String(err)
  }
  if (ok) registeredShortcut = shortcut
  else shortcutError ??= 'Another app already uses this shortcut.'
}

export interface MiniSettingsState {
  settings: MiniWindowSettings
  defaults: MiniWindowSettings
  /** The toggle shortcut is live. */
  registered: boolean
  /** Why it isn't (taken by another app, invalid). */
  error: string | null
  /** A well-known shortcut it would shadow (1Password, Spotlight, Inkfish's own). */
  clash: string | null
  open: number
}

function settingsState(): MiniSettingsState {
  const s = getMiniSettings()
  return {
    settings: s,
    defaults: profileDefaults,
    registered: registeredShortcut !== null && globalShortcut.isRegistered(registeredShortcut),
    error: shortcutError,
    clash: s.shortcut ? shortcutClash(s.shortcut, IS_MAC, knownShortcutsWith(getShortcutSettings())) : null,
    open: minis.filter(alive).length
  }
}

// --- wiring -----------------------------------------------------------------------------------

export function registerMiniWindow(): void {
  registerShortcut(getMiniSettings().shortcut)

  ipcMain.handle('mini:open', (_e: IpcMainInvokeEvent, noteId: string, focus?: boolean): boolean =>
    typeof noteId === 'string' && noteId.length > 0 ? openMini(noteId, focus === true) : false
  )
  // A tab dragged out of the main window's tab strip: open it where the pointer let go.
  ipcMain.handle('mini:tear-out', (_e: IpcMainInvokeEvent, noteId: unknown): boolean =>
    typeof noteId === 'string' && noteId.length > 0 ? openMini(noteId, true, screen.getCursorScreenPoint()) : false
  )
  ipcMain.on('mini:active', (_e: IpcMainEvent, noteId: unknown) => {
    activeNoteId = typeof noteId === 'string' && noteId ? noteId : null
  })
  ipcMain.handle('mini:return', (e: IpcMainInvokeEvent): void => {
    const m = miniForSender(e.sender)
    if (m) returnToMain(m)
  })
  ipcMain.handle('mini:close', (e: IpcMainInvokeEvent): void => {
    const m = miniForSender(e.sender)
    if (m && alive(m)) m.win.close()
  })
  ipcMain.handle('mini:tuck', (e: IpcMainInvokeEvent): void => {
    const m = miniForSender(e.sender)
    if (!m) return
    if (m.tucked) slideOut(m, true)
    else tuck(m)
  })
  ipcMain.handle('mini:state', (e: IpcMainInvokeEvent): MiniHeaderState | null => {
    const m = miniForSender(e.sender)
    return m ? headerState(m) : null
  })
  ipcMain.handle('mini:settings', (): MiniSettingsState => settingsState())
  ipcMain.handle('mini:set-settings', (_e: IpcMainInvokeEvent, patch: unknown): MiniSettingsState => {
    const prev = getMiniSettings()
    const next = parseMiniWindowSettings(
      { ...prev, ...(typeof patch === 'object' && patch ? patch : {}) },
      profileDefaults
    )
    settingsCache = next
    writeJson(MINI_WINDOW_SETTINGS_FILE, next)
    if (next.shortcut !== prev.shortcut || !registeredShortcut) registerShortcut(next.shortcut)
    applySettings(next)
    return settingsState()
  })
  // Live note sync: relay a window's unsaved text to every other window.
  ipcMain.on('mini:draft', (e: IpcMainEvent, id: unknown, markdown: unknown) => {
    if (typeof id !== 'string' || typeof markdown !== 'string') return
    // Nothing to sync with unless a mini is open (or this came from one).
    if (!minis.some(alive)) return
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents === e.sender) continue
      w.webContents.send('inkfish:note-draft', { id, markdown })
    }
  })
  ipcMain.on('mini:handle-click', (e: IpcMainEvent) => {
    const m = miniForSender(e.sender)
    if (m) onHandleClick(m)
  })
  ipcMain.on('mini:handle-hover', (e: IpcMainEvent, inside: unknown) => {
    const m = miniForSender(e.sender)
    if (!m || !m.tucked) return
    if (inside === true) m.peek.enter()
    else m.peek.leave()
  })
  ipcMain.on('mini:handle-drag', (e: IpcMainEvent, active: unknown) => {
    const m = miniForSender(e.sender)
    if (m) onHandleDrag(m, active === true)
  })

  // Displays come and go: re-fit docks and windows.
  const refit = (): void => {
    for (const m of minis.filter(alive)) {
      const display = screen.getDisplayMatching(m.win.getBounds())
      if (m.dock) {
        const next = reconcileDock(m.dock, size(m), displayInfo(display), allDisplays())
        if (!next) {
          undock(m)
          continue
        }
        m.dock = next
        m.displayId = display.id
        setOwnBounds(m, dockedBounds(size(m), next, display.workArea, m.tucked))
        placeHandle(m, m.win.getBounds())
      } else {
        setOwnBounds(m, clampMiniBounds(m.win.getBounds(), display.workArea))
      }
    }
    relayoutHandles()
  }
  screen.on('display-removed', refit)
  screen.on('display-metrics-changed', refit)
}

export function closeAllMinis(): void {
  for (const m of [...minis]) if (alive(m)) m.win.close()
}
