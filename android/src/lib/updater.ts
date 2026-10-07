import * as FileSystem from 'expo-file-system/legacy';
import * as Application from 'expo-application';
import * as IntentLauncher from 'expo-intent-launcher';

/**
 * In-app updates from GitHub Releases — no Play Store, no EAS.
 *
 * CI (`.github/workflows/android-release.yml`) publishes a signed APK on every
 * `android-v*` tag. The app reads the public Releases API, compares versions,
 * downloads the APK into cache, and hands it to Android's package installer
 * (the user taps Install once; Android asks to allow "install unknown apps"
 * the first time). Same signing key, so it updates in place and keeps data.
 */

const REPO = 'PylotLight/Inkfish';
const TAG_PREFIX = 'android-v';

export interface Release {
  version: string;
  tag: string;
  notes: string;
  apkUrl: string;
  apkSize: number;
  publishedAt: string;
}

export function currentVersion(): string {
  return Application.nativeApplicationVersion ?? '0.0.0';
}

/** -1 / 0 / 1 for dotted numeric versions (`0.2.10` > `0.2.9`). Pre-release tails ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
  published_at: string;
  assets: GhAsset[];
}

/** Newest published Android release (null when none). Throws on network errors. */
export async function latestRelease(): Promise<Release | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const list = (await res.json()) as GhRelease[];
  const candidates = list
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(TAG_PREFIX))
    .map((r) => ({ r, apk: r.assets.find((a) => a.name.endsWith('.apk')) }))
    .filter((x): x is { r: GhRelease; apk: GhAsset } => !!x.apk)
    .sort((x, y) => compareVersions(y.r.tag_name.slice(TAG_PREFIX.length), x.r.tag_name.slice(TAG_PREFIX.length)));
  const top = candidates[0];
  if (!top) return null;
  return {
    version: top.r.tag_name.slice(TAG_PREFIX.length),
    tag: top.r.tag_name,
    notes: (top.r.body ?? '').trim(),
    apkUrl: top.apk.browser_download_url,
    apkSize: top.apk.size,
    publishedAt: top.r.published_at
  };
}

/** The newer release, or null when this build is current. */
export async function checkForUpdate(): Promise<Release | null> {
  const r = await latestRelease();
  return r && compareVersions(r.version, currentVersion()) > 0 ? r : null;
}

/** Download the APK (resumable, with progress 0–1). Returns the local file URI. */
export async function downloadUpdate(r: Release, onProgress: (p: number) => void): Promise<string> {
  const dest = `${FileSystem.cacheDirectory ?? ''}Inkfish-${r.version}.apk`;
  const have = await FileSystem.getInfoAsync(dest);
  if (have.exists && !have.isDirectory && have.size === r.apkSize) {
    onProgress(1);
    return dest;
  }
  const dl = FileSystem.createDownloadResumable(r.apkUrl, dest, {}, (p) => {
    const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : r.apkSize;
    if (total > 0) onProgress(Math.min(1, p.totalBytesWritten / total));
  });
  const out = await dl.downloadAsync();
  if (!out || out.status !== 200) throw new Error(`Download failed (${out?.status ?? 'no response'})`);
  return out.uri;
}

/** Open Android's installer on the downloaded APK. */
export async function installUpdate(fileUri: string): Promise<void> {
  const contentUri = await FileSystem.getContentUriAsync(fileUri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: 1 // FLAG_GRANT_READ_URI_PERMISSION
  });
}

/** Remove downloaded APKs older than (or equal to) the running version. */
export async function cleanOldDownloads(): Promise<void> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return;
  try {
    for (const f of await FileSystem.readDirectoryAsync(dir)) {
      const m = /^Inkfish-(.+)\.apk$/.exec(f);
      if (m?.[1] && compareVersions(m[1], currentVersion()) <= 0) await FileSystem.deleteAsync(`${dir}${f}`, { idempotent: true });
    }
  } catch {
    // cache cleanup is best-effort
  }
}
