import { app, clipboard, ipcMain, net, Notification, shell } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BREW_UPGRADE_COMMAND,
  DEFAULT_UPDATE_FEED_URL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FEED_MAX_BYTES,
  UPDATE_INITIAL_DELAY_MS,
  UPDATE_REMIND_LATER_MS,
  applyUpdateSettings,
  decideUpdate,
  describeFeedHttpFailure,
  effectiveFeedUrl,
  isUpdateCheckDue,
  parseReleaseFeed,
  parseUpdatePreferences,
  pickLatestRelease,
  redactFeedUrl,
  releaseAssetCandidates,
  toReleaseInfo,
  type UpdateCheckStatus,
  type UpdatePreferences,
  type UpdateReleaseInfo,
  type UpdateSettingsResult,
  type UpdateState
} from '../shared/update-feed'
import { APP_NAME } from '../shared/config'
import { getMainWindow, sendToMain, showWindow } from './window'

/**
 * Update notifications from the GitHub releases Atom feed (ported from Surffish #64).
 * Main process only: renderers never fetch. No auto-install (no signed update feed): we tell
 * the user, link the .dmg / release page, and offer the Homebrew upgrade command.
 * First check ~30 s after launch (skipped if one ran in the last 6 h), then every 6 h.
 */

const PREFERENCES_FILE = 'update-preferences.json'
const FETCH_TIMEOUT_MS = 15_000
const ASSET_PROBE_TIMEOUT_MS = 8_000

let preferences: UpdatePreferences = parseUpdatePreferences(null)
let status: UpdateCheckStatus = 'idle'
let message: string | null = null
let latest: UpdateReleaseInfo | null = null
let checkTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<UpdateState> | null = null
let initialized = false
let activeNotification: Notification | null = null

function preferencesPath(): string {
  return join(app.getPath('userData'), PREFERENCES_FILE)
}

function loadPreferences(): void {
  try {
    const path = preferencesPath()
    preferences = parseUpdatePreferences(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
  } catch (error) {
    console.warn(`[updates] could not read ${PREFERENCES_FILE}:`, error)
    preferences = parseUpdatePreferences(null)
  }
}

/** 0600 + temp/rename: a custom feed URL may carry a token. */
function savePreferences(): void {
  try {
    const path = preferencesPath()
    writeFileSync(`${path}.tmp`, JSON.stringify(preferences, null, 2), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  } catch (error) {
    console.warn(`[updates] could not save ${PREFERENCES_FILE}:`, error)
  }
}

export function getUpdateState(): UpdateState {
  const decision = decideUpdate(latest?.version ?? null, app.getVersion(), preferences, Date.now())
  return {
    currentVersion: app.getVersion(),
    engine: { electron: process.versions.electron ?? '', chromium: process.versions.chrome ?? '' },
    status,
    message,
    latest,
    showBadge: decision.showBadge,
    updateAvailable: decision.updateAvailable,
    skippedVersion: preferences.skippedVersion,
    lastChecked: preferences.lastChecked,
    feedUrl: preferences.feedUrl,
    defaultFeedUrl: DEFAULT_UPDATE_FEED_URL,
    betaChannel: preferences.betaChannel
  }
}

function publish(): UpdateState {
  const state = getUpdateState()
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('updates:changed', state)
  return state
}

/** Bring the main window up on Settings → About & updates. */
export function revealUpdateSettings(): void {
  showWindow()
  // Let a freshly created window load (and mount) before asking it to navigate.
  sendToMain('updates:reveal')
}

function showUpdateNotification(release: UpdateReleaseInfo): void {
  if (!Notification.isSupported()) return
  activeNotification?.close()
  const notification = new Notification({
    title: `${APP_NAME} ${release.version} is available`,
    body: `You have ${app.getVersion()}. Click to see what's new.`
  })
  notification.on('click', () => revealUpdateSettings())
  notification.on('close', () => {
    if (activeNotification === notification) activeNotification = null
  })
  activeNotification = notification
  notification.show()
}

async function readCappedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > UPDATE_FEED_MAX_BYTES) throw new Error('The update feed is too large.')
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > UPDATE_FEED_MAX_BYTES) throw new Error('The update feed is too large.')
  return new TextDecoder().decode(buffer)
}

async function runCheck(manual: boolean): Promise<UpdateState> {
  const feedUrl = effectiveFeedUrl(preferences)
  status = 'checking'
  message = null
  publish()
  try {
    const response = await net.fetch(feedUrl, {
      headers: { Accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    preferences = { ...preferences, lastChecked: Date.now() }
    if (!response.ok) {
      const failure = describeFeedHttpFailure(response.status, feedUrl)
      console.warn(`[updates] HTTP ${response.status} from ${redactFeedUrl(feedUrl)} (${failure.message})`)
      status = failure.status
      message = failure.message
      latest = null
      return publish()
    }
    const entries = parseReleaseFeed(await readCappedText(response))
    const best = pickLatestRelease(entries, { includePrereleases: preferences.betaChannel })
    latest = best ? toReleaseInfo(best) : null
    const decision = decideUpdate(latest?.version ?? null, app.getVersion(), preferences, Date.now())
    status = decision.updateAvailable ? 'available' : 'up-to-date'
    message = !latest
      ? 'No releases found in the feed.'
      : decision.skipped
        ? `${latest.version} is available (skipped).`
        : decision.snoozed
          ? `${latest.version} is available (reminder snoozed).`
          : decision.updateAvailable
            ? `${latest.version} is available.`
            : `You're on the latest version.`
    if (decision.notify && latest) {
      showUpdateNotification(latest)
      preferences = { ...preferences, notifiedVersion: latest.version, remindLaterVersion: null, remindAfter: null }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[updates] check failed for ${redactFeedUrl(feedUrl)}: ${reason}`)
    status = 'error'
    message = /timed? ?out|abort/i.test(reason)
      ? 'Update check timed out. Check your connection.'
      : manual
        ? `Update check failed: ${reason}`
        : 'Update check failed; will retry later.'
  } finally {
    savePreferences()
  }
  return publish()
}

export function checkForUpdates(manual = false): Promise<UpdateState> {
  if (!inFlight) inFlight = runCheck(manual).finally(() => (inFlight = null))
  return inFlight
}

function scheduleNextCheck(delayMs: number): void {
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = setTimeout(() => {
    checkTimer = null
    const run = isUpdateCheckDue(preferences.lastChecked, Date.now()) ? checkForUpdates(false) : Promise.resolve()
    void run.finally(() => scheduleNextCheck(UPDATE_CHECK_INTERVAL_MS))
  }, delayMs)
  checkTimer.unref?.()
}

function skipUpdateVersion(version: unknown): UpdateState {
  if (typeof version === 'string' && latest && version === latest.version) {
    preferences = { ...preferences, skippedVersion: latest.version }
    activeNotification?.close()
    savePreferences()
  }
  return publish()
}

function remindUpdateLater(): UpdateState {
  if (latest) {
    preferences = { ...preferences, remindLaterVersion: latest.version, remindAfter: Date.now() + UPDATE_REMIND_LATER_MS }
    activeNotification?.close()
    savePreferences()
  }
  return publish()
}

async function setUpdateSettings(input: unknown): Promise<UpdateSettingsResult> {
  const result = applyUpdateSettings(preferences, input)
  if (!result.ok) return result
  preferences = result.preferences
  savePreferences()
  if (!result.changed) return { ok: true, state: publish() }
  latest = null
  return { ok: true, state: await checkForUpdates(true) }
}

/** Download: open the .dmg (or .zip) asset in the default browser when it exists, else the release page. */
async function downloadUpdate(): Promise<boolean> {
  const release = latest
  if (!release?.link) return false
  for (const candidate of releaseAssetCandidates(release.link, release.version, process.platform, process.arch, APP_NAME)) {
    try {
      const response = await net.fetch(candidate, {
        method: 'HEAD',
        redirect: 'follow',
        credentials: 'omit',
        signal: AbortSignal.timeout(ASSET_PROBE_TIMEOUT_MS)
      })
      if (response.ok) {
        await shell.openExternal(candidate)
        return true
      }
    } catch {
      // Try the next candidate; the release page still opens.
    }
  }
  await shell.openExternal(release.link)
  return true
}

/** Call once after the main window exists. */
export function initializeUpdates(): void {
  if (initialized) return
  initialized = true
  loadPreferences()
  scheduleNextCheck(UPDATE_INITIAL_DELAY_MS)
  app.once('will-quit', disposeUpdates)
}

export function disposeUpdates(): void {
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = null
  activeNotification?.close()
  activeNotification = null
}

export function registerUpdateIpc(): void {
  ipcMain.handle('updates:get', () => getUpdateState())
  ipcMain.handle('updates:check', () => checkForUpdates(true))
  ipcMain.handle('updates:skip', (_e, version: unknown) => skipUpdateVersion(version))
  ipcMain.handle('updates:remind-later', () => remindUpdateLater())
  ipcMain.handle('updates:settings:set', (_e, input: unknown) => setUpdateSettings(input))
  ipcMain.handle('updates:download', () => downloadUpdate())
  ipcMain.handle('updates:open-release', () => (latest?.link ? shell.openExternal(latest.link).then(() => true) : false))
  ipcMain.handle('updates:copy-brew', () => {
    clipboard.writeText(BREW_UPGRADE_COMMAND)
    return true
  })
}
