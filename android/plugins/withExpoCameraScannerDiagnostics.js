const path = require('node:path')
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins')
const { patchExpoCameraScanner } = require('./patch-expo-camera-scanner')
const { ensureGooglePlayServicesQuery } = require('./google-play-services-query')
const { patchScannerProguardRules } = require('./patch-scanner-proguard')

module.exports = function withExpoCameraScannerDiagnostics(config) {
  config = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = ensureGooglePlayServicesQuery(modConfig.modResults)
    return modConfig
  })
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const packageJson = require.resolve('expo-camera/package.json', {
        paths: [modConfig.modRequest.projectRoot]
      })
      const changedFiles = patchExpoCameraScanner(path.dirname(packageJson))
      if (changedFiles.length) {
        console.info(`[withExpoCameraScannerDiagnostics] Patched ${changedFiles.join(', ')}`)
      }
      const androidProjectRoot = modConfig.modRequest.platformProjectRoot
      if (patchScannerProguardRules(androidProjectRoot)) {
        console.info('[withExpoCameraScannerDiagnostics] Added ML Kit scanner R8 keep rules')
      }
      return modConfig
    }
  ])
}
