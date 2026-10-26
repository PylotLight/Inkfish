import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { appDataDir, readStoredRoot } from './appdata'
import type { VaultPaths } from './types'

export function envManaged(): boolean {
  return !!process.env['INKFISH_VAULT']?.trim()
}

// Default notes-home folder under ~ (suggested in onboarding, adopted if it already exists).
// A dev profile sets "Inkfish Dev" so it never silently adopts the release app's ~/Inkfish;
// picking that folder in onboarding / Settings is still allowed, it just has to be explicit.
let defaultVaultName = 'Inkfish'

export function setDefaultVaultName(name: string): void {
  defaultVaultName = name.trim() || 'Inkfish'
}

export function defaultVaultRoot(): string {
  return join(homedir(), defaultVaultName)
}

export function resolveVaultRoot(): string {
  const override = process.env['INKFISH_VAULT']
  if (override && override.trim()) return resolve(override)
  return readStoredRoot() ?? defaultVaultRoot()
}

/** Has a vault home been established? Stored choice, env override, or a
 * pre-existing default vault (adopted from earlier versions) all count.
 * False only on true first run — the onboarding wizard must pick first. */
export function vaultConfigured(): boolean {
  if (envManaged()) return true
  if (readStoredRoot()) return true
  return existsSync(defaultVaultRoot())
}

export function vaultPaths(root: string = resolveVaultRoot()): VaultPaths {
  const data = appDataDir()
  // Staging + index must never live inside the notes home (it would pollute
  // sync, Obsidian, and git). Fail loud instead of falling back into the vault.
  if (!data) throw new Error('app data dir unavailable — refusing to place index inside notes home')
  const staging = join(data, 'staging')
  return {
    root,
    inboxDir: join(staging, 'inbox'),
    dailyDir: join(staging, 'daily'),
    assetsDir: join(root, 'assets'),
    dbPath: join(data, 'inkfish.db')
  }
}

/** Resolve a note rel to an absolute path — staging rels (`inbox/`, `daily/`) live in app data. */
export function resolveNoteAbs(rel: string, paths: VaultPaths = vaultPaths()): string {
  if (rel === 'inbox' || rel.startsWith('inbox/')) return join(paths.inboxDir, rel.slice('inbox/'.length))
  if (rel === 'daily' || rel.startsWith('daily/')) return join(paths.dailyDir, rel.slice('daily/'.length))
  return join(paths.root, rel)
}

/** True for staging rels (working state) vs finalised vault content. */
export function isStagingRel(rel: string): boolean {
  return rel === 'inbox' || rel.startsWith('inbox/') || rel === 'daily' || rel.startsWith('daily/')
}
