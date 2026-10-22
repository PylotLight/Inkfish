/**
 * App profiles (ported from Surffish's dev profile, #65 / #69). A dev run (`bun run dev`, any
 * unpackaged Electron) is "Inkfish Dev": its own app name, userData dir, single-instance lock,
 * notes-folder default, LAN sync port and global shortcuts, so it runs beside the installed
 * release app without touching its vault config, settings, sync pairing or keys.
 * `INKFISH_PROFILE=<name>` picks another isolated profile ("Inkfish <name>"), packaged or not.
 *
 * No Electron imports: main, renderer and unit tests share it.
 */
import { APP_NAME } from './config'
import { DEFAULT_PORT } from './sync/protocol'

export type ProfileKind = 'release' | 'dev' | 'custom'

export interface AppProfile {
  kind: ProfileKind
  /** App name, userData folder name and default notes-folder name: "Inkfish", "Inkfish Dev", ... */
  name: string
  /** Short label for badges / pills ('' for release). */
  badge: string
  /** Folder under the home dir suggested (and auto-adopted) as the notes home. */
  vaultDirName: string
  /** Preferred LAN sync port. A clash still falls back to a random free port. */
  syncPort: number
  /** Global quick-capture accelerators ('' = not registered). */
  captureShortcut: string
  dailyShortcut: string
  /** Default global mini-window toggle for a fresh profile ('' = off). */
  miniShortcutDefault: string
}

export const RELEASE_CAPTURE_SHORTCUT = 'Alt+Space'
export const RELEASE_DAILY_SHORTCUT = 'Shift+Alt+Space'
/** Dev / custom profiles: ⌃⌥Space / ⇧⌃⌥Space, so both apps can hold their own keys at once. */
export const DEV_CAPTURE_SHORTCUT = 'Control+Alt+Space'
export const DEV_DAILY_SHORTCUT = 'Shift+Control+Alt+Space'

/** Sanitised INKFISH_PROFILE value ('' when unset / empty after cleaning). */
export function cleanProfileName(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/[^\w.-]/g, '').slice(0, 32)
}

export interface ProfileInput {
  isPackaged: boolean
  /** INKFISH_PROFILE */
  profileEnv?: string
  /** INKFISH_SHORTCUTS=off: register no global shortcuts in this run. */
  shortcutsEnv?: string
}

/** INKFISH_SHORTCUTS=off|0|false|no|none: register no global shortcuts in this run. */
export function shortcutsDisabled(shortcutsEnv: string | undefined): boolean {
  return /^(off|0|false|no|none)$/i.test((shortcutsEnv ?? '').trim())
}

export function resolveProfile({ isPackaged, profileEnv, shortcutsEnv }: ProfileInput): AppProfile {
  const custom = cleanProfileName(profileEnv)
  const kind: ProfileKind = custom ? 'custom' : isPackaged ? 'release' : 'dev'
  const shortcutsOff = shortcutsDisabled(shortcutsEnv)
  if (kind === 'release') {
    return {
      kind,
      name: APP_NAME,
      badge: '',
      vaultDirName: APP_NAME,
      syncPort: DEFAULT_PORT,
      captureShortcut: shortcutsOff ? '' : RELEASE_CAPTURE_SHORTCUT,
      dailyShortcut: shortcutsOff ? '' : RELEASE_DAILY_SHORTCUT,
      miniShortcutDefault: shortcutsOff ? '' : 'Control+Alt+M'
    }
  }
  const name = custom ? `${APP_NAME} ${custom}` : `${APP_NAME} Dev`
  return {
    kind,
    name,
    badge: custom ? custom.slice(0, 8).toLowerCase() : 'dev',
    vaultDirName: name,
    syncPort: DEFAULT_PORT + 1,
    captureShortcut: shortcutsOff ? '' : DEV_CAPTURE_SHORTCUT,
    dailyShortcut: shortcutsOff ? '' : DEV_DAILY_SHORTCUT,
    // The release app owns ⌃⌥M; a dev profile starts with no mini toggle (set one in Settings).
    miniShortcutDefault: ''
  }
}

/**
 * Whether to move userData to the profile's folder. Leave an explicitly chosen dir alone
 * (--user-data-dir, smoke tests): only switch when userData is still the default <appData>/<x>.
 */
export function shouldIsolateUserData(profile: AppProfile, userDataParent: string, appData: string): boolean {
  return profile.kind !== 'release' && userDataParent === appData
}

/** Dock badge text: the profile badge, plus the pending count when there is one ("dev 3"). */
export function profileBadgeText(profile: AppProfile, count: number): string {
  const n = count > 0 ? String(count) : ''
  if (!profile.badge) return n
  return n ? `${profile.badge} ${n}` : profile.badge
}

/** Human form of an accelerator for menus and hints: "Shift+Control+Alt+Space" -> "⇧⌃⌥Space" on macOS. */
export function shortcutLabel(accelerator: string, isMac: boolean): string {
  if (!accelerator) return ''
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  if (!isMac) return [...parts.map((p) => (p === 'CommandOrControl' ? 'Ctrl' : p === 'Control' ? 'Ctrl' : p)), key].join('+')
  const order = ['Control', 'Alt', 'Shift', 'Command', 'CommandOrControl']
  const sym: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', CommandOrControl: '⌘' }
  const mods = [...parts].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  // Apple order is ⌃⌥⇧⌘, but Inkfish has always written ⇧⌥Space; keep ⇧ first for familiarity.
  const shift = mods.includes('Shift') ? '⇧' : ''
  return shift + mods.filter((m) => m !== 'Shift').map((m) => sym[m] ?? m).join('') + key
}

/** What the renderer gets from `app:profile`. */
export interface AppProfileInfo {
  kind: ProfileKind
  name: string
  badge: string
  captureShortcut: string
  dailyShortcut: string
  /** ~/Inkfish or ~/Inkfish Dev: what onboarding suggests. */
  defaultVaultRoot: string
}
