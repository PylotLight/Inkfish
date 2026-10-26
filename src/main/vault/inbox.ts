import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { InboxItem, NoteKind, NoteSource, NoteStatus } from '../../shared/types'
import type { InboxRoute } from '../../shared/routing'
import { undoneDir } from './appdata'
import { ensureVault } from './bootstrap'
import { assertInside, resolveDirRel } from './fs'
import { newId, parseFrontmatter, slugify, stringifyFrontmatter } from './frontmatter'
import { vaultPaths } from './paths'
import { slugToId } from './projects'
import type { InboxWriteInput, RouteInput, VaultPaths } from './types'

// --- inbox ---------------------------------------------------------------------

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
    assets: input.assets ?? [],
    ...(input.previewed ? { routePreview: input.previewed } : {})
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
      createdAt,
      ...(input.previewed ? { previewed: input.previewed } : {})
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
    createdAt: Number.isFinite(created) ? created : 0,
    route: readRoute(fm),
    ...(typeof fm['routePreview'] === 'string' && fm['routePreview'] ? { previewed: fm['routePreview'] } : {})
  }
}

export function setInboxStatus(id: string, status: NoteStatus, paths: VaultPaths = vaultPaths()): boolean {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return false
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  fm['status'] = status
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) flat[k] = v
  writeFileSync(file, `${stringifyFrontmatter(flat)}${body}`, 'utf8')
  return true
}

const ROUTE_KEYS = [
  'routeAction',
  'routeFolder',
  'routeRel',
  'routeReason',
  'routeConfidence',
  'routeProvider',
  'routeSuggested',
  'routeTitle',
  'routeTags',
  'routeMarkdown'
] as const

/** Record (or clear, with null) the router's result on the raw inbox capture. */
export function setInboxRoute(id: string, route: InboxRoute | null, paths: VaultPaths = vaultPaths()): boolean {
  const file = join(paths.inboxDir, `${id}.md`)
  if (!existsSync(file)) return false
  const [fm, body] = parseFrontmatter(readFileSync(file, 'utf8'))
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) if (!(ROUTE_KEYS as readonly string[]).includes(k)) flat[k] = v
  if (route) {
    flat['routeAction'] = route.action
    flat['routeFolder'] = route.folder
    flat['routeRel'] = route.rel
    flat['routeReason'] = route.reason.replace(/[\r\n]+/g, ' ').slice(0, 200)
    flat['routeConfidence'] = route.confidence.toFixed(2)
    flat['routeProvider'] = route.provider
    flat['routeSuggested'] = route.suggested ? 'true' : 'false'
    flat['routeTitle'] = route.title ?? ''
    flat['routeTags'] = route.tags ?? []
    if (route.markdown) flat['routeMarkdown'] = Buffer.from(route.markdown, 'utf8').toString('base64')
  }
  writeFileSync(file, `${stringifyFrontmatter(flat)}${body}`, 'utf8')
  return true
}

function readRoute(fm: Record<string, string | string[]>): InboxRoute | undefined {
  const s = (k: string): string => (typeof fm[k] === 'string' ? (fm[k] as string) : '')
  const action = s('routeAction')
  if (action !== 'new' && action !== 'append' && action !== 'review') return undefined
  const conf = Number(s('routeConfidence'))
  const tags = Array.isArray(fm['routeTags']) ? fm['routeTags'].filter((t): t is string => typeof t === 'string') : []
  const encodedMarkdown = s('routeMarkdown')
  return {
    action,
    folder: s('routeFolder'),
    rel: s('routeRel'),
    reason: s('routeReason'),
    confidence: Number.isFinite(conf) ? conf : 0,
    provider: s('routeProvider'),
    suggested: s('routeSuggested') === 'true',
    ...(s('routeTitle') ? { title: s('routeTitle') } : {}),
    ...(tags.length ? { tags } : {}),
    ...(encodedMarkdown ? { markdown: Buffer.from(encodedMarkdown, 'base64').toString('utf8') } : {})
  }
}

export function listInbox(paths: VaultPaths = vaultPaths()): InboxItem[] {
  if (!existsSync(paths.inboxDir)) return []
  const items: InboxItem[] = []
  for (const f of readdirSync(paths.inboxDir)) {
    if (!f.endsWith('.md')) continue
    const item = readInboxItem(basename(f, '.md'), paths)
    if (item) items.push(item)
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

// --- processed notes ------------------------------------------------------------

/** Stable collision-safe vault-relative path shown for a new-note proposal. */
export function proposeNotePath(
  folder: string,
  title: string,
  createdAt: number,
  paths: VaultPaths = vaultPaths()
): string {
  if (folder.split(/[\\/]/).some((part) => part === '..')) throw new Error('invalid note folder')
  const requestedFolder = folder.trim().replace(/^[/\\]+|[/\\]+$/g, '')
  const folderRel = requestedFolder
    ? existsSync(join(paths.root, requestedFolder))
      ? requestedFolder
      : resolveDirRel(requestedFolder, paths)
    : ''
  const dir = join(paths.root, folderRel)
  const stamp = new Date(Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now())
    .toISOString()
    .slice(0, 10)
  const base = `${stamp}-${slugify(title)}`
  const reserved = new Set<string>()
  if (existsSync(paths.inboxDir)) {
    for (const entry of readdirSync(paths.inboxDir)) {
      if (!entry.endsWith('.md')) continue
      try {
        const [fm] = parseFrontmatter(readFileSync(join(paths.inboxDir, entry), 'utf8'))
        if (fm['routeAction'] === 'new' && fm['routeSuggested'] === 'true' && typeof fm['routeRel'] === 'string') {
          reserved.add(fm['routeRel'])
        }
      } catch {
        // Ignore unreadable inbox items; they cannot safely reserve a proposal path.
      }
    }
  }
  let suffix = 1
  let filename = ''
  let rel = ''
  do {
    filename = `${base}${suffix === 1 ? '' : ` ${suffix}`}.md`
    rel = folderRel ? join(folderRel, filename) : filename
    suffix++
  } while (existsSync(join(dir, filename)) || reserved.has(rel))
  assertInside(paths.root, join(paths.root, rel), rel)
  return rel
}

/** Write the processed note at its approved path (or propose a safe path for legacy callers). */
export function routeToProject(
  input: RouteInput,
  paths: VaultPaths = vaultPaths()
): { noteId: string; path: string; vaultRel: string } {
  ensureVault(paths)
  const title =
    input.title
      .trim()
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 80) || 'Untitled'
  const rel = input.vaultRel ?? proposeNotePath(input.projectName, title, input.createdAt ?? Date.now(), paths)
  if (!rel || rel.split(/[\\/]/).some((part) => part === '..') || !rel.toLowerCase().endsWith('.md')) {
    throw new Error('invalid proposed note path')
  }
  const file = join(paths.root, rel)
  assertInside(paths.root, file, rel)
  if (existsSync(file)) throw new Error(`${rel} already exists`)
  mkdirSync(dirname(file), { recursive: true })
  const noteId = newId('n')
  const createdAt = Number.isFinite(input.createdAt) && (input.createdAt ?? 0) > 0 ? input.createdAt! : Date.now()
  const folderRel = dirname(rel) === '.' ? '' : dirname(rel)
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    ...(folderRel ? { project: slugToId(folderRel.split('/')[0] ?? folderRel) } : {}),
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  })
  writeFileSync(file, `${fm}# ${title}\n\n${input.markdown.replace(/\s+$/, '')}\n`, 'utf8')
  return { noteId, path: file, vaultRel: relative(paths.root, file) }
}

/** Hidden markers around an appended capture, so undo/delete can strip just that section. */
export const appendMarker = (inboxId: string): { open: string; close: string } => ({
  open: `<!-- inkfish:inbox ${inboxId} -->`,
  close: `<!-- /inkfish:inbox ${inboxId} -->`
})

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `## 2026-10-23 14:02` in local time. */
export function appendHeading(at: Date): string {
  return `## ${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/**
 * Append a capture to an existing vault note as a dated section wrapped in hidden inbox markers.
 * Front matter and the rest of the note are left byte-for-byte.
 */
export function appendToNote(
  targetRel: string,
  input: { inboxId: string; markdown: string; at?: Date },
  paths: VaultPaths = vaultPaths()
): { path: string; vaultRel: string } {
  const abs = join(paths.root, targetRel)
  assertInside(paths.root, abs, targetRel)
  if (!existsSync(abs)) throw new Error(`${targetRel} not found`)
  const { open, close } = appendMarker(input.inboxId)
  const existing = readFileSync(abs, 'utf8')
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  const section = `${appendHeading(input.at ?? new Date())}\n${open}\n${input.markdown.replace(/\s+$/, '')}\n${close}\n`
  writeFileSync(abs, `${existing}${sep}${section}`, 'utf8')
  return { path: abs, vaultRel: relative(paths.root, abs) }
}

/**
 * Remove an appended section (heading + marked body) from `text`. Returns the stripped text and the
 * removed section, or null when the markers aren't there.
 */
export function stripAppended(text: string, inboxId: string): { text: string; removed: string } | null {
  const { open, close } = appendMarker(inboxId)
  const i = text.indexOf(open)
  if (i === -1) return null
  const j = text.indexOf(close, i)
  if (j === -1) return null
  let start = i
  // Take the dated heading line right above the marker with it.
  const before = text.slice(0, i)
  const m = /(^|\n)(## [^\n]*)\n$/.exec(before)
  if (m) start = before.length - m[2]!.length - 1
  let end = j + close.length
  if (text[end] === '\n') end++
  let head = text.slice(0, start)
  // Drop the blank line the append added in front.
  if (head.endsWith('\n\n')) head = head.slice(0, -1)
  return { text: head + text.slice(end), removed: text.slice(start, end) }
}

/**
 * Undo a routing: inbox item back to `inbox`. A note created for it is moved aside (app data); a
 * section appended to an existing note is cut out of that note (and kept aside too). Vault rels it
 * changed are pushed onto `touched` when given (for a targeted reindex).
 */
export function undoRoute(inboxId: string, paths: VaultPaths = vaultPaths(), touched?: string[]): boolean {
  // Only routed notes carry an `inbox:` front matter ref, and only appended sections carry the
  // hidden marker, so walking the vault is safe — user files never match.
  let found = false
  if (!existsSync(paths.root)) return false
  const marker = appendMarker(inboxId).open
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.name.startsWith('.')) continue
      const p = join(dir, f.name)
      if (f.isDirectory()) {
        walk(p)
        continue
      }
      if (!f.name.endsWith('.md')) continue
      const text = readFileSync(p, 'utf8')
      const [fm] = parseFrontmatter(text)
      if (fm['inbox'] === inboxId) {
        const trashed = join(undoneDir(), `${inboxId}-${basename(p)}`)
        writeFileSync(trashed, text)
        // Remove the original (raw inbox .md is untouched — nothing lost).
        unlinkSync(p)
        touched?.push(relative(paths.root, p))
        found = true
      } else if (text.includes(marker)) {
        const cut = stripAppended(text, inboxId)
        if (!cut) continue
        writeFileSync(join(undoneDir(), `${inboxId}-appended-${basename(p)}`), cut.removed)
        writeFileSync(p, cut.text, 'utf8')
        touched?.push(relative(paths.root, p))
        found = true
      }
    }
  }
  walk(paths.root)
  setInboxStatus(inboxId, 'inbox', paths)
  setInboxRoute(inboxId, null, paths)
  return found
}

/** Permanently delete an inbox capture: routed outputs moved aside, raw removed. */
export function deleteInboxItem(inboxId: string, paths: VaultPaths = vaultPaths()): boolean {
  undoRoute(inboxId, paths)
  const file = join(paths.inboxDir, `${inboxId}.md`)
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}
