import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendDaily, ensureDaily, type VaultPaths } from './vault'

function tmpPaths(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'inkfish-daily-'))
  return {
    root,
    inboxDir: join(root, '.x/inbox'),
    dailyDir: join(root, '.x/daily'),
    assetsDir: join(root, 'assets'),
    dbPath: join(root, '.x/db')
  } as VaultPaths
}

const at = new Date(2026, 9, 20, 0, 37)
const FM = '---\nkind: daily\ncreated: 2026-10-19T13:37:00.000Z\nsource: tray\n---\n'

describe('daily notes (Mac)', () => {
  test('open today creates an empty note: front matter only, no H1, no filler', () => {
    const paths = tmpPaths()
    try {
      const r = ensureDaily(at, paths)
      expect(r.created).toBe(true)
      expect(r.vaultRel).toBe('daily/2026-10-20.md')
      const raw = readFileSync(r.abs, 'utf8')
      expect(raw).toMatch(/^---\nkind: daily\ncreated: .+\nsource: tray\n---\n$/)
      expect(raw).not.toContain('Day started')
      expect(raw).not.toContain('# 2026-10-20')
      // Opening again leaves it alone.
      expect(ensureDaily(at, paths).created).toBe(false)
      expect(readFileSync(r.abs, 'utf8')).toBe(raw)
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })

  test('append writes compact tight bullets (multi-line indented, kind tagged)', () => {
    const paths = tmpPaths()
    try {
      ensureDaily(at, paths)
      appendDaily('coffee with sam', { date: at }, paths)
      appendDaily('standup\nshipped the thing', { date: new Date(2026, 9, 20, 9, 5), kind: 'voice' }, paths)
      const { abs } = ensureDaily(at, paths)
      const body = readFileSync(abs, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
      expect(body).toBe('- 00:37 coffee with sam\n- 09:05 · voice · standup\n  shipped the thing\n')
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })

  test('append after free text leaves a blank line, then stays a tight list', () => {
    const paths = tmpPaths()
    try {
      const { abs } = ensureDaily(at, paths)
      writeFileSync(abs, `${FM}plan: ship daily notes\n\n\n`)
      appendDaily('a', { date: at }, paths)
      appendDaily('b', { date: at }, paths)
      expect(readFileSync(abs, 'utf8')).toBe(`${FM}plan: ship daily notes\n\n- 00:37 a\n- 00:37 b\n`)
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })

  test('exact old boilerplate is cleaned up; anything user-touched is left alone', () => {
    const paths = tmpPaths()
    try {
      const abs = join(paths.dailyDir, '2026-10-20.md')
      ensureDaily(at, paths) // makes the dirs
      const legacy = `${FM}# 2026-10-20\n\n## 00:37\n\n_Day started._\n\n`
      writeFileSync(abs, legacy)
      const r = ensureDaily(at, paths)
      expect(r.migrated).toBe(true)
      expect(readFileSync(abs, 'utf8')).toBe(FM)

      const touched = `${FM}# 2026-10-20\n\n## 00:37\n\n_Day started._ and then some\n`
      writeFileSync(abs, touched)
      expect(ensureDaily(at, paths).migrated).toBe(false)
      expect(readFileSync(abs, 'utf8')).toBe(touched)

      const withEntries = `${FM}# 2026-10-20\n\n## 00:37\n\n_Day started._\n\n## 09:00\n\nreal entry\n`
      writeFileSync(abs, withEntries)
      expect(ensureDaily(at, paths).migrated).toBe(false)
      expect(readFileSync(abs, 'utf8')).toBe(withEntries)
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })

  test('appending to an old boilerplate note drops the boilerplate first', () => {
    const paths = tmpPaths()
    try {
      ensureDaily(at, paths)
      const abs = join(paths.dailyDir, '2026-10-20.md')
      writeFileSync(abs, `${FM}# 2026-10-20\n\n## 00:37\n\n_Day started._\n\n`)
      appendDaily('first real thing', { date: new Date(2026, 9, 20, 8, 1) }, paths)
      expect(readFileSync(abs, 'utf8')).toBe(`${FM}- 08:01 first real thing\n`)
      expect(existsSync(abs)).toBe(true)
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })
})
