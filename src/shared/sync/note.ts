import { joinEntries, splitEntries } from '../daily'
import { mergeText } from './diff3'

/**
 * Note-aware merges. Frontmatter merges per top-level key (raw lines kept, so
 * neither app's YAML formatting is rewritten); bodies use diff3; day logs are
 * a union of their daily bullets, including legacy timestamped entries (see shared/daily).
 */

interface Fm {
  keys: string[]
  /** key → raw lines (the `key:` line plus any indented/list continuation). */
  raw: Map<string, string[]>
}

export function splitFrontmatter(md: string): { fm: Fm | null; body: string } {
  if (!md.startsWith('---\n')) return { fm: null, body: md }
  const end = md.indexOf('\n---', 4)
  if (end < 0) return { fm: null, body: md }
  const block = md.slice(4, end)
  let rest = md.slice(end + 4)
  if (rest.startsWith('\n')) rest = rest.slice(1)
  const fm: Fm = { keys: [], raw: new Map() }
  let cur: string | null = null
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):/.exec(line)
    if (m && !/^\s/.test(line)) {
      cur = m[1]!
      fm.keys.push(cur)
      fm.raw.set(cur, [line])
    } else if (cur) fm.raw.get(cur)!.push(line)
  }
  return { fm, body: rest }
}

function joinFrontmatter(fm: Fm | null, body: string): string {
  if (!fm) return body
  const lines = fm.keys.flatMap((k) => fm.raw.get(k) ?? [])
  return `---\n${lines.join('\n')}\n---\n${body}`
}

function listItems(lines: string[]): string[] | null {
  // `tags: [a, b]` or `tags:` + `  - a` lines.
  const inline = /^[^:]+:\s*\[(.*)\]\s*$/.exec(lines[0] ?? '')
  if (inline)
    return inline[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  if (lines.length > 1 && lines.slice(1).every((l) => /^\s*-\s/.test(l) || !l.trim()))
    return lines
      .slice(1)
      .filter((l) => l.trim())
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
  return null
}

function rawFm(fm: Fm | null): string {
  return fm ? fm.keys.flatMap((k) => fm.raw.get(k) ?? []).join('\n') : ''
}

function fullFm(fm: Fm | null): string {
  return fm ? `---\n${rawFm(fm)}\n---\n` : ''
}

function mergeFm(
  base: Fm | null,
  ours: Fm | null,
  theirs: Fm | null
): { fm: Fm | null; clean: boolean; whole?: string } {
  if (!ours && !theirs) return { fm: null, clean: true }
  // Adding/removing the entire header on one side while the other edits it is
  // a real conflict; merge the complete header block so both versions survive.
  if (!ours || !theirs) {
    const merged = mergeText(fullFm(base), fullFm(ours), fullFm(theirs))
    return { fm: null, clean: merged.clean, whole: merged.text }
  }

  const baseKeys = base?.keys ?? []
  const keys = baseKeys.filter((k) => ours.raw.has(k) || theirs.raw.has(k))
  const additions = [...new Set([...ours.keys, ...theirs.keys])].filter((k) => !keys.includes(k)).sort()
  keys.push(...additions)
  const out: Fm = { keys, raw: new Map() }
  const value = (lines?: string[]): string => lines?.join('\n') ?? ''
  const same = (a?: string[], b?: string[]): boolean => value(a) === value(b)
  let clean = true

  for (const k of keys) {
    const b = base?.raw.get(k)
    const o = ours.raw.get(k)
    const t = theirs.raw.get(k)
    let lines: string[] | undefined
    if (same(o, t)) lines = o
    else if (same(b, o)) lines = t
    else if (same(b, t)) lines = o
    else {
      const lo = o && listItems(o)
      const lt = t && listItems(t)
      if (lo && lt) {
        const baseItems = b ? (listItems(b) ?? []) : []
        const all = new Set([...baseItems, ...lo, ...lt])
        const additions = [...all].filter((item) => !baseItems.includes(item)).sort()
        lines = [`${k}:`, ...baseItems.filter((item) => all.has(item)), ...additions].map((line, i) =>
          i === 0 ? line : `  - ${line}`
        )
      } else {
        const merged = mergeText(value(b), value(o), value(t))
        clean &&= merged.clean
        if (merged.text !== '') lines = merged.text.split('\n')
      }
    }
    if (lines) out.raw.set(k, lines)
  }
  out.keys = out.keys.filter((k) => out.raw.has(k))
  return { fm: out.keys.length ? out : null, clean }
}

export interface NoteMergeResult {
  clean: boolean
  text: string
}

/** Merge a markdown note edited on both sides since `base`. */
export function mergeNote(base: string, ours: string, theirs: string): NoteMergeResult {
  const b = splitFrontmatter(base),
    o = splitFrontmatter(ours),
    t = splitFrontmatter(theirs)
  const fm = mergeFm(b.fm, o.fm, t.fm)
  const body = mergeText(b.body, o.body, t.body)
  return {
    clean: fm.clean && body.clean,
    text: fm.whole !== undefined ? fm.whole + body.text : joinFrontmatter(fm.fm, body.text)
  }
}

/** Day log: union of plain/timestamped bullets and legacy `## HH:MM` sections, deduped.
 *  Timestamped entries sort by time; untimed bullets retain stable side/order after them. */
export function mergeDaily(ours: string, theirs: string): string {
  const parse = (md: string): { fm: Fm | null; head: string; blocks: ReturnType<typeof splitEntries>['blocks'] } => {
    const { fm, body } = splitFrontmatter(md)
    const { head, blocks } = splitEntries(body)
    return { fm, head: head.replace(/\s+$/, ''), blocks }
  }
  const o = parse(ours),
    t = parse(theirs)
  const seen = new Set<string>()
  const all: Array<{ time: string; text: string; bullet: boolean; i: number }> = []
  for (const b of [...o.blocks, ...t.blocks]) {
    const key = b.text.replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    all.push({ ...b, i: all.length })
  }
  // Stable sort timestamped entries by time, then keep untimed bullets in side/order sequence.
  all.sort((a, b) => {
    if (a.time && b.time) return a.time.localeCompare(b.time) || a.i - b.i
    if (a.time) return -1
    if (b.time) return 1
    return a.i - b.i
  })
  const head = o.head || t.head
  const entries = joinEntries(all)
  const body = head && entries ? `${head}\n\n${entries}\n` : head ? `${head}\n` : entries ? `${entries}\n` : ''
  return joinFrontmatter(o.fm ?? t.fm, body)
}

/** `work/Idea.md` → `work/Idea (conflict · Pixel 8 · 2026-10-08 0914).md` */
export function conflictPath(path: string, device: string, at: Date = new Date()): string {
  return numberedConflictPath(path, device, at, 1)
}

/** A stable collision-safe variant for distinct conflict versions created in the same minute. */
export function numberedConflictPath(path: string, device: string, at: Date, instance: number): string {
  const dot = path.lastIndexOf('.')
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : ''
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}`
  const safe = device.replace(/[\\/:*?"<>|]/g, '').trim() || 'other device'
  const suffix = instance > 1 ? ` #${instance}` : ''
  return `${stem} (conflict · ${safe} · ${stamp}${suffix})${ext}`
}
