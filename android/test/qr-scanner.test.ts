import { describe, expect, test } from 'bun:test'
import { launchQrScanner, type NativeQrScanner } from '../src/lib/qrScanner'

describe('native QR scanner adapter', () => {
  test('subscribes before launch, forwards one scanned payload, and removes the listener', async () => {
    const events: string[] = []
    let onData: ((data: string) => void) | undefined
    const scanner: NativeQrScanner = {
      subscribe: (listener) => {
        events.push('subscribe')
        onData = listener
        return { remove: () => events.push('remove') }
      },
      launch: async () => {
        events.push('launch')
        onData?.('inkfish://pair?d=payload')
        onData?.('inkfish://pair?d=duplicate')
      }
    }
    const received: string[] = []

    await launchQrScanner(scanner, (data) => received.push(data))

    expect(events).toEqual(['subscribe', 'launch', 'remove'])
    expect(received).toEqual(['inkfish://pair?d=payload'])
  })

  test('removes the native listener and propagates cancellation errors', async () => {
    const canceled = new Error('scanner closed')
    let removed = false
    const scanner: NativeQrScanner = {
      subscribe: () => ({ remove: () => (removed = true) }),
      launch: async () => {
        throw canceled
      }
    }

    await expect(launchQrScanner(scanner, () => undefined)).rejects.toBe(canceled)
    expect(removed).toBe(true)
  })
})
