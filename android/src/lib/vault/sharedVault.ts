import * as Legacy from 'expo-file-system/legacy'
import { APP, SHARED_VAULT_ROOT, setSharedVaultActive } from './state'
import { fromBase64, toBase64 } from '../sync'
import { migrateVault, type MigrationIo, type MigrationProgress, type MigrationResult } from './migration'

const STATE_FILE = `${APP}.vault-location.json`
const PRIVATE_VAULT = `${APP}vault/`

interface StoredState {
  version: 1
  activeTreeUri: string | null
  activeName: string | null
  pendingTreeUri: string | null
  pendingName: string | null
  migration: MigrationProgress | null
}

const emptyState = (): StoredState => ({
  version: 1,
  activeTreeUri: null,
  activeName: null,
  pendingTreeUri: null,
  pendingName: null,
  migration: null
})

let state: StoredState | null = null
let loadTask: Promise<StoredState> | null = null
let activeTreeRecovered = false
let migrationSourceLock: 'private' | 'shared' | null = null

async function native(): Promise<(typeof import('../../../modules/inkfish-saf-vault'))['default']> {
  return (await import('../../../modules/inkfish-saf-vault')).default
}

async function persist(): Promise<void> {
  if (!state) return
  if (!(await Legacy.getInfoAsync(APP)).exists) await Legacy.makeDirectoryAsync(APP, { intermediates: true })
  const { writeAtomically } = await import('./paths')
  await writeAtomically(STATE_FILE, JSON.stringify(state), 'utf8')
}

async function commitState(next: StoredState): Promise<void> {
  const previous = state
  state = next
  try {
    await persist()
  } catch (error) {
    state = previous
    throw error
  }
}

async function loadState(): Promise<StoredState> {
  if (state) return state
  if (loadTask) return loadTask
  const task = (async (): Promise<StoredState> => {
    const info = await Legacy.getInfoAsync(STATE_FILE)
    if (!info.exists) {
      state = emptyState()
      return state
    }
    let value: Partial<StoredState>
    try {
      value = JSON.parse(await Legacy.readAsStringAsync(STATE_FILE)) as Partial<StoredState>
    } catch (error) {
      throw new Error(`The saved vault location could not be read; no location was changed. ${error instanceof Error ? error.message : String(error)}`)
    }
    if (value.version !== 1) throw new Error('The saved vault location has an unsupported version; no location was changed.')
    state = {
      ...emptyState(),
      activeTreeUri: typeof value.activeTreeUri === 'string' ? value.activeTreeUri : null,
      activeName: typeof value.activeName === 'string' ? value.activeName : null,
      pendingTreeUri: typeof value.pendingTreeUri === 'string' ? value.pendingTreeUri : null,
      pendingName: typeof value.pendingName === 'string' ? value.pendingName : null,
      migration: value.migration && typeof value.migration === 'object' ? value.migration as MigrationProgress : null
    }
    return state
  })()
  loadTask = task
  try {
    return await task
  } finally {
    if (loadTask === task) loadTask = null
  }
}

/** Load the saved tree before any vault path is used; the private vault remains the default. */
export async function initializeSharedVault(): Promise<void> {
  const current = await loadState()
  if (setSharedVaultActive(!!current.activeTreeUri)) await invalidateDerivedCaches()
  if (current.activeTreeUri && !activeTreeRecovered) {
    const saf = await native()
    if (!(await saf.isAvailable(current.activeTreeUri))) {
      throw new Error('Shared-folder access was revoked. Reconnect the selected folder in Settings; the private original is unchanged.')
    }
    await saf.recover(current.activeTreeUri)
    activeTreeRecovered = true
  }
}

async function invalidateDerivedCaches(): Promise<void> {
  const scan = await import('./scan')
  scan.invalidateScanForVaultChange()
  const sync = await import('../syncfs')
  await sync.resetVaultHashCache()
}

export function getActiveTreeUri(): string | null {
  return state?.activeTreeUri ?? null
}

export function isMigrationSourcePath(uri: string): boolean {
  return migrationSourceLock === 'shared'
    ? uri.startsWith(SHARED_VAULT_ROOT)
    : migrationSourceLock === 'private'
      ? uri.startsWith(PRIVATE_VAULT)
      : false
}

export function getSharedVaultStatus(): {
  active: boolean
  activeName: string | null
  activeTreeUri: string | null
  pendingName: string | null
  pendingTreeUri: string | null
  migration: MigrationProgress | null
} {
  return {
    active: !!state?.activeTreeUri,
    activeName: state?.activeName ?? null,
    activeTreeUri: state?.activeTreeUri ?? null,
    pendingName: state?.pendingName ?? null,
    pendingTreeUri: state?.pendingTreeUri ?? null,
    migration: state?.migration ?? null
  }
}

export async function loadSharedVaultStatus(): Promise<ReturnType<typeof getSharedVaultStatus>> {
  await loadState()
  return getSharedVaultStatus()
}

function treeIdentity(uri: string): string {
  const match = /^content:\/\/([^/]+)\/tree\/([^/]+)/.exec(uri)
  if (!match) return uri
  let docId = match[2]!
  try { docId = decodeURIComponent(docId) } catch { /* keep the provider's encoded id */ }
  return `${match[1]}:${docId}`
}

/** Explicit picker selection. The directory is not activated or populated here. */
export async function chooseSharedVaultFolder(): Promise<{ name: string; alreadyActive: boolean }> {
  await loadState()
  const { Directory } = await import('expo-file-system')
  const selected = await Directory.pickDirectoryAsync()
  const saf = await native()
  const probe = await saf.probe(selected.uri)
  const alreadyActive = !!state!.activeTreeUri && treeIdentity(state!.activeTreeUri) === treeIdentity(selected.uri)
  const next = { ...state! }
  if (alreadyActive) {
    next.activeTreeUri = selected.uri
    next.activeName = probe.name || selected.name || 'Shared folder'
    next.pendingTreeUri = null
    next.pendingName = null
    next.migration = null
    await commitState(next)
    if (setSharedVaultActive(true)) await invalidateDerivedCaches()
    activeTreeRecovered = false
    await saf.recover(selected.uri)
    activeTreeRecovered = true
  } else {
    next.pendingTreeUri = selected.uri
    next.pendingName = probe.name || selected.name || 'Shared folder'
    next.migration = null
    await commitState(next)
  }
  return { name: probe.name || selected.name || 'Shared folder', alreadyActive }
}

async function buildMigrationIo(treeUri: string, sourceTreeUri: string | null): Promise<MigrationIo> {
  const saf = await native()
  const listLocal = async (parent: string) => {
    const uri = parent ? `${PRIVATE_VAULT}${parent}/` : PRIVATE_VAULT
    const names = await Legacy.readDirectoryAsync(uri)
    const result = []
    for (const name of names) {
      const info = await Legacy.getInfoAsync(`${uri}${name}`)
      if (!info.exists) continue
      result.push({ name, isDirectory: !!info.isDirectory })
    }
    return result
  }
  return {
    async listSource(path) {
      if (!sourceTreeUri) return listLocal(path)
      return (await saf.list(sourceTreeUri, path)).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory }))
    },
    async readSource(path) {
      if (sourceTreeUri) return fromBase64(await saf.read(sourceTreeUri, path, 'base64'))
      const b64 = await Legacy.readAsStringAsync(`${PRIVATE_VAULT}${path}`, { encoding: Legacy.EncodingType.Base64 })
      return fromBase64(b64)
    },
    async hashSource(path) {
      return sourceTreeUri ? saf.hash(sourceTreeUri, path) : saf.hashUri(`${PRIVATE_VAULT}${path}`)
    },
    async listDestination(path) {
      return (await saf.list(treeUri, path)).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory }))
    },
    async readDestination(path) {
      return fromBase64(await saf.read(treeUri, path, 'base64'))
    },
    async hashDestination(path) {
      return saf.hash(treeUri, path)
    },
    async mkdirDestination(path) {
      await saf.mkdir(treeUri, path)
    },
    async writeDestination(path, bytes) {
      await saf.writeAtomicIfAbsent(treeUri, path, toBase64(bytes), 'base64')
    },
    async copySourceToDestination(sourcePath, destinationPath) {
      let sourceUri = `${PRIVATE_VAULT}${sourcePath}`
      if (sourceTreeUri) {
        const info = await saf.stat(sourceTreeUri, sourcePath)
        if (!info.exists || info.isDirectory || !info.uri) throw new Error(`Shared source file is unavailable: ${sourcePath}`)
        sourceUri = info.uri
      }
      await saf.copyFromUri(sourceUri, treeUri, destinationPath)
    },
    async checkpoint(progress) {
      if (!state) await loadState()
      await commitState({ ...state!, migration: progress })
    }
  }
}

/** Copy/merge the current vault into the selected folder; the source is never moved or deleted. */
export async function copyVaultToSelectedShared(onProgress?: (progress: MigrationProgress) => void): Promise<MigrationResult> {
  const current = await loadState()
  const tree = current.pendingTreeUri
  if (!tree) throw new Error('Choose a shared folder first.')
  const saf = await native()
  const sourceTree = current.activeTreeUri
  if (migrationSourceLock) throw new Error('A shared-folder copy is already running.')
  migrationSourceLock = sourceTree ? 'shared' : 'private'
  try {
    // Probe again at the moment of copying: permissions/providers can change after selection.
    await saf.probe(tree)
    if (sourceTree) {
      if (!(await saf.isAvailable(sourceTree))) throw new Error('Current shared-folder access was revoked. Reconnect it before switching; its contents are unchanged.')
    } else if (!(await Legacy.getInfoAsync(PRIVATE_VAULT)).exists) {
      await Legacy.makeDirectoryAsync(PRIVATE_VAULT, { intermediates: true })
    }
    const result = await migrateVault(await buildMigrationIo(tree, sourceTree), onProgress)
    if (!result.verified) throw new Error('Shared copy did not pass final verification; the current vault remains active.')
    await saf.recover(tree)
    // Persist the destination choice only after every source file has been re-read and verified.
    await commitState({
      ...current,
      activeTreeUri: tree,
      activeName: current.pendingName,
      pendingTreeUri: null,
      pendingName: null,
      migration: null
    })
    const switchedSharedTree = !!sourceTree && treeIdentity(sourceTree) !== treeIdentity(tree)
    if (setSharedVaultActive(true) || switchedSharedTree) await invalidateDerivedCaches()
    activeTreeRecovered = true
    return result
  } finally {
    migrationSourceLock = null
  }
}

export const copyPrivateVaultToShared = copyVaultToSelectedShared

export async function discardPendingSharedFolder(): Promise<void> {
  await loadState()
  await commitState({ ...state!, pendingTreeUri: null, pendingName: null, migration: null })
}

export function resetSharedVaultStateForTests(): void {
  state = emptyState()
  loadTask = null
  activeTreeRecovered = false
  migrationSourceLock = null
  setSharedVaultActive(false)
}

export function sharedRootForTests(): string {
  return SHARED_VAULT_ROOT
}
