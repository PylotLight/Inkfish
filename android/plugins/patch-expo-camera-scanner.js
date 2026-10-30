const fs = require('node:fs')
const path = require('node:path')

const replacements = [
  {
    file: 'android/src/main/java/expo/modules/camera/utils/CameraUtils.kt',
    before: '  private const val GOOGLE_PLAY_STORE_PACKAGE = "com.android.vending"',
    after: '  private const val GOOGLE_PLAY_SERVICES_PACKAGE = "com.google.android.gms"',
    extraBefore: '        .getPackageInfo(GOOGLE_PLAY_STORE_PACKAGE, 0)',
    extraAfter: '        .getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, 0)'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before:
      '          .addOnFailureListener {\n            promise.reject(CameraExceptions.BarcodeScanningFailedException())\n          }',
    after:
      '          .addOnFailureListener { error ->\n            promise.reject(CameraExceptions.BarcodeScanningFailedException(error))\n          }'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before: '  "onBarcodeScanned",',
    after: '  "onBarcodeScanned",\n  "onBarcodeScannerError",'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before:
      '      } catch (_: Exception) {\n        promise.reject(CameraExceptions.GooglePlayServicesUnavailableException())\n      }',
    after:
      '      } catch (error: Exception) {\n        promise.reject(CameraExceptions.BarcodeScanningFailedException(error))\n      }'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraExceptions.kt',
    before: '  class BarcodeScanningFailedException :\n    CodedException("Barcode scanning failed")',
    after:
      '  class BarcodeScanningFailedException(cause: Throwable? = null) :\n    CodedException(\n      message = cause?.localizedMessage?.let { "Barcode scanning failed: $it" } ?: "Barcode scanning failed",\n      cause = cause\n    )'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/ExpoCameraView.kt',
    before: '  private val onMountError by EventDispatcher<CameraMountErrorEvent>()',
    after:
      '  private val onMountError by EventDispatcher<CameraMountErrorEvent>()\n  private val onBarcodeScannerError by EventDispatcher<CameraMountErrorEvent>()'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/ExpoCameraView.kt',
    before:
      '          try {\n            barcodeAnalyzer = BarcodeAnalyzer(barcodeFormats) {\n              onBarcodeScanned(it)\n            }.also {\n              analyzer.setAnalyzer(ContextCompat.getMainExecutor(context), it)\n            }\n          } catch (e: Exception) {\n            Log.e(CameraViewModule.TAG, "Failed to initialize BarcodeAnalyzer: ${e.message}")\n          }',
    after:
      '          try {\n            barcodeAnalyzer = BarcodeAnalyzer(\n              barcodeFormats,\n              onComplete = { onBarcodeScanned(it) },\n              onError = { error ->\n                onBarcodeScannerError(\n                  CameraMountErrorEvent(\n                    "Barcode analyzer failed: ${error.localizedMessage ?: error.javaClass.simpleName}"\n                  )\n                )\n              }\n            ).also {\n              analyzer.setAnalyzer(ContextCompat.getMainExecutor(context), it)\n            }\n          } catch (e: Exception) {\n            Log.e(CameraViewModule.TAG, "Failed to initialize BarcodeAnalyzer: ${e.message}", e)\n            onBarcodeScannerError(\n              CameraMountErrorEvent("Barcode analyzer failed to initialize: ${e.localizedMessage ?: e.javaClass.simpleName}")\n            )\n          }'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/analyzers/BarcodeAnalyzer.kt',
    before:
      '  private val barcodeScanner: BarcodeScanner,\n  val onComplete: (BarCodeScannerResult) -> Unit\n) : ImageAnalysis.Analyzer, Closeable {\n  constructor(formats: List<BarcodeType>, onComplete: (BarCodeScannerResult) -> Unit) : this(\n    BarcodeScanning.getClient(\n      BarcodeScannerOptions.Builder()\n        .setBarcodeFormats(barcodeFormats(formats))\n        .build()\n    ),\n    onComplete\n  )',
    after:
      '  private val barcodeScanner: BarcodeScanner,\n  val onComplete: (BarCodeScannerResult) -> Unit,\n  val onError: (Throwable) -> Unit\n) : ImageAnalysis.Analyzer, Closeable {\n  constructor(\n    formats: List<BarcodeType>,\n    onComplete: (BarCodeScannerResult) -> Unit,\n    onError: (Throwable) -> Unit\n  ) : this(\n    BarcodeScanning.getClient(\n      BarcodeScannerOptions.Builder()\n        .setBarcodeFormats(barcodeFormats(formats))\n        .build()\n    ),\n    onComplete,\n    onError\n  )'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/analyzers/BarcodeAnalyzer.kt',
    before:
      '        .addOnFailureListener {\n          Log.d("SCANNER", it.cause?.message ?: "Barcode scanning failed")\n        }',
    after:
      '        .addOnFailureListener { error ->\n          Log.e("SCANNER", "Barcode scanning failed", error)\n          onError(error)\n        }'
  }
]

function replaceRequired(source, before, after, file) {
  if (source.includes(after)) return source
  if (!source.includes(before)) {
    throw new Error(
      `Expo Camera scanner diagnostic patch no longer matches ${file}; review the native source before building.`
    )
  }
  return source.replace(before, after)
}

/** Apply the reviewed Expo Camera 58 Android source corrections in-place. */
function patchExpoCameraScanner(cameraPackageRoot) {
  const pendingWrites = new Map()
  for (const replacement of replacements) {
    const filePath = path.join(cameraPackageRoot, replacement.file)
    let source = pendingWrites.get(filePath) ?? fs.readFileSync(filePath, 'utf8')
    source = replaceRequired(source, replacement.before, replacement.after, replacement.file)
    if (replacement.extraBefore) {
      source = replaceRequired(source, replacement.extraBefore, replacement.extraAfter, replacement.file)
    }
    pendingWrites.set(filePath, source)
  }

  // Validate every source snippet before changing any files, so SDK drift cannot
  // leave a half-patched Expo Camera module behind.
  const changedFiles = [...pendingWrites].filter(([filePath, source]) => source !== fs.readFileSync(filePath, 'utf8'))
  for (const [filePath, source] of changedFiles) fs.writeFileSync(filePath, source)
  return changedFiles.map(([filePath]) => path.relative(cameraPackageRoot, filePath))
}

module.exports = { patchExpoCameraScanner }
