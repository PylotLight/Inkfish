import { clipboard, ClipboardItem, ipcMain, nativeImage, net, shell, type IpcMainInvokeEvent } from 'electron'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { imageMime, imageSourceOf, nativelyDecodable, type ImageSource } from '../shared/images'
import { vaultAbsPath } from './image-path'
import { resolveVaultRoot, vaultConfigured } from './vault'

/**
 * Copy / locate / reveal for images rendered in the editor (right-click menu
 * and click-select + ⌘C on live-preview image widgets).
 *
 * The renderer passes the URL the picture actually loaded from (`asset://vault/…`,
 * http(s), or a data URL). PNG goes straight to the system clipboard, JPEG via
 * nativeImage → PNG; other formats (gif/webp/…) come back as bytes for the
 * renderer to re-encode as PNG through a canvas (Chromium decodes them all),
 * then land here again through `images:copy-png`. Everything is written as
 * `image/png` through Electron 45's W3C-style `clipboard.write`.
 */

/** Largest image we'll copy (bytes). */
const MAX_BYTES = 40 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

export type CopyImageResult =
  | { ok: true }
  | { ok: false; error: string }
  /** Not decodable by nativeImage: renderer re-encodes `data` (base64) and calls copy-png. */
  | { ok: false; decode: { mime: string; data: string } }

/** Electron 45 clipboard (W3C-style): one atomic write of a PNG. */
async function writePng(png: Buffer): Promise<void> {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

function vaultFile(rel: string): string | null {
  if (!vaultConfigured()) return null
  return vaultAbsPath(resolveVaultRoot(), rel)
}

async function loadBytes(src: ImageSource): Promise<{ bytes: Buffer; name: string; contentType?: string }> {
  if (src.kind === 'vault') {
    const abs = vaultFile(src.rel)
    if (!abs || !existsSync(abs)) throw new Error('image file not found')
    return { bytes: await readFile(abs), name: abs }
  }
  if (src.kind === 'data') {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src.url)
    if (!m) throw new Error('bad data URL')
    const body = m[3] ?? ''
    const bytes = m[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body))
    return { bytes, name: '', contentType: m[1] }
  }
  const res = await net.fetch(src.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new Error('image too large')
  const bytes = Buffer.from(await res.arrayBuffer())
  return { bytes, name: new URL(src.url).pathname, contentType: res.headers.get('content-type') ?? undefined }
}

export async function copyImageFromUrl(url: string): Promise<CopyImageResult> {
  const src = imageSourceOf(url)
  if (!src) return { ok: false, error: 'unsupported image source' }
  try {
    const { bytes, name, contentType } = await loadBytes(src)
    if (bytes.length === 0) return { ok: false, error: 'empty image' }
    if (bytes.length > MAX_BYTES) return { ok: false, error: 'image too large' }
    const sniffed = imageMime(name, bytes)
    const mime = sniffed ?? (contentType?.startsWith('image/') ? (contentType.split(';')[0] ?? '').trim() : null)
    if (!mime) return { ok: false, error: 'not an image' }
    if (mime === 'image/png') {
      await writePng(bytes)
      return { ok: true }
    }
    if (nativelyDecodable(mime)) {
      // JPEG → PNG: what every paste target (Slack, Preview, Docs…) reads.
      const img = nativeImage.createFromBuffer(bytes)
      if (!img.isEmpty()) {
        await writePng(img.toPNG())
        return { ok: true }
      }
    }
    return { ok: false, decode: { mime, data: bytes.toString('base64') } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerImageClipboardIpc(): void {
  ipcMain.handle('images:copy', (_e: IpcMainInvokeEvent, url: string): Promise<CopyImageResult> =>
    copyImageFromUrl(url)
  )
  /** PNG data URL re-encoded by the renderer (gif/webp/… path). */
  ipcMain.handle('images:copy-png', async (_e: IpcMainInvokeEvent, dataUrl: string): Promise<boolean> => {
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return false
    const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
    if (png.length === 0 || imageMime('', png) !== 'image/png') return false
    await writePng(png)
    return true
  })
  /** Absolute file path for a vault image URL (null for remote / missing). */
  ipcMain.handle('images:locate', (_e: IpcMainInvokeEvent, url: string): string | null => {
    const src = imageSourceOf(url)
    if (src?.kind !== 'vault') return null
    const abs = vaultFile(src.rel)
    return abs && existsSync(abs) ? abs : null
  })
  ipcMain.handle('images:reveal', (_e: IpcMainInvokeEvent, url: string): boolean => {
    const src = imageSourceOf(url)
    if (src?.kind !== 'vault') return false
    const abs = vaultFile(src.rel)
    if (!abs || !existsSync(abs)) return false
    shell.showItemInFolder(abs)
    return true
  })
  ipcMain.handle('clipboard:write-text', async (_e: IpcMainInvokeEvent, text: string): Promise<boolean> => {
    if (typeof text !== 'string') return false
    await clipboard.writeText(text)
    return true
  })
}
