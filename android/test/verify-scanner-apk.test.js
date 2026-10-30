const { describe, expect, test } = require('bun:test')
const { REQUIRED_DEX_MARKERS, verifyScannerDex } = require('../plugins/verify-scanner-apk')

describe('packaged Android QR scanner guard', () => {
  test('accepts scanner markers after R8 renames Google Play Services types', () => {
    const dex = Buffer.from([...REQUIRED_DEX_MARKERS, 'Lcom/google/android/gms/common/moduleinstall/a;'].join('\n'))
    expect(dex.includes(Buffer.from('ModuleInstallRequest'))).toBe(false)
    expect(verifyScannerDex([dex])).toEqual(REQUIRED_DEX_MARKERS)
  })

  test('requires the stable module-install diagnostic even if the type name survives', () => {
    const dex = Buffer.from(
      [
        'ModuleInstallRequest',
        'onBarcodeScannerError',
        'Barcode analyzer failed:',
        'Barcode analyzer failed to initialize:'
      ].join('\n')
    )
    expect(() => verifyScannerDex([dex])).toThrow('Google Code Scanner module installation failed')
  })

  test('rejects DEX missing the native analyzer error-forwarding patch', () => {
    const dex = Buffer.from('Google Code Scanner module installation failed\nonBarcodeScannerError')
    expect(() => verifyScannerDex([dex])).toThrow('Barcode analyzer failed:')
    expect(() => verifyScannerDex([dex])).toThrow('Barcode analyzer failed to initialize:')
  })

  test('checks markers across multidex APK entries', () => {
    const firstDex = Buffer.from('Google Code Scanner module installation failed\nonBarcodeScannerError')
    const secondDex = Buffer.from('Barcode analyzer failed:')
    const thirdDex = Buffer.from('Barcode analyzer failed to initialize:')
    expect(verifyScannerDex([firstDex, secondDex, thirdDex])).toEqual(REQUIRED_DEX_MARKERS)
  })
})
