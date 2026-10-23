import { BrowserWindow, Menu, app, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { type FindAction, findActionForInput } from '../shared/find-keys'

export type { FindAction }

const sendFind = (action: FindAction): void => {
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isDestroyed()) win.webContents.send('inkfish:find', action)
}

/**
 * Catch the find keys in main, before the page or the menu sees them. On macOS the in-app ⌘F never
 * reached the renderer's keydown listener (or the menu key equivalent) while the window had focus;
 * before-input-event runs ahead of both, and preventDefault stops the page keydown and the menu item,
 * so each press runs exactly once.
 */
export function watchFindKeys(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    const action = findActionForInput(input)
    if (!action) return
    event.preventDefault()
    if (!contents.isDestroyed()) contents.send('inkfish:find', action)
  })
}

/**
 * macOS app menu with a real Edit › Find section. Without it the keys only work if the renderer's
 * keydown listener sees them; with it ⌘F / ⌥⌘F / ⌘G / ⇧⌘G are menu key equivalents that always reach
 * the focused window (main or a mini). When the renderer already handled the key (preventDefault)
 * the menu item doesn't fire again. Other platforms keep no menu bar.
 */
export function installAppMenu(): void {
  app.on('browser-window-created', (_event, win) => watchFindKeys(win.webContents))
  for (const win of BrowserWindow.getAllWindows()) watchFindKeys(win.webContents)
  if (process.platform !== 'darwin') return
  const find: MenuItemConstructorOptions = {
    label: 'Find',
    submenu: [
      { label: 'Find…', accelerator: 'CommandOrControl+F', click: () => sendFind('find') },
      { label: 'Find and Replace…', accelerator: 'Alt+CommandOrControl+F', click: () => sendFind('replace') },
      { label: 'Find Next', accelerator: 'CommandOrControl+G', click: () => sendFind('next') },
      { label: 'Find Previous', accelerator: 'Shift+CommandOrControl+G', click: () => sendFind('prev') }
    ]
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu', label: app.name },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        find
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
