export interface PendingImageAttachment {
  uri: string
  fileName?: string | null
  mimeType?: string | null
}

export type ImagePickerResultLike =
  { canceled: true; assets: null } | { canceled: false; assets: PendingImageAttachment[] }

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp'
}
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])

export function imageAttachmentsFromPickerResult(result: ImagePickerResultLike): PendingImageAttachment[] {
  if (result.canceled) return []
  return result.assets.map(({ uri, fileName, mimeType }) => ({ uri, fileName, mimeType }))
}

export function imageExtension(image: PendingImageAttachment): string {
  const mimeType = image.mimeType?.split(';')[0]?.toLowerCase()
  if (mimeType && EXTENSION_BY_MIME[mimeType]) return EXTENSION_BY_MIME[mimeType]!

  for (const candidate of [image.fileName, image.uri]) {
    if (!candidate) continue
    const path = candidate.split(/[?#]/, 1)[0] ?? candidate
    const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
    if (extension && IMAGE_EXTENSIONS.has(extension)) return `.${extension === 'jpeg' ? 'jpg' : extension}`
  }
  return '.jpg'
}

export function markdownImageRefs(paths: readonly string[]): string {
  return paths.map((path) => `![](${path})`).join('\n')
}

export function appendMarkdownImageRefs(text: string, paths: readonly string[]): string {
  return [text.trim(), markdownImageRefs(paths)].filter(Boolean).join('\n')
}
