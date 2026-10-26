import * as FileSystem from 'expo-file-system/legacy'
import {
  inboxFromFile,
  newId,
  slugify,
  stringifyFrontmatter,
  type InboxItem,
  type NoteKind,
  type NoteSource,
  type NoteStatus
} from '../format'
import { INBOX, UNDONE, VAULT } from './state'
import { ensureTree, mkdir, readText, writeText } from './paths'
import { childFiles, mapLimit } from './fs'
import { walkVault } from './scan'

// --- inbox ---

export interface InboxWriteInput {
  kind: NoteKind
  raw: string
  projectHint?: string
  source?: NoteSource
  assets?: string[]
}

export async function writeInboxItem(input: InboxWriteInput): Promise<InboxItem> {
  await ensureTree()
  const id = newId('in')
  const createdAt = Date.now()
  const fm = stringifyFrontmatter({
    id,
    kind: input.kind,
    status: 'inbox' satisfies NoteStatus,
    created: new Date(createdAt).toISOString(),
    source: input.source ?? 'android',
    projectHint: input.projectHint ?? 'auto',
    assets: input.assets ?? []
  })
  await writeText(`${INBOX}${id}.md`, `${fm}${input.raw.replace(/\s+$/, '')}\n`)
  return {
    id,
    kind: input.kind,
    raw: input.raw,
    assets: input.assets ?? [],
    status: 'inbox',
    projectHint: input.projectHint ?? 'auto',
    createdAt
  }
}

export async function listInbox(): Promise<InboxItem[]> {
  await ensureTree()
  const files = await childFiles(INBOX)
  const read = await mapLimit(files, 8, async (f): Promise<InboxItem | null> => {
    try {
      return inboxFromFile(f.replace(/\.md$/, ''), await readText(`${INBOX}${f}`))
    } catch {
      return null // skip unreadable captures
    }
  })
  const items = read.filter((i): i is InboxItem => i !== null)
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function setInboxStatus(id: string, status: NoteStatus): Promise<boolean> {
  const uri = `${INBOX}${id}.md`
  const info = await FileSystem.getInfoAsync(uri)
  if (!info.exists) return false
  const { parseFrontmatter } = await import('../format')
  const [fm, body] = parseFrontmatter(await readText(uri))
  fm['status'] = status
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) flat[k] = v
  await writeText(uri, `${stringifyFrontmatter(flat)}${body}`)
  return true
}

// --- routing (rules engine; same output shape as Mac `routeToProject`) ---

export interface RouteInput {
  inboxId: string
  projectName: string
  title: string
  tags: string[]
  markdown: string
  kind: NoteKind
}

export async function routeToProject(input: RouteInput): Promise<{ noteId: string; vaultRel: string }> {
  await ensureTree()
  const slug = slugify(input.projectName, 32)
  await mkdir(`${VAULT}${slug}/`)
  const noteId = newId('n')
  const createdAt = Date.now()
  const day = new Date(createdAt).toISOString().slice(0, 10)
  const base = `${day}-${slugify(input.title)}`
  let name = `${base}.md`
  let i = 1
  while ((await FileSystem.getInfoAsync(`${VAULT}${slug}/${name}`)).exists) {
    i++
    name = `${base} ${i}.md`
  }
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    project: slug,
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  })
  const rel = `${slug}/${name}`
  await writeText(`${VAULT}${rel}`, `${fm}# ${input.title}\n\n${input.markdown.replace(/\s+$/, '')}\n`)
  return { noteId, vaultRel: rel }
}

/** Undo a routing: processed file → staging/undone, inbox item back to `inbox`. */
export async function undoRoute(inboxId: string): Promise<boolean> {
  await ensureTree()
  const rels: string[] = []
  await walkVault(VAULT, '', rels)
  let found = false
  const { parseFrontmatter } = await import('../format')
  for (const rel of rels) {
    try {
      const text = await readText(`${VAULT}${rel}`)
      const [fm] = parseFrontmatter(text)
      if (fm['inbox'] === inboxId) {
        const base = rel.split('/').slice(-1)[0] ?? `${inboxId}.md`
        await writeText(`${UNDONE}${inboxId}-${base}`, text)
        await FileSystem.deleteAsync(`${VAULT}${rel}`, { idempotent: true })
        found = true
      }
    } catch {
      // keep going
    }
  }
  await setInboxStatus(inboxId, 'inbox')
  return found
}
