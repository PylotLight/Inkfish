/**
 * Image refs in note markdown → files the phone can show. Pure (no RN / Expo)
 * so it runs under bun (`android/test/mdimages.test.ts`).
 *
 * Same rules as the Mac (`src/shared/images.ts`):
 *  - `![alt](assets/2026/10/a.png)` is vault-rooted first, then note-relative;
 *    `./x.png` / `../x.png` are note-relative first; `/x.png` is vault-rooted.
 *  - `![alt|300](src)` / `![alt|300x200](src)` set the display size.
 * Plus Obsidian embeds: `![[x.png]]`, `![[x.png|300]]`, `![[sub/x.png]]`,
 * found by name anywhere in the vault (same folder first, then the shortest path).
 */
import { findImages, normalizeVaultPath, parseImageAlt } from '../../../src/shared/images'

export interface ImageToken {
  t: 'img'
  alt: string
  src: string
  width?: number
  height?: number
  /** `![[…]]` (Obsidian embed): `src` is a file name / vault path, resolved by name. */
  embed: boolean
}
export type InlineToken = { t: 'text'; text: string } | ImageToken

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg)$/i
const AUDIO_EXT = /\.(m4a|wav|mp3|ogg|aac|flac|webm)$/i
const REMOTE = /^(?:https?:|data:image\/)/i

export function isAudio(src: string): boolean {
  return AUDIO_EXT.test(src.split(/[?#]/)[0] ?? src)
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXT.test(path)
}

// `![[name]]`, `![[name|300]]`, `![[name|alt|300x200]]`, `![[name#heading]]`
const EMBED_RE = /!\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?((?:\|[^\]\n]*)?)\]\]/g

/** Split one line of markdown into text runs and image refs (markdown images + `![[embeds]]`). */
export function splitImages(line: string): InlineToken[] {
  const hits: Array<{ index: number; length: number; tok: ImageToken }> = []
  for (const r of findImages(line)) {
    hits.push({
      index: r.index,
      length: r.length,
      tok: {
        t: 'img',
        alt: r.alt,
        src: r.src,
        embed: false,
        ...(r.width ? { width: r.width } : {}),
        ...(r.height ? { height: r.height } : {})
      }
    })
  }
  for (const m of line.matchAll(EMBED_RE)) {
    const index = m.index ?? 0
    if (hits.some((h) => index >= h.index && index < h.index + h.length)) continue
    const name = (m[1] ?? '').trim()
    if (!name) continue
    // `|300`, `|alias`, `|alias|300x200` — same size rule as markdown alts.
    const size = parseImageAlt(m[2] ?? '')
    const alias = size.alt.replace(/^\|/, '').trim()
    hits.push({
      index,
      length: m[0].length,
      tok: {
        t: 'img',
        alt:
          alias ||
          name
            .split('/')
            .pop()!
            .replace(/\.[^.]+$/, ''),
        src: name,
        embed: true,
        ...(size.width ? { width: size.width } : {}),
        ...(size.height ? { height: size.height } : {})
      }
    })
  }
  if (!hits.length) return [{ t: 'text', text: line }]
  hits.sort((a, b) => a.index - b.index)
  const out: InlineToken[] = []
  let at = 0
  for (const h of hits) {
    if (h.index < at) continue
    if (h.index > at) out.push({ t: 'text', text: line.slice(at, h.index) })
    out.push(h.tok)
    at = h.index + h.length
  }
  if (at < line.length) out.push({ t: 'text', text: line.slice(at) })
  return out
}

/** The line is exactly one image ref (whitespace aside): render it as a block. */
export function blockImage(line: string): ImageToken | null {
  const toks = splitImages(line.trim())
  return toks.length === 1 && toks[0]!.t === 'img' ? toks[0] : null
}

export type ResolvedImage = { kind: 'remote'; uri: string } | { kind: 'vault'; rel: string }

function dirOf(rel: string | null | undefined): string {
  return rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Vault paths to try for a markdown image `src` in the note at `notePath`, most likely first (Mac order). */
export function imageRelCandidates(src: string, notePath?: string | null): string[] {
  const raw = decode(src.trim())
  if (!raw || /^file:/i.test(raw)) return []
  const noteDir = dirOf(notePath)
  const tries = raw.startsWith('/')
    ? [normalizeVaultPath(raw)]
    : raw.startsWith('./') || raw.startsWith('../')
      ? [normalizeVaultPath(`${noteDir}/${raw}`), normalizeVaultPath(raw)]
      : [normalizeVaultPath(raw), noteDir ? normalizeVaultPath(`${noteDir}/${raw}`) : null]
  return [...new Set(tries.filter((t): t is string => !!t))]
}

/**
 * Where an image ref points. `files` = vault-relative paths of the vault's
 * attachments (any non-note file), used to pick an existing candidate and to
 * find `![[name]]` embeds. Null when nothing matches.
 */
export function resolveImage(
  tok: Pick<ImageToken, 'src' | 'embed'>,
  notePath: string | null | undefined,
  files: readonly string[]
): ResolvedImage | null {
  const src = tok.src.trim()
  if (!src) return null
  if (REMOTE.test(src)) return { kind: 'remote', uri: src }
  const lower = new Map<string, string>()
  for (const f of files) if (!lower.has(f.toLowerCase())) lower.set(f.toLowerCase(), f)
  const existing = (rel: string): string | null => (files.includes(rel) ? rel : (lower.get(rel.toLowerCase()) ?? null))
  if (!tok.embed) {
    const cands = imageRelCandidates(src, notePath)
    for (const c of cands) {
      const hit = existing(c)
      if (hit) return { kind: 'vault', rel: hit }
    }
    // Not synced yet (or the list is stale): the Mac's first choice.
    return cands[0] ? { kind: 'vault', rel: cands[0] } : null
  }
  // Obsidian embed: an explicit path first (vault-rooted, then note-relative)…
  const name = decode(src).replace(/^\/+/, '')
  if (name.includes('/')) {
    for (const c of [normalizeVaultPath(name), normalizeVaultPath(`${dirOf(notePath)}/${name}`)]) {
      const hit = c && existing(c)
      if (hit) return { kind: 'vault', rel: hit }
    }
  }
  // …then by file name anywhere: same folder as the note, else the shortest path.
  const base = name.split('/').pop()!.toLowerCase()
  const tail = name.toLowerCase()
  const hits = files.filter((f) => {
    const l = f.toLowerCase()
    return l === tail || l.endsWith(`/${tail}`) || l.split('/').pop() === base
  })
  if (!hits.length) return null
  const noteDir = dirOf(notePath)
  const same = hits.find((f) => dirOf(f) === noteDir)
  if (same) return { kind: 'vault', rel: same }
  hits.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b))
  return { kind: 'vault', rel: hits[0]! }
}

/** `file://` URI for a vault-relative file under `vaultRoot` (expo's `…/inkfish/vault/`). */
export function vaultFileUri(vaultRoot: string, rel: string): string {
  return `${vaultRoot}${rel.split('/').map(encodeURIComponent).join('/')}`
}

/** Display size: explicit width (capped to the column) and height, else natural size scaled to fit. */
export function fitImage(
  natural: { w: number; h: number } | null,
  want: { width?: number; height?: number },
  maxWidth: number
): { width: number; height: number } {
  const ratio =
    natural && natural.w > 0 ? natural.h / natural.w : want.width && want.height ? want.height / want.width : 0.75
  const w = Math.max(1, Math.min(want.width ?? natural?.w ?? maxWidth, maxWidth))
  const h = want.width && want.height && w === want.width ? want.height : w * ratio
  return { width: Math.round(w), height: Math.max(1, Math.round(h)) }
}
