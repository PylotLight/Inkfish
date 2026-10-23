// Must be first: picks the app profile (dev runs → "Inkfish Dev") and moves userData before
// anything reads it or takes the single-instance lock.
import { profile } from './profile'
import {
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  protocol,
  session,
  systemPreferences,
  webContents
} from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
// Crash guard before the app's own modules: catches errors thrown while they load.
import './crash-guard'
import { closeProxy, initializeProxy } from './proxy'
import { APP_ID } from '../shared/config'
import { registerIpc } from './ipc'
import { initAiApi } from './ai-api'
import { registerSysTap, stopSysTap } from './systap'
import { destroyTray } from './tray'
import { startMenuBar } from './menubar'
import { createWindow, getMainWindow, sendToMain, showWindow } from './window'
import { createPopover, toggleDaily, toggleDailyAtTray, togglePopover, togglePopoverAtTray } from './popover'
import { registerAssetProtocol } from './assets-protocol'
import { closeAllMinis, getMiniSettings, registerMiniWindow } from './mini-window'
import { registerCaptureShortcuts, registerShortcutIpc } from './shortcuts'
import { openDb, reindexStaging, reindexVault } from './db'
import { ensureVault, mergeCaseDuplicates, setConfigDir, setDefaultVaultName, vaultConfigured } from './vault'
import { profileBadgeText } from '../shared/profile'
import { startVaultWatch, stopVaultWatch, rescanVaultFromDisk } from './watch'
import { closeDb } from './db'
import { createShutdown } from '../shared/stability'
import { createQuitFlush } from '../shared/autosave'
import { startSync, stopSync, appendSyncLog } from './sync'
import { initializeUpdates, registerUpdateIpc } from './updates'

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

// Single instance: a second launch focuses the existing window instead of forking. The lock is
// per userData, so "Inkfish" and "Inkfish Dev" each keep one window owner and run side by side.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function initVault(): void {
  try {
    const paths = ensureVault()
    const merged = mergeCaseDuplicates(paths.root)
    if (merged.dirs > 0 || merged.files > 0) {
      console.log(`[inkfish] healed ${merged.dirs} folder(s), ${merged.files} file(s) with case-duplicate names`)
      appendSyncLog({
        at: Date.now(),
        peer: '',
        kind: 'heal',
        message: `merged ${merged.dirs} folder(s), ${merged.files} file(s) with case-duplicate names`
      })
    }
    const kind = openDb(paths.dbPath)
    const n = reindexVault(paths.root) + reindexStaging(paths)
    console.log(`[inkfish] vault ${paths.root} — index ${kind}, ${n} notes`)
    startVaultWatch([paths.root, paths.inboxDir, paths.dailyDir], rescanVaultFromDisk)
  } catch (err) {
    console.error('[inkfish] vault init failed:', err)
  }
}

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId(profile.kind === 'release' ? APP_ID : `${APP_ID}.${profile.badge}`)
    await initializeProxy()

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Mic: route renderer getUserMedia through the macOS TCC prompt (needs
    // NSMicrophoneUsageDescription in Info.plist — see package.json extendInfo).
    // Every other permission keeps Electron's default (granted).
    // Electron 45+: getDisplayMedia (meeting capture) arrives as 'display-capture' instead of 'media'
    // with empty mediaTypes, so it no longer runs through the mic check below; it stays granted here
    // and setDisplayMediaRequestHandler picks the source. 'media' is now only camera/microphone.
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
    setDefaultVaultName(profile.vaultDirName)
    // Tell the profiles apart at a glance: Dock badge "dev" (the inbox count joins it, see ipc.ts).
    if (profile.badge && process.platform === 'darwin') app.dock?.setBadge(profileBadgeText(profile, 0))
    if (vaultConfigured()) {
      initVault()
    } else {
      // True first run: do NOTHING yet — the onboarding wizard picks the vault
      // location first, then the renderer drives setup via `vault:set-root`.
      console.log('[inkfish] first run — waiting for vault selection')
    }
    registerIpc()
    registerShortcutIpc()
    // Settings › AI: Electron 45 local AI handler for the Prompt API (off until a provider is connected).
    initAiApi()
    registerUpdateIpc()
    registerMiniWindow()
    // LAN sync listener for paired phones (no-op until a vault exists).
    startSync()
    registerSysTap()
    registerAssetProtocol()
    createWindow()
    createPopover()
    // Release notifications from the GitHub releases feed (first check ~30 s after launch).
    initializeUpdates()
    // Tray (unless turned off in Settings → Menu bar) + menu-bar-only Dock mode.
    startMenuBar({
      onShow: showWindow,
      onCapture: togglePopover,
      onCaptureAt: (x, y, w, h) => togglePopoverAtTray(x, y, w, h),
      onDailyAt: (x, y, w, h) => toggleDailyAtTray(x, y, w, h),
      onOpenToday: () => {
        showWindow()
        sendToMain('inkfish:open-today')
      },
      onQuit: () => app.quit()
    })

    // Global capture shortcuts: ⌥Space / ⇧⌥Space by default in the release app, ⌃⌥Space / ⇧⌃⌥Space
    // in a dev profile (INKFISH_SHORTCUTS=off: none). Configurable in Settings › Shortcuts
    // (main/shortcuts.ts re-registers live). A shortcut another app holds is skipped with a warning.
    registerCaptureShortcuts({ capture: togglePopover, daily: toggleDaily }, () => ({
      'mini window show/hide': getMiniSettings().shortcut
    }))

    // Dock click / relaunch from Finder (macOS). This used to be "no windows at all → create one",
    // but the hidden capture popover (and any minis) always count as windows, so after the main
    // window was closed (⌘W / red button destroys it) or hidden, clicking the Dock did nothing and
    // only a restart brought it back. Now: if the main window isn't up, show it (recreating if gone).
    app.on('activate', () => {
      const win = getMainWindow()
      // Launch: the first window is still loading and shows itself on ready-to-show.
      if (win && !win.isVisible() && win.webContents.isLoading()) return
      if (win?.isVisible() && !win.isMinimized()) return
      showWindow()
    })
  })
  .catch((error: unknown) => {
    dialog.showErrorBox('Inkfish could not start safely', error instanceof Error ? error.message : String(error))
    app.quit()
  })

app.on('second-instance', () => showWindow())

// On macOS the app stays alive in the tray after the window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Autosave: before anything closes, every window (main + minis) writes its pending text and
// acks. Quit is deferred until then (or a short timeout), so ⌘Q never drops a keystroke. The
// windows' own `beforeunload` sync-save is the second net; the ordered shutdown below runs after.
// Only renderers that hold an editor register (popover/capture windows never answer).
const autosaveWindows = new Set<number>()
ipcMain.on('inkfish:autosave-register', (e, on: unknown) => {
  const id = e.sender.id
  if (on === false) {
    autosaveWindows.delete(id)
    return
  }
  if (autosaveWindows.has(id)) return
  autosaveWindows.add(id)
  e.sender.once('destroyed', () => autosaveWindows.delete(id))
})
const quitFlush = createQuitFlush({
  targets: () =>
    [...autosaveWindows].filter((id) => {
      const wc = webContents.fromId(id)
      return !!wc && !wc.isDestroyed()
    }),
  request: (id, token) => {
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) throw new Error('gone')
    wc.send('inkfish:flush', token)
  },
  timeoutMs: 2000
})
ipcMain.on('inkfish:flush-done', (_e, token: unknown) => {
  if (typeof token === 'string') quitFlush.ack(token)
})
let quitFlushed = false
let quitFlushing = false
app.on('before-quit', (e) => {
  if (!quitFlushed) {
    e.preventDefault()
    if (quitFlushing) return
    quitFlushing = true
    void quitFlush
      .run()
      .then((r) => {
        if (r.timedOut) console.warn('[inkfish] quit flush timed out — beforeunload saves are the fallback')
      })
      .finally(() => {
        quitFlushed = true
        app.quit()
      })
    return
  }
  closeAllMinis()
})

// Ordered shutdown (ported from Surffish #136): stop everything that can write to the vault
// or the index first (watcher reindex, LAN sync), then close the SQLite index last so its WAL
// is checkpointed and nothing writes after it closes. A failing step never skips the rest.
const shutdown = createShutdown(
  [
    { name: 'proxy', run: closeProxy },
    { name: 'shortcuts', run: () => globalShortcut.unregisterAll() },
    { name: 'systap', run: stopSysTap },
    { name: 'vault watch', run: stopVaultWatch },
    { name: 'sync', run: stopSync },
    { name: 'tray', run: destroyTray },
    { name: 'index db', run: closeDb }
  ],
  (message) => console.warn(message)
)

app.on('will-quit', () => {
  shutdown()
})
