export function newId(prefix = ''): string {
  const rand = Math.random().toString(16).slice(2, 8)
  const stamp = new Date().toISOString().slice(0, 10)
  return prefix ? `${prefix}-${stamp}-${rand}` : `${stamp}-${rand}`
}

export function slugify(s: string, max = 48): string {
  const slug =
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  return slug.slice(0, max).replace(/-+$/, '') || 'untitled'
}

// --- frontmatter ---------------------------------------------------------------

function fmEscape(v: string): string {
  return v.includes(':') || v.includes('#') || v.includes('"') ? `"${v.replace(/"/g, '\\"')}"` : v
}

export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => fmEscape(String(x))).join(', ')}]`)
    } else {
      lines.push(`${k}: ${fmEscape(String(v))}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n')
}

function unquote(s: string): string {
  s = s.trim()
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  return s
}

function parseList(s: string): string[] {
  s = s.trim()
  if (!s.startsWith('[') || !s.endsWith(']')) return s ? [unquote(s)] : []
  const inner = s.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map((x) => unquote(x.trim()))
}

/** Minimal `---\nkey: value\n---\nbody` parser. Returns [data, body]. */
export function parseFrontmatter(md: string): [Record<string, string | string[]>, string] {
  if (!md.startsWith('---')) return [{}, md]
  const end = md.indexOf('\n---', 3)
  if (end === -1) return [{}, md]
  const data: Record<string, string | string[]> = {}
  for (const line of md.slice(3, end).split('\n')) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (!key) continue
    data[key] = val.startsWith('[') ? parseList(val) : unquote(val)
  }
  return [data, md.slice(end + 4).replace(/^\n/, '')]
}

/** Set or clear a portable display title while preserving other frontmatter and the body verbatim. */
export function setFrontmatterTitle(md: string, title: string): string {
  const value = title.trim()
  if (!md.startsWith('---')) return value ? `---\ntitle: ${JSON.stringify(value)}\n---\n${md}` : md
  const end = md.indexOf('\n---', 3)
  if (end === -1) return value ? `---\ntitle: ${JSON.stringify(value)}\n---\n${md}` : md
  const block = md.slice(0, end + 4).split('\n')
  const tail = md.slice(end + 4)
  let found = false
  const lines = block.flatMap((line) => {
    if (!/^title\s*:/i.test(line)) return [line]
    found = true
    return value ? [`title: ${JSON.stringify(value)}`] : []
  })
  if (value && !found) lines.splice(1, 0, `title: ${JSON.stringify(value)}`)
  if (!value && lines.slice(1, -1).every((line) => !line.trim())) return tail.replace(/^\n/, '')
  return `${lines.join('\n')}${tail}`
}
