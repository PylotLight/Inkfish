const fs = require('node:fs')
const path = require('node:path')

const scannerDependency =
  '  add(barcodeDependencyConfiguration, "com.google.android.gms:play-services-code-scanner:16.1.0")'
const codeScannerImports = [
  'import com.google.android.gms.common.moduleinstall.InstallStatusListener',
  'import com.google.android.gms.common.moduleinstall.ModuleInstall',
  'import com.google.android.gms.common.moduleinstall.ModuleInstallRequest',
  'import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate',
  'import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions',
  'import com.google.mlkit.vision.codescanner.GmsBarcodeScanning',
  'import java.util.concurrent.atomic.AtomicBoolean'
]

const analyzerEventBefore = '  "onBarcodeScanned",'
const analyzerEventAfter = '  "onBarcodeScanned",\n  "onBarcodeScannerError",'
const analyzerInitializationBefore =
  '          try {\n            barcodeAnalyzer = BarcodeAnalyzer(barcodeFormats) {\n              onBarcodeScanned(it)\n            }.also {\n              analyzer.setAnalyzer(ContextCompat.getMainExecutor(context), it)\n            }\n          } catch (e: Exception) {\n            Log.e(CameraViewModule.TAG, "Failed to initialize BarcodeAnalyzer: ${e.message}")\n          }'
const analyzerInitializationAfter =
  '          try {\n            barcodeAnalyzer = BarcodeAnalyzer(\n              barcodeFormats,\n              onComplete = { onBarcodeScanned(it) },\n              onError = { error ->\n                onBarcodeScannerError(\n                  CameraMountErrorEvent(\n                    "Barcode analyzer failed: ${error.localizedMessage ?: error.javaClass.simpleName}"\n                  )\n                )\n              }\n            ).also {\n              analyzer.setAnalyzer(ContextCompat.getMainExecutor(context), it)\n            }\n          } catch (e: Exception) {\n            Log.e(CameraViewModule.TAG, "Failed to initialize BarcodeAnalyzer: ${e.message}", e)\n            onBarcodeScannerError(\n              CameraMountErrorEvent("Barcode analyzer failed to initialize: ${e.localizedMessage ?: e.javaClass.simpleName}")\n            )\n          }'
const analyzerConstructorBefore =
  '  private val barcodeScanner: BarcodeScanner,\n  val onComplete: (BarCodeScannerResult) -> Unit\n) : ImageAnalysis.Analyzer, Closeable {\n  constructor(formats: List<BarcodeType>, onComplete: (BarCodeScannerResult) -> Unit) : this(\n    BarcodeScanning.getClient(\n      BarcodeScannerOptions.Builder()\n        .setBarcodeFormats(barcodeFormats(formats))\n        .build()\n    ),\n    onComplete\n  )'
const analyzerConstructorAfter =
  '  private val barcodeScanner: BarcodeScanner,\n  val onComplete: (BarCodeScannerResult) -> Unit,\n  val onError: (Throwable) -> Unit\n) : ImageAnalysis.Analyzer, Closeable {\n  constructor(\n    formats: List<BarcodeType>,\n    onComplete: (BarCodeScannerResult) -> Unit,\n    onError: (Throwable) -> Unit\n  ) : this(\n    BarcodeScanning.getClient(\n      BarcodeScannerOptions.Builder()\n        .setBarcodeFormats(barcodeFormats(formats))\n        .build()\n    ),\n    onComplete,\n    onError\n  )'
const analyzerFailureBefore =
  '        .addOnFailureListener {\n          Log.d("SCANNER", it.cause?.message ?: "Barcode scanning failed")\n        }'
const analyzerFailureAfter =
  '        .addOnFailureListener { error ->\n          Log.e("SCANNER", "Barcode scanning failed", error)\n          onError(error)\n        }'

function replaceRequired(source, before, after, file) {
  if (source.includes(after)) return source
  if (!source.includes(before)) {
    throw new Error(
      `Expo Camera scanner patch no longer matches ${file} near ${JSON.stringify(before.slice(0, 100))}; review the native source before building.`
    )
  }
  return source.replace(before, after)
}

function removeSystemScannerLaunch(source, file) {
  const launchStart = '    AsyncFunction("launchScanner") {'
  const propertyStart = '    Property("isDocumentScannerAvailable")'
  const start = source.indexOf(launchStart)
  if (start < 0) {
    if (source.includes('Property("isModernBarcodeScannerAvailable") { false }')) return source
    throw new Error(`Expo Camera launchScanner block is missing in ${file}; review the native source before building.`)
  }
  const nextProperty = source.indexOf(propertyStart, start)
  const closingBlock = source.lastIndexOf('\n    }\n', nextProperty)
  if (nextProperty < 0 || closingBlock < start) {
    throw new Error(
      `Expo Camera launchScanner block boundary changed in ${file}; review the native source before building.`
    )
  }
  return source.slice(0, start) + source.slice(closingBlock + '\n    }\n'.length)
}

function removeCodeScannerImports(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !codeScannerImports.includes(line.trim()))
    .join('\n')
}

function patchCameraModule(source, file) {
  source = removeSystemScannerLaunch(source, file)
  source = removeCodeScannerImports(source)
  source = source.replace(/^    Events\("onModernBarcodeScanned"\)\n/m, '')

  const availabilityBefore = source.match(/^    Property\("isModernBarcodeScannerAvailable"\) \{[\s\S]*?^    \}/m)?.[0]
  const availabilityAfter = '    Property("isModernBarcodeScannerAvailable") { false }'
  if (availabilityBefore && !availabilityBefore.includes('{ false }')) {
    source = source.replace(availabilityBefore, availabilityAfter)
  } else if (!availabilityBefore && !source.includes(availabilityAfter)) {
    throw new Error(
      `Expo Camera scanner availability property changed in ${file}; review the native source before building.`
    )
  }

  source = replaceRequired(source, analyzerEventBefore, analyzerEventAfter, file)
  if (source.includes('GmsBarcodeScanning') || source.includes('ModuleInstall')) {
    throw new Error(`Google Code Scanner references remain in ${file} after patching.`)
  }
  return source
}

/** Apply the reviewed Expo Camera 58 Android source corrections in-place. */
function patchExpoCameraScanner(cameraPackageRoot) {
  const files = {
    gradle: path.join(cameraPackageRoot, 'android/build.gradle'),
    utils: path.join(cameraPackageRoot, 'android/src/main/java/expo/modules/camera/utils/CameraUtils.kt'),
    module: path.join(cameraPackageRoot, 'android/src/main/java/expo/modules/camera/CameraViewModule.kt'),
    view: path.join(cameraPackageRoot, 'android/src/main/java/expo/modules/camera/ExpoCameraView.kt'),
    analyzer: path.join(cameraPackageRoot, 'android/src/main/java/expo/modules/camera/analyzers/BarcodeAnalyzer.kt')
  }
  const pendingWrites = new Map()
  const read = (key) => pendingWrites.get(files[key]) ?? fs.readFileSync(files[key], 'utf8')

  let gradle = read('gradle')
  if (gradle.includes(scannerDependency)) gradle = gradle.replace(scannerDependency, '')
  pendingWrites.set(files.gradle, gradle)

  let utils = read('utils')
  utils = replaceRequired(
    utils,
    '  private const val GOOGLE_PLAY_STORE_PACKAGE = "com.android.vending"',
    '  private const val GOOGLE_PLAY_SERVICES_PACKAGE = "com.google.android.gms"',
    files.utils
  )
  utils = replaceRequired(
    utils,
    '        .getPackageInfo(GOOGLE_PLAY_STORE_PACKAGE, 0)',
    '        .getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, 0)',
    files.utils
  )
  pendingWrites.set(files.utils, utils)

  const module = patchCameraModule(read('module'), files.module)
  pendingWrites.set(files.module, module)

  let view = read('view')
  view = replaceRequired(
    view,
    '  private val onMountError by EventDispatcher<CameraMountErrorEvent>()',
    '  private val onMountError by EventDispatcher<CameraMountErrorEvent>()\n  private val onBarcodeScannerError by EventDispatcher<CameraMountErrorEvent>()',
    files.view
  )
  view = replaceRequired(view, analyzerInitializationBefore, analyzerInitializationAfter, files.view)
  pendingWrites.set(files.view, view)

  let analyzer = read('analyzer')
  analyzer = replaceRequired(analyzer, analyzerConstructorBefore, analyzerConstructorAfter, files.analyzer)
  analyzer = replaceRequired(analyzer, analyzerFailureBefore, analyzerFailureAfter, files.analyzer)
  pendingWrites.set(files.analyzer, analyzer)

  const changedFiles = [...pendingWrites].filter(([filePath, source]) => source !== fs.readFileSync(filePath, 'utf8'))
  for (const [filePath, source] of changedFiles) fs.writeFileSync(filePath, source)
  return changedFiles.map(([filePath]) => path.relative(cameraPackageRoot, filePath))
}

module.exports = { patchExpoCameraScanner }
