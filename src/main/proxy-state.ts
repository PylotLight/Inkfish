import { cloneProxySettings, DEFAULT_PROXY_SETTINGS, type ProxySettings } from '../shared/proxy-settings'

/** Electron-free state shared with native helpers and their unit tests. */
export const proxyState = {
  settings: cloneProxySettings(DEFAULT_PROXY_SETTINGS),
  transitioning: true,
  blocked: false
}
export const proxyChangeListeners = new Set<() => void>()

export function onProxyChanging(listener: () => void): () => void {
  proxyChangeListeners.add(listener)
  return () => { proxyChangeListeners.delete(listener) }
}

export function getProxySettings(): ProxySettings { return cloneProxySettings(proxyState.settings) }
export function isProxyTransitioning(): boolean { return proxyState.transitioning || proxyState.blocked }
