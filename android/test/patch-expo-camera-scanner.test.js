const { afterEach, describe, expect, test } = require('bun:test')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { patchExpoCameraScanner } = require('../plugins/patch-expo-camera-scanner')

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inkfish-expo-camera-'))
  roots.push(root)
  const camera = path.join(root, 'android/src/main/java/expo/modules/camera')
  mkdirSync(path.join(camera, 'utils'), { recursive: true })
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
      '          .addOnFailureListener {',
      '            promise.reject(CameraExceptions.BarcodeScanningFailedException())',
      '          }'
    ].join('\n')
  )
  writeFileSync(
    path.join(camera, 'CameraExceptions.kt'),
    ['  class BarcodeScanningFailedException :', '    CodedException("Barcode scanning failed")'].join('\n')
  )
  return root
}

describe('Expo Camera scanner build patch', () => {
  test('checks Google Play services and passes the native failure cause through', () => {
    const root = fixture()
    const changed = patchExpoCameraScanner(root)
    const cameraUtils = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/utils/CameraUtils.kt'),
      'utf8'
    )
    const module = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/CameraViewModule.kt'),
      'utf8'
    )
    const exceptions = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/CameraExceptions.kt'),
      'utf8'
    )

    expect(changed).toHaveLength(3)
    expect(cameraUtils).toContain('GOOGLE_PLAY_SERVICES_PACKAGE = "com.google.android.gms"')
    expect(cameraUtils).toContain('.getPackageInfo(GOOGLE_PLAY_SERVICES_PACKAGE, 0)')
    expect(module).toContain('.addOnFailureListener { error ->')
    expect(module).toContain('BarcodeScanningFailedException(error)')
    expect(exceptions).toContain('Barcode scanning failed: $it')
    expect(exceptions).toContain('cause = cause')
  })

  test('is idempotent on repeated prebuilds', () => {
    const root = fixture()
    expect(patchExpoCameraScanner(root)).toHaveLength(3)
    expect(patchExpoCameraScanner(root)).toEqual([])
  })

  test('fails safely when Expo changes its native implementation', () => {
    const root = fixture()
    writeFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/CameraViewModule.kt'),
      'native implementation changed'
    )
    expect(() => patchExpoCameraScanner(root)).toThrow('review the native source before building')
    const cameraUtils = readFileSync(
      path.join(root, 'android/src/main/java/expo/modules/camera/utils/CameraUtils.kt'),
      'utf8'
    )
    expect(cameraUtils).toContain('GOOGLE_PLAY_STORE_PACKAGE')
  })
})
