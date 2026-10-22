// Release script: `bun scripts/release.ts [patch|minor|major|x.y.z|auto] [--app desktop|android|both] [--pre[=beta]] [--push] [--dry-run] [--yes]`
//
// Desktop (Mac) and Android ship on their own tag series:
//   desktop  vX.Y.Z          → .github/workflows/release.yml (dmg/zip, cask, npm launcher)
//   android  android-vX.Y.Z  → .github/workflows/android-release.yml (signed APK, never "latest")
//
// With no --app it looks at what changed since each app's last tag
// (android = android/** + src/shared/**, desktop = everything else that ships
// + src/shared/**; docs, tests, *.md, Casks, .github don't count), prints a
// summary and asks which to release. src/shared/sync changes default to both,
// so the phone and the Mac speak the same sync protocol. --yes takes the
// suggestion without asking (CI / scripts).
//
// Desktop: writes package.json, regenerates CHANGELOG.md with git-cliff,
//   commits `chore(release): vX.Y.Z` and tags vX.Y.Z (needs git-cliff on PATH).
// Android: tags android-vX.Y.Z on HEAD (patch from the last android tag). No
//   commit: the workflow stamps app.json from the tag.
//
// --pre cuts a test build instead: vX.Y.Z-beta.N / android-vX.Y.Z-beta.N (GitHub
//   pre-release, no cask, no npm, only offered to people with beta updates on).
//   Running it again bumps N; a normal release afterwards ships X.Y.Z. Desktop
//   pre-releases bump package.json but leave CHANGELOG.md alone (the final
//   release's section covers the betas).
//
// Default bump is patch. `auto` = git-cliff's suggestion (desktop only).
// Nothing is pushed without --push. See docs/releasing.md.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  APPS,
  appsOf,
  changesFor,
  formatSummary,
  isPrerelease,
  latestTag,
  openPrerelease,
  nextVersion,
  parseAppChoice,
  parseReleaseArgs,
  SEMVER,
  suggestApps,
  TAG_PREFIX,
  testedWithLine,
  type App,
  type AppChanges
} from './lib/release-plan'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')
const changelogPath = join(root, 'CHANGELOG.md')

function run(cmd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync(cmd, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (err) {
    if (allowFail) return ''
    const stderr = (err as { stderr?: string }).stderr?.trim()
    if (stderr) console.error(stderr)
    return fail(`command failed: ${cmd} ${args.join(' ')}`)
  }
}

function info(msg: string): void {
  console.log(`[release] ${msg}`)
}

function fail(msg: string): never {
  console.error(`[release] error: ${msg}`)
  process.exit(1)
}

// --- args -------------------------------------------------------------------

const parsed = parseReleaseArgs(process.argv.slice(2))
if ('error' in parsed) fail(parsed.error)
const args = parsed

if (args.help) {
  console.log(`Usage: bun scripts/release.ts [patch|minor|major|x.y.z|auto] [--app desktop|android|both] [--pre[=beta]] [--push] [--dry-run] [--yes]

  --app       desktop (vX.Y.Z), android (android-vX.Y.Z) or both. Without it the
              script shows what changed since each app's last tag and asks.
  --yes       don't ask: release whatever changed (sync changes → both). For CI.
  --pre       test build: X.Y.Z-beta.N (GitHub pre-release, no cask / npm,
              only offered in-app with "beta updates" on). Again → beta.N+1;
              a normal release afterwards ships X.Y.Z. --pre=rc for rc.N.
              'prerelease' as the first word means the same.
  --push      push the release commit + tags to origin when done
  --dry-run   show the plan and the changelog preview; change nothing

Version defaults to a patch bump from each app's own last tag. An explicit
x.y.z needs a single --app. 'auto' lets git-cliff pick (desktop only).`)
  process.exit(0)
}

// --- preflight ----------------------------------------------------------------

const dirty = run('git', ['status', '--porcelain'])
if (dirty && !args.dryRun) fail('working tree is dirty — commit or stash first\n' + dirty)
if (dirty && args.dryRun) info('note: working tree is dirty (ignored for dry run)')

const branch = run('git', ['branch', '--show-current'])
if (branch !== 'main') info(`note: releasing from branch '${branch}', not 'main'`)

const tags = run('git', ['tag', '--list'], true).split('\n').filter(Boolean)
const lastTags: Record<App, string | null> = {
  desktop: latestTag('desktop', tags),
  android: latestTag('android', tags)
}

function changedSince(tag: string | null): string[] {
  if (!tag) return run('git', ['ls-files']).split('\n').filter(Boolean)
  return run('git', ['diff', '--name-only', `${tag}..HEAD`])
    .split('\n')
    .filter(Boolean)
}

// --- which apps ----------------------------------------------------------------

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

async function pickApps(): Promise<App[]> {
  if (args.app) return appsOf(args.app)
  const changes: AppChanges[] = APPS.map((a) => changesFor(a, lastTags[a], changedSince(lastTags[a])))
  const suggestion = suggestApps(changes)
  console.log(formatSummary(changes, suggestion))
  if (args.yes || !process.stdin.isTTY) {
    if (!args.yes) info('stdin is not a terminal — taking the suggestion (pass --app to choose)')
    return suggestion
  }
  const def = suggestion.length === 2 ? 'both' : (suggestion[0] ?? 'none')
  const answer = (await ask(`release which? [desktop/android/both/none] (${def}): `)).trim() || def
  if (answer === 'none' || answer === 'n') return []
  const c = parseAppChoice(answer)
  if (!c) fail(`'${answer}' isn't desktop, android, both or none`)
  return appsOf(c)
}

const apps = await pickApps()
if (!apps.length) {
  info('nothing to release')
  process.exit(0)
}

// --- desktop ------------------------------------------------------------------

function detectCliff(): { bin: string; base: string[] } {
  if (run('git-cliff', ['--version'], true)) return { bin: 'git-cliff', base: [] }
  if (run('git', ['cliff', '--version'], true)) return { bin: 'git', base: ['cliff'] }
  return fail('git-cliff not found. Install it: brew install git-cliff | cargo install git-cliff')
}

function planDesktop(): { version: string; tag: string; cliff: { bin: string; base: string[] } } {
  const cliff = detectCliff()
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  let version: string
  if (args.version === 'auto') {
    // git-cliff weighs conventional commits (feat → minor, fix → patch, breaking → major).
    const suggested = run(cliff.bin, [...cliff.base, '--bumped-version'], true).replace(/^v/, '')
    const base = SEMVER.test(suggested) ? suggested : pkg.version
    version = nextVersion('desktop', lastTags.desktop, base, pkg.version, { tags, pre: args.pre })
    info(`git-cliff suggests ${suggested || '(none)'} → using ${version}`)
  } else {
    version = nextVersion('desktop', lastTags.desktop, args.version, pkg.version, { tags, pre: args.pre })
  }
  const tag = `${TAG_PREFIX.desktop}${version}`
  if (tags.includes(tag)) fail(`tag ${tag} already exists`)
  const open = openPrerelease('desktop', tags)
  info(
    `desktop: ${lastTags.desktop ?? pkg.version}${open ? ` (open: ${open})` : ''} → ${tag}${args.pre ? ' (pre-release)' : ''}`
  )
  return { version, tag, cliff }
}

function cutDesktop(p: ReturnType<typeof planDesktop>): void {
  const cliffExec = (a: string[]): string => run(p.cliff.bin, [...p.cliff.base, ...a])
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  pkg.version = p.version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  info('updated package.json')
  if (isPrerelease(p.version)) info('pre-release: CHANGELOG.md left alone (the final release covers it)')
  else {
    cliffExec(['--tag', p.tag, '--output', changelogPath])
    info('regenerated CHANGELOG.md')
  }
  run('git', ['add', 'package.json', 'CHANGELOG.md'])
  // Re-cutting after a failed push can leave nothing staged — skip the commit and just tag.
  if (run('git', ['diff', '--cached', '--name-only'])) run('git', ['commit', '-m', `chore(release): ${p.tag}`])
  else info(`version and changelog already up to date — tagging HEAD as ${p.tag}`)
  run('git', ['tag', '-a', p.tag, '-m', p.tag])
  info(`tagged ${p.tag}`)
}

// --- android --------------------------------------------------------------------

function planAndroid(): { version: string; tag: string } {
  const appJson = JSON.parse(readFileSync(join(root, 'android', 'app.json'), 'utf8')) as { expo?: { version?: string } }
  const version = nextVersion('android', lastTags.android, args.version, appJson.expo?.version ?? '0.0.0', {
    tags,
    pre: args.pre
  })
  const tag = `${TAG_PREFIX.android}${version}`
  if (tags.includes(tag)) fail(`tag ${tag} already exists`)
  const open = openPrerelease('android', tags)
  info(
    `android: ${lastTags.android ?? '(none)'}${open ? ` (open: ${open})` : ''} → ${tag}${args.pre ? ' (pre-release)' : ''}`
  )
  return { version, tag }
}

function cutAndroid(p: ReturnType<typeof planAndroid>, desktopTag: string | null): void {
  const line = testedWithLine(desktopTag)
  run('git', ['tag', '-a', p.tag, '-m', [p.tag, line].filter(Boolean).join('\n\n')])
  info(`tagged ${p.tag}`)
}

// --- go --------------------------------------------------------------------------

const desktopPlan = apps.includes('desktop') ? planDesktop() : null
const androidPlan = apps.includes('android') ? planAndroid() : null
// What each side ships alongside (the "tested with" line in the release notes).
// A test build pairs with the other side's open beta when there is one.
const desktopTag = desktopPlan?.tag ?? (args.pre ? openPrerelease('desktop', tags) : null) ?? lastTags.desktop
const androidTag = androidPlan?.tag ?? (args.pre ? openPrerelease('android', tags) : null) ?? lastTags.android

if (args.dryRun) {
  if (desktopPlan) {
    const preview = run(
      desktopPlan.cliff.bin,
      [...desktopPlan.cliff.base, '--unreleased', '--tag', desktopPlan.tag, '--strip', 'all'],
      true
    )
    console.log(`\n${preview}\n`)
    const what = isPrerelease(desktopPlan.version) ? 'package.json' : 'package.json + CHANGELOG.md'
    info(`dry run — would update ${what}, commit 'chore(release): ${desktopPlan.tag}' and tag ${desktopPlan.tag}`)
  }
  if (androidPlan) info(`dry run — would tag ${androidPlan.tag} on ${desktopPlan ? 'the release commit' : 'HEAD'}`)
  if (desktopPlan) info(`desktop notes: ${testedWithLine(androidTag) ?? '(no android tag yet)'}`)
  if (androidPlan) info(`android notes: ${testedWithLine(desktopTag) ?? '(no desktop tag yet)'}`)
  process.exit(0)
}

if (desktopPlan) cutDesktop(desktopPlan)
if (androidPlan) cutAndroid(androidPlan, desktopTag)

const newTags = [desktopPlan?.tag, androidPlan?.tag].filter((t): t is string => !!t)
if (args.push) {
  if (desktopPlan) run('git', ['push', 'origin', 'HEAD'])
  run('git', ['push', 'origin', ...newTags])
  info(`pushed ${newTags.join(' + ')} — the workflows take it from here:`)
  if (desktopPlan) info('https://github.com/PylotLight/Inkfish/actions/workflows/release.yml')
  if (androidPlan) info('https://github.com/PylotLight/Inkfish/actions/workflows/android-release.yml')
} else {
  info(`next: review, then 'git push origin HEAD ${newTags.join(' ')}'`)
}
