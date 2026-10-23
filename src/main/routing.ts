import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_ROUTING_PREFS,
  KEEP_IN_INBOX,
  keyTerms,
  routeKey,
  routeKeyLabel,
  sanitizeRoutingPrefs,
  toRoutePreview,
  type InboxRoute,
  type RouteDoc,
  type RoutePreview,
  type RoutingPrefs
} from '../shared/routing'
import type { ClassifyResult, NoteEntry, NoteKind } from '../shared/types'
import { classify, intelEligible, rulesRoute, type ClassifyInput, type RouteLlm } from './ai'
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

/**
 * The router's inputs for one capture. Filing and the live preview both build them here, so what the
 * capture popover previews is exactly what the rules router files.
 */
export function routeInputFor(raw: string, kind: NoteKind, hint: string | undefined, paths: VaultPaths): ClassifyInput {
  return {
    raw,
    kind,
    projects: listProjects(paths),
    projectHint: hint,
    corpus: routeCorpus(raw),
    prefs: loadRoutingPrefs()
  }
}

/**
 * Live preview for the capture popover: the offline rules router only (no model call), on the same
 * inputs filing uses. `aiReady` = an AI provider / Apple Intelligence may refine it at filing time.
 */
export function previewRoute(
  raw: string,
  kind: NoteKind,
  hint: string | undefined,
  paths: VaultPaths,
  aiReady = false
): RoutePreview {
  const input = routeInputFor(raw, kind, hint, paths)
  const { decision } = rulesRoute(input)
  const prefs = input.prefs ?? DEFAULT_ROUTING_PREFS
  return toRoutePreview(decision, { autoFile: prefs.autoFile, aiMayRefine: aiReady && intelEligible(input) })
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
  /** "Route" clicked: a capture the user kept in the inbox gets routed normally this time. */
  manual?: boolean
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
    let hint = opts.hint ?? item.projectHint
    if (opts.manual && hint === KEEP_IN_INBOX) hint = undefined
    const result = await classify({ ...routeInputFor(item.raw, item.kind, hint, paths), llm: opts.llm ?? null })
    const route: InboxRoute = {
      action: result.action,
      folder: result.projectName,
      rel: result.action === 'append' ? (result.targetRel ?? '') : '',
      reason: result.reason,
      confidence: result.confidence,
      provider: result.provider,
      suggested: false
    }
    // The capture showed a preview; say so when filing ended up somewhere else (AI refined it, vault changed).
    const previewed = item.previewed
    const differs = (rel: string): boolean =>
      Boolean(previewed) && previewed !== routeKey({ action: route.action, folder: route.folder, rel })
    const notePreview = (): void => {
      if (previewed) route.reason = `${route.reason} · preview said ${routeKeyLabel(previewed)}`
    }
    if (result.action === 'review' || !opts.apply) {
      if (differs(route.rel)) notePreview()
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
    if (differs(result.action === 'append' ? written.vaultRel : '')) notePreview()
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
