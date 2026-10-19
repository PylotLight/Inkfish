/**
 * Journal: every daily note (`daily/YYYY-MM-DD.md`) as one flickable timeline — Home's Daily
 * cards, the desktop Journal view and the Android Journal screen all build from this.
 *
 * Everything here is pure and works off index metadata (path, size, mtime, snippet) or a body
 * that was read lazily for a visible day, so a vault with 2k notes / hundreds of days never
 * reads every file just to draw the list.
 */
import { dailyTitle, dayOfPath, localDay, parseDay, parseEntries, shiftDay, stripLegacyTitle, type DailyEntry } from './daily'

/** Minimal index row the journal needs (desktop `NoteEntry` and Android `NoteEntry` both fit). */
export interface DayIndexRow {
  id: string
  path: string
  updatedAt: number
  size: number
  snippet: string
}

export type DayRef<T extends DayIndexRow = DayIndexRow> = T & { day: string }

/** Daily notes out of a note index, newest day first. Anything not `daily/YYYY-MM-DD.md` is skipped. */
export function dailyRefs<T extends DayIndexRow>(notes: readonly T[]): Array<DayRef<T>> {
  const out: Array<DayRef<T>> = []
  for (const n of notes) {
    const day = dayOfPath(n.path)
    if (day) out.push({ ...n, day })
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

/** True for a daily note path (Recent lists drop these; Journal shows them). */
export function isDailyPath(path: string): boolean {
  return dayOfPath(path) !== null
}

/** Notes that aren't daily notes (what "Recent" shows). */
export function withoutDaily<T extends { path: string }>(notes: readonly T[]): T[] {
  return notes.filter((n) => !isDailyPath(n.path))
}

export interface DaySummary {
  /** Timestamped entries in the note. */
  count: number
  /** The first `max` entries, file order (morning first). */
  entries: DailyEntry[]
  /** Free text for a day with no `- HH:MM` entries (someone just typed in it), else ''. */
  text: string
}

/** Plain one-liner of markdown-ish text for previews (links/emphasis/code marks dropped). */
export function plainLine(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|$|[.,!?;:])/g, '$1$2')
    .replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What a day card shows: entry count, the first few entries, or a free-text snippet when the
 * day has no entries. Works on a full body or on the 220-char index snippet (then `count` is a
 * lower bound — callers upgrade once the body is read).
 */
export function summarizeDay(body: string, max = 3): DaySummary {
  const clean = stripLegacyTitle(body)
  const all = parseEntries(clean)
  if (all.length) {
    return {
      count: all.length,
      entries: all.slice(0, max).map((e) => ({ ...e, text: plainLine(e.text) })),
      text: ''
    }
  }
  const text = clean
    .split('\n')
    .map(plainLine)
    .filter(Boolean)
    .join(' · ')
  return { count: 0, entries: [], text: text.slice(0, 240) }
}

/** `2026-10-20` → `2026-10`. */
export function monthKey(day: string): string {
  return day.slice(0, 7)
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** `2026-10` → `October 2026` (fixed English, like `dailyTitle`). */
export function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return key
  return `${MONTH_NAMES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`
}

/** `2026-10` ± n months. */
export function shiftMonth(key: string, n: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return key
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export type JournalRow<T> =
  | { kind: 'month'; key: string; label: string; count: number }
  | { kind: 'day'; day: string; item: T }

/**
 * Flat rows for a virtualized list: a month header, then that month's days. Input order is kept
 * (pass newest-first for the timeline); a header starts whenever the month changes.
 */
export function groupByMonth<T extends { day: string }>(items: readonly T[]): Array<JournalRow<T>> {
  const counts = new Map<string, number>()
  for (const it of items) counts.set(monthKey(it.day), (counts.get(monthKey(it.day)) ?? 0) + 1)
  const out: Array<JournalRow<T>> = []
  let current = ''
  for (const it of items) {
    const key = monthKey(it.day)
    if (key !== current) {
      current = key
      out.push({ kind: 'month', key, label: monthLabel(key), count: counts.get(key) ?? 0 })
    }
    out.push({ kind: 'day', day: it.day, item: it })
  }
  return out
}

/** Months that have at least one day, newest first, with counts (the jump list). */
export function monthCounts(days: readonly string[]): Array<{ key: string; label: string; count: number }> {
  const m = new Map<string, number>()
  for (const d of days) m.set(monthKey(d), (m.get(monthKey(d)) ?? 0) + 1)
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, count]) => ({ key, label: monthLabel(key), count }))
}

/** Words a day answers to besides its text: ISO date, friendly title, full month name, year. */
function dayWords(day: string, now: Date): string {
  const d = parseDay(day)
  const month = d ? MONTH_NAMES[d.getMonth()] ?? '' : ''
  return `${day} ${dailyTitle(day, now)} ${month} ${d?.getFullYear() ?? ''}`.toLowerCase()
}

/**
 * Does a day match a filter query? Every whitespace-separated word must appear somewhere in the
 * day's date words (`2026-10-20`, `tue 20 oct`, `october`) or its text. Case-insensitive.
 */
export function matchesDay(day: string, query: string, text = '', now: Date = new Date()): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${dayWords(day, now)} ${text.toLowerCase()}`
  return words.every((w) => hay.includes(w))
}

/**
 * Filter days by a query: matched by date words or by the text we have for it (`textOf`: a lazily
 * read body when it's loaded, else the index snippet). `alsoIds` adds days a full-text search
 * hit (the desktop index searches every file), so a word deep in an unread note still matches.
 */
export function filterDays<T extends { day: string; id: string }>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
  alsoIds?: ReadonlySet<string>,
  now: Date = new Date()
): T[] {
  if (!query.trim()) return items.slice()
  return items.filter((it) => alsoIds?.has(it.id) || matchesDay(it.day, query, textOf(it), now))
}

/**
 * A month as calendar weeks (Monday first), each cell a `YYYY-MM-DD` or null padding.
 * Always 4–6 rows of 7.
 */
export function monthGrid(key: string): Array<Array<string | null>> {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return []
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const first = new Date(year, month, 1)
  const lead = (first.getDay() + 6) % 7 // Mon=0 … Sun=6
  const daysIn = new Date(year, month + 1, 0).getDate()
  const cells: Array<string | null> = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= daysIn; d++) cells.push(localDay(new Date(year, month, d)))
  while (cells.length % 7) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/** Heat bucket (0–3) for a calendar cell from the note's size on disk — a cheap "how much" proxy
 *  that needs no file read. 0 = no note / empty (front matter only, ~70 bytes). */
export function heatLevel(size: number | undefined): 0 | 1 | 2 | 3 {
  if (!size || size <= 80) return 0
  if (size <= 400) return 1
  if (size <= 1500) return 2
  return 3
}

/**
 * Current run of consecutive days with a note, ending today (or yesterday, so the streak doesn't
 * read 0 first thing in the morning). Empty notes count — the file exists because you opened it.
 */
export function streak(days: Iterable<string>, today: string = localDay()): number {
  const have = new Set(days)
  let d = have.has(today) ? today : shiftDay(today, -1)
  let n = 0
  while (have.has(d)) {
    n++
    d = shiftDay(d, -1)
  }
  return n
}

/** Keyboard/swipe step through a list of days: `delta` +1 = next item in list order. */
export function stepDay(days: readonly string[], current: string | null, delta: number): string | null {
  if (!days.length) return null
  if (!current) return days[delta >= 0 ? 0 : days.length - 1] ?? null
  const i = days.indexOf(current)
  if (i < 0) return days[0] ?? null
  const j = Math.max(0, Math.min(days.length - 1, i + delta))
  return days[j] ?? null
}

/** `n entries` label. */
export function entryCountLabel(n: number): string {
  return n === 1 ? '1 entry' : `${n} entries`
}
