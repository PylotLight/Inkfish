const fs = require('node:fs')
const path = require('node:path')

const scannerLaunchBefore = [
  `        val scanner = GmsBarcodeScanning.getClient(reactContext, options)
        scanner.startScan()
          .addOnSuccessListener { barcode ->
            val result = BarCodeScannerResultSerializer.parseBarcodeScanningResult(barcode)
            sendEvent("onModernBarcodeScanned", BarCodeScannerResultSerializer.toBundle(result, 1.0f))
            promise.resolve()
          }
          .addOnCanceledListener {
            promise.reject(CameraExceptions.BarcodeScanningCancelledException())
          }
          .addOnFailureListener {
            promise.reject(CameraExceptions.BarcodeScanningFailedException())
          }`,
  `        val scanner = GmsBarcodeScanning.getClient(reactContext, options)
        scanner.startScan()
          .addOnSuccessListener { barcode ->
            val result = BarCodeScannerResultSerializer.parseBarcodeScanningResult(barcode)
            sendEvent("onModernBarcodeScanned", BarCodeScannerResultSerializer.toBundle(result, 1.0f))
            promise.resolve()
          }
          .addOnCanceledListener {
            promise.reject(CameraExceptions.BarcodeScanningCancelledException())
          }
          .addOnFailureListener { error ->
            promise.reject(CameraExceptions.BarcodeScanningFailedException(error))
          }`
]

const scannerLaunchAfter = `        val scanner = GmsBarcodeScanning.getClient(reactContext, options)
        val moduleInstallClient = ModuleInstall.getClient(reactContext)
        val scannerLaunchStarted = AtomicBoolean(false)
        val promiseSettled = AtomicBoolean(false)

        val launchInstalledScanner: () -> Unit = {
          if (scannerLaunchStarted.compareAndSet(false, true)) {
            try {
              scanner.startScan()
                .addOnSuccessListener { barcode ->
                  if (promiseSettled.compareAndSet(false, true)) {
                    val result = BarCodeScannerResultSerializer.parseBarcodeScanningResult(barcode)
                    sendEvent("onModernBarcodeScanned", BarCodeScannerResultSerializer.toBundle(result, 1.0f))
                    promise.resolve()
                  }
                }
                .addOnCanceledListener {
                  if (promiseSettled.compareAndSet(false, true)) {
                    promise.reject(CameraExceptions.BarcodeScanningCancelledException())
                  }
                }
                .addOnFailureListener { error ->
                  if (promiseSettled.compareAndSet(false, true)) {
                    promise.reject(CameraExceptions.BarcodeScanningFailedException(error))
                  }
                }
            } catch (error: Exception) {
              if (promiseSettled.compareAndSet(false, true)) {
                promise.reject(CameraExceptions.BarcodeScanningFailedException(error))
              }
            }
          }
        }

        lateinit var installStatusListener: InstallStatusListener
        installStatusListener = object : InstallStatusListener {
          override fun onInstallStatusUpdated(update: ModuleInstallStatusUpdate) {
            when (update.installState) {
              ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED -> {
                moduleInstallClient.unregisterListener(this)
                launchInstalledScanner()
              }
              ModuleInstallStatusUpdate.InstallState.STATE_FAILED,
              ModuleInstallStatusUpdate.InstallState.STATE_CANCELED -> {
                moduleInstallClient.unregisterListener(this)
                if (promiseSettled.compareAndSet(false, true)) {
                  promise.reject(
                    CameraExceptions.BarcodeScanningFailedException(
                      IllegalStateException(
                        "Google Code Scanner module installation failed (state=\${update.installState}, error=\${update.errorCode})"
                      )
                    )
                  )
                }
              }
            }
          }
        }

        val installRequest = ModuleInstallRequest.newBuilder()
          .addApi(scanner)
          .setListener(installStatusListener)
          .build()
        moduleInstallClient.installModules(installRequest)
          .addOnSuccessListener { response ->
            if (response.areModulesAlreadyInstalled()) {
              moduleInstallClient.unregisterListener(installStatusListener)
              launchInstalledScanner()
            }
          }
          .addOnFailureListener { error ->
            moduleInstallClient.unregisterListener(installStatusListener)
            if (promiseSettled.compareAndSet(false, true)) {
              promise.reject(CameraExceptions.BarcodeScanningFailedException(error))
            }
          }`

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
    before: 'import android.util.Log',
    after:
      'import android.util.Log\nimport com.google.android.gms.common.moduleinstall.InstallStatusListener\nimport com.google.android.gms.common.moduleinstall.ModuleInstall\nimport com.google.android.gms.common.moduleinstall.ModuleInstallRequest\nimport com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before: 'import java.io.File',
    after: 'import java.io.File\nimport java.util.concurrent.atomic.AtomicBoolean'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before: '  "onBarcodeScanned",',
    after: '  "onBarcodeScanned",\n  "onBarcodeScannerError",'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before: '    // False on Horizon OS (Quest devices) and devices without Google Play Services.',
    after: '    // False on Horizon OS (Quest devices) and when the bundled barcode client is absent.'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before: '      !VRUtilities.isQuest() && CameraUtils.isMLKitAvailable(appContext.reactContext)',
    after: '      !VRUtilities.isQuest() && CameraUtils.isMLKitBarcodeScannerAvailable()'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before:
      '      } catch (_: Exception) {\n        promise.reject(CameraExceptions.GooglePlayServicesUnavailableException())\n      }',
    after:
      '      } catch (error: Exception) {\n        promise.reject(CameraExceptions.BarcodeScanningFailedException(error))\n      }'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before:
      '      if (!CameraUtils.hasGooglePlayServices(appContext.reactContext)) {\n        promise.reject(CameraExceptions.GooglePlayServicesUnavailableException())\n        return@AsyncFunction\n      }',
    after:
      '      // Let ModuleInstallClient check the actual scanner service/module;\n      // a package lookup can still be a false negative on restricted profiles.'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    before: scannerLaunchBefore,
    after: scannerLaunchAfter
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
  const beforeVariants = Array.isArray(before) ? before : [before]
  const matchedBefore = beforeVariants.find((variant) => source.includes(variant))
  if (!matchedBefore) {
    throw new Error(
      `Expo Camera scanner diagnostic patch no longer matches ${file} near ${JSON.stringify(beforeVariants[0].slice(0, 100))}; review the native source before building.`
    )
  }
  return source.replace(matchedBefore, after)
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
