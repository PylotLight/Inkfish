/**
 * Global capture shortcuts (Settings › Shortcuts): quick capture (⌥Space) and append to today
 * (⇧⌥Space), stored as Electron accelerators in userData/shortcuts.json. Defaults come from the app
 * profile (⌃⌥Space / ⇧⌃⌥Space for a dev run). '' means "off".
 *
 * No Electron imports: main, renderer and unit tests share it.
 */
import { KNOWN_SHORTCUTS, acceleratorKeys, formatAccelerator, normalizeAccelerator } from './mini-window'

export const SHORTCUTS_SETTINGS_FILE = 'shortcuts.json'

export type ShortcutId = 'capture' | 'daily'

export interface ShortcutSettings {
  /** Quick capture popover ('' = off). */
  capture: string
  /** Capture popover set to append to today's note ('' = off). */
  daily: string
}

export const SHORTCUT_IDS: readonly ShortcutId[] = ['capture', 'daily']

export const SHORTCUT_NAMES: Record<ShortcutId, string> = {
  capture: 'Quick capture',
  daily: "Add to today's note"
}

const F_KEY = /^f([1-9]|1[0-9]|2[0-4])$/i

/**
 * A global capture shortcut, normalized, or null when unusable. Same rules as the mini-window
 * toggle (needs a modifier other than Shift, exactly one key), except a function key may stand
 * alone or with only Shift: F13 and friends don't eat typing.
 */
export function normalizeGlobalShortcut(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const normalized = normalizeAccelerator(input)
  if (normalized) return normalized
  const parts = input
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const [a = '', b = ''] = parts
  if (parts.length === 1 && F_KEY.test(a)) return a.toUpperCase()
  if (parts.length === 2) {
    if (/^shift$/i.test(a) && F_KEY.test(b)) return `Shift+${b.toUpperCase()}`
    if (/^shift$/i.test(b) && F_KEY.test(a)) return `Shift+${a.toUpperCase()}`
  }
  return null
}

export type ShortcutCheck = { ok: true; accelerator: string } | { ok: false; error: string }

const MODIFIER_WORDS = new Set([
  'command',
  'cmd',
  'commandorcontrol',
  'cmdorctrl',
  'control',
  'ctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta'
])

/**
 * Why a recorded / typed accelerator can't be a global shortcut, in words for Settings. '' is
 * allowed (it turns the shortcut off).
 */
export function validateGlobalShortcut(input: string, isMac: boolean): ShortcutCheck {
  if (input === '') return { ok: true, accelerator: '' }
  const ok = normalizeGlobalShortcut(input)
  if (ok) return { ok: true, accelerator: ok }
  const parts = input
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const mods = parts.filter((p) => MODIFIER_WORDS.has(p.toLowerCase()))
  const keys = parts.filter((p) => !MODIFIER_WORDS.has(p.toLowerCase()))
  const modHint = isMac ? '⌘, ⌃ or ⌥' : 'Ctrl, Alt or Super'
  if (keys.length === 0) return { ok: false, error: 'Press a key along with the modifiers.' }
  if (keys.length > 1) return { ok: false, error: 'Use one key plus modifiers.' }
  if (mods.length === 0 || mods.every((m) => m.toLowerCase() === 'shift')) {
    return { ok: false, error: `Add ${modHint} — a plain key would fire while you type (only F-keys work alone).` }
  }
  return { ok: false, error: `${keys[0]} can't be used in a global shortcut.` }
}

export function defaultShortcutSettings(capture: string, daily: string): ShortcutSettings {
  return { capture, daily }
}

/** Settings as stored or sent from Settings: '' turns one off, missing / invalid keeps the default. */
export function parseShortcutSettings(value: unknown, defaults: ShortcutSettings): ShortcutSettings {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const pick = (id: ShortcutId): string =>
    record[id] === '' ? '' : (normalizeGlobalShortcut(record[id]) ?? defaults[id])
  return { capture: pick('capture'), daily: pick('daily') }
}

/** Two accelerators press the same keys (CommandOrControl resolved for the platform). */
export function sameShortcut(a: string, b: string, isMac: boolean): boolean {
  if (!a || !b) return false
  const ka = acceleratorKeys(a, isMac) ?? a
  const kb = acceleratorKeys(b, isMac) ?? b
  return ka === kb
}

/**
 * Inkfish's own other global shortcut already on these keys, as a message, or null.
 * `others` maps a name ("Mini window show/hide") to its accelerator.
 */
export function ownShortcutConflict(
  accelerator: string,
  others: Record<string, string>,
  isMac: boolean
): string | null {
  if (!accelerator) return null
  for (const [name, other] of Object.entries(others)) {
    if (sameShortcut(accelerator, other, isMac))
      return `${formatAccelerator(accelerator, isMac)} is already Inkfish's ${name} shortcut.`
  }
  return null
}

/** Result of `shortcuts:set`: what's stored + live now, and why a change was refused. */
export interface ShortcutState {
  settings: ShortcutSettings
  defaults: ShortcutSettings
  /** Which ones are actually registered with the OS right now. */
  registered: Record<ShortcutId, boolean>
  /** Per shortcut: why it isn't registered (taken at launch, …). */
  errors: Partial<Record<ShortcutId, string>>
  /** INKFISH_SHORTCUTS=off for this run: nothing registers. */
  disabled: boolean
}

export interface ShortcutSetResult extends ShortcutState {
  /** The change was refused (invalid / taken): the old shortcut is kept. */
  error: string | null
}

/**
 * KNOWN_SHORTCUTS with Inkfish's own capture entries swapped for the configured ones, so the
 * mini-window toggle warns about the capture keys the user actually picked (not ⌥Space).
 */
export function knownShortcutsWith(own: ShortcutSettings): typeof KNOWN_SHORTCUTS {
  const owners: Record<ShortcutId, string> = { capture: 'Inkfish quick capture', daily: 'Inkfish append to today' }
  const ownerSet = new Set(Object.values(owners))
  return [
    ...SHORTCUT_IDS.filter((id) => own[id]).map((id) => ({ accelerator: own[id], owner: owners[id] })),
    ...KNOWN_SHORTCUTS.filter((k) => !ownerSet.has(k.owner))
  ]
}
