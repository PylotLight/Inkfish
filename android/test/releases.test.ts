import { describe, expect, test } from 'bun:test'
import { compareVersions, pickRelease, updateFor, type GhRelease } from '../src/lib/releases'

const rel = (tag: string, opts: Partial<GhRelease> = {}): GhRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes('-beta') || tag.includes('-rc'),
  body: `notes for ${tag}`,
  published_at: '2026-10-20T00:00:00Z',
  assets: [
    {
      name: `Inkfish-android-${tag.replace('android-v', '')}.apk`,
      browser_download_url: `https://example.test/${tag}.apk`,
      size: 1
    }
  ],
  ...opts
})

// What the Releases API returns: Mac + Android, stable + test builds, newest first.
const feed: GhRelease[] = [
  rel('v0.2.15-beta.1'),
  rel('android-v0.2.8-beta.2'),
  rel('android-v0.2.8-beta.1'),
  rel('v0.2.14'),
  rel('android-v0.2.7'),
  rel('android-v0.2.6')
]
const stable = { includePrereleases: false }
const beta = { includePrereleases: true }

describe('version order (SemVer 2.0, same as the Mac)', () => {
  test('betas sort below their release, numerically', () => {
    expect(compareVersions('0.2.8-beta.1', '0.2.8')).toBe(-1)
    expect(compareVersions('0.2.8', '0.2.8-beta.1')).toBe(1)
    expect(compareVersions('0.2.8-beta.2', '0.2.8-beta.10')).toBe(-1)
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('0.2.8-beta.1', '0.2.7')).toBe(1)
    expect(compareVersions('0.2.8', '0.2.8')).toBe(0)
  })
})

describe('which release a phone is offered', () => {
  test('stable phones never see test builds', () => {
    expect(pickRelease(feed, stable)?.version).toBe('0.2.7')
    expect(updateFor(feed, '0.2.6', stable)?.version).toBe('0.2.7')
    expect(updateFor(feed, '0.2.7', stable)).toBeNull()
  })
  test('stable Android releases remain eligible when GitHub marks them as pre-releases', () => {
    const r = pickRelease([rel('android-v0.2.9', { prerelease: true }), ...feed], stable)!
    expect(r.version).toBe('0.2.9')
    expect(r.prerelease).toBe(false)
  })
  test('Android beta version suffixes stay hidden by default even if GitHub marks them stable', () => {
    const betaRelease = rel('android-v0.2.9-beta.1', { prerelease: false })
    expect(pickRelease([betaRelease], stable)).toBeNull()
  })
  test('Android beta version suffixes are offered when Beta updates are enabled', () => {
    const betaRelease = rel('android-v0.2.9-beta.1', { prerelease: false })
    const r = pickRelease([betaRelease], beta)!
    expect(r.version).toBe('0.2.9-beta.1')
    expect(r.prerelease).toBe(true)
  })
  test('beta updates on: newest including test builds', () => {
    const r = updateFor(feed, '0.2.7', beta)!
    expect(r.version).toBe('0.2.8-beta.2')
    expect(r.prerelease).toBe(true)
    expect(r.apkUrl).toBe('https://example.test/android-v0.2.8-beta.2.apk')
    expect(updateFor(feed, '0.2.8-beta.1', beta)?.version).toBe('0.2.8-beta.2')
  })
  test('on a beta with beta updates off: nothing until the final ships, then the final', () => {
    expect(updateFor(feed, '0.2.8-beta.2', stable)).toBeNull() // 0.2.7 is older, no downgrade
    const shipped = [rel('android-v0.2.8'), ...feed]
    const r = updateFor(shipped, '0.2.8-beta.2', stable)!
    expect(r.version).toBe('0.2.8')
    expect(r.prerelease).toBe(false)
    expect(updateFor(shipped, '0.2.8-beta.2', beta)?.version).toBe('0.2.8') // final beats its betas
  })
  test('Mac tags, drafts, junk tags and releases without an APK are ignored', () => {
    const noisy = [
      rel('v9.9.9'),
      rel('android-v9.0.0', { draft: true }),
      rel('android-vnext'),
      rel('android-v8.0.0', { assets: [] }),
      ...feed
    ]
    expect(pickRelease(noisy, beta)?.version).toBe('0.2.8-beta.2')
  })
})
