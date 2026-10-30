const { describe, expect, test } = require('bun:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const component = readFileSync(path.join(__dirname, '../src/components/PairScanner.tsx'), 'utf8')

describe('Android pairing QR scanner route', () => {
  test('uses the in-app camera permission, preview and bundled barcode analyzer callback', () => {
    expect(component).toContain('useCameraPermissions()')
    expect(component).toContain('<CameraViewWithScannerDiagnostics')
    expect(component).toContain("barcodeScannerSettings={{ barcodeTypes: ['qr'] }}")
    expect(component).toContain('onBarcodeScanned={busy ? undefined : ({ data }) => handle(data)}')
    expect(component).toContain('visible && !!perm?.granted && !initialCode && !externalPairing')
    expect(component).not.toMatch(/launchScanner|onModernBarcodeScanned|preferNativeScanner|Google Code Scanner/)
  })
})
