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
    before: '          .addOnFailureListener {\n            promise.reject(CameraExceptions.BarcodeScanningFailedException())\n          }',
    after: '          .addOnFailureListener { error ->\n            promise.reject(CameraExceptions.BarcodeScanningFailedException(error))\n          }'
  },
  {
    file: 'android/src/main/java/expo/modules/camera/CameraExceptions.kt',
    before: '  class BarcodeScanningFailedException :\n    CodedException("Barcode scanning failed")',
    after: '  class BarcodeScanningFailedException(cause: Throwable? = null) :\n    CodedException(\n      message = cause?.localizedMessage?.let { "Barcode scanning failed: $it" } ?: "Barcode scanning failed",\n      cause = cause\n    )'
  }
]

function replaceRequired(source, before, after, file) {
  if (source.includes(after)) return source
  if (!source.includes(before)) {
    throw new Error(`Expo Camera scanner diagnostic patch no longer matches ${file}; review the native source before building.`)
  }
  return source.replace(before, after)
}

/** Apply the reviewed Expo Camera 58 Android source corrections in-place. */
function patchExpoCameraScanner(cameraPackageRoot) {
  const pendingWrites = []
  for (const replacement of replacements) {
    const filePath = path.join(cameraPackageRoot, replacement.file)
    let source = fs.readFileSync(filePath, 'utf8')
    source = replaceRequired(source, replacement.before, replacement.after, replacement.file)
    if (replacement.extraBefore) {
      source = replaceRequired(source, replacement.extraBefore, replacement.extraAfter, replacement.file)
    }
    const original = fs.readFileSync(filePath, 'utf8')
    if (source !== original) pendingWrites.push([filePath, source])
  }

  // Validate all source snippets before changing any files, so SDK drift cannot
  // leave a half-patched Expo Camera module behind.
  for (const [filePath, source] of pendingWrites) fs.writeFileSync(filePath, source)
  return pendingWrites.map(([filePath]) => path.relative(cameraPackageRoot, filePath))
}

module.exports = { patchExpoCameraScanner }
