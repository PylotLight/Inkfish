const path = require('node:path')
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins')
const { patchExpoCameraScanner } = require('./patch-expo-camera-scanner')
const { ensureGooglePlayServicesQuery } = require('./google-play-services-query')

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
      return modConfig
    }
  ])
}
