const { afterEach, describe, expect, test } = require('bun:test')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { patchExpoCameraScanner } = require('../plugins/patch-expo-camera-scanner')
const androidPackage = require('../package.json')

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('builds patched Expo Camera from local source instead of a prebuilt AAR', () => {
  expect(androidPackage.expo?.autolinking?.android?.buildFromSource).toContain('expo-camera')
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inkfish-expo-camera-'))
  roots.push(root)
  const cameraRoot = path.join(root, 'node_modules/expo-camera')
  const camera = path.join(cameraRoot, 'android/src/main/java/expo/modules/camera')
  const analyzer = path.join(camera, 'analyzers')
  mkdirSync(path.join(camera, 'utils'), { recursive: true })
  mkdirSync(analyzer, { recursive: true })
  mkdirSync(path.join(cameraRoot, 'android'), { recursive: true })
  writeFileSync(
    path.join(cameraRoot, 'android/build.gradle'),
    [
      'def barcodeDependencyConfiguration = isBarcodeScannerEnabled ? "implementation" : "compileOnly"',
      '  add(barcodeDependencyConfiguration, "com.google.android.gms:play-services-code-scanner:16.1.0")',
      '  add(barcodeDependencyConfiguration, "com.google.mlkit:barcode-scanning:17.3.0")',
      '  add(barcodeDependencyConfiguration, "androidx.camera:camera-mlkit-vision:${camerax_version}")'
    ].join('\n')
  )
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
      'import com.google.android.gms.common.moduleinstall.ModuleInstall',
      'import com.google.mlkit.vision.codescanner.GmsBarcodeScanning',
      'import java.util.concurrent.atomic.AtomicBoolean',
      'val cameraEvents = arrayOf(',
      '  "onBarcodeScanned",',
      '  "onFacesDetected"',
      ')',
      '    Events("onModernBarcodeScanned")',
      '    Property("isModernBarcodeScannerAvailable") {',
      '      CameraUtils.isMLKitAvailable(appContext.reactContext)',
      '    }',
      '    AsyncFunction("launchScanner") { settings: BarcodeSettings, promise: Promise ->',
      '      val scanner = GmsBarcodeScanning.getClient(context, options)',
      '      ModuleInstall.getClient(context)',
      '    }',
      '    Property("isDocumentScannerAvailable") { CameraUtils.hasGooglePlayServices(appContext.reactContext) }',
      '    if (!CameraUtils.isMLKitAvailable(appContext.reactContext)) { // unrelated image-scan path }'
    ].join('\n')
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
  return { root, cameraRoot, camera }
}

describe('Expo Camera bundled QR analyzer build patch', () => {
  test('removes Google Code Scanner and preserves the bundled ML Kit live analyzer', () => {
    const { root, cameraRoot, camera } = fixture()
    const changed = patchExpoCameraScanner(cameraRoot)
    const gradle = readFileSync(path.join(cameraRoot, 'android/build.gradle'), 'utf8')
    const cameraUtils = readFileSync(path.join(camera, 'utils/CameraUtils.kt'), 'utf8')
    const module = readFileSync(path.join(camera, 'CameraViewModule.kt'), 'utf8')
    const cameraView = readFileSync(path.join(camera, 'ExpoCameraView.kt'), 'utf8')
    const analyzer = readFileSync(path.join(camera, 'analyzers/BarcodeAnalyzer.kt'), 'utf8')

    expect(root).toBeTruthy()
    expect(changed).toHaveLength(5)
    expect(gradle).not.toContain('play-services-code-scanner')
    expect(gradle).toContain('com.google.mlkit:barcode-scanning:17.3.0')
    expect(gradle).toContain('androidx.camera:camera-mlkit-vision')
    expect(cameraUtils).toContain('GOOGLE_PLAY_SERVICES_PACKAGE = "com.google.android.gms"')
    expect(cameraUtils).toContain('.getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, 0)')
    expect(module).not.toContain('GmsBarcodeScanning')
    expect(module).not.toContain('ModuleInstall')
    expect(module).not.toContain('launchScanner')
    expect(module).not.toContain('onModernBarcodeScanned')
    expect(module).toContain('Property("isModernBarcodeScannerAvailable") { false }')
    expect(module).toContain('"onBarcodeScannerError"')
    expect(module).toContain('CameraUtils.isMLKitAvailable(appContext.reactContext)')
    expect(module).toContain('Property("isDocumentScannerAvailable")')
    expect(module).toContain('CameraUtils.hasGooglePlayServices(appContext.reactContext)')
    expect(cameraView).toContain('onBarcodeScannerError by EventDispatcher<CameraMountErrorEvent>()')
    expect(cameraView).toContain('BarcodeAnalyzer(')
    expect(cameraView).toContain('onError = { error ->')
    expect(cameraView).toContain('Barcode analyzer failed to initialize:')
    expect(analyzer).toContain('BarcodeScanning.getClient(')
    expect(analyzer).toContain('val onError: (Throwable) -> Unit')
    expect(analyzer).toContain('Log.e("SCANNER", "Barcode scanning failed", error)')
    expect(analyzer).toContain('onError(error)')
  })

  test('is idempotent on repeated prebuilds', () => {
    const { cameraRoot } = fixture()
    expect(patchExpoCameraScanner(cameraRoot)).toHaveLength(5)
    expect(patchExpoCameraScanner(cameraRoot)).toEqual([])
  })

  test('fails safely when Expo changes its native implementation', () => {
    const { cameraRoot, camera } = fixture()
    writeFileSync(path.join(camera, 'CameraViewModule.kt'), 'native implementation changed')
    expect(() => patchExpoCameraScanner(cameraRoot)).toThrow('review the native source before building')
    expect(readFileSync(path.join(camera, 'utils/CameraUtils.kt'), 'utf8')).toContain('GOOGLE_PLAY_STORE_PACKAGE')
    expect(readFileSync(path.join(cameraRoot, 'android/build.gradle'), 'utf8')).toContain('play-services-code-scanner')
  })
})
