import { describe, expect, test } from 'bun:test'
import { addressScope, interfaceDiagnostics, pairingHosts } from './sync-network'
import type { NetworkInterfaceInfo } from 'node:os'

const iface = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`
})

describe('sync network diagnostics', () => {
  test('classifies RFC1918, carrier-grade VPN, link-local, and public IPv4 addresses', () => {
    expect(addressScope('10.0.0.2')).toBe('lan')
    expect(addressScope('172.31.0.2')).toBe('lan')
    expect(addressScope('192.168.1.2')).toBe('lan')
    expect(addressScope('100.64.0.1')).toBe('vpn-overlay')
    expect(addressScope('100.127.255.254')).toBe('vpn-overlay')
    expect(addressScope('100.63.255.254')).toBe('other')
    expect(addressScope('100.128.0.1')).toBe('other')
    expect(addressScope('169.254.1.2')).toBe('link-local')
    expect(addressScope('8.8.8.8')).toBe('other')
  })

  test('advertises LAN and VPN overlay IPv4s, prioritizing en0 and skipping duplicates/internal addresses', () => {
    const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      utun4: [iface('100.88.1.2')],
      en1: [iface('192.168.2.3'), iface('127.0.0.1', true)],
      en0: [iface('192.168.1.4'), iface('100.88.1.2')],
      en5: [iface('8.8.8.8')]
    }
    expect(pairingHosts(interfaces)).toEqual(['192.168.1.4', '100.88.1.2', '192.168.2.3'])
  })

  test('interface diagnostics label QR candidates and omit public IPv4 values', () => {
    const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      en0: [iface('192.168.1.4'), iface('8.8.8.8')],
      utun4: [iface('100.88.1.2')],
      awdl0: [iface('169.254.1.2')]
    }
    expect(interfaceDiagnostics(interfaces)).toEqual([
      {
        name: 'en0',
        addresses: [{ address: '192.168.1.4', scope: 'lan', includedInQr: true }],
        omittedIpv4Count: 1
      },
      {
        name: 'awdl0',
        addresses: [{ address: '169.254.1.2', scope: 'link-local', includedInQr: false }],
        omittedIpv4Count: 0
      },
      {
        name: 'utun4',
        addresses: [{ address: '100.88.1.2', scope: 'vpn-overlay', includedInQr: true }],
        omittedIpv4Count: 0
      }
    ])
  })
})
