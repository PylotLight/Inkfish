const { afterEach, describe, expect, test } = require('bun:test')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { patchExpoCameraScanner } = require('../plugins/patch-expo-camera-scanner')

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inkfish-expo-camera-'))
  roots.push(root)
  const camera = path.join(root, 'android/src/main/java/expo/modules/camera')
  const analyzer = path.join(camera, 'analyzers')
  mkdirSync(path.join(camera, 'utils'), { recursive: true })
  mkdirSync(analyzer, { recursive: true })
  writeFileSync(
    path.join(camera, 'utils/CameraUtils.kt'),
    [
      '  private const val GOOGLE_PLAY_STORE_PACKAGE = "com.android.vending"',
      '        .getPackageInfo(GOOGLE_PLAY_STORE_PACKAGE, 0)'
    ].join('\n')
  )
  writeFileSync(
    path.join(camera, 'CameraViewModule.kt'),
    [
      'val cameraEvents = arrayOf(',
      '  "onBarcodeScanned",',
      '  "onFacesDetected"',
      ')',
      '          .addOnFailureListener {',
      '            promise.reject(CameraExceptions.BarcodeScanningFailedException())',
      '          }',
      '      } catch (_: Exception) {',
      '        promise.reject(CameraExceptions.GooglePlayServicesUnavailableException())',
      '      }'
    ].join('\n')
  )
  writeFileSync(
    path.join(camera, 'CameraExceptions.kt'),
    ['  class BarcodeScanningFailedException :', '    CodedException("Barcode scanning failed")'].join('\n')
  )
  writeFileSync(
    path.join(camera, 'ExpoCameraView.kt'),
    [
      '  private val onMountError by EventDispatcher<CameraMountErrorEvent>()',
      '          try {',
      '            barcodeAnalyzer = BarcodeAnalyzer(barcodeFormats) {',
      '              onBarcodeScanned(it)',
      '            }.also {',
      '              analyzer.setAnalyzer(ContextCompat.getMainExecutor(context), it)',
      '            }',
      '          } catch (e: Exception) {',
      '            Log.e(CameraViewModule.TAG, "Failed to initialize BarcodeAnalyzer: ${e.message}")',
      '          }'
    ].join('\n')
  )
  writeFileSync(
    path.join(analyzer, 'BarcodeAnalyzer.kt'),
    [
      '  private val barcodeScanner: BarcodeScanner,',
      '  val onComplete: (BarCodeScannerResult) -> Unit',
      ') : ImageAnalysis.Analyzer, Closeable {',
      '  constructor(formats: List<BarcodeType>, onComplete: (BarCodeScannerResult) -> Unit) : this(',
      '    BarcodeScanning.getClient(',
      '      BarcodeScannerOptions.Builder()',
      '        .setBarcodeFormats(barcodeFormats(formats))',
      '        .build()',
      '    ),',
      '    onComplete',
      '  )',
      '        .addOnFailureListener {',
      '          Log.d("SCANNER", it.cause?.message ?: "Barcode scanning failed")',
      '        }'
    ].join('\n')
  )
  return root
}

describe('Expo Camera scanner build patch', () => {
  test('checks the right Play Services package and surfaces precise native scanner diagnostics', () => {
    const root = fixture()
    const changed = patchExpoCameraScanner(root)
    const cameraUtils = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/utils/CameraUtils.kt'),
      'utf8'
    )
    const module = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/CameraViewModule.kt'),
      'utf8'
    )
    const exceptions = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/CameraExceptions.kt'),
      'utf8'
    )
    const cameraView = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/ExpoCameraView.kt'),
      'utf8'
    )
    const analyzer = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/analyzers/BarcodeAnalyzer.kt'),
      'utf8'
    )

    expect(changed).toHaveLength(5)
    expect(cameraUtils).toContain('GOOGLE_PLAY_SERVICES_PACKAGE = "com.google.android.gms"')
    expect(cameraUtils).toContain('.getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, 0)')
    expect(module).toContain('.addOnFailureListener { error ->')
    expect(module).toContain('BarcodeScanningFailedException(error)')
    expect(module).toContain('"onBarcodeScannerError"')
    expect(module).toContain('catch (error: Exception)')
    expect(exceptions).toContain('Barcode scanning failed: $it')
    expect(exceptions).toContain('cause = cause')
    expect(cameraView).toContain('onBarcodeScannerError by EventDispatcher<CameraMountErrorEvent>()')
    expect(cameraView).toContain('onError = { error ->')
    expect(cameraView).toContain('Barcode analyzer failed to initialize:')
    expect(analyzer).toContain('val onError: (Throwable) -> Unit')
    expect(analyzer).toContain('Log.e("SCANNER", "Barcode scanning failed", error)')
    expect(analyzer).toContain('onError(error)')
  })

  test('is idempotent on repeated prebuilds', () => {
    const root = fixture()
    expect(patchExpoCameraScanner(root)).toHaveLength(5)
    expect(patchExpoCameraScanner(root)).toEqual([])
  })

  test('fails safely when Expo changes its native implementation', () => {
    const root = fixture()
    writeFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/CameraViewModule.kt'),
      'native implementation changed'
    )
    expect(() => patchExpoCameraScanner(root)).toThrow('review the native source before building')
    const cameraUtils = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/utils/CameraUtils.kt'),
      'utf8'
    )
    expect(cameraUtils).toContain('GOOGLE_PLAY_STORE_PACKAGE')
  })
})
