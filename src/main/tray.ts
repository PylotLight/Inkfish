import { Tray, Menu, Notification, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import { APP_NAME, TRAY_TOOLTIP } from '../shared/config'

export interface TrayCallbacks {
  onShow(): void
  onCapture(): void
  onCaptureAt(x?: number, y?: number, w?: number, h?: number): void
  onDailyAt(x?: number, y?: number, w?: number, h?: number): void
  onOpenToday(): void
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
  tray.setToolTip(TRAY_TOOLTIP)
  const atTray = (): [number | undefined, number | undefined, number | undefined, number | undefined] => {
    const b = tray?.getBounds()
    return [b?.x, b?.y, b?.width, b?.height]
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'New note  (⌥Space)', click: cb.onCapture },
      { label: 'Append to today  (⇧⌥Space)', click: () => cb.onDailyAt(...atTray()) },
      { label: 'Open today', click: cb.onOpenToday },
      { label: 'Show Inkfish', click: cb.onShow },
      { type: 'separator' },
      {
        label: 'Send test notification',
        click: () => {
          if (Notification.isSupported()) {
            new Notification({ title: APP_NAME, body: 'Hello from the tray!' }).show()
          }
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: cb.onQuit }
    ])
  )
  // Left-click pops the capture window (same as Opt-Space); right-click keeps
  // the advanced menu (Show / test notification / Quit).
  tray.on('click', () => {
    const b = tray?.getBounds()
    cb.onCaptureAt(b?.x, b?.y, b?.width, b?.height)
  })
  tray.on('right-click', () => tray?.popUpContextMenu())
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
