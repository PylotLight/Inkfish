import { describe, expect, test } from 'bun:test'
import { loopbackPortOwnedByPid } from './loopback-owner'

describe('loopback process ownership', () => {
  test('requires the exact numeric loopback address and port to be listening', () => {
    const owner = (output: string): boolean => loopbackPortOwnedByPid(123, 4567, () => output)
    expect(
      owner(
        'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nllama-server 123 user 5u IPv4 0 0 TCP 127.0.0.1:4567 (LISTEN)'
      )
    ).toBe(true)
    expect(owner('llama-server 123 user 5u IPv4 0 0 TCP 127.0.0.1:45670 (LISTEN)')).toBe(false)
    expect(owner('llama-server 123 user 5u IPv4 0 0 TCP 0.0.0.0:4567 (LISTEN)')).toBe(false)
    expect(owner('llama-server 123 user 5u IPv4 0 0 TCP 127.0.0.1:4567 (ESTABLISHED)')).toBe(false)
  })

  test('rejects invalid process IDs and ports without invoking lsof', () => {
    let calls = 0
    const runner = (): string => {
      calls++
      return ''
    }
    expect(loopbackPortOwnedByPid(0, 4567, runner)).toBe(false)
    expect(loopbackPortOwnedByPid(123, 65536, runner)).toBe(false)
    expect(calls).toBe(0)
  })
})
