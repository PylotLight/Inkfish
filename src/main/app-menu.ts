import { BrowserWindow, Menu, app, type MenuItemConstructorOptions } from 'electron'

/** Which find action a menu item asks the focused note for. */
export type FindAction = 'find' | 'replace' | 'next' | 'prev'

const sendFind = (action: FindAction): void => {
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isDestroyed()) win.webContents.send('inkfish:find', action)
}

/**
 * macOS app menu with a real Edit › Find section. Without it the keys only work if the renderer's
 * keydown listener sees them; with it ⌘F / ⌥⌘F / ⌘G / ⇧⌘G are menu key equivalents that always reach
 * the focused window (main or a mini). When the renderer already handled the key (preventDefault)
 * the menu item doesn't fire again. Other platforms keep no menu bar.
 */
export function installAppMenu(): void {
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
