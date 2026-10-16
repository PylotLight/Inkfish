import { Tray, Menu, Notification, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { join } from 'node:path'
import { profile } from './profile'
import { shortcutLabel } from '../shared/profile'

export interface TrayCallbacks {
  onShow(): void
  onCapture(): void
  onCaptureAt(x?: number, y?: number, w?: number, h?: number): void
  onDailyAt(x?: number, y?: number, w?: number, h?: number): void
  onOpenToday(): void
  onQuit(): void
  /** Extra right-click items (menu bar mode adds the Dock toggle). */
  menuExtras?(): MenuItemConstructorOptions[]
}

let tray: Tray | null = null

// 1x1 transparent PNG used only if the generated assets are missing.
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function resolveIcon(): NativeImage {
  // __dirname is out/main both in dev and in built output, so ../../assets works for both.
  const base = join(__dirname, '../../assets')
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  const img = nativeImage.createFromPath(join(base, file))
  if (!img.isEmpty()) {
    if (process.platform === 'darwin') img.setTemplateImage(true)
    return img
  }
  console.warn(`[tray] icon missing at ${join(base, file)} — run \`bun run assets\``)
  return nativeImage.createFromDataURL(FALLBACK_ICON)
}

export function createAppTray(cb: TrayCallbacks): void {
  if (tray) return
  tray = new Tray(resolveIcon())
  tray.setToolTip(`${profile.name} — click for menu`)
  // macOS: a dev profile's tray icon carries its badge text so it's never mistaken for the release app's.
  if (profile.badge && process.platform === 'darwin') tray.setTitle(profile.badge)
  const atTray = (): [number | undefined, number | undefined, number | undefined, number | undefined] => {
    const b = tray?.getBounds()
    return [b?.x, b?.y, b?.width, b?.height]
  }
  // NOTE: no `setContextMenu` — on macOS a bound menu also fires on
  // left-click, which popped the menu *and* the capture window together.
  // The menu is built on demand for right-click only.
  const isMac = process.platform === 'darwin'
  const hint = (accel: string): string => (accel ? `  (${shortcutLabel(accel, isMac)})` : '')
  const buildMenu = (): Menu =>
    Menu.buildFromTemplate([
      { label: `New note${hint(profile.captureShortcut)}`, click: cb.onCapture },
      { label: `Append to today${hint(profile.dailyShortcut)}`, click: () => cb.onDailyAt(...atTray()) },
      { label: 'Open today', click: cb.onOpenToday },
      { label: `Show ${profile.name}`, click: cb.onShow },
      { type: 'separator' },
      ...(cb.menuExtras?.() ?? []),
      {
        label: 'Send test notification',
        click: () => {
          if (Notification.isSupported()) {
            new Notification({ title: profile.name, body: 'Hello from the tray!' }).show()
          }
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: cb.onQuit }
    ])
  // Left-click pops the capture window (same as Opt-Space); right-click gets
  // the menu — never both at once.
  tray.on('click', () => {
    const b = tray?.getBounds()
    cb.onCaptureAt(b?.x, b?.y, b?.width, b?.height)
  })
  tray.on('right-click', () => tray?.popUpContextMenu(buildMenu()))
}

export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
