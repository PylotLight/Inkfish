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
  alt: string
  src: string
}

/** `![alt](src)`, `![alt](<src with spaces>)`, optional `"title"`. */
const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g

export function findImages(text: string): ImageRef[] {
  const out: ImageRef[] = []
  for (const m of text.matchAll(IMAGE_RE)) {
    const src = (m[2] ?? m[3] ?? '').trim()
    if (!src) continue
    out.push({ index: m.index ?? 0, length: m[0].length, alt: m[1] ?? '', src })
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
