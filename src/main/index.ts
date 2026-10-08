import { app, BrowserWindow, desktopCapturer, globalShortcut, protocol, session, systemPreferences } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { APP_ID } from '../shared/config'
import { registerIpc } from './ipc'
import { registerSysTap, stopSysTap } from './systap'
import { createAppTray, destroyTray } from './tray'
import { createWindow, getMainWindow, showWindow } from './window'
import { createPopover, toggleDaily, toggleDailyAtTray, togglePopover, togglePopoverAtTray } from './popover'
import { registerAssetProtocol } from './assets-protocol'
import { openDb, reindexStaging, reindexVault } from './db'
import { ensureSeedProjects, ensureVault, mergeCaseDuplicates, setConfigDir, vaultConfigured } from './vault'
import { startVaultWatch, stopVaultWatch, rescanVaultFromDisk } from './watch'
import { startSync, stopSync } from './sync'

// Custom protocols must be privileged before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

// In-app WASM speech engines (Redux · Web, ONNX Runtime Web) use threads, which
// need SharedArrayBuffer; file:// pages can't send COOP/COEP headers.
// On macOS, Chromium's ScreenCaptureKit loopback gives getDisplayMedia the
// Mac's output audio — the "Them" side of meeting capture (macOS 13+).
app.commandLine.appendSwitch(
  'enable-features',
  [
    'SharedArrayBuffer',
    // macOS 14.2+: CoreAudio tap (CATap) is the more reliable loopback path;
    // SCK loopback remains the fallback on 13.x.
    ...(process.platform === 'darwin'
      ? ['MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride', 'MacCatapLoopbackAudioForScreenShare']
      : [])
  ].join(',')
)

// Single instance: a second launch focuses the existing window instead of forking.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function initVault(): void {
  try {
    const paths = ensureVault()
    ensureSeedProjects(paths)
    const merged = mergeCaseDuplicates(paths.root)
    if (merged.dirs > 0 || merged.files > 0) {
      console.log(`[inkfish] healed ${merged.dirs} folder(s), ${merged.files} file(s) with case-duplicate names`)
    }
    const kind = openDb(paths.dbPath)
    const n = reindexVault(paths.root) + reindexStaging(paths)
    console.log(`[inkfish] vault ${paths.root} — index ${kind}, ${n} notes`)
    startVaultWatch([paths.root, paths.inboxDir, paths.dailyDir], rescanVaultFromDisk)
  } catch (err) {
    console.error('[inkfish] vault init failed:', err)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Mic: route renderer getUserMedia through the macOS TCC prompt (needs
  // NSMicrophoneUsageDescription in Info.plist — see package.json extendInfo).
  // Every other permission keeps Electron's default (granted).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission !== 'media' || process.platform !== 'darwin') {
      callback(true)
      return
    }
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    if (types.includes('video')) {
      callback(false)
      return
    }
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') callback(true)
    else if (status === 'not-determined') {
      systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false))
    } else callback(false)
  })

  // Meeting capture: grant getDisplayMedia the primary screen plus system-audio
  // loopback without a picker. The renderer keeps a 2px video track alive but disabled (stopping it kills SCK audio); macOS
  // asks for Screen & System Audio Recording the first time.
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    // null denies (documented), though the typings omit it.
    const deny = (): void => (callback as (s: unknown) => void)(null)
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => (sources[0] ? callback({ video: sources[0], audio: 'loopback' }) : deny()))
      .catch(deny)
  })

  setConfigDir(app.getPath('userData'))
  if (vaultConfigured()) {
    initVault()
  } else {
    // True first run: do NOTHING yet — the onboarding wizard picks the vault
    // location first, then the renderer drives setup via `vault:set-root`.
    console.log('[inkfish] first run — waiting for vault selection')
  }
  registerIpc()
  // LAN sync listener for paired phones (no-op until a vault exists).
  startSync()
  registerSysTap()
  registerAssetProtocol()
  createWindow()
  createPopover()
  createAppTray({
    onShow: showWindow,
    onCapture: togglePopover,
    onCaptureAt: (x, y, w) => togglePopoverAtTray(x, y, w),
    onDailyAt: (x, y, w) => toggleDailyAtTray(x, y, w),
    onOpenToday: () => {
      showWindow()
      getMainWindow()?.webContents.send('inkfish:open-today')
    },
    onQuit: () => app.quit()
  })

  // Opt-Space capture shortcut (Alt+Space). Unregisters automatically on quit.
  const ok = globalShortcut.register('Alt+Space', togglePopover)
  if (!ok) console.warn('[inkfish] Alt+Space already taken — capture via tray menu')
  // Shift+Opt-Space appends to today's day-log.
  const okDaily = globalShortcut.register('Shift+Alt+Space', toggleDaily)
  if (!okDaily) console.warn('[inkfish] Shift+Alt+Space already taken — append via tray menu')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => showWindow())

// On macOS the app stays alive in the tray after the window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopSysTap()
  stopSync()
  stopVaultWatch()
  destroyTray()
})
