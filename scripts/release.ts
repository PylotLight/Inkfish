// Release script: `bun run release [patch|minor|major|x.y.z] [--push] [--dry-run]`
//
// One-command release cut:
//   1. resolve the next version (explicit, semver bump, or git-cliff's
//      suggestion based on conventional commits since the last tag)
//   2. write it to package.json
//   3. regenerate CHANGELOG.md with git-cliff (commits become the new
//      version section, compare links included)
//   4. commit + annotated tag `vX.Y.Z`
//
// Pushing the tag triggers .github/workflows/release.yml, which builds the
// artifacts, publishes the GitHub release (notes from git-cliff) and updates
// the Homebrew tap. See docs/releasing.md.
//
// Requires git-cliff on PATH (`brew install git-cliff` or
// `cargo install git-cliff`, https://git-cliff.org).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const args = process.argv.slice(2)
const push = args.includes('--push')
const dryRun = args.includes('--dry-run')
const versionArg = args.find((a) => !a.startsWith('--'))

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: bun run release [patch|minor|major|x.y.z] [--push] [--dry-run]

With no version argument, git-cliff picks the next version from conventional
commits since the last tag (falls back to the current package.json version
when no tags exist yet).

  --push      push the release commit and tag to origin when done
  --dry-run   resolve the version and preview the changelog; change nothing`)
  process.exit(0)
}

// --- preflight ----------------------------------------------------------------

// git-cliff installs as both a `git-cliff` binary and a `git cliff` subcommand.
function detectCliff(): { bin: string; base: string[] } {
  if (run('git-cliff', ['--version'], true)) return { bin: 'git-cliff', base: [] }
  if (run('git', ['cliff', '--version'], true)) return { bin: 'git', base: ['cliff'] }
  return fail(
    'git-cliff not found. Install it: brew install git-cliff | cargo install git-cliff'
  )
}
const cliff = detectCliff()

function cliffExec(args: string[], allowFail = false): string {
  return run(cliff.bin, [...cliff.base, ...args], allowFail)
}

const dirty = run('git', ['status', '--porcelain'])
if (dirty && !dryRun) {
  fail('working tree is dirty — commit or stash first\n' + dirty)
}
if (dirty && dryRun) {
  info('note: working tree is dirty (ignored for dry run)')
}

const branch = run('git', ['branch', '--show-current'])
if (branch !== 'main') {
  info(`note: releasing from branch '${branch}', not 'main'`)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }

// --- version resolution ---------------------------------------------------------

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const BUMPS = ['patch', 'minor', 'major'] as const
type Bump = (typeof BUMPS)[number]

function bumpVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = (current.split('-')[0] ?? '')
    .split('.')
    .map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

let version: string
if (versionArg && SEMVER.test(versionArg)) {
  version = versionArg
} else if (versionArg && (BUMPS as readonly string[]).includes(versionArg)) {
  version = bumpVersion(pkg.version, versionArg as Bump)
} else if (versionArg) {
  fail(`'${versionArg}' is neither a semver version nor one of: ${BUMPS.join(', ')}`)
} else {
  // git-cliff weighs conventional commits (feat → minor, fix → patch, breaking
  // → major). It needs an existing tag to bump from; on the very first release
  // it can't, so keep whatever package.json already says.
  const suggested = cliffExec(['--bumped-version'], true).replace(/^v/, '')
  version = SEMVER.test(suggested) ? suggested : pkg.version
  info(`git-cliff suggests ${suggested || '(none)'} → using ${version}`)
}

const tag = `v${version}`
if (run('git', ['rev-parse', '--verify', '--quiet', tag], true)) {
  fail(`tag ${tag} already exists`)
}

// --- dry run -------------------------------------------------------------------

const preview = cliffExec(['--unreleased', '--tag', tag, '--strip', 'all'])
info(`new version: ${pkg.version} → ${version} (${tag})`)
if (dryRun) {
  console.log(`\n${preview}\n`)
  info(`dry run — would update package.json, regenerate CHANGELOG.md,`)
  info(`commit 'chore(release): ${tag}' and tag ${tag}${push ? ' (and push)' : ''}`)
  process.exit(0)
}
if (!preview) {
  info('warning: no commits since the last tag — changelog section will be empty')
}

// --- write files ------------------------------------------------------------------

pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
info('updated package.json')

cliffExec(['--tag', tag, '--output', changelogPath])
info('regenerated CHANGELOG.md')

// --- commit + tag -------------------------------------------------------------------

run('git', ['add', 'package.json', 'CHANGELOG.md'])
// Re-cutting a version that was already released (or re-running after a
// failed push) can leave nothing staged — skip the commit and just tag.
if (run('git', ['diff', '--cached', '--name-only'])) {
  run('git', ['commit', '-m', `chore(release): ${tag}`])
  info(`committed and tagged ${tag}`)
} else {
  info(`version and changelog already up to date — tagging HEAD as ${tag}`)
}
run('git', ['tag', '-a', tag, '-m', tag])

if (push) {
  run('git', ['push', '--follow-tags'])
  info('pushed — the release workflow takes it from here:')
  info('https://github.com/PylotLight/Inkfish/actions/workflows/release.yml')
} else {
  info(`next: review 'git show ${tag}', then 'git push --follow-tags'`)
  info('pushing the tag triggers the build + GitHub release + Homebrew tap update')
}
