import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NoteKind, NoteSource } from '../../shared/types'
import { appendToDailyFile, formatEntry, localDay as sharedLocalDay, migrateLegacyDaily } from '../../shared/daily'
import { ensureVault } from './bootstrap'
import { stringifyFrontmatter } from './frontmatter'
import { vaultPaths } from './paths'
import type { VaultPaths } from './types'

/** Local calendar day (YYYY-MM-DD). A day log follows the wall clock, not UTC —
 *  in Melbourne `toISOString()` filed everything before 11am under yesterday. */
export const localDay = sharedLocalDay

export function dailyFile(
  date: Date = new Date(),
  paths: VaultPaths = vaultPaths()
): { abs: string; vaultRel: string } {
  const day = localDay(date)
  const abs = join(paths.dailyDir, `${day}.md`)
  // Staging rel namespace (`daily/<day>.md`) — stable even though the file
  // lives in app data, so index rows, tree filters, and open-today all agree.
  return { abs, vaultRel: `daily/${day}.md` }
}

function dailyFrontmatter(source: NoteSource | undefined): string {
  return stringifyFrontmatter({ kind: 'daily', created: new Date().toISOString(), source: source ?? 'tray' })
}

/**
 * Make sure the day note exists (front matter only — an empty page, no title H1, no filler) and
 * quietly clean up the old generated body (`# <day>` + `## HH:MM` + `_Day started._`) when that
 * is EXACTLY all the file holds. Anything the user wrote is left alone.
 */
export function ensureDaily(
  date: Date = new Date(),
  paths: VaultPaths = vaultPaths(),
  source?: NoteSource
): { abs: string; vaultRel: string; created: boolean; migrated: boolean } {
  ensureVault(paths)
  const { abs, vaultRel } = dailyFile(date, paths)
  mkdirSync(dirname(abs), { recursive: true })
  if (!existsSync(abs)) {
    writeFileSync(abs, dailyFrontmatter(source), 'utf8')
    return { abs, vaultRel, created: true, migrated: false }
  }
  const migrated = migrateLegacyDaily(readFileSync(abs, 'utf8'), localDay(date))
  if (migrated !== null) {
    writeFileSync(abs, migrated, 'utf8')
    return { abs, vaultRel, created: false, migrated: true }
  }
  return { abs, vaultRel, created: false, migrated: false }
}

/** Append a compact `- HH:MM text` entry to today's day note. Creates the file on first use. */
export function appendDaily(
  raw: string,
  opts: { kind?: NoteKind; date?: Date; source?: NoteSource } = {},
  paths: VaultPaths = vaultPaths()
): { vaultRel: string; path: string } {
  const text = raw.trim()
  if (!text) throw new Error('daily note is empty')
  const at = opts.date ?? new Date()
  const { abs, vaultRel } = ensureDaily(at, paths, opts.source)
  writeFileSync(abs, appendToDailyFile(readFileSync(abs, 'utf8'), formatEntry(text, opts.kind ?? 'text', at)), 'utf8')
  return { vaultRel, path: abs }
}
