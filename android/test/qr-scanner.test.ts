import { describe, expect, test } from 'bun:test'
import { describeNativeQrScannerError, launchQrScanner, type NativeQrScanner } from '../src/lib/qrScanner'

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

  test('reports Android user cancellation separately from a launch failure', () => {
    const diagnostic = describeNativeQrScannerError({
      code: 'ERR_BARCODE_SCANNING_CANCELLED',
      message: 'Barcode scanning was cancelled'
    })

    expect(diagnostic.kind).toBe('cancelled')
    expect(diagnostic.userMessage).toContain('was cancelled')
    expect(diagnostic.userMessage).toContain('live camera is ready')
    expect(diagnostic.logMessage).toContain('ERR_BARCODE_SCANNING_CANCELLED')
  })

  test('identifies an unavailable Google Play Services scanner', () => {
    const diagnostic = describeNativeQrScannerError({
      code: 'ERR_GOOGLE_PLAY_SERVICES_UNAVAILABLE',
      message: 'Google Play Services is not available on this device.'
    })

    expect(diagnostic.kind).toBe('unavailable')
    expect(diagnostic.userMessage).toContain('Google Play services is missing or unavailable')
    expect(diagnostic.logMessage).toContain('ERR_GOOGLE_PLAY_SERVICES_UNAVAILABLE')
  })

  test('preserves the underlying Google failure detail supplied by the native bridge', () => {
    const diagnostic = describeNativeQrScannerError({
      code: 'ERR_BARCODE_SCANNING_FAILED',
      message: 'Barcode scanning failed: scanner module install pending'
    })

    expect(diagnostic.kind).toBe('failed')
    expect(diagnostic.userMessage).toContain('ERR_BARCODE_SCANNING_FAILED')
    expect(diagnostic.userMessage).toContain('scanner module install pending')
    expect(diagnostic.logMessage).toContain('scanner module install pending')
  })
})
