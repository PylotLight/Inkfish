import { Tray, Menu, Notification, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'

export interface TrayCallbacks {
  onShow(): void
  onHide(): void
  onToggleWindow(): void
  onQuit(): void
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
  tray.setToolTip('bun-electron-app kitchen')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show window', click: cb.onShow },
      { label: 'Hide to tray', click: cb.onHide },
      { type: 'separator' },
      {
        label: 'Send test notification',
        click: () => {
          if (Notification.isSupported()) {
            new Notification({ title: 'bun-electron-app', body: 'Hello from the tray!' }).show()
          }
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: cb.onQuit }
    ])
  )
  tray.on('click', cb.onToggleWindow)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
