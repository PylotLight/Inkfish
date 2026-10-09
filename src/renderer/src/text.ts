/** Strip markdown chrome for titles, list rows and dashboard text. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Filename without dirs or `.md` — the Obsidian-style display title. */
export function baseName(vaultPath: string): string {
  const f = vaultPath.split('/').pop() ?? vaultPath
  return f.toLowerCase().endsWith('.md') ? f.slice(0, -3) : f
}

export interface Titled {
  id: string
  path: string
  title: string
}

/**
 * Obsidian-style title: custom override (app config) wins, else the .md
 * filename, else the indexed first line. Inbox raws keep their first line.
 */
export function displayTitle(e: Titled, overrides: Record<string, string>): string {
  if (e.path.startsWith('inbox/')) return plain(e.title).slice(0, 120) || e.id
  const o = overrides[e.id]
  if (o && o.trim()) return o.trim()
  const b = baseName(e.path)
  if (b) return b
  return plain(e.title).slice(0, 120) || 'Untitled'
}

/** Drop a leading `# H1` that duplicates the display title (double header). */
export function dropDupH1(src: string, title: string): string {
  const lines = src.split('\n')
  const m = /^#\s+(.*)$/.exec(lines[0] ?? '')
  if (m && title && plain(m[1] ?? '').toLowerCase() === title.toLowerCase()) {
    return lines.slice(1).join('\n')
  }
  return src
}

/** `12345` → `12.0k chars`; small counts stay exact. */
export function fmtChars(n: number): string {
  if (n < 1000) return `${n} chars`
  return `${(n / 1024).toFixed(1)}k chars`
}

/** `24576` → `24.0 KB`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** `Date.now() - 3h` → `3h ago`. */
export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Ordinal positions of every case-insensitive `query` hit in `text`. */
export function findAll(text: string, query: string): number[] {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: number[] = []
  let from = 0
  while (true) {
    const i = hay.indexOf(needle, from)
    if (i < 0) return out
    out.push(i)
    from = i + Math.max(1, needle.length)
  }
}
