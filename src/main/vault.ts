import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { InboxItem, MeetingSaveInput, NoteKind, NoteSource, NoteStatus } from '../shared/types'
import type { InboxRoute } from '../shared/routing'
import { undoneDir } from './vault/appdata'
import { ensureVault } from './vault/bootstrap'
import { assertInside, resolveDirRel, uniqueFile } from './vault/fs'
import { newId, parseFrontmatter, slugify, stringifyFrontmatter } from './vault/frontmatter'
import { vaultPaths } from './vault/paths'
import { slugToId } from './vault/projects'
import type { InboxWriteInput, RouteInput, VaultPaths } from './vault/types'

export * from './vault/types'
export * from './vault/frontmatter'
export * from './vault/appdata'
export * from './vault/paths'
export * from './vault/fs'
export * from './vault/projects'
export * from './vault/bootstrap'
export * from './vault/files'
export * from './vault/trash'
export * from './vault/daily'

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
  'routeSuggested'
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
  }
  writeFileSync(file, `${stringifyFrontmatter(flat)}${body}`, 'utf8')
  return true
}

function readRoute(fm: Record<string, string | string[]>): InboxRoute | undefined {
  const s = (k: string): string => (typeof fm[k] === 'string' ? (fm[k] as string) : '')
  const action = s('routeAction')
  if (action !== 'new' && action !== 'append' && action !== 'review') return undefined
  const conf = Number(s('routeConfidence'))
  return {
    action,
    folder: s('routeFolder'),
    rel: s('routeRel'),
    reason: s('routeReason'),
    confidence: Number.isFinite(conf) ? conf : 0,
    provider: s('routeProvider'),
    suggested: s('routeSuggested') === 'true'
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

/** Write the processed note into `<vault>/<folder>/`, link back to the inbox id. */
export function routeToProject(
  input: RouteInput,
  paths: VaultPaths = vaultPaths()
): { noteId: string; path: string; vaultRel: string } {
  ensureVault(paths)
  const folder = input.projectName.trim().replace(/^\/+|\/+$/g, '')
  if (!folder) throw new Error('no folder to file into')
  // Exact folder, else an existing case variant (Personal vs personal); a new one is created as named.
  const rel = existsSync(join(paths.root, folder)) ? folder : resolveDirRel(folder, paths)
  const dir = join(paths.root, rel)
  assertInside(paths.root, dir, folder)
  mkdirSync(dir, { recursive: true })
  const noteId = newId('n')
  const createdAt = Date.now()
  const file = join(dir, `${new Date(createdAt).toISOString().slice(0, 10)}-${slugify(input.title)}.md`)
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    project: slugToId(rel.split('/')[0] ?? rel),
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  })
  writeFileSync(file, `${fm}# ${input.title}\n\n${input.markdown.replace(/\s+$/, '')}\n`, 'utf8')
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

// --- assets ---------------------------------------------------------------------

export function saveAsset(fileName: string, data: Buffer, paths: VaultPaths = vaultPaths()): string {
  ensureVault(paths)
  const now = new Date()
  const dir = join(paths.assetsDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  const safe = `${newId('a')}${extname(fileName) || '.bin'}`
  writeFileSync(join(dir, safe), data)
  return relative(paths.root, join(dir, safe))
}

export function resolveAsset(vaultRel: string, paths: VaultPaths = vaultPaths()): string {
  return join(paths.root, vaultRel)
}

// --- live meeting notes ---------------------------------------------------------

const fmtDuration = (sec: number): string => {
  const m = Math.round(sec / 60)
  return m < 1 ? `${Math.round(sec)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * Write a captured meeting as its own note: `<vault>/<folder>/YYYY-MM-DD HHmm Title.md`
 * with `kind: meeting`. Re-saving with `replaceRel` re-titles / re-files it.
 */
export function writeMeetingNote(input: MeetingSaveInput, paths: VaultPaths = vaultPaths()): string {
  ensureVault(paths)
  const folder = input.folder.trim().replace(/^\/+|\/+$/g, '')
  const dir = join(paths.root, folder)
  if (folder) assertInside(paths.root, dir, folder)
  mkdirSync(dir, { recursive: true })
  const started = new Date(input.startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`
  const title = input.title.trim() || 'Meeting'
  const base = `${day} ${pad(started.getHours())}${pad(started.getMinutes())} ${title.replace(/[/\\:]+/g, '-')}`.slice(
    0,
    110
  )
  const prev = input.replaceRel ? join(paths.root, input.replaceRel) : null
  if (prev) assertInside(paths.root, prev, input.replaceRel as string)
  const name =
    prev && dirname(prev) === dir && basename(prev) === `${base}.md` ? `${base}.md` : uniqueFile(dir, base, '.md')
  const abs = join(dir, name)
  const fm = stringifyFrontmatter({
    kind: 'meeting',
    created: started.toISOString(),
    duration: fmtDuration(input.durationSec),
    speakers: input.speakers,
    tags: input.tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
  })
  const when = started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const audio = input.audioRel ? `\n![](${input.audioRel})\n` : ''
  const body =
    `# ${title}\n\n> ${when} · ${fmtDuration(input.durationSec)} · ${input.speakers.join(', ')}\n${audio}\n` +
    `## Notes\n\n- \n\n## Actions\n\n- [ ] \n\n## Transcript\n\n${input.transcript.trim() || '_Nothing was transcribed._'}\n`
  writeFileSync(abs, `${fm}${body}`, 'utf8')
  if (prev && prev !== abs && existsSync(prev)) unlinkSync(prev)
  return relative(paths.root, abs)
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
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) continue
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    const first = lines[0] ?? ''
    const at = timeIdx >= 0 ? ((lines[timeIdx] ?? '').split('-->')[0]?.trim() ?? '') : ''
    const content = (timeIdx >= 0 ? lines.slice(timeIdx + 1) : lines).join(' ')
    if (!content || /^NOTE/i.test(first)) continue
    const m = /^<v\s+([^>]+)>(.*)<\/v>\s*$/i.exec(content) ?? /^([^:]{1,40}):\s+(.*)$/.exec(content)
    out.push({
      at,
      speaker: m ? (m[1]?.trim() ?? '') : '',
      line: m ? (m[2] ?? '').trim() : content
    })
  }
  return out
}

export function meetingToMarkdown(cues: Array<{ at: string; speaker: string; line: string }>, title: string): string {
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
