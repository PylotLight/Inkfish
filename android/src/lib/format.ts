/**
 * Pure vault-format helpers — byte-compatible with the Mac app
 * (`src/main/vault.ts`, `src/main/ai.ts`). No RN / Expo imports here so the
 * file can be unit-tested with plain `tsc` + node.
 */
import { parseTags } from '../../../src/shared/tags'
import { DEFAULT_ROUTING_PREFS, decideRoute, keyTerms } from '../../../src/shared/routing'

export type NoteKind = 'text' | 'voice' | 'image' | 'meeting'
export type NoteStatus = 'inbox' | 'processing' | 'ready' | 'archived'
export type NoteSource = 'tray' | 'popover' | 'meeting' | 'image' | 'import' | 'android'

export interface Project {
  id: string
  name: string
  /** Vault-relative dir, e.g. `work`. */
  dir: string
}

export interface InboxItem {
  id: string
  kind: NoteKind
  raw: string
  assets: string[]
  status: NoteStatus
  projectHint?: string
  createdAt: number
}

export interface NoteEntry {
  id: string
  /** Vault-relative path, e.g. `work/2026-10-07-slug.md` (staging: `inbox/<id>.md`). */
  path: string
  title: string
  kind: NoteKind
  status: NoteStatus
  projectId: string | null
  inboxId: string | null
  tags: string[]
  snippet: string
  createdAt: number
  updatedAt: number
  size: number
}

export interface NoteDoc extends NoteEntry {
  markdown: string
  /** Raw front matter block the file had when read (`---…---`), '' when none. */
  head?: string
}

export interface ClassifyResult {
  projectId: string
  projectName: string
  title: string
  tags: string[]
  markdown: string
  provider: string
  confidence: number
  /** new note, or leave in the inbox for review (Android never appends). */
  action: 'new' | 'append' | 'review'
  reason: string
}

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

export function slugToId(slug: string): string {
  return slugify(slug, 32)
}

// --- frontmatter (must stay identical to Mac `stringifyFrontmatter`) ---

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
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  return s
}

function parseList(s: string): string[] {
  s = s.trim()
  if (!s.startsWith('[') || !s.endsWith(']')) return s ? [unquote(s)] : []
  const inner = s.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map((x) => unquote(x.trim()))
}

/**
 * Minimal `---\nkey: value\n---\nbody` parser. Returns [data, body]. Top-level
 * keys only; inline lists (`tags: [a, b]`) and YAML block lists
 * (`tags:` + `  - a` lines, as Obsidian and the Mac write them) become arrays.
 * Other indented lines (nested maps, folded text) are skipped, never read as keys.
 */
export function parseFrontmatter(md: string): [Record<string, string | string[]>, string] {
  if (!md.startsWith('---')) return [{}, md]
  const end = md.indexOf('\n---', 3)
  if (end === -1) return [{}, md]
  const data: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const raw of md.slice(3, end).split('\n')) {
    const line = raw.replace(/\r$/, '')
    const item = /^(?:\s+-|-)\s+(.*)$/.exec(line) ?? /^\s*-$/.exec(line)
    if (listKey && item) {
      const v = unquote(item[1] ?? '')
      const arr = data[listKey]
      if (v) data[listKey] = Array.isArray(arr) ? [...arr, v] : [v]
      continue
    }
    if (/^\s/.test(line)) continue // nested / continuation line
    listKey = null
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (!key) continue
    if (!val) {
      // `key:` alone: a block list may follow.
      data[key] = ''
      listKey = key
      continue
    }
    data[key] = val.startsWith('[') ? parseList(val) : unquote(val)
  }
  return [data, md.slice(end + 4).replace(/^\n/, '')]
}

// --- titles / bodies (same rules as Mac `db.ts` + `ai.ts`) ---

/**
 * Display title for a note file: front matter `title:` wins (same rule as Mac
 * title sync), then the first `# H1`, then the first line.
 */
export function titleFromFile(fm: Record<string, string | string[]>, body: string): string {
  const t = fm['title']
  if (typeof t === 'string' && t.trim()) return t.trim().slice(0, 120)
  return titleFromBody(body)
}

/** Markdown image/embed refs, stripped from list snippets so they read as text. */
export function snippetText(body: string): string {
  return body
    .replace(/!\[\[[^\]\n]*\]\]/g, '')
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function titleFromBody(body: string): string {
  const h = /^#\s+(.+)$/m.exec(body)
  if (h?.[1]) return h[1].trim().slice(0, 120)
  return body.split('\n')[0]?.trim().slice(0, 120) || 'Untitled'
}

export function titleFromRaw(raw: string): string {
  const first =
    raw
      .split('\n')
      .map((l) => l.trim().replace(/^#+\s*/, ''))
      .find((l) => l.length > 0) ?? 'Untitled'
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first
  return sentence.slice(0, 80).trim() || 'Untitled'
}

export function tagsFromRaw(raw: string, kind: NoteKind): string[] {
  const tags = new Set<string>()
  for (const m of raw.matchAll(/#([a-z0-9][a-z0-9-_]*)/gi)) {
    const t = m[1]?.toLowerCase()
    if (t) tags.add(t)
  }
  if (kind !== 'text') tags.add(kind)
  return [...tags].slice(0, 8)
}

export function formatBody(raw: string, kind: NoteKind): string {
  const text = raw.trim()
  if (kind === 'meeting') return text
  return text
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => (/^\s*[*•]\s+/.test(l) ? l.replace(/^\s*[*•]\s+/, '- ') : l))
    .join('\n')
}

/**
 * Rules router — the same content-based scoring as the Mac (src/shared/routing.ts), over the notes
 * index (title + snippet). Never guesses a folder: unsure captures stay in the inbox for review.
 * Android doesn't append to existing notes (yet), so append is off here.
 */
export function rulesClassify(
  raw: string,
  kind: NoteKind,
  projects: Project[],
  projectHint?: string,
  notes: readonly NoteEntry[] = []
): ClassifyResult {
  const vault = notes.filter((n) => !n.path.startsWith('inbox/') && !n.path.startsWith('daily/'))
  const terms = keyTerms(raw, 12)
  const docs = vault
    .filter((n) => {
      const hay = `${n.title}\n${n.snippet}\n${n.tags.join(' ')}`.toLowerCase()
      return terms.some((t) => hay.includes(t))
    })
    .slice(0, 60)
    .map((n) => ({ path: n.path, title: n.title, kind: n.kind, tags: n.tags, body: n.snippet }))
  const d = decideRoute({
    raw,
    kind,
    folders: projects.map((p) => ({ id: p.id, name: p.name, dir: p.dir })),
    notes: vault.map((n) => ({ path: n.path, kind: n.kind, tags: n.tags })),
    docs,
    prefs: { ...DEFAULT_ROUTING_PREFS, allowAppend: false },
    hint: projectHint
  })
  const p = d.folder ? projects.find((x) => x.dir === d.folder) : undefined
  return {
    projectId: p?.id ?? (d.folder ? slugToId(d.folder) : ''),
    projectName: d.folder ?? '',
    title: titleFromRaw(raw),
    tags: d.tags,
    markdown: formatBody(raw, kind),
    provider: d.provider,
    confidence: d.confidence,
    action: d.action === 'append' ? 'new' : d.action,
    reason: d.reason
  }
}

/** Folder-derived project for a vault-relative path (same rule as Mac `projectFromPath`). */
export function projectFromPath(vaultRel: string): string | null {
  const parts = vaultRel.split('/')
  if (parts[0] === 'projects' && parts[1]) return parts[1] ?? null
  if (parts[0] === 'inbox' || parts[0] === 'daily') return null
  return parts.length > 1 ? (parts[0] ?? null) : null
}

/** Build a `NoteEntry` from raw file text + stat info (mirrors Mac `indexFile`). */
export function entryFromFile(vaultRel: string, text: string, stat: { size: number; mtime: number }): NoteEntry {
  const [fm, body] = parseFrontmatter(text)
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const id = str(fm['id']) ?? vaultRel
  const kind = (str(fm['kind']) as NoteKind | null) ?? 'text'
  const status = (str(fm['status']) as NoteStatus | null) ?? (vaultRel.startsWith('inbox/') ? 'inbox' : 'ready')
  const fromFm = str(fm['project'])
  const fromPath = projectFromPath(vaultRel)
  const projectId = fromFm ?? (fromPath ? slugToId(fromPath) : null)
  const inboxId = str(fm['inbox'])
  // Inline `[a, b]`, YAML block lists and `a, b` scalars — the Mac's own reader.
  const tags = parseTags(text)
  let createdAt = str(fm['created']) ? Date.parse(str(fm['created']) as string) : NaN
  if (!Number.isFinite(createdAt)) createdAt = stat.mtime
  const clean = snippetText(body.replace(/^\s*#\s+.*(\n|$)/, ''))
  return {
    id,
    path: vaultRel,
    title: titleFromFile(fm, body),
    kind,
    status,
    projectId,
    inboxId,
    tags,
    snippet: clean.slice(0, 220),
    createdAt,
    updatedAt: stat.mtime,
    size: stat.size
  }
}

/** Build an `InboxItem` from a staging inbox file (mirrors Mac `readInboxItem`). */
export function inboxFromFile(id: string, text: string): InboxItem {
  const [fm, body] = parseFrontmatter(text)
  const created = typeof fm['created'] === 'string' ? Date.parse(fm['created']) : NaN
  const assets = fm['assets']
  return {
    id: String(fm['id'] ?? id),
    kind: (fm['kind'] as NoteKind) ?? 'text',
    raw: body.replace(/\s+$/, ''),
    assets: Array.isArray(assets) ? (assets as string[]) : [],
    status: (fm['status'] as NoteStatus) ?? 'inbox',
    projectHint: typeof fm['projectHint'] === 'string' ? fm['projectHint'] : 'auto',
    createdAt: Number.isFinite(created) ? (created as number) : 0
  }
}
