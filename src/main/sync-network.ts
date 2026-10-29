import type { NetworkInterfaceInfo } from 'node:os'

export type SyncAddressScope = 'lan' | 'vpn-overlay' | 'link-local' | 'other'

export interface SyncAddressDiagnostic {
  address: string
  scope: SyncAddressScope
  includedInQr: boolean
}

export interface SyncInterfaceDiagnostic {
  name: string
  addresses: SyncAddressDiagnostic[]
  omittedIpv4Count: number
}

function octets(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null
  const values = parts.map(Number)
  return values.every((part) => part >= 0 && part <= 255) ? values : null
}

export function addressScope(address: string): SyncAddressScope {
  const [a, b] = octets(address) ?? []
  if (a === undefined || b === undefined) return 'other'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan'
  // RFC 6598 shared address space, commonly used by Tailscale and other VPN overlays.
  if (a === 100 && b >= 64 && b <= 127) return 'vpn-overlay'
  if (a === 169 && b === 254) return 'link-local'
  return 'other'
}

export function pairingHosts(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const names = Object.keys(interfaces).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : a.localeCompare(b)))
  const hosts: string[] = []
  for (const name of names) {
    for (const info of interfaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const scope = addressScope(info.address)
      if ((scope === 'lan' || scope === 'vpn-overlay') && !hosts.includes(info.address)) hosts.push(info.address)
    }
  }
  return hosts
}

/** Only disclose routable local, VPN-overlay, and link-local IPv4 addresses in the UI. */
export function interfaceDiagnostics(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): SyncInterfaceDiagnostic[] {
  return Object.keys(interfaces)
    .sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : a.localeCompare(b)))
    .map((name) => {
      const ipv4 = (interfaces[name] ?? []).filter((info) => info.family === 'IPv4' && !info.internal)
      const addresses: SyncAddressDiagnostic[] = []
      let omittedIpv4Count = 0
      for (const info of ipv4) {
        const scope = addressScope(info.address)
        if (scope === 'lan' || scope === 'vpn-overlay' || scope === 'link-local') {
          addresses.push({ address: info.address, scope, includedInQr: scope === 'lan' || scope === 'vpn-overlay' })
        } else {
          omittedIpv4Count++
        }
      }
      return { name, addresses, omittedIpv4Count }
    })
    .filter((info) => info.addresses.length > 0 || info.omittedIpv4Count > 0)
}
