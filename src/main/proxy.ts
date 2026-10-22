import { app, session, webContents } from 'electron'
import { createConnection } from 'node:net'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  anyProxyActive,
  buildRoutingProxyConfig,
  effectiveRouteForUrl,
  endpointKey,
  resolutionMatches,
  routingSelfTestCases
} from '../shared/proxy-routing'
import {
  cloneProxySettings,
  DEFAULT_PROXY_SETTINGS,
  validateProxySettings,
  type ProxySettings,
  type ProxyTestResult
} from '../shared/proxy-settings'

import { getProxySettings, proxyState, proxyChangeListeners } from './proxy-state'
export { getProxySettings, isProxyTransitioning, onProxyChanging } from './proxy-state'
let revision = 0
let queue: Promise<unknown> = Promise.resolve()
const checks = new Map<string, { until: number; result: Promise<ProxyTestResult> }>()
const settingsPath = (): string => join(app.getPath('userData'), 'proxy.json')

/** TCP reachability only: this deliberately does not claim to verify SOCKS or SSH. */
export function testProxyPort(host: string, port: number, timeout = 2000): Promise<ProxyTestResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (result: ProxyTestResult): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ reachable: false, message: 'No response from the local proxy before the timeout.' }),
      timeout
    )
    socket.once('connect', () =>
      finish({
        reachable: true,
        message: `TCP port ${endpointKey(host, port)} is reachable. This does not verify SOCKS or the SSH connection.`
      })
    )
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish({
        reachable: false,
        message: `${error.code ?? 'Connection error'}: cannot reach ${endpointKey(host, port)}.`
      })
    )
  })
}

function webRTCPolicy(contents: Electron.WebContents): void {
  if (!contents.isDestroyed())
    contents.setWebRTCIPHandlingPolicy(anyProxyActive(proxyState.settings) ? 'disable_non_proxied_udp' : 'default')
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium proxy self-check timed out.')), 5000)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function apply(settings: ProxySettings): Promise<void> {
  const target = session.defaultSession
  await target.closeAllConnections()
  await target.setProxy(buildRoutingProxyConfig(settings) as Electron.ProxyConfig)
  for (const check of routingSelfTestCases(settings)) {
    const actual = await withTimeout(target.resolveProxy(check.url))
    if (!resolutionMatches(check.expected, actual))
      throw new Error(`SOCKS routing self-check failed: expected ${check.expected}, got ${actual}.`)
  }
  await target.closeAllConnections()
}

/** Called before windows or network work can start. Invalid saved settings never fall back direct. */
export async function initializeProxy(): Promise<void> {
  try {
    proxyState.settings = validateProxySettings(JSON.parse(readFileSync(settingsPath(), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        'Saved SOCKS settings could not be loaded. Fix or remove proxy.json in the app profile before starting Inkfish.',
        { cause: error }
      )
    proxyState.settings = cloneProxySettings(DEFAULT_PROXY_SETTINGS)
  }
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      if (proxyState.transitioning || proxyState.blocked) {
        callback({ cancel: true })
        return
      }
      const route = effectiveRouteForUrl(details.url, proxyState.settings)
      if (!proxyState.settings.killSwitch || !route || route.kind === 'direct') {
        callback({})
        return
      }
      const key = endpointKey(route.host, route.port)
      let check = checks.get(key)
      if (!check || check.until < Date.now()) {
        check = { until: Date.now() + 2000, result: testProxyPort(route.host, route.port) }
        checks.set(key, check)
      }
      const at = revision
      void check.result.then(
        (result) =>
          callback({ cancel: proxyState.transitioning || proxyState.blocked || at !== revision || !result.reachable }),
        () => callback({ cancel: true })
      )
    }
  )
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    const route = effectiveRouteForUrl(details.url, proxyState.settings)
    if (route?.kind === 'proxy') checks.delete(endpointKey(route.host, route.port))
  })
  app.on('web-contents-created', (_event, contents) => webRTCPolicy(contents))
  await apply(proxyState.settings)
  proxyState.transitioning = false
}

/** Serialize saves so overlapping IPC calls cannot desynchronize the saved and live route. */
export function setProxySettings(input: unknown): Promise<ProxySettings> {
  const settings = validateProxySettings(input)
  const result = queue.then(async () => {
    proxyState.transitioning = true
    revision++
    checks.clear()
    try {
      for (const listener of proxyChangeListeners) listener()
      await apply(settings)
      const file = settingsPath()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
      proxyState.settings = settings
      proxyState.blocked = false
      for (const contents of webContents.getAllWebContents()) webRTCPolicy(contents)
      return getProxySettings()
    } catch (error) {
      // Keep the request gate shut if even restoring the previous config fails.
      try {
        await apply(proxyState.settings)
        proxyState.blocked = false
      } catch {
        proxyState.blocked = true
      }
      throw error
    } finally {
      proxyState.transitioning = false
    }
  })
  queue = result.catch(() => undefined)
  return result
}

export function testLocalProxy(input: unknown): Promise<ProxyTestResult> {
  try {
    const { primary } = validateProxySettings(input)
    return testProxyPort(primary.host, primary.port, 4000)
  } catch (error) {
    return Promise.resolve({ reachable: false, message: error instanceof Error ? error.message : String(error) })
  }
}

export function closeProxy(): void {
  proxyState.blocked = true
  checks.clear()
  for (const listener of proxyChangeListeners) listener()
  void session.defaultSession.closeAllConnections()
}
