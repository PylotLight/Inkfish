const { describe, expect, test } = require('bun:test')
const { REQUIRED_DEX_MARKERS, verifyScannerDex } = require('../plugins/verify-scanner-apk')

describe('packaged Android QR scanner guard', () => {
  test('accepts the bundled ML Kit analyzer class and diagnostics', () => {
    const dex = Buffer.from([...REQUIRED_DEX_MARKERS, 'Lcom/google/mlkit/vision/barcode/BarcodeScanning;'].join('\n'))
    expect(verifyScannerDex([dex])).toEqual(REQUIRED_DEX_MARKERS)
  })

  test('requires the bundled analyzer class even if its error strings survive', () => {
    const dex = Buffer.from(
      ['onBarcodeScannerError', 'Barcode analyzer failed:', 'Barcode analyzer failed to initialize:'].join('\n')
    )
    expect(() => verifyScannerDex([dex])).toThrow('com/google/mlkit/vision/barcode/BarcodeScanning')
  })

  test('rejects DEX missing the native analyzer error-forwarding patch', () => {
    const dex = Buffer.from('com/google/mlkit/vision/barcode/BarcodeScanning\nonBarcodeScannerError')
    expect(() => verifyScannerDex([dex])).toThrow('Barcode analyzer failed:')
    expect(() => verifyScannerDex([dex])).toThrow('Barcode analyzer failed to initialize:')
  })

  test('checks markers across multidex APK entries', () => {
    const firstDex = Buffer.from('com/google/mlkit/vision/barcode/BarcodeScanning\nonBarcodeScannerError')
    const secondDex = Buffer.from('Barcode analyzer failed:')
    const thirdDex = Buffer.from('Barcode analyzer failed to initialize:')
    expect(verifyScannerDex([firstDex, secondDex, thirdDex])).toEqual(REQUIRED_DEX_MARKERS)
  })
})
