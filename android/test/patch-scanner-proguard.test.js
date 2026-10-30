const { afterEach, describe, expect, test } = require('bun:test')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  SCANNER_PROGUARD_MARKER,
  SCANNER_PROGUARD_RULES,
  patchScannerProguardRules
} = require('../plugins/patch-scanner-proguard')

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function androidProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inkfish-scanner-r8-'))
  roots.push(root)
  mkdirSync(path.join(root, 'app'))
  writeFileSync(path.join(root, 'app/proguard-rules.pro'), '# Generated Android app rules\n')
  return root
}

describe('ML Kit scanner R8 rules', () => {
  test('keeps reflective bundled barcode analyzer and component registration classes', () => {
    const root = androidProject()

    expect(patchScannerProguardRules(root)).toBe(true)

    const rules = readFileSync(path.join(root, 'app/proguard-rules.pro'), 'utf8')
    expect(rules).toContain(SCANNER_PROGUARD_MARKER)
    for (const rule of SCANNER_PROGUARD_RULES) expect(rules).toContain(rule)
    expect(rules).toContain('com.google.android.gms.internal.mlkit_vision_barcode')
    expect(rules).toContain('com.google.android.gms.internal.mlkit_vision_barcode_bundled')
    expect(rules).toContain('com.google.firebase.components.ComponentRegistrar')
    expect(rules).not.toContain('mlkit_code_scanner')
  })

  test('is idempotent and restores any missing required rule without duplicating the marker', () => {
    const root = androidProject()
    const rulesPath = path.join(root, 'app/proguard-rules.pro')

    expect(patchScannerProguardRules(root)).toBe(true)
    const once = readFileSync(rulesPath, 'utf8')
    expect(patchScannerProguardRules(root)).toBe(false)
    expect(readFileSync(rulesPath, 'utf8')).toBe(once)

    writeFileSync(rulesPath, once.replace(SCANNER_PROGUARD_RULES[0], ''))
    expect(patchScannerProguardRules(root)).toBe(true)
    const repaired = readFileSync(rulesPath, 'utf8')
    expect(repaired).toContain(SCANNER_PROGUARD_RULES[0])
    expect(repaired.split(SCANNER_PROGUARD_MARKER)).toHaveLength(2)
  })

  test('fails clearly when Expo changes the generated Android app ProGuard file path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'inkfish-scanner-r8-missing-'))
    roots.push(root)

    expect(() => patchScannerProguardRules(root)).toThrow('proguard-rules.pro')
  })
})
