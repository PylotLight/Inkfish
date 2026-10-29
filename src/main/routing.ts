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
import { classify, formatBody, intelEligible, rulesRoute, type ClassifyInput, type RouteLlm } from './ai'
import { loadVaultIntelImages } from './intel-images'
import { indexFile, indexPath, removePath, routeHits, routeMeta } from './db'
import {
  appDataDir,
  appendToNote,
  listProjects,
  proposeNotePath,
  readInboxItem,
  routeToProject,
  setInboxRoute,
  setInboxStatus,
  slugify,
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
export function routeInputFor(
  raw: string,
  kind: NoteKind,
  hint: string | undefined,
  paths: VaultPaths,
  assets: string[] = [],
  includeImages = true
): ClassifyInput {
  return {
    raw,
    kind,
    ...(includeImages ? { images: loadVaultIntelImages(raw, assets, paths.root) } : {}),
    projects: listProjects(paths),
    projectHint: hint,
    corpus: routeCorpus(raw),
    prefs: loadRoutingPrefs()
  }
}

/**
 * Live preview for the capture popover: the offline rules router only (no model call), on the same
 * inputs filing uses. `aiReady` = an external AI provider or enabled embedded engine may refine it at filing time.
 */
export function previewRoute(
  raw: string,
  kind: NoteKind,
  hint: string | undefined,
  paths: VaultPaths,
  aiReady = false
): RoutePreview {
  const input = routeInputFor(raw, kind, hint, paths, [], false)
  const { decision } = rulesRoute(input)
  const prefs = input.prefs ?? DEFAULT_ROUTING_PREFS
  const preview = toRoutePreview(decision, { autoFile: prefs.autoFile, aiMayRefine: aiReady && intelEligible(input) })
  return decision.action === 'new' && !decision.folder ? { ...preview, suggested: true } : preview
}

// --- route one inbox capture -----------------------------------------------------------------

export interface RouteOutcome {
  /** The note written or appended to; null when left in the inbox (review / suggest-only). */
  note: NoteEntry | null
  classify: ClassifyResult
  route: InboxRoute
}

export interface RouteOptions {
  /** File it now (false = record a suggestion only); root-level proposals always wait for approval. */
  apply: boolean
  /** Explicit choice — a folder (Move → / picker) or `@append:<rel>` (candidate chip) — overrides the capture's own hint. */
  hint?: string
  /** "Route" clicked: a capture the user kept in the inbox gets routed normally this time. */
  manual?: boolean
  /** Apply the exact persisted suggestion instead of invoking classification again. */
  approveSuggestion?: boolean
  llm?: RouteLlm | null
}

const inboxRel = (id: string): string => `inbox/${id}.md`

function savedProposal(item: NonNullable<ReturnType<typeof readInboxItem>>): {
  route: InboxRoute
  result: ClassifyResult
} | null {
  const route = item.route
  if (!route?.suggested || (route.action !== 'new' && route.action !== 'append') || !route.rel) return null
  if (route.action === 'new' && !route.title) return null
  const targetTitle = route.rel.split('/').pop()?.replace(/\.md$/i, '') ?? route.rel
  return {
    route,
    result: {
      projectId: route.folder ? slugify(route.folder, 32) : '',
      projectName: route.folder,
      title: route.title ?? targetTitle,
      tags: route.tags ?? [],
      markdown: route.markdown ?? formatBody(item.raw, item.kind),
      provider: route.provider,
      confidence: route.confidence,
      action: route.action,
      targetRel: route.action === 'append' ? route.rel : null,
      targetTitle: route.action === 'append' ? targetTitle : null,
      reason: route.reason
    }
  }
}

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
  if (item.status === 'processing') return { error: `inbox item ${id} is already being routed` }
  if (item.status === 'ready') return { error: `inbox item ${id} is already routed; undo it before routing again` }
  if (item.status !== 'inbox') return { error: `inbox item ${id} cannot be routed from status ${item.status}` }
  const reindexInbox = (): void => void indexFile(join(paths.inboxDir, `${id}.md`), inboxRel(id))
  setInboxStatus(id, 'processing', paths)
  reindexInbox()
  try {
    const approved = opts.approveSuggestion ? savedProposal(item) : null
    let result: ClassifyResult
    let route: InboxRoute
    if (approved) {
      result = approved.result
      route = { ...approved.route, suggested: false }
    } else {
      let hint = opts.hint ?? item.projectHint
      if (opts.manual && hint === KEEP_IN_INBOX) hint = undefined
      result = await classify({
        ...routeInputFor(item.raw, item.kind, hint, paths, item.assets ?? []),
        llm: opts.llm ?? null
      })
      const baselineMarkdown = formatBody(item.raw, item.kind)
      route = {
        action: result.action,
        folder: result.projectName,
        rel: '',
        reason: result.reason,
        confidence: result.confidence,
        provider: result.provider,
        suggested: false,
        ...(result.action === 'new' ? { title: result.title, tags: result.tags } : {}),
        ...(result.markdown !== baselineMarkdown ? { markdown: result.markdown } : {}),
        ...(result.candidates?.length ? { candidates: result.candidates } : {})
      }
      if (result.action === 'append') route.rel = result.targetRel ?? ''
      else if (result.action === 'new') {
        route.rel = proposeNotePath(result.projectName, result.title, item.createdAt, paths)
      }
    }
    // The capture showed a preview; say so when filing ended up somewhere else (AI refined it, vault changed).
    const previewed = item.previewed
    const differs = (rel: string): boolean =>
      Boolean(previewed) && previewed !== routeKey({ action: route.action, folder: route.folder, rel })
    const notePreview = (): void => {
      if (previewed) route.reason = `${route.reason} · preview said ${routeKeyLabel(previewed)}`
    }
    const approvalRequired = !approved && result.action === 'new' && !result.projectName
    if (result.action === 'review' || !opts.apply || approvalRequired) {
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
          kind: item.kind,
          vaultRel: route.rel,
          createdAt: item.createdAt
        },
        paths
      )
    }
    route.rel = written.vaultRel
    if (differs(result.action === 'append' ? written.vaultRel : '')) notePreview()
    route.suggested = false
    route.markdown = undefined
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
