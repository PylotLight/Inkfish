import { app, BrowserWindow, globalShortcut, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { profile } from './profile'
import { shortcutsDisabled } from '../shared/profile'
import {
  SHORTCUTS_SETTINGS_FILE,
  SHORTCUT_IDS,
  SHORTCUT_NAMES,
  ownShortcutConflict,
  parseShortcutSettings,
  validateGlobalShortcut,
  type ShortcutId,
  type ShortcutSetResult,
  type ShortcutSettings,
  type ShortcutState
} from '../shared/shortcuts'
import { formatAccelerator } from '../shared/mini-window'

/**
 * Global capture shortcuts (shared/shortcuts.ts), configurable in Settings › Shortcuts.
 * Re-registers live: a new accelerator is registered BEFORE the old one is dropped, so a key
 * another app holds (or the OS refuses) leaves the working shortcut in place and the refusal is
 * returned to Settings. INKFISH_SHORTCUTS=off still registers nothing for that run.
 */

const IS_MAC = process.platform === 'darwin'
const DISABLED = shortcutsDisabled(process.env['INKFISH_SHORTCUTS'])
/** Profile defaults: ⌥Space / ⇧⌥Space (release), ⌃⌥Space / ⇧⌃⌥Space (dev). */
const DEFAULTS: ShortcutSettings = {
  capture: DISABLED ? '' : profile.captureShortcut,
  daily: DISABLED ? '' : profile.dailyShortcut
}

let cached: ShortcutSettings | null = null
const handlers: Partial<Record<ShortcutId, () => void>> = {}
const live: Record<ShortcutId, string> = { capture: '', daily: '' }
const errors: Partial<Record<ShortcutId, string>> = {}
/** Other Inkfish global shortcuts (the mini-window toggle) so two never share keys. */
let otherShortcuts: () => Record<string, string> = () => ({})

function settingsPath(): string {
  return join(app.getPath('userData'), SHORTCUTS_SETTINGS_FILE)
}

export function getShortcutSettings(): ShortcutSettings {
  if (cached) return cached
  try {
    const p = settingsPath()
    cached = parseShortcutSettings(existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined, DEFAULTS)
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

/** What the tray menu / hints should show: the configured accelerator, '' when off for this run. */
export function shortcutFor(id: ShortcutId): string {
  return DISABLED ? '' : getShortcutSettings()[id]
}

function save(next: ShortcutSettings): void {
  cached = next
  try {
    const p = settingsPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.warn('[inkfish] could not save shortcuts:', err)
  }
}

function tryRegister(accel: string, fn: () => void): string | null {
  try {
    if (globalShortcut.isRegistered(accel)) return `${formatAccelerator(accel, IS_MAC)} is already used by Inkfish.`
    if (globalShortcut.register(accel, fn)) return null
  } catch (err) {
    return `${formatAccelerator(accel, IS_MAC)} isn't a valid shortcut (${err instanceof Error ? err.message : String(err)}).`
  }
  return "That shortcut's taken by another app."
}

function unregister(accel: string): void {
  if (!accel) return
  try {
    globalShortcut.unregister(accel)
  } catch {
    // already gone
  }
}

function state(): ShortcutState {
  const s = getShortcutSettings()
  const registered = {} as Record<ShortcutId, boolean>
  for (const id of SHORTCUT_IDS) registered[id] = !!live[id] && live[id] === s[id] && globalShortcut.isRegistered(live[id])
  return { settings: s, defaults: DEFAULTS, registered, errors: { ...errors }, disabled: DISABLED }
}

function broadcast(): void {
  const st = state()
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('shortcuts:changed', st)
}

/**
 * Change one shortcut. Validation and conflicts first; then the new accelerator is registered and
 * only on success is the old one dropped and the choice saved. '' turns it off.
 */
export function setShortcut(id: ShortcutId, input: string): ShortcutSetResult {
  suspend(false)
  const check = validateGlobalShortcut(input, IS_MAC)
  if (!check.ok) return { ...state(), error: check.error }
  const accel = check.accelerator
  const current = getShortcutSettings()
  if (accel === current[id] && (accel === '' || live[id] === accel || DISABLED)) return { ...state(), error: null }
  const others: Record<string, string> = { ...otherShortcuts() }
  for (const other of SHORTCUT_IDS) if (other !== id) others[SHORTCUT_NAMES[other].toLowerCase()] = current[other]
  const clash = ownShortcutConflict(accel, others, IS_MAC)
  if (clash) return { ...state(), error: clash }

  if (!DISABLED && accel) {
    const fn = handlers[id]
    if (fn) {
      // Same keys already ours (re-registering after a failed launch registration): drop first.
      if (live[id] === accel) unregister(accel)
      const err = tryRegister(accel, fn)
      if (err) return { ...state(), error: err }
    }
  }
  if (live[id] && live[id] !== accel) unregister(live[id])
  live[id] = DISABLED ? '' : accel
  delete errors[id]
  save({ ...current, [id]: accel })
  broadcast()
  return { ...state(), error: null }
}

/**
 * Register the saved capture shortcuts at launch. A key another app holds is skipped with a
 * warning (the setting is kept, Settings shows it isn't active). Unregisters automatically on quit.
 */
export function registerCaptureShortcuts(fns: Record<ShortcutId, () => void>, others?: () => Record<string, string>): void {
  Object.assign(handlers, fns)
  if (others) otherShortcuts = others
  if (DISABLED) return
  const s = getShortcutSettings()
  for (const id of SHORTCUT_IDS) {
    const accel = s[id]
    if (!accel) continue
    const err = tryRegister(accel, fns[id])
    if (err) {
      errors[id] = err
      console.warn(`[inkfish] ${accel} not registered — ${SHORTCUT_NAMES[id].toLowerCase()} via tray menu: ${err}`)
    } else live[id] = accel
  }
}

let suspended = false
/**
 * While a Settings recorder field has focus, Inkfish's own capture shortcuts are released so
 * pressing them records the keys instead of popping capture over Settings.
 */
function suspend(on: boolean): void {
  if (on === suspended || DISABLED) return
  suspended = on
  for (const id of SHORTCUT_IDS) {
    const accel = live[id]
    if (!accel) continue
    if (on) unregister(accel)
    else {
      const fn = handlers[id]
      const err = fn ? tryRegister(accel, fn) : null
      if (err) {
        live[id] = ''
        errors[id] = err
      }
    }
  }
}

export function registerShortcutIpc(): void {
  ipcMain.on('shortcuts:recording', (_e, on: unknown) => suspend(on === true))
  ipcMain.handle('shortcuts:get', (): ShortcutState => state())
  ipcMain.handle('shortcuts:set', (_e: IpcMainInvokeEvent, id: unknown, accel: unknown): ShortcutSetResult => {
    if (!SHORTCUT_IDS.includes(id as ShortcutId) || typeof accel !== 'string') return { ...state(), error: 'Bad request.' }
    return setShortcut(id as ShortcutId, accel)
  })
}
