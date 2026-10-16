/**
 * Markdown image refs → URLs the renderer can load.
 *
 * Captured images are written as vault-root paths (`![](assets/2026/10/a_x.png)`,
 * the same shape as Obsidian's "absolute path in vault" links), so a note keeps
 * working when it's filed from `inbox/` into a project folder. Hand-written
 * note-relative refs (`./pic.png`, `../assets/x.png`) also resolve.
 *
 * Local files load through the privileged `asset://` protocol. The host is
 * always the fixed `vault` so the vault path lives in the URL path, which keeps
 * its case and survives Chromium's standard-scheme host normalisation.
 */

export const ASSET_HOST = 'vault'

export interface ImageRef {
  /** Offset of `!` within the scanned text. */
  index: number
  /** Full match length, `![alt](src "title")`. */
  length: number
  /** Alt text with any Obsidian `|300` / `|300x200` size suffix removed. */
  alt: string
  src: string
  /** Explicit display width in px, from `![alt|300](src)`. */
  width?: number
  /** Explicit display height in px, from `![alt|300x200](src)`. */
  height?: number
}

/** Obsidian size suffix: last `|` segment that is `300` or `300x200`. */
const SIZE_RE = /\|\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/

/**
 * Split the raw text between `![` and `]` into alt + optional size, Obsidian
 * style: `cat|300` → alt `cat`, width 300; `|300x200` → alt ``, 300×200. Only
 * a trailing numeric segment counts, so `a|b` or `x|` stay as literal alts.
 */
export function parseImageAlt(raw: string): { alt: string; width?: number; height?: number } {
  const m = SIZE_RE.exec(raw)
  if (!m) return { alt: raw }
  const width = Number(m[1])
  const height = m[2] !== undefined ? Number(m[2]) : undefined
  if (!(width > 0) || (height !== undefined && !(height > 0))) return { alt: raw }
  const alt = raw.slice(0, m.index).trimEnd()
  return height !== undefined ? { alt, width, height } : { alt, width }
}

/** Raw alt text for `alt` with an optional size: `alt|300`, `alt|300x200`, or just `alt`. */
export function formatImageAlt(alt: string, width?: number | null, height?: number | null): string {
  if (!width || width <= 0) return alt
  const w = Math.round(width)
  return height && height > 0 ? `${alt}|${w}x${Math.round(height)}` : `${alt}|${w}`
}

/** Text edit that replaces just the alt section of an image ref (between `![` and `]`). */
export interface AltEdit {
  from: number
  to: number
  insert: string
}

/**
 * Edit that sets (or with `width` null, removes) the size suffix of the image
 * ref starting at `refStart` in `text`. Returns null when there is no image
 * ref there or nothing would change. A ref that had `wxh` keeps that shape,
 * with the height scaled to the new width so the aspect stays put.
 */
export function resizeImageEdit(text: string, refStart: number, width: number | null): AltEdit | null {
  const ref = imageAt(text, refStart)
  if (!ref) return null
  const close = text.indexOf(']', refStart + 2)
  const rawAlt = text.slice(refStart + 2, close)
  const cur = parseImageAlt(rawAlt)
  let next: string
  if (width === null) next = cur.alt
  else {
    const w = Math.max(1, Math.round(width))
    const h = cur.width && cur.height ? Math.max(1, Math.round((cur.height * w) / cur.width)) : undefined
    next = formatImageAlt(cur.alt, w, h)
  }
  if (next === rawAlt) return null
  return { from: refStart + 2, to: close, insert: next }
}

/** The image ref that starts exactly at `pos` in `text`, if any. */
export function imageAt(text: string, pos: number): ImageRef | null {
  if (text.slice(pos, pos + 2) !== '![') return null
  const eol = text.indexOf('\n', pos)
  const ref = findImages(text.slice(pos, eol < 0 ? text.length : eol))[0]
  return ref && ref.index === 0 ? { ...ref, index: pos } : null
}

function lineAround(text: string, pos: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', pos - 1) + 1
  const nl = text.indexOf('\n', pos)
  return { from, to: nl < 0 ? text.length : nl }
}

/** Whether the image ref at `from..to` is alone on its line (whitespace aside). */
export function isBlockImage(text: string, from: number, to: number): boolean {
  const l = lineAround(text, from)
  return to <= l.to && text.slice(l.from, from).trim() === '' && text.slice(to, l.to).trim() === ''
}

/**
 * Edits that move the image ref at `from..to` to the drop point `drop`.
 * A ref alone on its line moves as a whole line, landing `before` or `after`
 * the line under the drop point; an inline ref moves to the exact offset
 * (never into the middle of another image ref). All offsets are in the
 * original text, so the edits apply as one change set (one undo step).
 * Returns null for a drop that would change nothing.
 */
export function moveImageEdits(
  text: string,
  from: number,
  to: number,
  drop: number,
  place: 'before' | 'after' = 'after'
): AltEdit[] | null {
  const token = text.slice(from, to)
  if (!token.startsWith('![')) return null
  drop = Math.max(0, Math.min(text.length, drop))
  if (isBlockImage(text, from, to)) {
    const src = lineAround(text, from)
    const tgt = lineAround(text, drop)
    if (tgt.from === src.from) return null
    // Dropping right next to where it already is.
    if (place === 'after' && tgt.to + 1 === src.from) return null
    if (place === 'before' && src.to + 1 === tgt.from) return null
    const removal: AltEdit =
      src.to < text.length
        ? { from: src.from, to: src.to + 1, insert: '' }
        : src.from > 0
          ? { from: src.from - 1, to: src.to, insert: '' }
          : { from: src.from, to: src.to, insert: '' }
    const line = text.slice(src.from, src.to)
    const insert: AltEdit =
      place === 'before'
        ? { from: tgt.from, to: tgt.from, insert: `${line}\n` }
        : { from: tgt.to, to: tgt.to, insert: `\n${line}` }
    return insert.from < removal.from ? [insert, removal] : [removal, insert]
  }
  if (drop >= from && drop <= to) return null
  // Never split another ref: snap to the end of an image the drop lands inside.
  const tl = lineAround(text, drop)
  for (const im of findImages(text.slice(tl.from, tl.to))) {
    const a = tl.from + im.index
    const b = a + im.length
    if (drop > a && drop < b) drop = b
  }
  if (drop >= from && drop <= to) return null
  const removal: AltEdit = { from, to, insert: '' }
  const insert: AltEdit = { from: drop, to: drop, insert: token }
  return drop < from ? [insert, removal] : [removal, insert]
}

/** Apply non-overlapping edits given in original-text offsets (test/helper use). */
export function applyEdits(text: string, edits: AltEdit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.from - a.from || b.to - a.to))
    out = out.slice(0, e.from) + e.insert + out.slice(e.to)
  return out
}

/** `![alt](src)`, `![alt](<src with spaces>)`, optional `"title"`. */
const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g

export function findImages(text: string): ImageRef[] {
  const out: ImageRef[] = []
  for (const m of text.matchAll(IMAGE_RE)) {
    const src = (m[2] ?? m[3] ?? '').trim()
    if (!src) continue
    out.push({ index: m.index ?? 0, length: m[0].length, ...parseImageAlt(m[1] ?? ''), src })
  }
  return out
}

const REMOTE_RE = /^(?:https?:|data:image\/|blob:|asset:)/i

/** Collapse `.`/`..` segments; returns null if the path climbs above the root. */
export function normalizeVaultPath(p: string): string | null {
  const parts: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.length > 0 ? parts.join('/') : null
}

/** `asset://vault/<encoded vault path>` for a vault-relative file. */
export function assetUrl(vaultRel: string): string {
  return `asset://${ASSET_HOST}/${vaultRel.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Candidate URLs for an image ref inside the note at `notePath` (vault-relative,
 * e.g. `personal/Untitled 2.md`), most likely first. Remote/data URLs pass
 * through untouched.
 */
export function imageCandidates(src: string, notePath?: string | null): string[] {
  const raw = src.trim()
  if (!raw) return []
  if (REMOTE_RE.test(raw)) return [raw]
  if (/^file:\/\//i.test(raw)) return []
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // keep raw — a literal `%` in a filename
  }
  const rooted = decoded.startsWith('/')
  const noteDir = notePath && notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const tries: Array<string | null> = rooted
    ? [normalizeVaultPath(decoded)]
    : decoded.startsWith('./') || decoded.startsWith('../')
      ? [normalizeVaultPath(`${noteDir}/${decoded}`), normalizeVaultPath(decoded)]
      : [normalizeVaultPath(decoded), noteDir ? normalizeVaultPath(`${noteDir}/${decoded}`) : null]
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tries) {
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(assetUrl(t))
  }
  return out
}

/**
 * Vault-relative path for an `asset://` request URL. Accepts the current
 * `asset://vault/<path>` form and the legacy `asset://<path>` form.
 */
export function assetPathFromUrl(url: string): string | null {
  if (!url.toLowerCase().startsWith('asset://')) return null
  const rest = url.slice('asset://'.length).split(/[?#]/)[0] ?? ''
  const slash = rest.indexOf('/')
  const host = slash < 0 ? rest : rest.slice(0, slash)
  const path = host.toLowerCase() === ASSET_HOST ? (slash < 0 ? '' : rest.slice(slash + 1)) : rest
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  return normalizeVaultPath(decoded)
}

/** Markdown for a freshly captured image, on its own line. */
export function imageMarkdown(vaultRel: string): string {
  return /[\s()<>]/.test(vaultRel) ? `![](<${vaultRel}>)` : `![](${vaultRel})`
}

/** Where a rendered image's bytes come from (for copy / reveal). */
export type ImageSource =
  { kind: 'vault'; rel: string } | { kind: 'remote'; url: string } | { kind: 'data'; url: string }

/** Classify a loaded image URL (`img.currentSrc`): vault asset, http(s), or data URL. */
export function imageSourceOf(url: string | null | undefined): ImageSource | null {
  const u = (url ?? '').trim()
  if (!u) return null
  if (/^asset:/i.test(u)) {
    const rel = assetPathFromUrl(u)
    return rel ? { kind: 'vault', rel } : null
  }
  if (/^https?:\/\//i.test(u)) return { kind: 'remote', url: u }
  if (/^data:image\//i.test(u)) return { kind: 'data', url: u }
  return null
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff'
}

/**
 * Image MIME type, sniffed from the bytes' magic number when given, else from
 * the file extension. Null when neither says "image".
 */
export function imageMime(name: string, bytes?: Uint8Array | null): string | null {
  if (bytes && bytes.length >= 12) {
    const b = bytes
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
    const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    if (riff && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  }
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase()
  return (ext && IMAGE_MIME[ext]) || null
}

/** Formats Electron's nativeImage decodes on every platform; others go through a canvas re-encode. */
export function nativelyDecodable(mime: string | null): boolean {
  return mime === 'image/png' || mime === 'image/jpeg'
}
