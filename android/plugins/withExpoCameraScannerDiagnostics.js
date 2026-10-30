const path = require('node:path')
const { withDangerousMod } = require('@expo/config-plugins')
const { patchExpoCameraScanner } = require('./patch-expo-camera-scanner')

module.exports = function withExpoCameraScannerDiagnostics(config) {
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
