import * as FileSystem from 'expo-file-system/legacy'
import { File, FileMode } from 'expo-file-system'
import * as Application from 'expo-application'
import * as IntentLauncher from 'expo-intent-launcher'
import { downloadApk, sha256Chunks } from './apkDownload'
import { compareVersions, pickRelease, updateFor, type GhRelease, type PickOptions, type Release } from './releases'

/**
 * In-app updates from GitHub Releases — no Play Store, no EAS.
 *
 * CI (`.github/workflows/android-release.yml`) publishes a signed APK on every
 * `android-v*` tag. The app reads the public Releases API, compares versions,
 * downloads the APK into cache, and hands it to Android's package installer
 * (the user taps Install once; Android asks to allow "install unknown apps"
 * the first time). Same signing key, so it updates in place and keeps data.
 * Which release to offer (stable only, or test builds too) is decided in ./releases.
 */

const REPO = 'PylotLight/Inkfish'

export { compareVersions, type Release } from './releases'

export function currentVersion(): string {
  return Application.nativeApplicationVersion ?? '0.0.0'
}

async function fetchReleases(): Promise<GhRelease[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  return (await res.json()) as GhRelease[]
}

/**
 * Newest published Android release (null when none). Test builds (pre-releases, X.Y.Z-beta.N)
 * only with `includePrereleases` ("Beta updates" in Settings). Throws on network errors.
 */
export async function latestRelease(opts: PickOptions = { includePrereleases: false }): Promise<Release | null> {
  return pickRelease(await fetchReleases(), opts)
}

/** The newer release, or null when this build is current. */
export async function checkForUpdate(opts: PickOptions = { includePrereleases: false }): Promise<Release | null> {
  return updateFor(await fetchReleases(), currentVersion(), opts)
}

/** Download the APK with bounded byte-range retries, integrity checks, and safe promotion. */
export async function downloadUpdate(r: Release, onProgress: (p: number) => void): Promise<string> {
  const cache = FileSystem.cacheDirectory
  if (!cache) throw new Error('Android cache directory is unavailable')
  const dest = `${cache}Inkfish-${r.version}.apk`
  const partial = `${dest}.part`

  return downloadApk(
    r,
    partial,
    dest,
    {
      getInfo: (uri) => FileSystem.getInfoAsync(uri),
      delete: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
      move: (from, to) => FileSystem.moveAsync({ from, to }),
      sha256: async (uri) => {
        const handle = new File(uri).open(FileMode.ReadOnly)
        try {
          return await sha256Chunks(() => handle.readBytes(1024 * 1024))
        } finally {
          handle.close()
        }
      },
      download: async (url, destination, resumeData, progress) => {
        const task = FileSystem.createDownloadResumable(
          url,
          destination,
          {},
          (p) => {
            const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : r.apkSize
            if (total > 0) progress(Math.max(0, Math.min(1, p.totalBytesWritten / total)))
          },
          resumeData
        )
        const result = await task.downloadAsync()
        return result ? { uri: result.uri, status: result.status, headers: result.headers } : undefined
      }
    },
    onProgress
  )
}

/** Open Android's installer on the downloaded APK. */
export async function installUpdate(fileUri: string): Promise<void> {
  const contentUri = await FileSystem.getContentUriAsync(fileUri)
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: 1 // FLAG_GRANT_READ_URI_PERMISSION
  })
}

/** Remove downloaded APKs and partials older than (or equal to) the running version. */
export async function cleanOldDownloads(): Promise<void> {
  const dir = FileSystem.cacheDirectory
  if (!dir) return
  try {
    for (const f of await FileSystem.readDirectoryAsync(dir)) {
      const m = /^Inkfish-(.+)\.apk(?:\.part)?$/.exec(f)
      if (m?.[1] && compareVersions(m[1], currentVersion()) <= 0)
        await FileSystem.deleteAsync(`${dir}${f}`, { idempotent: true })
    }
  } catch {
    // cache cleanup is best-effort
  }
}
