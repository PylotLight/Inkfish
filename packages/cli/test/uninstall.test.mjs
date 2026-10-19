// --uninstall: arg parsing, path planning and the run itself, all on a temp "home" (never the real one).
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import config from '../app.config.mjs'
import { parseArgs } from '../lib/core.mjs'
import { helpText, run, uninstallHint } from '../lib/launcher.mjs'
import { createUI } from '../lib/ui.mjs'
import { expandHome, isSafeToDelete, leftoversText, shellPath, uninstallPlan } from '../lib/uninstall.mjs'

const roots = []
const tempHome = () => { const d = mkdtempSync(join(tmpdir(), 'cli-uninstall-')); roots.push(d); return d }
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }) })

const sink = () => {
  const out = { chunks: [], isTTY: false, write(s) { out.chunks.push(s); return true }, text: () => out.chunks.join('') }
  return out
}

/** A fake home with the launcher cache and every configured data path present. */
function populated() {
  const home = tempHome()
  mkdirSync(join(home, '.cache', 'inkfish', '0.2.10', 'Inkfish.app'), { recursive: true })
  for (const { path } of config.uninstall.userData) {
    const p = expandHome(path, home)
    if (p.endsWith('.plist')) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, '<plist/>') } else mkdirSync(p, { recursive: true })
  }
  // a sibling that must survive
  mkdirSync(join(home, 'Library', 'Application Support', 'Other App'), { recursive: true })
  return home
}

function runIn(home, argv, extra = {}) {
  const err = sink()
  const out = sink()
  const calls = []
  const p = run(config, {
    argv, packageVersion: '0.2.10', env: {}, platform: 'linux', arch: 'x64', home,
    ui: createUI({ stream: err, env: {} }), stdout: out,
    isRunning: () => false, keychainExists: () => null, exec: (cmd, args) => { calls.push([cmd, ...args]); return 0 },
    fetchImpl: () => { throw new Error('network used') },
    ...extra,
  })
  return p.then((code) => ({ code, err: err.text(), out: out.text(), calls }))
}

describe('parseArgs', () => {
  test('--uninstall', () => {
    expect(parseArgs(['--uninstall'])).toMatchObject({ uninstall: true, all: false, yes: false, passthrough: [] })
  })
  test('--uninstall --all --yes, any order, -y too', () => {
    expect(parseArgs(['--all', '--uninstall', '--yes'])).toMatchObject({ uninstall: true, all: true, yes: true, passthrough: [] })
    expect(parseArgs(['--uninstall', '-y', '--all'])).toMatchObject({ uninstall: true, all: true, yes: true })
  })
  test('--purge is --uninstall --all', () => {
    expect(parseArgs(['--purge'])).toMatchObject({ uninstall: true, all: true, yes: false })
  })
  test('--all / --yes without --uninstall go to the app, in order', () => {
    expect(parseArgs(['https://a.test', '--all', '-y'])).toMatchObject({ uninstall: false, all: false, yes: false, passthrough: ['https://a.test', '--all', '-y'] })
  })
  test('after -- nothing is ours', () => {
    expect(parseArgs(['--', '--uninstall', '--all'])).toMatchObject({ uninstall: false, all: false, passthrough: ['--uninstall', '--all'] })
    expect(parseArgs(['--uninstall', '--', '--all'])).toMatchObject({ uninstall: true, all: false, passthrough: ['--all'] })
  })
})

describe('paths', () => {
  test('expandHome', () => {
    expect(expandHome('~/Library/Logs/Inkfish', '/h')).toBe('/h/Library/Logs/Inkfish')
    expect(expandHome('~', '/h')).toBe('/h')
    expect(expandHome('/abs/x/../y', '/h')).toBe('/abs/y')
    expect(expandHome('relative', '/h')).toBeNull()
  })
  test('isSafeToDelete only allows app-named paths inside home', () => {
    const h = '/Users/me'
    expect(isSafeToDelete(config, `${h}/Library/Application Support/Inkfish`, h)).toBe(true)
    expect(isSafeToDelete(config, `${h}/Library/Preferences/com.pylotlight.inkfish.plist`, h)).toBe(true)
    expect(isSafeToDelete(config, `${h}/Library/Application Support`, h)).toBe(false)
    expect(isSafeToDelete(config, h, h)).toBe(false)
    expect(isSafeToDelete(config, '/Library/Inkfish', h)).toBe(false)
    expect(isSafeToDelete(config, `${h}/Library/../../etc/inkfish`, h)).toBe(false)
    expect(isSafeToDelete(config, 'Inkfish', h)).toBe(false)
  })
  test('every configured path is absolute under ~ and passes the safety check', () => {
    for (const { path } of config.uninstall.userData) {
      expect(path.startsWith('~/Library/')).toBe(true)
      expect(isSafeToDelete(config, expandHome(path, '/Users/me'), '/Users/me')).toBe(true)
    }
  })
  test('plan marks what exists, honours the cache env overrides', () => {
    const home = tempHome()
    mkdirSync(join(home, 'Library', 'Logs', 'Inkfish'), { recursive: true })
    const plan = uninstallPlan(config, { env: { XDG_CACHE_HOME: join(home, 'xdg') }, home })
    expect(plan.cache.path).toBe(join(home, 'xdg', 'inkfish'))
    expect(plan.data.filter((d) => d.exists).map((d) => d.path)).toEqual([join(home, 'Library', 'Logs', 'Inkfish')])
    expect(uninstallPlan(config, { env: { INKFISH_CLI_CACHE_DIR: '/x/inkfish' }, home }).cache.path).toBe('/x/inkfish')
  })
  test('shellPath quotes spaces with $HOME so fish and bash both expand it', () => {
    expect(shellPath('/h/Library/Logs/Inkfish', '/h')).toBe('~/Library/Logs/Inkfish')
    expect(shellPath('/h/Library/Application Support/Inkfish', '/h')).toBe('"$HOME/Library/Application Support/Inkfish"')
  })
  test('leftovers text lists found data, keychain and bun commands', () => {
    const home = populated()
    const text = leftoversText(config, uninstallPlan(config, { env: {}, home }), { home })
    expect(text).toContain('~/Library/Application Support/Inkfish')
    expect(text).toContain('rm -rf "$HOME/Library/Application Support/Inkfish"')
    expect(text).toContain("security delete-generic-password -s 'Inkfish Safe Storage'")
    expect(text).toContain('bun pm cache rm')
    expect(text).toContain('rm -rf ~/.npm/_npx')
    expect(text).toContain('--uninstall --all')
  })
})

describe('run --uninstall', () => {
  test('removes only the launcher cache and prints what is left', async () => {
    const home = populated()
    const r = await runIn(home, ['--uninstall'])
    expect(r.code).toBe(0)
    expect(existsSync(join(home, '.cache', 'inkfish'))).toBe(false)
    expect(existsSync(join(home, 'Library', 'Application Support', 'Inkfish'))).toBe(true)
    expect(r.err).toContain('ok: removed the launcher cache ~/.cache/inkfish')
    expect(r.out).toContain("Inkfish's own data is still here")
    expect(r.out).toContain('~/Library/Logs/Inkfish')
    expect(r.calls).toEqual([])
  })

  test('nothing there: still fine', async () => {
    const r = await runIn(tempHome(), ['--uninstall'])
    expect(r.code).toBe(0)
    expect(r.err).toContain('is already gone')
    expect(r.out).toContain('no Inkfish app data found')
  })

  test('refuses while the app is running and deletes nothing', async () => {
    const home = populated()
    const r = await runIn(home, ['--purge', '--yes'], { isRunning: () => true })
    expect(r.code).toBe(1)
    expect(r.err).toContain('Inkfish is running')
    expect(existsSync(join(home, '.cache', 'inkfish'))).toBe(true)
    expect(existsSync(join(home, 'Library', 'Application Support', 'Inkfish'))).toBe(true)
  })

  test('--all asks, and "no" deletes nothing', async () => {
    const home = populated()
    let asked = ''
    const r = await runIn(home, ['--uninstall', '--all'], { confirm: async (q) => { asked = q; return false } })
    expect(r.code).toBe(1)
    expect(asked).toContain('delete')
    expect(r.err).toContain('nothing deleted')
    expect(existsSync(join(home, '.cache', 'inkfish'))).toBe(true)
    expect(existsSync(join(home, 'Library', 'Application Support', 'Inkfish'))).toBe(true)
  })

  test('--all + yes deletes the app data but nothing else', async () => {
    const home = populated()
    const r = await runIn(home, ['--uninstall', '--all'], { confirm: async () => true })
    expect(r.code).toBe(0)
    for (const { path } of config.uninstall.userData) expect(existsSync(expandHome(path, home))).toBe(false)
    expect(existsSync(join(home, '.cache', 'inkfish'))).toBe(false)
    expect(existsSync(join(home, 'Library', 'Application Support', 'Other App'))).toBe(true)
    expect(r.out).not.toContain('still here')
    expect(r.out).toContain('bun pm cache rm')
  })

  test('--purge --yes on macOS runs defaults delete and removes the keychain item', async () => {
    const home = populated()
    const r = await runIn(home, ['--purge', '--yes'], { platform: 'darwin', arch: 'arm64', keychainExists: () => true, confirm: async () => { throw new Error('asked') } })
    expect(r.code).toBe(0)
    expect(r.calls).toEqual([
      ['defaults', 'delete', 'com.pylotlight.inkfish'],
      ['security', 'delete-generic-password', '-s', 'Inkfish Safe Storage'],
    ])
    expect(r.err).toContain('removed keychain item "Inkfish Safe Storage"')
  })
})

describe('docs', () => {
  test('help mentions --uninstall', () => {
    const help = helpText(config, '0.2.10')
    expect(help).toContain('--uninstall')
    expect(help).toContain('--purge')
  })
  test('first-run hint', () => {
    expect(uninstallHint(config, true)).toBe('remove it later with bunx @pylotlight/inkfish --uninstall')
    expect(uninstallHint(config, false)).toBe('remove it later with npx @pylotlight/inkfish --uninstall')
  })
})
