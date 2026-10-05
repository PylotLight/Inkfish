import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { InboxItem, NoteKind, NoteSource, NoteStatus, Project } from '../shared/types'

/**
 * Vault writer (main process only). Plain `.md` files are the source of
 * truth; sqlite (`db.ts`) is just an index. Never deletes raw inbox files.
 */

export interface VaultPaths {
  root: string
  inboxDir: string
  projectsDir: string
  assetsDir: string
  dbPath: string
}

// --- vault home: env > stored choice > default ----------------------------------
// The user's choice persists in the Electron userData dir (`inkfish.json`).
// Main startup calls `setConfigDir(app.getPath('userData'))` once; everything
// else resolves dynamically so a mid-session move just works.

let configDir: string | null = null

export function setConfigDir(dir: string): void {
  configDir = dir
}

function configPath(): string | null {
  if (!configDir) return null
  return join(configDir, 'inkfish.json')
}

export function readStoredRoot(): string | null {
  try {
    const p = configPath()
    if (!p || !existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as { vaultRoot?: unknown }
    return typeof data.vaultRoot === 'string' && data.vaultRoot ? data.vaultRoot : null
  } catch {
    return null
  }
}

export function storeRoot(root: string): void {
  const p = configPath()
  if (!p) return
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ vaultRoot: root }, null, 2))
}

/** True when INKFISH_VAULT is set (dev/tests manage the location). */
export function envManaged(): boolean {
  return !!process.env['INKFISH_VAULT']?.trim()
}

export function resolveVaultRoot(): string {
  const override = process.env['INKFISH_VAULT']
  if (override && override.trim()) return resolve(override)
  return readStoredRoot() ?? join(homedir(), 'Inkfish')
}

/** Has a vault home been established? Stored choice, env override, or a
 * pre-existing default vault (adopted from earlier versions) all count.
 * False only on true first run — the onboarding wizard must pick first. */
export function vaultConfigured(): boolean {
  if (envManaged()) return true
  if (readStoredRoot()) return true
  return existsSync(join(homedir(), 'Inkfish'))
}

export function vaultPaths(root: string = resolveVaultRoot()): VaultPaths {
  return {
    root,
    inboxDir: join(root, 'inbox'),
    projectsDir: join(root, 'projects'),
    assetsDir: join(root, 'assets'),
    dbPath: join(root, 'inkfish.db')
  }
}

export function ensureVault(paths: VaultPaths = vaultPaths()): VaultPaths {
  mkdirSync(paths.inboxDir, { recursive: true })
  mkdirSync(paths.projectsDir, { recursive: true })
  mkdirSync(paths.assetsDir, { recursive: true })
  return paths
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

// --- frontmatter ---------------------------------------------------------------

function fmEscape(v: string): string {
  return v.includes(':') || v.includes('#') || v.includes('"')
    ? `"${v.replace(/"/g, '\\"')}"`
    : v
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
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"')
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

// --- inbox ---------------------------------------------------------------------

export interface InboxWriteInput {
  kind: NoteKind
  raw: string
  projectHint?: string
  source?: NoteSource
  assets?: string[]
}

export function writeInboxItem(
  input: InboxWriteInput,
  paths: VaultPaths = vaultPaths()
): { item: InboxItem; path: string } {
  ensureVault(paths)
  const id = newId('in')
  const createdAt = Date.now()
  const status: NoteStatus = 'inbox'
  const source: NoteSource = input.source ?? 'tray'
  const fm = stringifyFrontmatter({
    id,
    kind: input.kind,
    status,
    created: new Date(createdAt).toISOString(),
    source,
    projectHint: input.projectHint ?? 'auto',
    assets: input.assets ?? []
  })
  const file = join(paths.inboxDir, `${id}.md`)
  writeFileSync(file, `${fm}${input.raw.replace(/\s+$/, '')}\n`, 'utf8')
  return {
    item: {
      id,
      kind: input.kind,
      raw: input.raw,
      assets: input.assets ?? [],
      status,
      projectHint: input.projectHint ?? 'auto',
      createdAt
    },
    path: file
  }
}

export function readInboxItem(id: string, paths: VaultPaths = vaultPaths()): InboxItem | null {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return null
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  const created = typeof fm['created'] === 'string' ? Date.parse(fm['created']) : NaN
  const assets = fm['assets']
  return {
    id: String(fm['id'] ?? id),
    kind: (fm['kind'] as NoteKind) ?? 'text',
    raw: body.replace(/\s+$/, ''),
    assets: Array.isArray(assets) ? assets : [],
    status: (fm['status'] as NoteStatus) ?? 'inbox',
    projectHint: typeof fm['projectHint'] === 'string' ? fm['projectHint'] : 'auto',
    createdAt: Number.isFinite(created) ? created : 0
  }
}

export function setInboxStatus(
  id: string,
  status: NoteStatus,
  paths: VaultPaths = vaultPaths()
): boolean {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return false
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  fm['status'] = status
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) flat[k] = v
  writeFileSync(file, `${stringifyFrontmatter(flat)}${body}`, 'utf8')
  return true
}

export function listInbox(paths: VaultPaths = vaultPaths()): InboxItem[] {
  ensureVault(paths)
  const items: InboxItem[] = []
  for (const f of readdirSync(paths.inboxDir)) {
    if (!f.endsWith('.md')) continue
    const item = readInboxItem(basename(f, '.md'), paths)
    if (item) items.push(item)
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

// --- projects ------------------------------------------------------------------

const PROJECT_COLORS = ['#6ea8fe', '#7ee2a8', '#e5a56e', '#c79bfe', '#e5636f', '#6ed3e5']

export function slugToId(slug: string): string {
  return slugify(slug, 32)
}

/** Seed projects on first run so the picker + router have somewhere to go. */
export function ensureSeedProjects(paths: VaultPaths = vaultPaths()): Project[] {
  ensureVault(paths)
  const seeds = ['personal', 'work', 'reading']
  const out: Project[] = []
  seeds.forEach((name, i) => {
    const dir = join(paths.projectsDir, name)
    mkdirSync(dir, { recursive: true })
    out.push({ id: slugToId(name), name, dir: `projects/${name}`, color: PROJECT_COLORS[i] })
  })
  // Keep user-created project dirs visible too.
  for (const f of readdirSync(paths.projectsDir, { withFileTypes: true })) {
    if (!f.isDirectory() || seeds.includes(f.name)) continue
    out.push({ id: slugToId(f.name), name: f.name, dir: `projects/${f.name}` })
  }
  return out
}

export function listProjects(paths: VaultPaths = vaultPaths()): Project[] {
  ensureVault(paths)
  const found: Project[] = []
  let i = 0
  for (const f of readdirSync(paths.projectsDir, { withFileTypes: true })) {
    if (!f.isDirectory()) continue
    found.push({
      id: slugToId(f.name),
      name: f.name,
      dir: `projects/${f.name}`,
      color: PROJECT_COLORS[i++ % PROJECT_COLORS.length]
    })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

export function createProject(name: string, paths: VaultPaths = vaultPaths()): Project {
  const slug = slugify(name, 32)
  if (!slug || slug === 'untitled') throw new Error('project name is empty')
  const dir = join(paths.projectsDir, slug)
  mkdirSync(dir, { recursive: true })
  return { id: slugToId(slug), name: slug, dir: `projects/${slug}` }
}

// --- processed notes ------------------------------------------------------------

export interface RouteInput {
  inboxId: string
  projectName: string
  title: string
  tags: string[]
  markdown: string
  kind: NoteKind
}

/** Write the processed note into `projects/<name>/`, link back to the inbox id. */
export function routeToProject(
  input: RouteInput,
  paths: VaultPaths = vaultPaths()
): { noteId: string; path: string; vaultRel: string } {
  ensureVault(paths)
  const slug = slugify(input.projectName, 32)
  const dir = join(paths.projectsDir, slug)
  mkdirSync(dir, { recursive: true })
  const noteId = newId('n')
  const createdAt = Date.now()
  const file = join(dir, `${new Date(createdAt).toISOString().slice(0, 10)}-${slugify(input.title)}.md`)
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    project: slug,
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  })
  writeFileSync(file, `${fm}# ${input.title}\n\n${input.markdown.replace(/\s+$/, '')}\n`, 'utf8')
  return { noteId, path: file, vaultRel: relative(paths.root, file) }
}

/** Undo a routing: inbox item back to `inbox`, processed file moved aside. */
export function undoRoute(inboxId: string, paths: VaultPaths = vaultPaths()): boolean {
  // Find processed notes pointing at this inbox id and archive them.
  let found = false
  if (!existsSync(paths.projectsDir)) return false
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name)
      if (f.isDirectory()) {
        walk(p)
        continue
      }
      if (!f.name.endsWith('.md')) continue
      const [fm] = parseFrontmatter(readFileSync(p, 'utf8'))
      if (fm['inbox'] === inboxId) {
        const trashed = join(dirname(p), `.${basename(p)}.undone`)
        writeFileSync(trashed, readFileSync(p))
        // Remove the original (raw inbox .md is untouched — nothing lost).
        unlinkSync(p)
        found = true
      }
    }
  }
  walk(paths.projectsDir)
  setInboxStatus(inboxId, 'inbox', paths)
  return found
}

// --- assets ---------------------------------------------------------------------

export function saveAsset(
  fileName: string,
  data: Buffer,
  paths: VaultPaths = vaultPaths()
): string {
  ensureVault(paths)
  const now = new Date()
  const dir = join(
    paths.assetsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0')
  )
  mkdirSync(dir, { recursive: true })
  const safe = `${newId('a')}${extname(fileName) || '.bin'}`
  writeFileSync(join(dir, safe), data)
  return relative(paths.root, join(dir, safe))
}

export function resolveAsset(vaultRel: string, paths: VaultPaths = vaultPaths()): string {
  return join(paths.root, vaultRel)
}

// --- meeting import --------------------------------------------------------------

/** Parse a Teams-exported `.vtt` (or plain transcript) into timestamped lines. */
export function parseVtt(text: string): Array<{ at: string; speaker: string; line: string }> {
  const out: Array<{ at: string; speaker: string; line: string }> = []
  // Drop WEBVTT header + NOTE blocks, then cue blocks.
  const body = text
    .replace(/^WEBVTT.*$/m, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  for (const block of body) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    const first = lines[0] ?? ''
    const at = timeIdx >= 0 ? (lines[timeIdx] ?? '').split('-->')[0]?.trim() ?? '' : ''
    const content = (timeIdx >= 0 ? lines.slice(timeIdx + 1) : lines).join(' ')
    if (!content || /^NOTE/i.test(first)) continue
    const m = /^<v\s+([^>]+)>(.*)<\/v>\s*$/i.exec(content) ?? /^([^:]{1,40}):\s+(.*)$/.exec(content)
    out.push({
      at,
      speaker: m ? m[1]?.trim() ?? '' : '',
      line: m ? (m[2] ?? '').trim() : content
    })
  }
  return out
}

export function meetingToMarkdown(
  cues: Array<{ at: string; speaker: string; line: string }>,
  title: string
): string {
  const attendees = [...new Set(cues.map((c) => c.speaker).filter(Boolean))]
  const transcript = cues
    .map((c) => `- ${c.at ? `**${c.at}** ` : ''}${c.speaker ? `**${c.speaker}:** ` : ''}${c.line}`)
    .join('\n')
  return (
    `> ${title} — captured transcript. Fill in decisions + actions below.\n\n` +
    `## Attendees\n\n${attendees.length > 0 ? attendees.map((a) => `- ${a}`).join('\n') : '- '}\n\n` +
    `## Decisions\n\n- \n\n## Actions\n\n- [ ] \n\n## Transcript\n\n${transcript || '- '}\n`
  )
}
