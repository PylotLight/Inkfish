const fs = require('node:fs')
const path = require('node:path')

const SCANNER_PROGUARD_MARKER = '# Inkfish ML Kit scanner R8 rules; see googlesamples/mlkit issue 1018.'

const SCANNER_PROGUARD_RULES = [
  '-keep class com.google.mlkit.** { *; }',
  '-keep class com.google.android.gms.internal.mlkit_code_scanner.** { *; }',
  '-keep class com.google.android.gms.internal.mlkit_vision_barcode.** { *; }',
  '-keep class com.google.android.gms.internal.mlkit_vision_barcode_bundled.** { *; }',
  '-keep class com.google.android.gms.internal.mlkit_vision_common.** { *; }',
  '-keep class * implements com.google.firebase.components.ComponentRegistrar { void <init>(); }',
  '-keep,allowshrinking interface com.google.firebase.components.ComponentRegistrar'
]

function patchScannerProguardRules(androidProjectRoot) {
  const rulesPath = path.join(androidProjectRoot, 'app', 'proguard-rules.pro')
  const source = fs.readFileSync(rulesPath, 'utf8')
  const existingLines = new Set(source.split(/\r?\n/))
  const missingRules = SCANNER_PROGUARD_RULES.filter((rule) => !existingLines.has(rule))

  if (missingRules.length === 0) return false

  const hasMarker = existingLines.has(SCANNER_PROGUARD_MARKER)
  const separator = source.length === 0 ? '' : source.endsWith('\n') ? '\n' : '\n\n'
  fs.writeFileSync(
    rulesPath,
    `${source}${separator}${hasMarker ? '' : `${SCANNER_PROGUARD_MARKER}\n`}${missingRules.join('\n')}\n`
  )
  return true
}

module.exports = {
  SCANNER_PROGUARD_MARKER,
  SCANNER_PROGUARD_RULES,
  patchScannerProguardRules
}
