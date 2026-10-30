const { describe, expect, test } = require('bun:test')
const { REQUIRED_DEX_MARKERS, verifyScannerDex } = require('../plugins/verify-scanner-apk')

describe('packaged Android QR scanner guard', () => {
  test('accepts DEX containing scanner installation and analyzer error code', () => {
    const dex = Buffer.from(REQUIRED_DEX_MARKERS.join('\n'))
    expect(verifyScannerDex([dex])).toEqual(REQUIRED_DEX_MARKERS)
  })

  test('rejects DEX missing the native analyzer error-forwarding patch', () => {
    const dex = Buffer.from('ModuleInstallRequest\nonBarcodeScannerError')
    expect(() => verifyScannerDex([dex])).toThrow('Barcode analyzer failed:')
    expect(() => verifyScannerDex([dex])).toThrow('Barcode analyzer failed to initialize:')
  })

  test('checks markers across multidex APK entries', () => {
    const firstDex = Buffer.from('ModuleInstallRequest\nonBarcodeScannerError')
    const secondDex = Buffer.from('Barcode analyzer failed:')
    const thirdDex = Buffer.from('Barcode analyzer failed to initialize:')
    expect(verifyScannerDex([firstDex, secondDex, thirdDex])).toEqual(REQUIRED_DEX_MARKERS)
  })
})
