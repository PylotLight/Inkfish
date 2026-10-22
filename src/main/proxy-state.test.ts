import { afterEach, expect, test } from 'bun:test'
import { cloneProxySettings, DEFAULT_PROXY_SETTINGS } from '../shared/proxy-settings'
import { getProxySettings, isProxyTransitioning, onProxyChanging, proxyChangeListeners, proxyState } from './proxy-state'
import { modelDownloadEnvironment, prepareEngine } from './stt'

const original = { settings: getProxySettings(), transitioning: proxyState.transitioning, blocked: proxyState.blocked }
afterEach(() => {
  proxyState.settings = cloneProxySettings(original.settings)
  proxyState.transitioning = original.transitioning
  proxyState.blocked = original.blocked
})

test('settings returned to callers are deep copies', () => {
  proxyState.settings = { ...cloneProxySettings(DEFAULT_PROXY_SETTINGS), proxies: [{ name: 'Work', host: 'localhost', port: 1081 }], rules: [{ pattern: '*.example.com', route: 'proxy:Work' }] }
  const snapshot = getProxySettings()
  snapshot.primary.enabled = true
  snapshot.proxies[0]!.port = 9999
  snapshot.rules[0]!.route = 'direct'
  expect(getProxySettings().primary.enabled).toBe(false)
  expect(getProxySettings().proxies[0]!.port).toBe(1081)
  expect(getProxySettings().rules[0]!.route).toBe('proxy:Work')
})

test('native downloads fail closed during transitions and blocked routing', async () => {
  proxyState.transitioning = true
  expect(isProxyTransitioning()).toBe(true)
  await expect(prepareEngine('parakeet-v3')).rejects.toThrow('proxy settings change')
  proxyState.transitioning = false
  proxyState.blocked = true
  await expect(prepareEngine('parakeet-v3')).rejects.toThrow('routing is blocked')
})

test('native model helper uses the bridge without inherited proxy bypasses', () => {
  const base = { HTTPS_PROXY: 'http://old:80', ALL_PROXY: 'socks5://old:90', no_proxy: '*', http_proxy: 'http://old:80', PATH: '/bin' }
  const env = modelDownloadEnvironment(base, 'http://127.0.0.1:12345', ' https://hf-mirror.com/// ')
  expect(env['http_proxy']).toBe('http://127.0.0.1:12345')
  expect(env['https_proxy']).toBe('http://127.0.0.1:12345')
  expect(env['HTTPS_PROXY']).toBeUndefined()
  expect(env['ALL_PROXY']).toBeUndefined()
  expect(env['no_proxy']).toBeUndefined()
  expect(env['REGISTRY_URL']).toBe('https://hf-mirror.com')
  expect(env['PATH']).toBe('/bin')
  expect(base.no_proxy).toBe('*')
})

test('proxy change listeners can be removed without disturbing native download listener', () => {
  let calls = 0
  const before = proxyChangeListeners.size
  const remove = onProxyChanging(() => { calls++ })
  for (const listener of proxyChangeListeners) listener()
  expect(calls).toBe(1)
  remove()
  expect(proxyChangeListeners.size).toBe(before)
})
