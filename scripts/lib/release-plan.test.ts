import { describe, expect, test } from 'bun:test'
import {
  appsForPath,
  baseVersion,
  bumpVersion,
  changesFor,
  cmpSemver,
  formatSummary,
  latestTag,
  nextPreNumber,
  nextVersion,
  openPrerelease,
  parseReleaseArgs,
  suggestApps,
  testedWithLine,
  versionOfTag,
  type AppChanges
} from './release-plan'

describe('appsForPath', () => {
  test('android/** is android only', () => {
    expect(appsForPath('android/src/lib/syncing.tsx')).toEqual(['android'])
    expect(appsForPath('android/package.json')).toEqual(['android'])
  })
  test('src/shared/** is both', () => {
    expect(appsForPath('src/shared/sync/protocol.ts')).toEqual(['desktop', 'android'])
    expect(appsForPath('src/shared/tags.ts')).toEqual(['desktop', 'android'])
  })
  test('everything else that ships is desktop', () => {
    for (const p of [
      'src/main/sync.ts',
      'src/renderer/src/App.tsx',
      'stt/Sources/main.swift',
      'packages/cli/bin/inkfish.mjs',
      'package.json',
      'bun.lock'
    ])
      expect(appsForPath(p)).toEqual(['desktop'])
  })
  test('docs, tests, markdown, casks, CI and the release tooling need no release', () => {
    for (const p of [
      'README.md',
      'android/README.md',
      'docs/sync.md',
      'Casks/inkfish.rb',
      '.github/workflows/android-release.yml',
      'src/shared/sync/compat.test.ts',
      'android/test/syncstatus.test.ts',
      'packages/cli/test/x.test.ts',
      'scripts/release.ts',
      'scripts/lib/release-plan.ts',
      'LICENSE'
    ])
      expect(appsForPath(p)).toEqual([])
  })
})

describe('tags', () => {
  const tags = [
    'v0.2.9',
    'v0.2.12',
    'v0.2.10',
    'android-v0.2.4',
    'android-v0.2.5',
    'android-v0.2.10-rc.1',
    'v0.3.0-beta.1',
    'nightly'
  ]
  test('v* never matches android-v*', () => {
    expect(versionOfTag('desktop', 'android-v0.2.5')).toBeNull()
    expect(versionOfTag('android', 'v0.2.5')).toBeNull()
    expect(versionOfTag('android', 'android-v0.2.5')).toBe('0.2.5')
  })
  test('latest by semver, not by string order, skipping pre-releases', () => {
    expect(latestTag('desktop', tags)).toBe('v0.2.12')
    expect(latestTag('android', tags)).toBe('android-v0.2.5')
    expect(latestTag('android', ['v1.0.0'])).toBeNull()
  })
  test('patch from each app’s own last tag', () => {
    expect(nextVersion('android', 'android-v0.2.5', 'patch')).toBe('0.2.6')
    expect(nextVersion('desktop', 'v0.2.12', 'patch')).toBe('0.2.13')
    expect(nextVersion('desktop', 'v0.2.12', 'minor')).toBe('0.3.0')
    expect(nextVersion('android', null, 'patch', '0.2.0')).toBe('0.2.1')
    expect(nextVersion('android', 'android-v0.2.5', '0.4.0')).toBe('0.4.0')
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
  })
})

describe('change detection', () => {
  const files = ['android/src/screens/NoteScreen.tsx', 'src/main/window.ts', 'docs/sync.md']
  test('each app only sees its own files', () => {
    expect(changesFor('android', 'android-v0.2.5', files)).toMatchObject({
      files: ['android/src/screens/NoteScreen.tsx'],
      sync: false
    })
    expect(changesFor('desktop', 'v0.2.12', files)).toMatchObject({ files: ['src/main/window.ts'], sync: false })
  })
  test('suggest only the apps that changed', () => {
    const c = (app: 'desktop' | 'android', fs: string[], lastTag: string | null = 'x'): AppChanges =>
      changesFor(app, lastTag, fs)
    expect(suggestApps([c('desktop', ['src/main/a.ts']), c('android', ['src/main/a.ts'])])).toEqual(['desktop'])
    expect(suggestApps([c('desktop', ['android/App.tsx']), c('android', ['android/App.tsx'])])).toEqual(['android'])
    expect(suggestApps([c('desktop', ['docs/a.md']), c('android', ['docs/a.md'])])).toEqual([])
  })
  test('src/shared/sync changes default to both', () => {
    const fs = ['src/shared/sync/engine.ts']
    const changes = [changesFor('desktop', 'v0.2.12', fs), changesFor('android', 'android-v0.2.5', fs)]
    expect(changes.every((c) => c.sync)).toBe(true)
    expect(suggestApps(changes)).toEqual(['desktop', 'android'])
    expect(formatSummary(changes, suggestApps(changes))).toContain('suggested: both (sync changed')
  })
  test('other shared code counts for both too, and a never-released app is suggested', () => {
    const fs = ['src/shared/tags.ts']
    expect(suggestApps([changesFor('desktop', 'v1', fs), changesFor('android', 'android-v1', fs)])).toEqual([
      'desktop',
      'android'
    ])
    expect(suggestApps([changesFor('desktop', 'v1', []), changesFor('android', null, [])])).toEqual(['android'])
  })
})

describe('args', () => {
  test('defaults: patch, ask which app', () => {
    expect(parseReleaseArgs([])).toEqual({
      version: 'patch',
      app: null,
      push: false,
      dryRun: false,
      yes: false,
      help: false,
      pre: null
    })
  })
  test('patch --app android|desktop|both, --app=, --yes for CI', () => {
    expect(parseReleaseArgs(['patch', '--app', 'android'])).toMatchObject({ version: 'patch', app: 'android' })
    expect(parseReleaseArgs(['--app=both', '--push', '--yes'])).toMatchObject({ app: 'both', push: true, yes: true })
    expect(parseReleaseArgs(['minor', '--app', 'desktop', '--dry-run'])).toMatchObject({
      version: 'minor',
      app: 'desktop',
      dryRun: true
    })
    expect(parseReleaseArgs(['--non-interactive'])).toMatchObject({ yes: true })
  })
  test('rejects nonsense', () => {
    expect(parseReleaseArgs(['--app', 'ios'])).toHaveProperty('error')
    expect(parseReleaseArgs(['huge'])).toHaveProperty('error')
    expect(parseReleaseArgs(['0.3.0', '--app', 'both'])).toHaveProperty('error')
    expect(parseReleaseArgs(['auto', '--app', 'android'])).toHaveProperty('error')
    expect(parseReleaseArgs(['--wat'])).toHaveProperty('error')
  })
  test('tested-with line', () => {
    expect(testedWithLine('android-v0.2.5')).toBe('tested with android-v0.2.5')
    expect(testedWithLine(null)).toBeNull()
  })
})

describe('pre-releases', () => {
  test('semver precedence: betas sort below their release, numerically', () => {
    expect(cmpSemver('0.2.15-beta.1', '0.2.15')).toBeLessThan(0)
    expect(cmpSemver('0.2.15', '0.2.15-beta.1')).toBeGreaterThan(0)
    expect(cmpSemver('0.2.15-beta.2', '0.2.15-beta.10')).toBeLessThan(0)
    expect(cmpSemver('0.2.15-beta.9', '0.2.14')).toBeGreaterThan(0)
    expect(cmpSemver('0.2.15-beta.1', '0.2.15-rc.1')).toBeLessThan(0)
    expect(cmpSemver('0.2.15-beta', '0.2.15-beta.1')).toBeLessThan(0)
    expect(cmpSemver('0.2.15-beta.1', '0.2.15-beta.1')).toBe(0)
    expect(baseVersion('0.2.15-beta.3')).toBe('0.2.15')
  })

  const stable = ['v0.2.14', 'android-v0.2.7']
  test('first --pre: patch bump + beta.1, per app', () => {
    expect(nextVersion('desktop', 'v0.2.14', 'patch', '0.2.14', { tags: stable, pre: 'beta' })).toBe('0.2.15-beta.1')
    expect(nextVersion('android', 'android-v0.2.7', 'patch', '0.0.0', { tags: stable, pre: 'beta' })).toBe(
      '0.2.8-beta.1'
    )
    expect(nextVersion('desktop', 'v0.2.14', 'minor', '0.2.14', { tags: stable, pre: 'beta' })).toBe('0.3.0-beta.1')
  })

  const open = [...stable, 'v0.2.15-beta.1', 'v0.2.15-beta.2', 'android-v0.2.8-beta.1']
  test('repeated --pre bumps the counter (and never collides across apps)', () => {
    expect(openPrerelease('desktop', open)).toBe('v0.2.15-beta.2')
    expect(openPrerelease('android', open)).toBe('android-v0.2.8-beta.1')
    expect(
      nextVersion('desktop', latestTag('desktop', open), 'patch', '0.2.15-beta.2', { tags: open, pre: 'beta' })
    ).toBe('0.2.15-beta.3')
    expect(nextVersion('android', latestTag('android', open), 'patch', '0.0.0', { tags: open, pre: 'beta' })).toBe(
      '0.2.8-beta.2'
    )
    expect(nextPreNumber('desktop', '0.2.15', 'beta', [...open, 'v0.2.15-beta.10'])).toBe(11)
    expect(nextPreNumber('desktop', '0.2.15', 'rc', open)).toBe(1)
  })

  test('a normal release after betas ships the final version', () => {
    expect(latestTag('desktop', open)).toBe('v0.2.14') // change detection still runs from the last stable tag
    expect(nextVersion('desktop', 'v0.2.14', 'patch', '0.2.15-beta.2', { tags: open })).toBe('0.2.15')
    expect(nextVersion('android', 'android-v0.2.7', 'patch', '0.0.0', { tags: open })).toBe('0.2.8')
  })

  test('a bigger bump goes past the open beta', () => {
    expect(nextVersion('desktop', 'v0.2.14', 'minor', '0.2.14', { tags: open })).toBe('0.3.0')
    expect(nextVersion('desktop', 'v0.2.14', 'minor', '0.2.14', { tags: open, pre: 'beta' })).toBe('0.3.0-beta.1')
    // an open minor beta wins over a patch bump
    expect(nextVersion('desktop', 'v0.2.14', 'patch', '0.2.14', { tags: ['v0.2.14', 'v0.3.0-beta.1'] })).toBe('0.3.0')
  })

  test('once the final ships, its betas are closed', () => {
    const shipped = [...open, 'v0.2.15']
    expect(openPrerelease('desktop', shipped)).toBeNull()
    expect(
      nextVersion('desktop', latestTag('desktop', shipped), 'patch', '0.2.15', { tags: shipped, pre: 'beta' })
    ).toBe('0.2.16-beta.1')
    expect(nextVersion('desktop', latestTag('desktop', shipped), 'patch', '0.2.15', { tags: shipped })).toBe('0.2.16')
  })

  test('explicit versions', () => {
    expect(nextVersion('desktop', 'v0.2.14', '0.4.0', '0.2.14', { tags: open, pre: 'beta' })).toBe('0.4.0-beta.1')
    expect(nextVersion('desktop', 'v0.2.14', '0.2.15', '0.2.14', { tags: open, pre: 'beta' })).toBe('0.2.15-beta.3')
    expect(nextVersion('desktop', 'v0.2.14', '0.4.0-rc.7', '0.2.14', { tags: open })).toBe('0.4.0-rc.7')
  })

  test('args: --pre, --pre=rc, prerelease keyword', () => {
    expect(parseReleaseArgs(['patch', '--app', 'both', '--pre', '--yes'])).toMatchObject({
      version: 'patch',
      app: 'both',
      pre: 'beta',
      yes: true
    })
    expect(parseReleaseArgs(['--prerelease'])).toMatchObject({ pre: 'beta' })
    expect(parseReleaseArgs(['--pre=rc', '--app=desktop'])).toMatchObject({ pre: 'rc', app: 'desktop' })
    expect(parseReleaseArgs(['prerelease', '--app', 'android'])).toMatchObject({
      version: 'patch',
      pre: 'beta',
      app: 'android'
    })
    expect(parseReleaseArgs(['prerelease', 'minor'])).toMatchObject({ version: 'minor', pre: 'beta' })
    expect(parseReleaseArgs(['--pre=1x'])).toHaveProperty('error')
    expect(parseReleaseArgs(['0.3.0-beta.1', '--pre', '--app', 'desktop'])).toHaveProperty('error')
  })
})
