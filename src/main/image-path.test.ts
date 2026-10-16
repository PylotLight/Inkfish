import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { vaultAbsPath } from './image-path'

describe('vaultAbsPath', () => {
  const root = '/Users/me/Notes'
  test('resolves vault-relative files', () => {
    expect(vaultAbsPath(root, 'assets/2026/10/a b.png')).toBe(join(root, 'assets/2026/10/a b.png'))
    expect(vaultAbsPath(root, 'x/../assets/c.png')).toBe(join(root, 'assets/c.png'))
  })
  test('rejects escapes, absolute paths and the root itself', () => {
    expect(vaultAbsPath(root, '../secret.png')).toBeNull()
    expect(vaultAbsPath(root, 'assets/../../x.png')).toBeNull()
    expect(vaultAbsPath(root, '/etc/passwd')).toBeNull()
    expect(vaultAbsPath(root, '')).toBeNull()
    expect(vaultAbsPath(root, '.')).toBeNull()
  })
})
