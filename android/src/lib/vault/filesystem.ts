import * as Legacy from 'expo-file-system/legacy'
import { SHARED_VAULT_ROOT } from './state'
import { getActiveTreeUri, isMigrationSourcePath } from './sharedVault'

export const EncodingType = Legacy.EncodingType
const B64 = Legacy.EncodingType.Base64

type Info = Awaited<ReturnType<typeof Legacy.getInfoAsync>>
type ReadOptions = Parameters<typeof Legacy.readAsStringAsync>[1]
type WriteOptions = Parameters<typeof Legacy.writeAsStringAsync>[2]
type MkdirOptions = Parameters<typeof Legacy.makeDirectoryAsync>[1]
type DeleteOptions = Parameters<typeof Legacy.deleteAsync>[1]
type MoveOptions = Parameters<typeof Legacy.moveAsync>[0]
type CopyOptions = Parameters<typeof Legacy.copyAsync>[0]

export function isSharedVaultPath(uri: string): boolean {
  return uri.startsWith(SHARED_VAULT_ROOT)
}

export async function resolveSharedContentUri(uri: string): Promise<string | null> {
  if (!isSharedVaultPath(uri)) return uri
  const stat = await (await native()).stat(treeUri(), relativePath(uri))
  return stat.exists && !stat.isDirectory ? (stat.uri ?? null) : null
}

function relativePath(uri: string): string {
  return uri.slice(SHARED_VAULT_ROOT.length).replace(/^\/+|\/+$/g, '')
}

function treeUri(): string {
  const uri = getActiveTreeUri()
  if (!uri) throw new Error('The shared vault is not active. Select and verify a shared folder in Settings first.')
  return uri
}

function assertNotMigrationSource(uri: string): void {
  if (isMigrationSourcePath(uri))
    throw new Error('Vault changes are paused while the shared-folder copy is being verified.')
}

async function native(): Promise<(typeof import('../../../modules/inkfish-saf-vault'))['default']> {
  return (await import('../../../modules/inkfish-saf-vault')).default
}

function normalizeBase64(value: string): string {
  return value.replace(/\s+/g, '')
}

async function localParent(uri: string): Promise<void> {
  const parent = uri.slice(0, uri.lastIndexOf('/') + 1)
  if (parent) await Legacy.makeDirectoryAsync(parent, { intermediates: true })
}

async function copySafToLocal(sourceRel: string, destination: string): Promise<void> {
  const fs = await native()
  const tree = treeUri()
  const stat = await fs.stat(tree, sourceRel)
  if (!stat.exists) throw new Error(`Shared document is missing: ${sourceRel}`)
  if ((await Legacy.getInfoAsync(destination)).exists)
    throw new Error(`Local move destination already exists: ${destination}`)
  if (stat.isDirectory) {
    await Legacy.makeDirectoryAsync(destination, { intermediates: true })
    const destPrefix = destination.endsWith('/') ? destination : `${destination}/`
    for (const name of await fs.list(tree, sourceRel).then((entries) => entries.map((entry) => entry.name))) {
      const child = `${sourceRel}/${name}`
      await copySafToLocal(child, `${destPrefix}${name}`)
    }
    return
  }
  await localParent(destination)
  const bytes = await fs.read(tree, sourceRel, 'base64')
  await Legacy.writeAsStringAsync(destination, bytes, { encoding: B64 })
  const verify = await Legacy.readAsStringAsync(destination, { encoding: B64 })
  if (normalizeBase64(verify) !== normalizeBase64(bytes))
    throw new Error(`Local trash copy verification failed: ${sourceRel}`)
}

async function copyLocalToSaf(source: string, destinationRel: string): Promise<void> {
  const fs = await native()
  const tree = treeUri()
  const info = await Legacy.getInfoAsync(source)
  if (!info.exists) throw new Error(`Local move source is missing: ${source}`)
  if (info.isDirectory) {
    await fs.mkdir(tree, destinationRel)
    const sourcePrefix = source.endsWith('/') ? source : `${source}/`
    for (const name of await Legacy.readDirectoryAsync(sourcePrefix)) {
      await copyLocalToSaf(`${sourcePrefix}${name}`, `${destinationRel}/${name}`)
    }
    return
  }
  await fs.copyFromUri(source, tree, destinationRel)
}

export async function getInfoAsync(uri: string): Promise<Info> {
  if (!isSharedVaultPath(uri)) return Legacy.getInfoAsync(uri)
  const info = await (await native()).stat(treeUri(), relativePath(uri))
  return {
    exists: info.exists,
    isDirectory: info.isDirectory,
    uri: info.uri ?? uri,
    size: info.size,
    modificationTime: info.modificationTime ? info.modificationTime / 1000 : 0
  } as Info
}

export async function readDirectoryAsync(uri: string): Promise<string[]> {
  if (!isSharedVaultPath(uri)) return Legacy.readDirectoryAsync(uri)
  return (await (await native()).list(treeUri(), relativePath(uri))).map((entry) => entry.name)
}

export async function readAsStringAsync(uri: string, options?: ReadOptions): Promise<string> {
  if (!isSharedVaultPath(uri)) return Legacy.readAsStringAsync(uri, options)
  const encoding = options?.encoding === B64 ? 'base64' : 'utf8'
  return (await native()).read(treeUri(), relativePath(uri), encoding)
}

export async function writeAsStringAsync(uri: string, contents: string, options?: WriteOptions): Promise<void> {
  assertNotMigrationSource(uri)
  if (!isSharedVaultPath(uri)) return Legacy.writeAsStringAsync(uri, contents, options)
  const encoding = options?.encoding === B64 ? 'base64' : 'utf8'
  return (await native()).writeAtomic(treeUri(), relativePath(uri), contents, encoding)
}

export async function makeDirectoryAsync(uri: string, _options?: MkdirOptions): Promise<void> {
  assertNotMigrationSource(uri)
  if (!isSharedVaultPath(uri)) return Legacy.makeDirectoryAsync(uri, _options)
  const rel = relativePath(uri)
  if (!rel) return
  return (await native()).mkdir(treeUri(), rel)
}

export async function deleteAsync(uri: string, options?: DeleteOptions): Promise<void> {
  assertNotMigrationSource(uri)
  if (!isSharedVaultPath(uri)) return Legacy.deleteAsync(uri, options)
  const rel = relativePath(uri)
  if (!rel) throw new Error('The selected shared vault root cannot be deleted.')
  const info = await getInfoAsync(uri)
  if (!info.exists) {
    if (options?.idempotent) return
    throw new Error(`Shared document does not exist: ${rel}`)
  }
  return (await native()).delete(treeUri(), rel)
}

export async function moveAsync(options: MoveOptions): Promise<void> {
  const { from, to } = options
  assertNotMigrationSource(from)
  assertNotMigrationSource(to)
  const fromShared = isSharedVaultPath(from)
  const toShared = isSharedVaultPath(to)
  if (fromShared && toShared) return (await native()).move(treeUri(), relativePath(from), relativePath(to))
  if (fromShared) {
    await copySafToLocal(relativePath(from), to)
    await (await native()).delete(treeUri(), relativePath(from))
    return
  }
  if (toShared) {
    if (!(await Legacy.getInfoAsync(from)).exists) throw new Error(`Move source does not exist: ${from}`)
    const destInfo = await getInfoAsync(to)
    if (destInfo.exists) throw new Error(`Move destination already exists: ${relativePath(to)}`)
    await copyLocalToSaf(from, relativePath(to))
    await Legacy.deleteAsync(from)
    return
  }
  return Legacy.moveAsync(options)
}

export async function copyAsync(options: CopyOptions): Promise<void> {
  const { from, to } = options
  assertNotMigrationSource(to)
  const fromShared = isSharedVaultPath(from)
  const toShared = isSharedVaultPath(to)
  if (fromShared && toShared) {
    const source = relativePath(from)
    const destination = relativePath(to)
    const fs = await native()
    const info = await fs.stat(treeUri(), source)
    if (!info.exists || info.isDirectory) throw new Error(`Shared copy source is not a file: ${source}`)
    await fs.copyFromUri(info.uri ?? '', treeUri(), destination)
    return
  }
  if (fromShared) {
    const info = await getInfoAsync(from)
    if (!info.exists || info.isDirectory) throw new Error(`Shared copy source is not a file: ${relativePath(from)}`)
    await copySafToLocal(relativePath(from), to)
    return
  }
  if (toShared) {
    await (await native()).copyFromUri(from, treeUri(), relativePath(to))
    return
  }
  return Legacy.copyAsync(options)
}
