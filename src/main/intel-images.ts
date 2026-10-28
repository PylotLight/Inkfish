import { realpathSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { INTEL_MAX_IMAGE_BYTES, INTEL_MAX_IMAGES, type IntelImage } from '../shared/intelligence'
import { assetPathFromUrl, findImages, imageCandidates } from '../shared/images'
import { vaultAbsPath } from './image-path'

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_TOTAL_BYTES = INTEL_MAX_IMAGE_BYTES * INTEL_MAX_IMAGES

function mimeFor(bytes: Buffer): IntelImage['mime'] | null {
  if (bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

function safeRealFile(root: string, vaultRel: string): string | null {
  const abs = vaultAbsPath(root, vaultRel)
  if (!abs) return null
  try {
    const rootReal = realpathSync(root)
    const fileReal = realpathSync(abs)
    const fromRoot = relative(rootReal, fileReal)
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
      return null
    if (isAbsolute(fromRoot)) return null
    return fileReal
  } catch {
    return null
  }
}

/**
 * Read at most two small PNG/JPEG assets inside the vault. The helper never
 * follows remote/data URLs, and realpath checks reject symlinks outside the vault.
 */
export function loadVaultIntelImages(raw: string, assets: string[], vaultRoot: string): IntelImage[] {
  const candidates = [
    ...assets.flatMap((ref) => imageCandidates(ref)),
    ...findImages(raw).flatMap((image) => imageCandidates(image.src, 'inbox/_capture.md'))
  ]
  const seen = new Set<string>()
  const images: IntelImage[] = []
  let totalBytes = 0
  for (const candidate of candidates) {
    const vaultRel = assetPathFromUrl(candidate)
    if (!vaultRel) continue
    const file = safeRealFile(vaultRoot, vaultRel)
    if (!file || seen.has(file)) continue
    seen.add(file)
    try {
      const stat = statSync(file)
      if (!stat.isFile() || stat.size <= 0 || stat.size > INTEL_MAX_IMAGE_BYTES) continue
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) continue
      const bytes = readFileSync(file)
      const mime = mimeFor(bytes)
      if (!mime) continue
      images.push({ mime, data: bytes.toString('base64') })
      totalBytes += bytes.length
      if (images.length >= INTEL_MAX_IMAGES) return images
    } catch {
      // Missing, unreadable or unsupported assets are left for the rules fallback.
    }
  }
  return images
}
