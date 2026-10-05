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
