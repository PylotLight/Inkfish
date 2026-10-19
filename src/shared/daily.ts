/**
 * Daily notes (`daily/YYYY-MM-DD.md`): one shape shared by Mac, the quick-capture popover and
 * Android, so every device writes (and sync merges) the same thing.
 *
 * The file:
 *  - is named by ISO date (sorts, syncs, never renamed); the app shows a friendly title
 *    (`Tue 20 Oct`) in the header/tabs instead — so the body has NO `# 2026-10-20` H1 repeating it.
 *  - starts empty (front matter only). No "Day started." filler.
 *  - appended entries are compact, one bullet each, with a small time prefix:
 *
 *        - 09:10 coffee with sam
 *        - 11:30 · voice · standup notes
 *          second line of a multi-line entry (indented under its bullet)
 *
 * Older notes used `# YYYY-MM-DD` + one `## HH:MM` section per entry; everything here still
 * reads those (previews, sync merge). The exact old auto-generated "Day started." boilerplate is
 * cleaned up when nothing else is in the file — never anything the user wrote.
 */

/** `daily/2026-10-20.md` → captures `2026`, `10`, `20`. */
export const DAILY_PATH_RE = /^daily\/(\d{4})-(\d{2})-(\d{2})\.md$/

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar day (YYYY-MM-DD). A day note follows the wall clock, not UTC. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `HH:MM` on the local clock. */
export function localTime(d: Date = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `2026-10-20` → local midnight Date, or null when it isn't a real date. */
export function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return localDay(d) === day ? d : null
}

/** `daily/2026-10-20.md` → `2026-10-20` (null for anything else). */
export function dayOfPath(path: string): string | null {
  const m = DAILY_PATH_RE.exec(path)
  if (!m) return null
  const day = `${m[1]}-${m[2]}-${m[3]}`
  return parseDay(day) ? day : null
}

export function dailyPath(day: string): string {
  return `daily/${day}.md`
}

/** `2026-10-20` ± n days (calendar days, DST-safe). */
export function shiftDay(day: string, n: number): string {
  const d = parseDay(day)
  if (!d) return day
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Friendly display title: `Tue 20 Oct`, with the year when it isn't this year (`Mon 3 Nov 2025`).
 * Fixed English labels (not locale-formatted) so tests and every device agree.
 */
export function dailyTitle(day: string, now: Date = new Date()): string {
  const d = parseDay(day)
  if (!d) return day
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`
}

/** Display title for a daily-note path, or null when the path isn't one. */
export function dailyTitleForPath(path: string, now: Date = new Date()): string | null {
  const day = dayOfPath(path)
  return day ? dailyTitle(day, now) : null
}

/** One entry line: `- 09:10 text`; non-text kinds get a tag (`- 09:10 · voice · text`).
 *  Multi-line text is indented under the bullet so it stays one list item. */
export function formatEntry(raw: string, kind: string = 'text', at: Date = new Date()): string {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  const [first = '', ...rest] = text.split('\n')
  const tag = kind && kind !== 'text' ? ` · ${kind} ·` : ''
  const head = `- ${localTime(at)}${tag} ${first}`.replace(/\s+$/, '')
  const tail = rest.map((l) => (l.trim() ? `  ${l}` : ''))
  return [head, ...tail].join('\n')
}

/** Entry bullet start (`- 09:10 …`, `- 9:10`). */
const ENTRY_RE = /^- (\d{1,2}:\d{2})(?=\s|$)/
/** Legacy per-entry heading (`## 09:10`, `## 09:10 · voice`). */
const LEGACY_RE = /^## (\d{1,2}:\d{2})(?=\s|$)/

/** True when the last block of `body` is an entry bullet (so the next one joins the same list). */
function endsWithEntry(body: string): boolean {
  const lines = body.replace(/\s+$/, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? ''
    if (ENTRY_RE.test(l)) return true
    if (/^\s+\S/.test(l)) continue // continuation line of a multi-line entry
    return false
  }
  return false
}

/** Append an entry to a note body: tight list after another entry, blank line otherwise. */
export function appendEntry(body: string, entry: string): string {
  const prev = body.replace(/\s+$/, '')
  if (!prev) return `${entry}\n`
  return `${prev}${endsWithEntry(prev) ? '\n' : '\n\n'}${entry}\n`
}

/**
 * The old generated body, exactly: `# <day>` + one `## HH:MM` section holding `_Day started._`.
 * Only this exact shape counts — a single extra character means the user touched it.
 */
export function isLegacyBoilerplate(body: string, day: string): boolean {
  const re = new RegExp(`^# ${day.replace(/-/g, '\\-')}\\n\\n## \\d{2}:\\d{2}\\n\\n_Day started\\._\\n*$`)
  return re.test(body)
}

/** Drop a leading `# YYYY-MM-DD` heading (the old duplicate title) for read-only previews. */
export function stripLegacyTitle(body: string): string {
  return body.replace(/^#\s+\d{4}-\d{2}-\d{2}[ \t]*(?:\n+|$)/, '')
}

export interface DailyEntry {
  time: string
  /** First non-blank line of the entry, kind tag removed. */
  text: string
  kind?: string
}

/** Every timestamped entry in a body, in file order (new bullets and legacy `## HH:MM` sections). */
export function parseEntries(body: string): DailyEntry[] {
  const out: DailyEntry[] = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const bullet = ENTRY_RE.exec(line)
    if (bullet) {
      let rest = line.slice(bullet[0].length).trim()
      let kind: string | undefined
      const tagged = /^· (\w+) ·\s*/.exec(rest)
      if (tagged) {
        kind = tagged[1]
        rest = rest.slice(tagged[0].length)
      }
      if (!rest) {
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j] ?? ''); j++) {
          rest = (lines[j] ?? '').trim()
          break
        }
      }
      out.push({ time: bullet[1]!.padStart(5, '0'), text: rest, ...(kind ? { kind } : {}) })
      continue
    }
    const legacy = LEGACY_RE.exec(line)
    if (legacy) {
      const kind = /·\s*(\w+)/.exec(line.slice(legacy[0].length))?.[1]
      let text = ''
      for (let j = i + 1; j < lines.length; j++) {
        const t = (lines[j] ?? '').trim()
        if (/^## /.test(lines[j] ?? '') || ENTRY_RE.test(lines[j] ?? '')) break
        if (t) {
          text = t
          break
        }
      }
      out.push({ time: legacy[1]!.padStart(5, '0'), text, ...(kind ? { kind } : {}) })
    }
  }
  return out
}

/**
 * Split a body into free text before the first entry (`head`) and entry blocks. A block runs
 * until the next entry start; anything in between (continuation lines, notes typed under an
 * entry) belongs to the block above it. Used by the sync merge.
 */
export function splitEntries(body: string): { head: string; blocks: Array<{ time: string; text: string; bullet: boolean }> } {
  const lines = body.split('\n')
  const headLines: string[] = []
  const blocks: Array<{ time: string; lines: string[]; bullet: boolean }> = []
  for (const line of lines) {
    const b = ENTRY_RE.exec(line)
    const l = b ? null : LEGACY_RE.exec(line)
    if (b || l) {
      blocks.push({ time: (b ?? l)![1]!.padStart(5, '0'), lines: [line], bullet: !!b })
    } else if (blocks.length) {
      blocks[blocks.length - 1]!.lines.push(line)
    } else {
      headLines.push(line)
    }
  }
  return {
    head: headLines.join('\n'),
    blocks: blocks.map((x) => ({ time: x.time, bullet: x.bullet, text: x.lines.join('\n').replace(/\s+$/, '') }))
  }
}

/** Join entry blocks back: bullets after bullets stay one tight list; legacy sections get blank lines. */
export function joinEntries(blocks: Array<{ text: string; bullet: boolean }>): string {
  let out = ''
  blocks.forEach((b, i) => {
    if (i > 0) out += blocks[i - 1]!.bullet && b.bullet ? '\n' : '\n\n'
    out += b.text
  })
  return out
}

/** Split raw file text into its front matter block (verbatim, `---` lines + trailing newline
 *  included; '' when there is none) and the body. `fm + body` is always the original text. */
export function splitDailyFile(raw: string): { fm: string; body: string } {
  if (!raw.startsWith('---\n')) return { fm: '', body: raw }
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return { fm: '', body: raw }
  let cut = end + 4
  if (raw[cut] === '\n') cut++
  return { fm: raw.slice(0, cut), body: raw.slice(cut) }
}

/** Raw text of a day note after appending `entry` (front matter kept verbatim). */
export function appendToDailyFile(raw: string, entry: string): string {
  const { fm, body } = splitDailyFile(raw)
  return `${fm}${appendEntry(body, entry)}`
}

/** The day note's new raw text when it is exactly the old generated boilerplate, else null. */
export function migrateLegacyDaily(raw: string, day: string): string | null {
  const { fm, body } = splitDailyFile(raw)
  return isLegacyBoilerplate(body, day) ? fm : null
}
