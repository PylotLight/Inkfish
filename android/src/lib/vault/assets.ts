import * as FileSystem from 'expo-file-system/legacy'
import { newId } from '../format'
import { ASSETS } from './state'
import { ensureTree, mkdir } from './paths'

// --- assets ---

export async function saveAssetCopy(fromUri: string, ext: string): Promise<string> {
  await ensureTree()
  const now = new Date()
  const dir = `${ASSETS}${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/`
  await mkdir(dir)
  const name = `${newId('a')}${ext || '.bin'}`
  await FileSystem.copyAsync({ from: fromUri, to: `${dir}${name}` })
  return `assets/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${name}`
}

/** Write a base64 image payload from the system clipboard into the vault. */
export async function saveAssetBase64(base64: string, ext = '.png'): Promise<string> {
  await ensureTree()
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const dir = `${ASSETS}${now.getFullYear()}/${month}/`
  await mkdir(dir)
  const name = `${newId('a')}${ext || '.png'}`
  await FileSystem.writeAsStringAsync(`${dir}${name}`, base64, { encoding: FileSystem.EncodingType.Base64 })
  return `assets/${now.getFullYear()}/${month}/${name}`
}
