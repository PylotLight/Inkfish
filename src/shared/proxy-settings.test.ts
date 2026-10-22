import { describe, expect, test } from 'bun:test'
import { cloneProxySettings, DEFAULT_PROXY_SETTINGS, validateProxySettings, type ProxySettings } from './proxy-settings.ts'

const valid: ProxySettings = {
  primary: { enabled: true, host: 'LOCALHOST', port: 1080, bypassLocalNetwork: false },
  proxies: [{ name: 'Work', host: '127.0.0.1', port: 1081 }],
  rules: [{ pattern: '*.example.com', route: 'proxy:Work' }],
  killSwitch: true
}

describe('proxy settings', () => {
  test('normalizes primary host, coerces numeric port, and defaults local bypass on', () => {
    expect(validateProxySettings({ ...valid, primary: { ...valid.primary, host: ' LocalHost ', port: '1080', bypassLocalNetwork: undefined } })).toEqual({
      ...valid, primary: { enabled: true, host: 'localhost', port: 1080, bypassLocalNetwork: true }
    })
  })
  test('accepts only loopback proxy hosts and valid ports', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1']) {
      expect(validateProxySettings({ ...valid, primary: { ...valid.primary, host } }).primary.host).toBe(host.toLowerCase())
    }
    for (const host of ['example.com', '0.0.0.0', '192.168.1.2', '127.0.0.2', '[::1]', '']) {
      expect(() => validateProxySettings({ ...valid, primary: { ...valid.primary, host } })).toThrow('only localhost')
    }
    for (const port of [0, -1, 65536, 1.5, 'not-a-port', NaN]) {
      expect(() => validateProxySettings({ ...valid, primary: { ...valid.primary, port } })).toThrow('port between')
    }
    for (const port of [1, 65535, '1080']) expect(validateProxySettings({ ...valid, primary: { ...valid.primary, port } }).primary.port).toBe(Number(port))
  })
  test('rejects malformed top-level values, required switches, and non-list routing fields', () => {
    for (const value of [null, [], 'settings', 5]) expect(() => validateProxySettings(value)).toThrow('object')
    expect(() => validateProxySettings({ ...valid, primary: undefined })).toThrow('SOCKS5 proxy')
    expect(() => validateProxySettings({ ...valid, primary: { ...valid.primary, enabled: 1 } })).toThrow('SOCKS5 proxy')
    expect(() => validateProxySettings({ ...valid, killSwitch: undefined })).toThrow('kill switch')
    expect(() => validateProxySettings({ ...valid, proxies: {} })).toThrow('lists')
    expect(() => validateProxySettings({ ...valid, rules: null })).toThrow('lists')
  })
  test('delegates invalid named proxies and rules to routing validation', () => {
    expect(() => validateProxySettings({ ...valid, proxies: [{ name: 'bad/name', host: '127.0.0.1', port: 1081 }] })).toThrow()
    expect(() => validateProxySettings({ ...valid, rules: [{ pattern: '*.bad*', route: 'proxy' }] })).toThrow()
    expect(() => validateProxySettings({ ...valid, rules: [{ pattern: 'example.com', route: 'proxy:missing' }] })).toThrow()
  })
  test('clones nested values without sharing mutable objects; defaults are not mutated', () => {
    const source = validateProxySettings(valid)
    const copy = cloneProxySettings(source)
    expect(copy).toEqual(source)
    copy.primary.host = '127.0.0.1'
    copy.proxies[0]!.name = 'Changed'
    copy.rules[0]!.route = 'direct'
    expect(source.primary.host).toBe('localhost')
    expect(source.proxies[0]!.name).toBe('Work')
    expect(source.rules[0]!.route).toBe('proxy:Work')
    expect(DEFAULT_PROXY_SETTINGS).toEqual({ primary: { enabled: false, host: '127.0.0.1', port: 1080, bypassLocalNetwork: true }, proxies: [], rules: [], killSwitch: false })
  })
})
