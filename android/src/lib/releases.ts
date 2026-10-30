import { compareSemver, isPrereleaseVersion, parseSemver } from '../../../src/shared/update-feed'

/**
 * Which GitHub release the phone should offer. Pure (no Expo), so it's unit-tested in
 * android/test/releases.test.ts. Uses the same SemVer 2.0 ordering as the Mac
 * (src/shared/update-feed.ts): 0.2.8-beta.1 < 0.2.8-beta.2 < 0.2.8 < 0.2.9.
 *
 * Android beta builds (`release.ts --pre` → android-vX.Y.Z-beta.N) are only considered
 * with "Beta updates" on. The Android workflow marks every Android release as a GitHub
 * pre-release to protect the desktop `/releases/latest`; the SemVer suffix alone selects
 * Android's beta channel.
 */

export const TAG_PREFIX = 'android-v'

export interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}
export interface GhRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  body: string | null
  published_at: string
  assets: GhAsset[]
}

export interface Release {
  version: string
  tag: string
  notes: string
  apkUrl: string
  apkSize: number
  publishedAt: string
  /** An Android test build with a SemVer prerelease suffix, such as X.Y.Z-beta.N. */
  prerelease: boolean
}

export interface PickOptions {
  /** "Beta updates" on: also offer test builds. */
  includePrereleases: boolean
}

/** -1 / 0 / 1, SemVer 2.0 (`0.2.10` > `0.2.9`, `0.2.8-beta.1` < `0.2.8`). Unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  return compareSemver(a, b)
}

/** Newest Android release with an APK the user should be offered (null when none). */
export function pickRelease(list: readonly GhRelease[], opts: PickOptions): Release | null {
  let best: { r: GhRelease; apk: GhAsset; version: string; pre: boolean } | null = null
  for (const r of list) {
    if (r.draft || !r.tag_name.startsWith(TAG_PREFIX)) continue
    const version = r.tag_name.slice(TAG_PREFIX.length)
    if (!parseSemver(version)) continue
    const pre = isPrereleaseVersion(version)
    if (pre && !opts.includePrereleases) continue
    const apk = r.assets.find((a) => a.name.endsWith('.apk'))
    if (!apk) continue
    if (!best || compareSemver(version, best.version) > 0) best = { r, apk, version, pre }
  }
  if (!best) return null
  return {
    version: best.version,
    tag: best.r.tag_name,
    notes: (best.r.body ?? '').trim(),
    apkUrl: best.apk.browser_download_url,
    apkSize: best.apk.size,
    publishedAt: best.r.published_at,
    prerelease: best.pre
  }
}

/** The release to offer over `current`, or null when this build is as new or newer. */
export function updateFor(list: readonly GhRelease[], current: string, opts: PickOptions): Release | null {
  const r = pickRelease(list, opts)
  return r && compareSemver(r.version, current) > 0 ? r : null
}
