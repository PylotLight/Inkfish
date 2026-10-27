import * as FileSystem from 'expo-file-system/legacy'
import { stringifyFrontmatter, type NoteKind } from '../format'
import {
  appendToDailyFile,
  dayOfPath,
  formatEntry,
  localDay,
  splitDailyFile,
  stripLegacyTitle,
  type DailyEntry
} from '../../../../src/shared/daily'
import { summarizeDay } from '../../../../src/shared/journal'
import { DAILY } from './state'
import { ensureTree, readText, writeText } from './paths'
import { mapLimit } from './fs'

// --- daily ---

/** Local calendar day — matches Mac `localDay` (UTC filed mornings under yesterday). */
function todayName(d = new Date()): string {
  return localDay(d)
}

/** Append a compact plain bullet to today's note (same shape as Mac — see shared/daily). */
export async function appendDaily(raw: string, _kind: NoteKind = 'text'): Promise<string> {
  await ensureTree()
  const text = raw.trim()
  if (!text) throw new Error('daily note is empty')
  const now = new Date()
  const rel = `daily/${todayName(now)}.md`
  const uri = `${DAILY}${todayName(now)}.md`
  const entry = formatEntry(text)
  const exists = (await FileSystem.getInfoAsync(uri)).exists
  if (!exists) {
    const fm = stringifyFrontmatter({
      kind: 'daily',
      created: now.toISOString(),
      source: 'android'
    })
    await writeText(uri, `${fm}${entry}\n`)
  } else {
    await writeText(uri, appendToDailyFile(await readText(uri), entry))
  }
  return rel
}

// --- journal: every daily note, summarized once per change ---------------------------
// Daily notes live in staging (`staging/daily/YYYY-MM-DD.md`, one flat folder), not the vault.
// The Journal + Home Daily section draw from these summaries, which ride in the saved index
// snapshot, so they show instantly at launch; the refresh lists that one folder (a stat per
// file) and only re-reads days whose size/mtime changed. Full bodies are read per visible page.

/** Index row for one daily note: enough to draw a card / timeline row without reading it. */
export interface DayInfo {
  /** Path id (daily notes have no front matter id), opens in the editor. */
  id: string
  path: string
  day: string
  size: number
  updatedAt: number
  /** Timestamped entries in the note. */
  count: number
  /** First few entries (plain text), file order. */
  entries: DailyEntry[]
  /** Plain text of the day for filtering + free-text previews (capped). */
  snippet: string
}

const DAY_PREVIEW = 4
const DAY_TEXT_CAP = 400
export const dayCache = new Map<string, DayInfo>()
let daysTask: Promise<DayInfo[]> | null = null

/** Summarize one day file's text (front matter dropped). Pure apart from the parse. */
export function dayInfoFromText(rel: string, text: string, stat: { size: number; mtime: number }): DayInfo | null {
  const day = dayOfPath(rel)
  if (!day) return null
  const all = summarizeDay(splitDailyFile(text).body, 1000)
  const entries = all.entries.slice(0, DAY_PREVIEW)
  const snippet = (all.entries.length ? all.entries.map((e) => e.text).join(' · ') : all.text).slice(0, DAY_TEXT_CAP)
  return { id: rel, path: rel, day, size: stat.size, updatedAt: stat.mtime, count: all.count, entries, snippet }
}

/** Every daily note, newest day first. Concurrent callers share one pass. */
export function listDays(): Promise<DayInfo[]> {
  if (daysTask) return daysTask
  const task = (async () => {
    let names: string[]
    try {
      names = (await FileSystem.readDirectoryAsync(DAILY)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    } catch {
      names = []
    }
    const rows = await mapLimit(names, 8, async (name): Promise<DayInfo | null> => {
      const rel = `daily/${name}`
      const uri = `${DAILY}${name}`
      try {
        const info = await FileSystem.getInfoAsync(uri)
        if (!info.exists || info.isDirectory) return null
        const size = info.size ?? 0
        const mtime = info.modificationTime ? info.modificationTime * 1000 : Date.now()
        const hit = dayCache.get(rel)
        if (hit && hit.size === size && hit.updatedAt === mtime) return hit
        const row = dayInfoFromText(rel, await readText(uri), { size, mtime })
        if (row) dayCache.set(rel, row)
        return row
      } catch {
        return null
      }
    })
    const present = new Set(names.map((n) => `daily/${n}`))
    for (const k of dayCache.keys()) if (!present.has(k)) dayCache.delete(k)
    return rows.filter((r): r is DayInfo => r !== null).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  })()
  daysTask = task
  task
    .finally(() => {
      if (daysTask === task) daysTask = null
    })
    .catch(() => undefined)
  return task
}

/** Summaries from the saved snapshot (no disk), newest first — what the first frame shows. */
export function cachedDays(): DayInfo[] {
  return [...dayCache.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

/** One day's body (front matter + old `# date` title dropped), '' when there's no note. */
export async function readDay(day: string): Promise<string> {
  const uri = `${DAILY}${day}.md`
  try {
    return stripLegacyTitle(splitDailyFile(await readText(uri)).body)
  } catch {
    return ''
  }
}

export async function readDaily(d = new Date()): Promise<{ rel: string; body: string }> {
  await ensureTree()
  const rel = `daily/${todayName(d)}.md`
  const uri = `${DAILY}${todayName(d)}.md`
  if (!(await FileSystem.getInfoAsync(uri)).exists) return { rel, body: '' }
  const { parseFrontmatter } = await import('../format')
  const [, body] = parseFrontmatter(await readText(uri))
  // Older notes opened with a `# YYYY-MM-DD` heading that repeats the screen title.
  return { rel, body: stripLegacyTitle(body) }
}

/** Reset the day cache (tests only — keeps `listDays` honest after fs resets). */
export function resetDaysForTests(): void {
  dayCache.clear()
  daysTask = null
}
