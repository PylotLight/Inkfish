import { mergeText } from './diff3'

/**
 * Note-aware merges. Frontmatter merges per top-level key (raw lines kept, so
 * neither app's YAML formatting is rewritten); bodies use diff3; day logs are
 * a union of their `## HH:MM` sections.
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
  if (inline) return inline[1]!.split(',').map((s) => s.trim()).filter(Boolean)
  if (lines.length > 1 && lines.slice(1).every((l) => /^\s*-\s/.test(l) || !l.trim()))
    return lines.slice(1).filter((l) => l.trim()).map((l) => l.replace(/^\s*-\s*/, '').trim())
  return null
}

function mergeFm(base: Fm | null, ours: Fm | null, theirs: Fm | null): Fm | null {
  if (!ours && !theirs) return null
  if (!ours) return theirs
  if (!theirs) return ours
  const out: Fm = { keys: [...ours.keys], raw: new Map(ours.raw) }
  for (const k of theirs.keys) if (!out.keys.includes(k)) out.keys.push(k)
  const same = (a?: string[], b?: string[]): boolean => (a ?? []).join('\n') === (b ?? []).join('\n')
  for (const k of out.keys) {
    const b = base?.raw.get(k), o = ours.raw.get(k), t = theirs.raw.get(k)
    if (same(o, t)) continue
    if (same(b, o)) { if (t) out.raw.set(k, t); else { out.raw.delete(k); out.keys = out.keys.filter((x) => x !== k) } continue }
    if (same(b, t)) continue // only ours changed
    // Both changed: lists union, scalars keep ours (deterministic: caller picks "ours" = newer).
    const lo = o && listItems(o), lt = t && listItems(t)
    if (lo && lt) {
      const items = [...new Set([...lo, ...lt])]
      out.raw.set(k, [`${k}:`, ...items.map((i) => `  - ${i}`)])
    }
  }
  return out
}

export interface NoteMergeResult {
  clean: boolean
  text: string
}

/** Merge a markdown note edited on both sides since `base`. */
export function mergeNote(base: string, ours: string, theirs: string): NoteMergeResult {
  const b = splitFrontmatter(base), o = splitFrontmatter(ours), t = splitFrontmatter(theirs)
  const fm = mergeFm(b.fm, o.fm, t.fm)
  const body = mergeText(b.body, o.body, t.body)
  return { clean: body.clean, text: joinFrontmatter(fm, body.text) }
}

/** Day log: union of `## HH:MM …` sections (deduped, time-ordered). Never conflicts. */
export function mergeDaily(ours: string, theirs: string): string {
  const parse = (md: string): { head: string; secs: string[] } => {
    const { fm, body } = splitFrontmatter(md)
    const parts = body.split(/^(?=## )/m)
    const head = parts[0]!.startsWith('## ') ? '' : parts.shift()!
    return { head: joinFrontmatter(fm, head), secs: parts.map((s) => s.replace(/\s+$/, '')) }
  }
  const o = parse(ours), t = parse(theirs)
  const seen = new Set<string>()
  const all: string[] = []
  for (const s of [...o.secs, ...t.secs]) {
    const key = s.replace(/\s+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    all.push(s)
  }
  const time = (s: string): string => /^## (\d{1,2}:\d{2})/.exec(s)?.[1]?.padStart(5, '0') ?? '99:99'
  // Stable sort by time; same-minute entries keep ours-then-theirs order.
  const sorted = all.map((s, i) => ({ s, i })).sort((a, b) => time(a.s).localeCompare(time(b.s)) || a.i - b.i)
  const head = (o.head || t.head).replace(/\s+$/, '')
  return `${head}\n\n${sorted.map((x) => x.s).join('\n\n')}\n`
}

/** `work/Idea.md` → `work/Idea (conflict · Pixel 8 · 2026-10-08 0914).md` */
export function conflictPath(path: string, device: string, at: Date = new Date()): string {
  const dot = path.lastIndexOf('.')
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : ''
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}`
  const safe = device.replace(/[\\/:*?"<>|]/g, '').trim() || 'other device'
  return `${stem} (conflict · ${safe} · ${stamp})${ext}`
}
