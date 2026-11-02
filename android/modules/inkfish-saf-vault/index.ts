import { requireNativeModule } from 'expo-modules-core'

export interface SafEntry {
  name: string
  isDirectory: boolean
  size: number
  modificationTime: number
  uri: string
}

export interface SafStat {
  exists: boolean
  isDirectory: boolean
  size: number
  modificationTime: number
  uri?: string
}

export interface SafProbeResult {
  name: string
  files: true
  nestedDirectories: true
  rename: true
  delete: true
  noOverwrite: true
}

export interface InkfishSafVaultNative {
  probe(treeUri: string): Promise<SafProbeResult>
  isAvailable(treeUri: string): Promise<boolean>
  list(treeUri: string, rel: string): Promise<SafEntry[]>
  stat(treeUri: string, rel: string): Promise<SafStat>
  hash(treeUri: string, rel: string): Promise<string>
  hashUri(sourceUri: string): Promise<string>
  read(treeUri: string, rel: string, encoding: 'utf8' | 'base64'): Promise<string>
  writeAtomic(treeUri: string, rel: string, contents: string, encoding: 'utf8' | 'base64'): Promise<void>
  writeAtomicIfAbsent(treeUri: string, rel: string, contents: string, encoding: 'utf8' | 'base64'): Promise<void>
  copyFromUri(sourceUri: string, treeUri: string, rel: string): Promise<void>
  mkdir(treeUri: string, rel: string): Promise<void>
  move(treeUri: string, fromRel: string, toRel: string): Promise<void>
  delete(treeUri: string, rel: string): Promise<void>
  recover(treeUri: string): Promise<number>
}

export default requireNativeModule<InkfishSafVaultNative>('InkfishSafVault')
