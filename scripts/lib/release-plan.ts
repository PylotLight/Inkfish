// Pure helpers for scripts/release.ts: which app a path belongs to, what changed
// since each app's last tag, version bumps, args. No git / fs here so it's unit-tested.
//
// Two apps, two tag series:
//   desktop  → vX.Y.Z           (.github/workflows/release.yml)
//   android  → android-vX.Y.Z   (.github/workflows/android-release.yml)

export type App = 'desktop' | 'android'
export type AppChoice = App | 'both'
export const APPS: readonly App[] = ['desktop', 'android']

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export const BUMPS = ['patch', 'minor', 'major'] as const
export type Bump = (typeof BUMPS)[number]

export const TAG_PREFIX: Record<App, string> = { desktop: 'v', android: 'android-v' }

/** Paths that never need a release of either app on their own. */
function isNoise(p: string): boolean {
  return (
    p.endsWith('.md') ||
    p.startsWith('docs/') ||
    p.startsWith('Casks/') ||
    p.startsWith('.github/') ||
    p === 'LICENSE' ||
    p === '.gitignore' ||
    p === '.prettierrc' ||
    /\.test\.tsx?$/.test(p) ||
    p.startsWith('android/test/') ||
    p.startsWith('packages/cli/test/') ||
    p === 'scripts/release.ts' ||
    p.startsWith('scripts/lib/release-plan')
  )
}

/** Shared code both apps import (the phone pulls in src/shared/sync, tags, images, note-move, title-sync…). */
export function isShared(p: string): boolean {
  return p.startsWith('src/shared/')
}

/** The sync wire protocol: both sides should ship together when it changes. */
export function isSync(p: string): boolean {
  return p.startsWith('src/shared/sync/')
}

/** Which app(s) a changed file belongs to. Empty = needs no release. */
export function appsForPath(p: string): App[] {
  if (isNoise(p)) return []
  if (isShared(p)) return ['desktop', 'android']
  if (p.startsWith('android/')) return ['android']
  return ['desktop']
}

export interface AppChanges {
  app: App
  /** Last tag of this app's series, or null if it was never released. */
  lastTag: string | null
  /** Files since lastTag that belong to this app. */
  files: string[]
  /** Any of them in src/shared/sync. */
  sync: boolean
}

export function changesFor(app: App, lastTag: string | null, changedFiles: string[]): AppChanges {
  const files = changedFiles.filter((f) => appsForPath(f).includes(app))
  return { app, lastTag, files, sync: files.some(isSync) }
}

/** Apps worth releasing. Sync protocol changes pull in both so the two sides stay in step. */
export function suggestApps(changes: AppChanges[]): App[] {
  if (changes.some((c) => c.sync)) return [...APPS]
  return changes.filter((c) => c.files.length > 0 || c.lastTag === null).map((c) => c.app)
}

function semverKey(v: string): number[] {
  return (v.split('-')[0] ?? '').split('.').map((n) => Number(n) || 0)
}

function cmpSemver(a: string, b: string): number {
  const x = semverKey(a)
  const y = semverKey(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Version from a tag of `app`'s series, or null when the tag isn't one of its tags. `v*` never matches `android-v*`. */
export function versionOfTag(app: App, tag: string): string | null {
  const prefix = TAG_PREFIX[app]
  if (!tag.startsWith(prefix)) return null
  const v = tag.slice(prefix.length)
  return SEMVER.test(v) ? v : null
}

/** Newest tag of `app`'s series by semver (not by date). */
export function latestTag(app: App, tags: string[]): string | null {
  let best: { tag: string; v: string } | null = null
  for (const t of tags) {
    const v = versionOfTag(app, t)
    if (!v || v.includes('-')) continue // skip pre-releases
    if (!best || cmpSemver(v, best.v) > 0) best = { tag: t, v }
  }
  return best?.tag ?? null
}

export function bumpVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = semverKey(current)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** Next version for an app from its last tag (or `fallback`, e.g. package.json, when never tagged). */
export function nextVersion(app: App, lastTag: string | null, bump: Bump | string, fallback = '0.0.0'): string {
  if (SEMVER.test(bump)) return bump
  const current = (lastTag && versionOfTag(app, lastTag)) || fallback
  return bumpVersion(current, bump as Bump)
}

/** The cross-app line every release body carries. */
export function testedWithLine(otherTag: string | null): string | null {
  return otherTag ? `tested with ${otherTag}` : null
}

export function parseAppChoice(s: string | undefined): AppChoice | null {
  const v = (s ?? '').trim().toLowerCase()
  if (v === 'desktop' || v === 'mac') return 'desktop'
  if (v === 'android' || v === 'phone') return 'android'
  if (v === 'both' || v === 'all') return 'both'
  return null
}

export function appsOf(choice: AppChoice): App[] {
  return choice === 'both' ? [...APPS] : [choice]
}

export interface ReleaseArgs {
  /** patch | minor | major | x.y.z | 'auto' (git-cliff's pick, desktop only). Default patch. */
  version: string
  app: AppChoice | null
  push: boolean
  dryRun: boolean
  /** Don't prompt: take the detected suggestion (CI). */
  yes: boolean
  help: boolean
}

export function parseReleaseArgs(argv: string[]): ReleaseArgs | { error: string } {
  const out: ReleaseArgs = { version: 'patch', app: null, push: false, dryRun: false, yes: false, help: false }
  let sawVersion = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--push') out.push = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes' || a === '-y' || a === '--non-interactive' || a === '--ci') out.yes = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--app' || a.startsWith('--app=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]
      const c = parseAppChoice(raw)
      if (!c) return { error: `--app wants desktop | android | both, got '${raw ?? ''}'` }
      out.app = c
    } else if (a.startsWith('--')) return { error: `unknown flag ${a}` }
    else if (!sawVersion) {
      if (!SEMVER.test(a) && !(BUMPS as readonly string[]).includes(a) && a !== 'auto') {
        return { error: `'${a}' is neither a semver version, auto, nor one of: ${BUMPS.join(', ')}` }
      }
      out.version = a
      sawVersion = true
    } else return { error: `unexpected argument '${a}'` }
  }
  if (out.app === 'both' && SEMVER.test(out.version)) {
    return { error: 'an explicit x.y.z needs a single --app (desktop and android are versioned separately)' }
  }
  if (out.app === 'android' && out.version === 'auto') return { error: "'auto' (git-cliff) is desktop only" }
  return out
}

/** Human summary of what changed since each app's last tag. */
export function formatSummary(changes: AppChanges[], suggestion: App[], maxFiles = 8): string {
  const lines: string[] = []
  for (const c of changes) {
    const since = c.lastTag ?? '(never released)'
    lines.push(`${c.app.padEnd(7)} since ${since}: ${c.files.length} file(s)${c.sync ? ' — touches src/shared/sync' : ''}`)
    for (const f of c.files.slice(0, maxFiles)) lines.push(`    ${f}`)
    if (c.files.length > maxFiles) lines.push(`    … +${c.files.length - maxFiles} more`)
  }
  const pick = suggestion.length === 2 ? 'both' : (suggestion[0] ?? 'nothing')
  lines.push(`suggested: ${pick}${changes.some((c) => c.sync) ? ' (sync changed, keep phone + Mac in step)' : ''}`)
  return lines.join('\n')
}
