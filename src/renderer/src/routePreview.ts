import { appendHint, KEEP_IN_INBOX, routeKey, type RoutePreview } from '../../shared/routing'
import type { NoteKind } from '../../shared/types'

/**
 * Capture popover's live route preview: what kind a capture is, whether there's enough text to
 * preview, the debounced / stale-safe fetcher, and the menu of overrides. Pure (no React / DOM) so it
 * runs under `bun test`.
 */

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
const AUDIO = /\.(wav|mp3|m4a|ogg|flac)$/i

/** Same rule the popover saves with: audio wins, then image, else text. */
export function captureKind(attachments: readonly string[]): NoteKind {
  if (attachments.some((a) => AUDIO.test(a))) return 'voice'
  if (attachments.some((a) => IMAGE.test(a))) return 'image'
  return 'text'
}

/** Enough words to say anything useful (image / audio refs don't count). */
export function previewable(raw: string, min = 6): boolean {
  const words = raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/🎙\s*`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return words.length >= min
}

/** Identity of one preview request: the exact text, kind and hint the save would send. */
export const previewKey = (raw: string, kind: NoteKind, hint: string): string => `${kind}\u0000${hint}\u0000${raw}`

/** `routeKey` of a preview — recorded on the capture so the inbox can flag a different outcome. */
export const previewRouteKey = (p: RoutePreview): string =>
  routeKey({ action: p.action, folder: p.folder, rel: p.target?.rel })

export interface PreviewArgs {
  raw: string
  kind: NoteKind
  hint: string
}

/**
 * Debounced preview fetcher. `request` restarts the timer; only the newest request's answer is
 * delivered (older in-flight answers are dropped), and `cancel` drops everything pending.
 */
export function createPreviewer(
  fetch: (a: PreviewArgs) => Promise<RoutePreview | null>,
  onResult: (key: string, p: RoutePreview | null) => void,
  delay = 300
): { request: (a: PreviewArgs) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  const cancel = (): void => {
    seq++
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const request = (a: PreviewArgs): void => {
    cancel()
    const mine = seq
    const key = previewKey(a.raw, a.kind, a.hint)
    timer = setTimeout(() => {
      timer = undefined
      fetch(a)
        .then((p) => {
          if (mine === seq) onResult(key, p)
        })
        .catch(() => {
          if (mine === seq) onResult(key, null)
        })
    }, delay)
  }
  return { request, cancel }
}

export interface PreviewOption {
  id: string
  label: string
  /** New hint to send ('auto' = let the router decide); null = open the folder picker. */
  hint: string | null
}

/** Overrides offered from the preview line. Folder names → picker ids when the folder is a project. */
export function previewOptions(
  p: RoutePreview,
  hint: string,
  projects: ReadonlyArray<{ id: string; dir: string }>
): PreviewOption[] {
  const out: PreviewOption[] = []
  if (hint !== 'auto') out.push({ id: 'auto', label: 'Let Inkfish decide', hint: 'auto' })
  if (p.action !== 'append' && p.alt.append)
    out.push({ id: 'append', label: `Add to “${p.alt.append.title}” instead`, hint: appendHint(p.alt.append.rel) })
  // Other related notes worth adding to — skip whatever the line already names (best pick / target).
  const listed = new Set([p.alt.append?.rel, p.action === 'append' ? p.target?.rel : undefined])
  for (const c of p.candidates) {
    if (listed.has(c.rel)) continue
    out.push({ id: `cand:${c.rel}`, label: `Add to “${c.title}” instead`, hint: appendHint(c.rel) })
  }
  if (p.action !== 'new' && p.alt.folder !== null) {
    const id = projects.find((x) => x.dir === p.alt.folder)?.id ?? p.alt.folder
    out.push({ id: 'new', label: `New note in ${p.alt.folder || 'vault root'}`, hint: id })
  }
  out.push({ id: 'folder', label: 'Other folder…', hint: null })
  if (!(p.action === 'inbox' && p.override)) out.push({ id: 'inbox', label: 'Keep in inbox', hint: KEEP_IN_INBOX })
  return out
}
