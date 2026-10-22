import { validateProxyRouting, type ProxyRoutingInput } from './proxy-routing'

export interface ProxySettings extends ProxyRoutingInput {
  primary: { enabled: boolean; host: string; port: number; bypassLocalNetwork: boolean }
  killSwitch: boolean
}

export interface ProxyTestResult {
  reachable: boolean
  message: string
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  primary: { enabled: false, host: '127.0.0.1', port: 1080, bypassLocalNetwork: true },
  proxies: [],
  rules: [],
  killSwitch: false
}

/** Same local-only endpoints and routing validation as Surffish. */
export function validateProxySettings(input: unknown): ProxySettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Proxy settings must be an object.')
  const candidate = input as Partial<ProxySettings>
  const primary = candidate.primary
  if (!primary || typeof primary.enabled !== 'boolean') throw new Error('Choose whether the SOCKS5 proxy is enabled.')
  const host = typeof primary.host === 'string' ? primary.host.trim().toLowerCase() : ''
  const port = Number(primary.port)
  if (!['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('For safety only localhost SOCKS proxies are accepted.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535.')
  if (typeof candidate.killSwitch !== 'boolean') throw new Error('Choose whether the kill switch is enabled.')
  if (!Array.isArray(candidate.proxies) || !Array.isArray(candidate.rules))
    throw new Error('Network rules and proxies must be lists.')
  return {
    primary: { enabled: primary.enabled, host, port, bypassLocalNetwork: primary.bypassLocalNetwork !== false },
    ...validateProxyRouting(candidate),
    killSwitch: candidate.killSwitch
  }
}

export function cloneProxySettings(settings: ProxySettings): ProxySettings {
  return {
    primary: { ...settings.primary },
    proxies: settings.proxies.map((p) => ({ ...p })),
    rules: settings.rules.map((r) => ({ ...r })),
    killSwitch: settings.killSwitch
  }
}
