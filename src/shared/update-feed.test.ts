import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_UPDATE_FEED_URL,
  DEFAULT_UPDATE_PREFERENCES,
  INVALID_FEED_URL_MESSAGE,
  applyUpdateSettings,
  compareSemver,
  decideUpdate,
  describeFeedHttpFailure,
  effectiveFeedUrl,
  isUpdateCheckDue,
  normalizeFeedUrl,
  parseReleaseFeed,
  parseSemver,
  parseUpdatePreferences,
  pickLatestRelease,
  redactFeedUrl,
  releaseAssetCandidates,
  releaseNotesToText,
  toReleaseInfo,
  UPDATE_CHECK_INTERVAL_MS,
  type ReleaseFeedEntry,
  type UpdatePreferences
} from './update-feed'

const fixture = readFileSync(join(import.meta.dir, 'fixtures', 'inkfish-releases.atom'), 'utf8')
const NOW = 1_800_000_000_000
const prefs = (patch: Partial<UpdatePreferences> = {}): UpdatePreferences => ({ ...DEFAULT_UPDATE_PREFERENCES, ...patch })
const entry = (version: string): ReleaseFeedEntry => ({ tag: `v${version}`, version, title: version, updated: '', link: '', contentHtml: '' })

describe('feed parsing', () => {
  test('reads the Inkfish releases feed and skips Android tags', () => {
    const entries = parseReleaseFeed(fixture)
    expect(entries.map((e) => e.tag)).toEqual(['v0.2.5', 'v0.2.4'])
    const latest = pickLatestRelease(entries, { includePrereleases: false })!
    expect(latest.version).toBe('0.2.5')
    expect(latest.link).toBe('https://github.com/PylotLight/Inkfish/releases/tag/v0.2.5')
    const notes = toReleaseInfo(latest).notes
    expect(notes).toContain('## [0.2.5]')
    expect(notes).toContain('• ')
    expect(notes).not.toContain('<')
  })
  test('rejects documents that are not Atom feeds', () => {
    expect(() => parseReleaseFeed('<html></html>')).toThrow()
  })
  test('release notes drop scripts and tags', () => {
    expect(releaseNotesToText('<h2>New</h2><ul><li>a &amp; b</li></ul><script>alert(1)</script>')).toBe('## New\n• a & b')
  })
})

describe('semver', () => {
  test('parse + SemVer 2.0 precedence', () => {
    expect(parseSemver('v1.2.3-beta.1+build')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['beta', 1] })
    expect(parseSemver('android-v0.2.4')).toBeNull()
    expect(compareSemver('0.2.10', '0.2.9')).toBe(1)
    expect(compareSemver('0.3.0-beta.1', '0.3.0')).toBe(-1)
    expect(compareSemver('0.3.0-beta.2', '0.3.0-beta.10')).toBe(-1)
  })
  test('pre-releases only on the beta channel', () => {
    const entries = [entry('0.2.5'), entry('0.3.0-beta.1')]
    expect(pickLatestRelease(entries, { includePrereleases: false })!.version).toBe('0.2.5')
    expect(pickLatestRelease(entries, { includePrereleases: true })!.version).toBe('0.3.0-beta.1')
  })
})

describe('decideUpdate', () => {
  test('newer / same / older', () => {
    expect(decideUpdate('0.2.6', '0.2.5', prefs(), NOW)).toMatchObject({ updateAvailable: true, showBadge: true, notify: true })
    expect(decideUpdate('0.2.5', '0.2.5', prefs(), NOW).updateAvailable).toBe(false)
    expect(decideUpdate('0.2.4', '0.2.5', prefs(), NOW).updateAvailable).toBe(false)
  })
  test('skip hides only that version', () => {
    expect(decideUpdate('0.2.6', '0.2.5', prefs({ skippedVersion: '0.2.6' }), NOW)).toMatchObject({ skipped: true, showBadge: false, notify: false })
    expect(decideUpdate('0.2.7', '0.2.5', prefs({ skippedVersion: '0.2.6' }), NOW).showBadge).toBe(true)
  })
  test('notify once per version; remind later snoozes then re-notifies', () => {
    expect(decideUpdate('0.2.6', '0.2.5', prefs({ notifiedVersion: '0.2.6' }), NOW)).toMatchObject({ showBadge: true, notify: false })
    const snoozed = prefs({ notifiedVersion: '0.2.6', remindLaterVersion: '0.2.6', remindAfter: NOW + 1000 })
    expect(decideUpdate('0.2.6', '0.2.5', snoozed, NOW)).toMatchObject({ snoozed: true, showBadge: false, notify: false })
    expect(decideUpdate('0.2.6', '0.2.5', snoozed, NOW + 2000)).toMatchObject({ snoozed: false, showBadge: true, notify: true })
  })
  test('scheduled checks are due after the interval', () => {
    expect(isUpdateCheckDue(null, NOW)).toBe(true)
    expect(isUpdateCheckDue(NOW - 1000, NOW)).toBe(false)
    expect(isUpdateCheckDue(NOW - UPDATE_CHECK_INTERVAL_MS, NOW)).toBe(true)
  })
})

describe('settings + feed URL', () => {
  test('http(s) only, blank means default', () => {
    expect(normalizeFeedUrl('')).toBe('')
    expect(normalizeFeedUrl(DEFAULT_UPDATE_FEED_URL)).toBe('')
    expect(normalizeFeedUrl('file:///etc/passwd')).toBeNull()
    expect(effectiveFeedUrl(prefs())).toBe('https://github.com/PylotLight/Inkfish/releases.atom')
    expect(redactFeedUrl('https://u:p@nas.local/f.atom?token=x')).toBe('https://nas.local/f.atom?…')
  })
  test('bad input is a validation result, never a throw', () => {
    expect(applyUpdateSettings(prefs(), { feedUrl: 'ftp://x' })).toEqual({ ok: false, error: INVALID_FEED_URL_MESSAGE })
    expect(applyUpdateSettings(prefs(), null).ok).toBe(false)
    const r = applyUpdateSettings(prefs(), { betaChannel: true })
    expect(r.ok && r.changed && r.preferences.betaChannel).toBe(true)
  })
  test('GitHub 404 means private repo', () => {
    expect(describeFeedHttpFailure(404, DEFAULT_UPDATE_FEED_URL).message).toBe('Update check unavailable (repo private)')
    expect(describeFeedHttpFailure(500, DEFAULT_UPDATE_FEED_URL).status).toBe('error')
  })
  test('asset candidates follow the electron-builder artifact name on macOS', () => {
    expect(releaseAssetCandidates('https://github.com/PylotLight/Inkfish/releases/tag/v0.2.5', '0.2.5', 'darwin', 'arm64')).toEqual([
      'https://github.com/PylotLight/Inkfish/releases/download/v0.2.5/Inkfish-0.2.5-mac-arm64.dmg',
      'https://github.com/PylotLight/Inkfish/releases/download/v0.2.5/Inkfish-0.2.5-mac-arm64.zip'
    ])
    expect(releaseAssetCandidates('https://github.com/PylotLight/Inkfish/releases/tag/v0.2.5', '0.2.5', 'linux', 'x64')).toEqual([])
  })
  test('preferences parse defensively', () => {
    expect(parseUpdatePreferences(null)).toEqual(DEFAULT_UPDATE_PREFERENCES)
    expect(parseUpdatePreferences({ feedUrl: 'ftp://x', betaChannel: 'yes', skippedVersion: 'v0.2.5', remindAfter: -5, lastChecked: NOW })).toEqual(
      prefs({ skippedVersion: '0.2.5', lastChecked: NOW })
    )
  })
})
