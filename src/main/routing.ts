import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_ROUTING_PREFS,
  keyTerms,
  sanitizeRoutingPrefs,
  type InboxRoute,
  type RouteDoc,
  type RoutingPrefs
} from '../shared/routing'
import type { ClassifyResult, NoteEntry } from '../shared/types'
import { classify, type RouteLlm } from './ai'
import { indexFile, indexPath, removePath, routeHits, routeMeta } from './db'
import {
  appDataDir,
  appendToNote,
  listProjects,
  readInboxItem,
  routeToProject,
  setInboxRoute,
  setInboxStatus,
  undoRoute,
  type VaultPaths
} from './vault'

/**
 * Settings › Routing prefs (app data `routing.json`, read by the main-process router), the vault
 * evidence the router scores against (FTS5 hits for the capture's key terms plus every note's
 * kind/tags), and filing one inbox capture. Electron-free so it runs under `bun test`.
 */

function prefsPath(): string | null {
  const dir = appDataDir()
  return dir ? join(dir, 'routing.json') : null
}

export function loadRoutingPrefs(): RoutingPrefs {
  try {
    const p = prefsPath()
    if (!p || !existsSync(p)) return { ...DEFAULT_ROUTING_PREFS }
    return sanitizeRoutingPrefs(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return { ...DEFAULT_ROUTING_PREFS }
  }
}

export function saveRoutingPrefs(patch: Partial<RoutingPrefs>): RoutingPrefs {
  const next = sanitizeRoutingPrefs({ ...loadRoutingPrefs(), ...(patch ?? {}) })
  const p = prefsPath()
  if (p) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(next, null, 2))
  }
  return next
}

/** Router evidence for one capture, straight from the index (no file reads). */
export function routeCorpus(raw: string): {
  notes: Array<{ path: string; kind: string; tags: string[] }>
  docs: RouteDoc[]
  totalDocs: number
} {
  const notes = routeMeta()
  const docs: RouteDoc[] = routeHits(keyTerms(raw, 12), 60).map((h) => ({
    path: h.path,
    title: h.title,
    kind: h.kind,
    tags: h.tagList,
    body: h.body.slice(0, 20_000)
  }))
  return { notes, docs, totalDocs: notes.length }
}

// --- route one inbox capture -----------------------------------------------------------------

export interface RouteOutcome {
  /** The note written or appended to; null when left in the inbox (review / suggest-only). */
  note: NoteEntry | null
  classify: ClassifyResult
  route: InboxRoute
}

export interface RouteOptions {
  /** File it now (false = record the suggestion only; Settings › Routing auto-file off). */
  apply: boolean
  /** Explicit folder (Move → / picker) — overrides the capture's own hint. */
  hint?: string
  llm?: RouteLlm | null
}

const inboxRel = (id: string): string => `inbox/${id}.md`

/**
 * Classify + file one inbox capture: a new note in a folder, a dated section appended to a related
 * note, or nothing (left in the inbox with the reason). The raw capture is never deleted.
 */
export async function routeInboxItem(
  id: string,
  paths: VaultPaths,
  opts: RouteOptions
): Promise<RouteOutcome | { error: string }> {
  const item = readInboxItem(id, paths)
  if (!item) return { error: `inbox item ${id} not found` }
  const reindexInbox = (): void => void indexFile(join(paths.inboxDir, `${id}.md`), inboxRel(id))
  setInboxStatus(id, 'processing', paths)
  reindexInbox()
  try {
    const result = await classify({
      raw: item.raw,
      kind: item.kind,
      projects: listProjects(paths),
      projectHint: opts.hint ?? item.projectHint,
      corpus: routeCorpus(item.raw),
      prefs: loadRoutingPrefs(),
      llm: opts.llm ?? null
    })
    const route: InboxRoute = {
      action: result.action,
      folder: result.projectName,
      rel: result.action === 'append' ? (result.targetRel ?? '') : '',
      reason: result.reason,
      confidence: result.confidence,
      provider: result.provider,
      suggested: false
    }
    if (result.action === 'review' || !opts.apply) {
      route.suggested = result.action !== 'review'
      setInboxStatus(id, 'inbox', paths)
      setInboxRoute(id, route, paths)
      reindexInbox()
      return { note: null, classify: result, route }
    }
    let written: { path: string; vaultRel: string }
    if (result.action === 'append' && result.targetRel) {
      written = appendToNote(result.targetRel, { inboxId: id, markdown: result.markdown }, paths)
      removePath(written.vaultRel)
    } else {
      written = routeToProject(
        {
          inboxId: id,
          projectName: result.projectName,
          title: result.title,
          tags: result.tags,
          markdown: result.markdown,
          kind: item.kind
        },
        paths
      )
    }
    route.rel = written.vaultRel
    setInboxStatus(id, 'ready', paths)
    setInboxRoute(id, route, paths)
    reindexInbox()
    return { note: indexFile(written.path, written.vaultRel), classify: result, route }
  } catch (err) {
    setInboxStatus(id, 'inbox', paths)
    reindexInbox()
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Undo a capture's routing and refresh just the notes it touched (deleted note / trimmed append). */
export function undoInboxRoute(id: string, paths: VaultPaths): boolean {
  const touched: string[] = []
  const ok = undoRoute(id, paths, touched)
  for (const rel of touched) {
    removePath(rel)
    indexPath(paths.root, rel)
  }
  indexFile(join(paths.inboxDir, `${id}.md`), inboxRel(id))
  return ok
}
