/**
 * Mini window: a small frameless always-on-top window holding one note, so it floats over other
 * apps while you work (meeting notes, a checklist, a scratchpad). "Pop out to Mini Window" (⌘⇧M)
 * opens the open note there; ⌘⇧M inside it returns it to the main window. Edits sync live with
 * the main window's copy of the note. A global shortcut (Settings → Mini window) shows/hides it.
 *
 * Ported from Surffish's mini window (PylotLight/Surffish src/shared/mini-window.ts), trimmed to what
 * a notes app needs: no tab grouping or floating header panel. Docking (tuck to edge), hover peek
 * and the frame loop are the same modules (shared/mini-window-dock|peek|motion.ts).
 * Pure rules only; main/mini-window.ts does the windows.
 */

/** Settings → Mini window. */
export const MINI_WINDOW_SETTINGS_FILE = 'mini-window.json'
/** Last size/position per display, per slot (separate from settings so a settings write never drops it). */
export const MINI_WINDOW_GEOMETRY_FILE = 'mini-window-geometry.json'

/**
 * Default global toggle: ⌃⌥M on macOS, Ctrl+Alt+M elsewhere. Deliberately not ⌘⇧Space (1Password's
 * Quick Access) and not ⌘⇧M (the in-app pop-out / return key, which stays local to Inkfish).
 */
export const DEFAULT_MINI_WINDOW_SHORTCUT = 'Control+Alt+M'
/** In-app (not global): pop the open note out / return the mini's note to the main window. */
export const MINI_WINDOW_POP_KEY = 'CommandOrControl+Shift+M'
export const MINI_WINDOW_MIN_OPACITY = 0.4

export interface MiniWindowSettings {
  /** Global accelerator that shows/hides the mini window(s) ('' = off). */
  shortcut: string
  /** Window opacity, MINI_WINDOW_MIN_OPACITY..1 (macOS and Windows; Linux ignores it). */
  opacity: number
  /** Dropped against a screen edge (or tucked with its button), the window slides away behind a handle tab. */
  tuckToEdge: boolean
  /** While tucked, resting the pointer on the handle peeks the window out until the pointer leaves. */
  peekOnHover: boolean
  /** How long the pointer rests on the handle before it peeks, one of MINI_WINDOW_PEEK_DELAYS. */
  peekDelayMs: number
  /** Dropped near a corner, the window snaps into it. */
  snapToCorners: boolean
}

export const DEFAULT_MINI_WINDOW_SETTINGS: MiniWindowSettings = {
  shortcut: DEFAULT_MINI_WINDOW_SHORTCUT,
  opacity: 1,
  tuckToEdge: true,
  peekOnHover: true,
  peekDelayMs: 350,
  snapToCorners: true
}

/** Settings → Mini window → hover delay choices (ms). */
export const MINI_WINDOW_PEEK_DELAYS: readonly number[] = [200, 350, 600, 1000]

export function isMiniWindowPeekDelay(value: unknown): value is number {
  return typeof value === 'number' && MINI_WINDOW_PEEK_DELAYS.includes(value)
}

const MODIFIERS = new Map<string, string>([
  ['commandorcontrol', 'CommandOrControl'], ['cmdorctrl', 'CommandOrControl'],
  ['command', 'Command'], ['cmd', 'Command'], ['super', 'Super'], ['meta', 'Super'],
  ['control', 'Control'], ['ctrl', 'Control'],
  ['alt', 'Alt'], ['option', 'Alt'], ['altgr', 'AltGr'],
  ['shift', 'Shift']
])
const NAMED_KEYS = new Set([
  'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'Plus'
])
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Super', 'Control', 'Alt', 'AltGr', 'Shift']

/**
 * A global shortcut as Electron's accelerator syntax, normalized ("cmd+shift+space" →
 * "Command+Shift+Space"), or null when it isn't usable: it needs at least one modifier other than
 * Shift (a bare key or Shift+key would eat typing everywhere) and exactly one key.
 */
export function normalizeAccelerator(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const parts = input.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > 5) return null
  const modifiers = new Set<string>()
  let key: string | null = null
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.toLowerCase())
    if (modifier) {
      modifiers.add(modifier)
      continue
    }
    if (key !== null) return null
    if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase()
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) key = part.toUpperCase()
    else {
      const named = [...NAMED_KEYS].find((name) => name.toLowerCase() === part.toLowerCase())
      if (named) key = named === 'Esc' ? 'Escape' : named === 'Enter' ? 'Return' : named
      else if (/^[-=[\]\\;',./`]$/.test(part)) key = part
      else return null
    }
  }
  if (!key) return null
  if (![...modifiers].some((modifier) => modifier !== 'Shift')) return null
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+')
}

/** Settings as stored (or sent from Settings): anything unreadable falls back to the defaults. */
export function parseMiniWindowSettings(value: unknown, defaults: MiniWindowSettings = DEFAULT_MINI_WINDOW_SETTINGS): MiniWindowSettings {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const d = defaults
  // An explicit '' turns the shortcut off; missing or invalid keeps the default.
  const shortcut = record.shortcut === '' ? '' : (normalizeAccelerator(record.shortcut) ?? d.shortcut)
  const opacity =
    typeof record.opacity === 'number' && Number.isFinite(record.opacity)
      ? Math.round(Math.min(1, Math.max(MINI_WINDOW_MIN_OPACITY, record.opacity)) * 100) / 100
      : d.opacity
  const bool = (key: keyof MiniWindowSettings, fallback: boolean): boolean =>
    typeof record[key] === 'boolean' ? (record[key] as boolean) : fallback
  return {
    shortcut,
    opacity,
    tuckToEdge: bool('tuckToEdge', d.tuckToEdge),
    peekOnHover: bool('peekOnHover', d.peekOnHover),
    peekDelayMs: isMiniWindowPeekDelay(record.peekDelayMs) ? record.peekDelayMs : d.peekDelayMs,
    snapToCorners: bool('snapToCorners', d.snapToCorners)
  }
}

/** Accelerators compared on what they press (CommandOrControl counts as Command on macOS, Control elsewhere). */
export function acceleratorKeys(accelerator: string, isMac: boolean): string | null {
  const normalized = normalizeAccelerator(accelerator.replace(/CmdOrCtrl/gi, 'CommandOrControl'))
  if (!normalized) return null
  return normalized
    .split('+')
    .map((part) => (part === 'CommandOrControl' ? (isMac ? 'Command' : 'Control') : part))
    .sort()
    .join('+')
}

/**
 * Shortcuts a global mini-window toggle would shadow: Inkfish's own, and well-known system / app
 * ones. Registering over another app's global shortcut either fails (the OS refuses) or silently
 * steals it, so Settings warns before either happens.
 */
export const KNOWN_SHORTCUTS: ReadonlyArray<{ accelerator: string; owner: string; mac?: boolean }> = [
  { accelerator: 'Alt+Space', owner: 'Inkfish quick capture' },
  { accelerator: 'Shift+Alt+Space', owner: 'Inkfish append to today' },
  { accelerator: MINI_WINDOW_POP_KEY, owner: 'Inkfish pop out / return (in-app)' },
  { accelerator: 'Command+Shift+Space', owner: '1Password Quick Access', mac: true },
  { accelerator: 'Command+Space', owner: 'Spotlight', mac: true },
  { accelerator: 'Command+Alt+Space', owner: 'Finder search', mac: true },
  { accelerator: 'Control+Space', owner: 'Input source switching', mac: true },
  { accelerator: 'Control+Shift+Space', owner: '1Password Quick Access', mac: false },
  { accelerator: 'Super+Space', owner: 'Input source / launcher', mac: false }
]

/** Who already uses `accelerator` on this platform (from KNOWN_SHORTCUTS), or null. */
export function shortcutClash(accelerator: string, isMac: boolean, known = KNOWN_SHORTCUTS): string | null {
  const wanted = acceleratorKeys(accelerator, isMac)
  if (!wanted) return null
  const hit = known.find((k) => (k.mac === undefined || k.mac === isMac) && acceleratorKeys(k.accelerator, isMac) === wanted)
  return hit?.owner ?? null
}

export interface ShortcutKeyEvent { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** A key press in Settings' shortcut field as an accelerator ("Command+Shift+Space"), or null while only modifiers are down. */
export function acceleratorFromKeyEvent(event: ShortcutKeyEvent, isMac: boolean): string | null {
  const raw = rawAcceleratorFromKeyEvent(event, isMac)
  return raw ? normalizeAccelerator(raw) : null
}

/**
 * The key press spelled as an accelerator WITHOUT validating it ("Space", "Shift+K"), or null while
 * only modifiers are down / the key has no accelerator name. Lets Settings say why a combo is refused.
 */
export function rawAcceleratorFromKeyEvent(event: ShortcutKeyEvent, isMac: boolean): string | null {
  let key: string | null = null
  if (event.code === 'Space') key = 'Space'
  else if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3)
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code
  else {
    const named: Record<string, string> = {
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return',
      Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown'
    }
    key = named[event.key] ?? null
  }
  if (!key) return null
  const parts: string[] = []
  if (isMac) {
    if (event.metaKey) parts.push('Command')
    if (event.ctrlKey) parts.push('Control')
  } else {
    if (event.ctrlKey) parts.push('Control')
    if (event.metaKey) parts.push('Super')
  }
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  return [...parts, key].join('+')
}

/** How an accelerator reads in Settings and menus ("⌃⌥M" on macOS, "Ctrl+Alt+M" elsewhere). */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  if (!accelerator) return 'Off'
  const parts = accelerator.split('+')
  if (isMac) {
    const symbols: Record<string, string> = { CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' }
    return parts.map((part) => symbols[part] ?? part).join('')
  }
  const names: Record<string, string> = { CommandOrControl: 'Ctrl', Control: 'Ctrl', Command: 'Super', Super: 'Super' }
  return parts.map((part) => names[part] ?? part).join('+')
}

/** Is this keydown the in-app pop-out / return key (⌘⇧M, Ctrl+Shift+M)? */
export function isPopKey(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')
}

// ---------------------------------------------------------------------------
// Geometry

export interface MiniRect { x: number; y: number; width: number; height: number }

export const MINI_WINDOW_DEFAULT_SIZE = { width: 360, height: 440 }
export const MINI_WINDOW_MIN_SIZE = { width: 240, height: 160 }
/** Gap kept from the work area's edges when placed in (or snapped to) a corner. */
export const MINI_WINDOW_MARGIN = 16
/** Dropped this close to a corner (both edges), the window snaps into it. */
export const MINI_WINDOW_SNAP_DISTANCE = 32
/** Header height when revealed; it overlays the note's top. */
export const MINI_WINDOW_HEADER_HEIGHT = 34
/** Pointer this close to the top of the window reveals the header. */
export const MINI_WINDOW_REVEAL_ZONE = 40

/** Saved geometry is keyed by display (its work area), so each monitor remembers its own spot. */
export function miniDisplayKey(workArea: MiniRect): string {
  return `${Math.round(workArea.x)},${Math.round(workArea.y)},${Math.round(workArea.width)}x${Math.round(workArea.height)}`
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseMiniGeometry(value: unknown): Record<string, MiniRect> {
  const out: Record<string, MiniRect> = {}
  if (typeof value !== 'object' || value === null) return out
  for (const [key, rect] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    if (typeof rect !== 'object' || rect === null) continue
    const { x, y, width, height } = rect as Record<string, unknown>
    if (finite(x) && finite(y) && finite(width) && finite(height) && width > 0 && height > 0) {
      out[key] = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
    }
  }
  return out
}

/** Fit `rect` inside the work area (shrinking it to fit, never below the minimum size). */
export function clampMiniBounds(rect: MiniRect, workArea: MiniRect): MiniRect {
  const width = Math.max(MINI_WINDOW_MIN_SIZE.width, Math.min(Math.round(rect.width), workArea.width))
  const height = Math.max(MINI_WINDOW_MIN_SIZE.height, Math.min(Math.round(rect.height), workArea.height))
  const x = Math.min(Math.max(Math.round(rect.x), workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(Math.round(rect.y), workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/** Where a new mini window goes on a display: its saved spot there, else the top-right corner. */
export function initialMiniBounds(workArea: MiniRect, saved: MiniRect | undefined): MiniRect {
  if (saved) return clampMiniBounds(saved, workArea)
  const { width, height } = MINI_WINDOW_DEFAULT_SIZE
  return clampMiniBounds(
    { x: workArea.x + workArea.width - width - MINI_WINDOW_MARGIN, y: workArea.y + MINI_WINDOW_MARGIN, width, height },
    workArea
  )
}

/** Dropped near a corner of the work area: the bounds snapped into it (MINI_WINDOW_MARGIN from both edges), else null. */
export function snapMiniToCorner(rect: MiniRect, workArea: MiniRect, distance = MINI_WINDOW_SNAP_DISTANCE): MiniRect | null {
  const left = rect.x - workArea.x
  const top = rect.y - workArea.y
  const right = workArea.x + workArea.width - (rect.x + rect.width)
  const bottom = workArea.y + workArea.height - (rect.y + rect.height)
  const nearLeft = left <= distance
  const nearRight = right <= distance
  const nearTop = top <= distance
  const nearBottom = bottom <= distance
  if (!((nearLeft || nearRight) && (nearTop || nearBottom))) return null
  const x = nearLeft ? workArea.x + MINI_WINDOW_MARGIN : workArea.x + workArea.width - rect.width - MINI_WINDOW_MARGIN
  const y = nearTop ? workArea.y + MINI_WINDOW_MARGIN : workArea.y + workArea.height - rect.height - MINI_WINDOW_MARGIN
  if (x === rect.x && y === rect.y) return null
  return { ...rect, x, y }
}

// ---------------------------------------------------------------------------
// Several mini windows

/** How many mini windows can be open at once. */
export const MINI_WINDOW_MAX = 6
/** A new mini window opens this far (x and y) from one already there, so they never stack exactly. */
export const MINI_WINDOW_CASCADE_STEP = 28

/** The lowest slot no open mini window uses (slots key each window's remembered spot), or null when all are taken. */
export function freeMiniSlot(used: readonly number[], max = MINI_WINDOW_MAX): number | null {
  for (let slot = 0; slot < max; slot++) if (!used.includes(slot)) return slot
  return null
}

/**
 * `rect` (fitted to the work area), stepped diagonally by MINI_WINDOW_CASCADE_STEP until no window in
 * `others` sits at (about) the same spot. It steps toward the middle of the work area.
 */
export function cascadeMiniBounds(rect: MiniRect, others: readonly MiniRect[], workArea: MiniRect, step = MINI_WINDOW_CASCADE_STEP): MiniRect {
  let current = clampMiniBounds(rect, workArea)
  const dx = current.x + current.width / 2 > workArea.x + workArea.width / 2 ? -step : step
  const dy = current.y + current.height / 2 > workArea.y + workArea.height / 2 ? -step : step
  const taken = (r: MiniRect): boolean => others.some((other) => Math.abs(other.x - r.x) < step / 2 && Math.abs(other.y - r.y) < step / 2)
  for (let i = 0; i < 64 && taken(current); i++) {
    const next = clampMiniBounds({ ...current, x: current.x + dx, y: current.y + dy }, workArea)
    if (next.x === current.x && next.y === current.y) break
    current = next
  }
  return current
}

/** Per-window remembered state, one record per slot (`{ slots: [...] }`). */
export function parseMiniSlots<T>(value: unknown, parseOne: (value: unknown) => Record<string, T>): Array<Record<string, T>> {
  if (typeof value !== 'object' || value === null) return []
  const slots = (value as Record<string, unknown>).slots
  if (Array.isArray(slots)) return slots.slice(0, MINI_WINDOW_MAX).map((slot) => parseOne(slot))
  return []
}

/** One slot's record set to `record` (others kept), ready to write back as `{ slots }`. */
export function withMiniSlot<T>(slots: ReadonlyArray<Record<string, T>>, slot: number, record: Record<string, T>): { slots: Array<Record<string, T>> } {
  const next = slots.map((entry) => ({ ...entry }))
  while (next.length <= slot) next.push({})
  next[slot] = record
  while (next.length > 0 && Object.keys(next[next.length - 1] ?? {}).length === 0) next.pop()
  return { slots: next }
}

// ---------------------------------------------------------------------------
// Live note sync between windows

/**
 * The smallest single edit turning `from` into `to` (common prefix/suffix trimmed), so a remote
 * update applied to an editor keeps the caret and scroll instead of replacing the whole document.
 * Null when they're equal.
 */
export function minimalEdit(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let endA = from.length
  let endB = to.length
  while (endA > start && endB > start && from.charCodeAt(endA - 1) === to.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  return { from: start, to: endA, insert: to.slice(start, endB) }
}

/** `#mini?id=<note id>` — the hash a mini window's renderer loads with. */
export function miniHash(noteId: string): string {
  return `mini?id=${encodeURIComponent(noteId)}`
}

/** The note id from a mini window's location hash, or null when it isn't one. */
export function noteIdFromMiniHash(hash: string): string | null {
  const m = /^#?mini\?(.*)$/.exec(hash)
  if (!m) return null
  const id = new URLSearchParams(m[1] ?? '').get('id')
  return id || null
}
