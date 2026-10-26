import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { ensureVault } from './bootstrap'
import { newId } from './frontmatter'
import { vaultPaths } from './paths'
import type { VaultPaths } from './types'

// --- assets ---------------------------------------------------------------------

export function saveAsset(fileName: string, data: Buffer, paths: VaultPaths = vaultPaths()): string {
  ensureVault(paths)
  const now = new Date()
  const dir = join(paths.assetsDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  const safe = `${newId('a')}${extname(fileName) || '.bin'}`
  writeFileSync(join(dir, safe), data)
  return relative(paths.root, join(dir, safe))
}

export function resolveAsset(vaultRel: string, paths: VaultPaths = vaultPaths()): string {
  return join(paths.root, vaultRel)
}
