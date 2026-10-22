/**
 * Lightweight frontmatter `tags:` support: read (inline `[a, b]`, block `- a` lists, or a
 * comma/space separated scalar), write (inline list, other keys kept byte-for-byte), and the
 * sidebar's `#tag` / `tag:foo` search syntax. Pure, shared by main (file writes) and renderer.
 */

/** `#Work Stuff ` → `Work-Stuff`. Empty string when nothing usable is left. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .replace(/^["']|["']$/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[,[\]{}#"'`]/g, '')
    .slice(0, 64)
}

/** Dedupe case-insensitively, keep first spelling and order. */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const n = normalizeTag(t)
    if (!n) continue
    const k = n.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out
}

interface FmBlock {
  /** Lines between the `---` fences. */
  lines: string[]
  /** Text after the closing fence line (body). */
  body: string
  /** Line ending used by the file. */
  eol: string
}

function splitFm(md: string): FmBlock | null {
  const eol = md.includes('\r\n') ? '\r\n' : '\n'
  if (!md.startsWith(`---${eol}`)) return null
  const lines = md.split(eol)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      return { lines: lines.slice(1, i), body: lines.slice(i + 1).join(eol), eol }
    }
  }
  return null
}

const KEY_RE = /^([A-Za-z0-9_-]+)\s*:(.*)$/

/** [start, end) line range of the `tags:` entry (key line + indented continuation). */
function tagsRange(lines: string[]): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_RE.exec(lines[i]!)
    if (!m || m[1]!.toLowerCase() !== 'tags') continue
    let j = i + 1
    while (j < lines.length && (/^\s+\S/.test(lines[j]!) || /^-\s/.test(lines[j]!))) j++
    return [i, j]
  }
  return null
}

function parseValue(first: string, rest: string[]): string[] {
  const v = first.trim()
  if (v.startsWith('[')) {
    const inner = v.replace(/^\[/, '').replace(/\]\s*$/, '')
    return inner.split(',').map((s) => s.trim())
  }
  if (v) return v.split(/[,\s]+/)
  return rest
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.replace(/^-\s*/, ''))
}

/** Tags from a note's frontmatter (empty when there is none). */
export function parseTags(md: string): string[] {
  const fm = splitFm(md)
  if (!fm) return []
  const r = tagsRange(fm.lines)
  if (!r) return []
  const m = KEY_RE.exec(fm.lines[r[0]]!)!
  return uniqueTags(parseValue(m[2] ?? '', fm.lines.slice(r[0] + 1, r[1])))
}

function quoteTag(t: string): string {
  return /[:#,[\]{}&*!|>'"%@`]/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t
}

/**
 * Replace the note's frontmatter `tags:` with `tags` (inline list). Other frontmatter lines stay
 * untouched; no frontmatter yet → one is added; empty list → the key is removed (and a block left
 * empty is dropped). The body is never modified.
 */
export function setTags(md: string, tags: readonly string[]): string {
  const clean = uniqueTags(tags)
  const line = `tags: [${clean.map(quoteTag).join(', ')}]`
  const fm = splitFm(md)
  if (!fm) {
    if (clean.length === 0) return md
    const eol = md.includes('\r\n') ? '\r\n' : '\n'
    return `---${eol}${line}${eol}---${eol}${md}`
  }
  const lines = [...fm.lines]
  const r = tagsRange(lines)
  if (r) lines.splice(r[0], r[1] - r[0], ...(clean.length ? [line] : []))
  else if (clean.length) lines.push(line)
  if (lines.length === 0 || lines.every((l) => !l.trim())) return fm.body
  return ['---', ...lines, '---', fm.body].join(fm.eol)
}

export function addTag(md: string, tag: string): string {
  return setTags(md, [...parseTags(md), tag])
}

export function removeTag(md: string, tag: string): string {
  const k = normalizeTag(tag).toLowerCase()
  return setTags(
    md,
    parseTags(md).filter((t) => t.toLowerCase() !== k)
  )
}

// --- sidebar search ---------------------------------------------------------------------------

export interface TagQuery {
  /** Wanted tags (normalized, lower-case). */
  tags: string[]
  /** Remaining free text (searched as usual). */
  text: string
}

/**
 * `#work`, `tag:work`, `tag:#work` tokens → tag filters; everything else stays free text.
 * Null when the query has no tag token.
 */
export function parseTagQuery(query: string): TagQuery | null {
  const tags: string[] = []
  const text: string[] = []
  for (const tok of query.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(?:tag:#?|#)(.+)$/i.exec(tok)
    const t = m ? normalizeTag(m[1]!) : ''
    if (t) tags.push(t.toLowerCase())
    else text.push(tok)
  }
  return tags.length ? { tags, text: text.join(' ') } : null
}

/** Every wanted tag matches one of the note's tags exactly or as a nested parent (`a` ⊇ `a/b`). */
export function matchesTags(noteTags: readonly string[], wanted: readonly string[]): boolean {
  const have = noteTags.map((t) => normalizeTag(t).toLowerCase())
  return wanted.every((w) => have.some((h) => h === w || h.startsWith(`${w}/`)))
}
