import { sha256 } from '@noble/hashes/sha2.js'

export interface ApkReleaseAsset {
  version: string
  apkUrl: string
  apkSize: number
  apkSha256?: string
}

export interface ApkFileInfo {
  exists: boolean
  isDirectory?: boolean
  size?: number
}

export interface ApkDownloadResult {
  uri: string
  status: number
  headers?: Record<string, string>
}

export interface ApkDownloadAdapter {
  getInfo: (uri: string) => Promise<ApkFileInfo>
  delete: (uri: string) => Promise<void>
  move: (from: string, to: string) => Promise<void>
  sha256: (uri: string) => Promise<string>
  download: (
    url: string,
    destination: string,
    resumeData: string | undefined,
    onProgress: (progress: number) => void
  ) => Promise<ApkDownloadResult | undefined>
  sleep?: (milliseconds: number) => Promise<void>
}

export const APK_DOWNLOAD_ATTEMPTS = 4

export async function sha256Chunks(readNext: () => Promise<Uint8Array>): Promise<string> {
  const hash = sha256.create()
  while (true) {
    const bytes = await readNext()
    if (bytes.length === 0) break
    hash.update(bytes)
  }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Download failed (HTTP ${status})`)
  }
}

function validDigest(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!/^[\da-f]{64}$/i.test(value)) throw new Error('Invalid SHA-256 digest in release metadata')
  return value.toLowerCase()
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

function validContentRange(value: string | undefined, offset: number, expectedSize: number): boolean {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value ?? '')
  if (!match || Number(match[1]) !== offset) return false
  const end = Number(match[2])
  if (end < offset) return false
  const total = match[3]
  return total === '*' || Number(total) === expectedSize
}

function waitBeforeRetry(adapter: ApkDownloadAdapter, failedAttempt: number): Promise<void> {
  const delay = 500 * 2 ** (failedAttempt - 1)
  return adapter.sleep ? adapter.sleep(delay) : new Promise((resolve) => setTimeout(resolve, delay))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resume an interrupted Android APK download into a `.part` file. A partial is promoted
 * only after HTTP/range, exact-size, and (when published by GitHub) SHA-256 checks pass.
 * Expo's legacy Android downloader appends when resumeData is supplied, even if a server
 * ignores Range; this function detects that 200 response and discards the mixed file.
 */
export async function downloadApk(
  asset: ApkReleaseAsset,
  partUri: string,
  finalUri: string,
  adapter: ApkDownloadAdapter,
  onProgress: (progress: number) => void
): Promise<string> {
  if (!Number.isSafeInteger(asset.apkSize) || asset.apkSize <= 0)
    throw new Error('Invalid APK size in release metadata')
  const expectedSha256 = validDigest(asset.apkSha256)
  const reportProgress = (progress: number): void => {
    onProgress(Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0)
  }

  const info = async (uri: string): Promise<ApkFileInfo> => {
    const result = await adapter.getInfo(uri)
    return result.exists && !result.isDirectory ? result : { exists: false }
  }
  const isTrustedCompleteFile = async (uri: string): Promise<boolean> => {
    const file = await info(uri)
    if (!file.exists || file.size !== asset.apkSize || !expectedSha256) return false
    return (await adapter.sha256(uri)).toLowerCase() === expectedSha256
  }
  const promote = async (): Promise<string> => {
    const existing = await info(finalUri)
    if (existing.exists) await adapter.delete(finalUri)
    await adapter.move(partUri, finalUri)
    reportProgress(1)
    return finalUri
  }

  if (await isTrustedCompleteFile(finalUri)) {
    reportProgress(1)
    return finalUri
  }
  const oldFinal = await info(finalUri)
  if (oldFinal.exists) await adapter.delete(finalUri)

  let lastError: unknown = new Error('Download did not complete')
  for (let attempt = 1; attempt <= APK_DOWNLOAD_ATTEMPTS; attempt++) {
    const part = await info(partUri)
    let offset = part.exists ? (part.size ?? 0) : 0

    if (offset === asset.apkSize && (await isTrustedCompleteFile(partUri))) return await promote()
    if (offset <= 0 || offset >= asset.apkSize) {
      if (part.exists) await adapter.delete(partUri)
      offset = 0
    }

    try {
      const resumeData = offset > 0 ? String(offset) : undefined
      const result = await adapter.download(asset.apkUrl, partUri, resumeData, reportProgress)
      if (!result) throw new Error('Download was cancelled before it completed')

      if (resumeData && result.status === 200) {
        // The legacy native downloader appends the whole 200 body to an existing partial.
        // Never keep that mixed file; retry from byte zero instead.
        await adapter.delete(partUri)
        reportProgress(0)
        throw new Error('Server ignored the byte-range request; restarting the download')
      }
      if (resumeData && result.status === 206) {
        if (!validContentRange(header(result.headers, 'content-range'), offset, asset.apkSize)) {
          await adapter.delete(partUri)
          throw new Error('Server returned an invalid byte range; restarting the download')
        }
      } else if ((!resumeData && result.status !== 200) || (resumeData && result.status !== 206)) {
        await adapter.delete(partUri)
        throw new HttpStatusError(result.status)
      }

      const completedPart = await info(partUri)
      const size = completedPart.size ?? 0
      if (size > asset.apkSize) {
        await adapter.delete(partUri)
        reportProgress(0)
        throw new Error(`Downloaded APK is larger than expected (${size} of ${asset.apkSize} bytes)`)
      }
      if (size < asset.apkSize) {
        lastError = new Error(`Download stopped at ${size} of ${asset.apkSize} bytes`)
        if (attempt < APK_DOWNLOAD_ATTEMPTS) await waitBeforeRetry(adapter, attempt)
        continue
      }

      if (expectedSha256 && (await adapter.sha256(partUri)).toLowerCase() !== expectedSha256) {
        await adapter.delete(partUri)
        reportProgress(0)
        throw new Error('Downloaded APK failed its SHA-256 integrity check')
      }
      return await promote()
    } catch (error) {
      lastError = error
      const permanentHttpError =
        error instanceof HttpStatusError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 416, 429].includes(error.status)
      if (permanentHttpError) {
        const remaining = await info(partUri)
        if (remaining.exists) await adapter.delete(partUri)
        throw error
      }
      if (attempt < APK_DOWNLOAD_ATTEMPTS) await waitBeforeRetry(adapter, attempt)
    }
  }

  const remaining = await info(partUri)
  if (!remaining.exists || !remaining.size) {
    if (remaining.exists) await adapter.delete(partUri)
    throw new Error(`Download failed after ${APK_DOWNLOAD_ATTEMPTS} attempts: ${errorMessage(lastError)}`)
  }
  if ((remaining.size ?? 0) >= asset.apkSize) await adapter.delete(partUri)
  throw new Error(
    `Download interrupted after ${APK_DOWNLOAD_ATTEMPTS} attempts; ${remaining.size ?? 0} of ${asset.apkSize} bytes remain saved to resume. ${errorMessage(lastError)}`
  )
}
