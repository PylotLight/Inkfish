const { execFileSync } = require('node:child_process')

const REQUIRED_DEX_MARKERS = Object.freeze([
  'com/google/mlkit/vision/barcode/BarcodeScanning',
  'onBarcodeScannerError',
  'Barcode analyzer failed:',
  'Barcode analyzer failed to initialize:'
])

function verifyScannerDex(dexFiles) {
  const dexBytes = Buffer.concat(dexFiles)
  const missing = REQUIRED_DEX_MARKERS.filter((marker) => !dexBytes.includes(Buffer.from(marker)))
  if (missing.length) {
    throw new Error(
      `Android APK is missing required native scanner code markers: ${missing.join(', ')}. ` +
        'Could not verify the bundled ML Kit barcode analyzer and its native diagnostics in the optimized DEX.'
    )
  }
  return REQUIRED_DEX_MARKERS
}

function verifyScannerApk(apkPath) {
  const entries = execFileSync('unzip', ['-Z1', apkPath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((entry) => /^classes(?:\d+)?\.dex$/.test(entry))
  if (entries.length === 0) throw new Error('APK contains no DEX bytecode files')

  const dexFiles = entries.map((entry) =>
    execFileSync('unzip', ['-p', apkPath, entry], {
      maxBuffer: 64 * 1024 * 1024
    })
  )
  return verifyScannerDex(dexFiles)
}

if (require.main === module) {
  const apkPath = process.argv[2]
  if (!apkPath) {
    console.error('Usage: node plugins/verify-scanner-apk.js <path-to-apk>')
    process.exitCode = 2
  } else {
    try {
      const markers = verifyScannerApk(apkPath)
      console.log(`Verified native scanner code in APK: ${markers.join(', ')}`)
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}

module.exports = { REQUIRED_DEX_MARKERS, verifyScannerApk, verifyScannerDex }
