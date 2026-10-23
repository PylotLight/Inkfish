/** In-note find: pure matching, shared by the editor decorations, the counter and replace. */

export interface FindOpts {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface FindMatch {
  from: number
  to: number
}

/** Hard cap so a pathological query (`.` on a huge note) can't freeze the renderer. */
export const MAX_MATCHES = 5000

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Builds the search regex, or `null` for an empty / invalid query. */
export function findRegex(query: string, opts: FindOpts = {}): RegExp | null {
  if (!query) return null
  let src = opts.regex ? query : escapeRe(query)
  if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`
  try {
    return new RegExp(src, `gu${opts.caseSensitive ? '' : 'i'}${opts.regex ? 'm' : ''}`)
  } catch {
    return null
  }
}

/** True when `query` is a regex that doesn't compile (the bar shows it in red). */
export function isInvalidQuery(query: string, opts: FindOpts = {}): boolean {
  return !!query && !!opts.regex && findRegex(query, opts) === null
}

/** Every non-empty match in `text`, in order. Zero-length regex hits are skipped. */
export function findMatches(text: string, query: string, opts: FindOpts = {}): FindMatch[] {
  const re = findRegex(query, opts)
  if (!re) return []
  const out: FindMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push({ from: m.index, to: m.index + m[0].length })
    if (out.length >= MAX_MATCHES) break
  }
  return out
}

/** Wraps any integer index into `[0, total)`; 0 when there are no matches. */
export function wrapIndex(i: number, total: number): number {
  return total > 0 ? ((i % total) + total) % total : 0
}

/** Index of the first match at or after `pos` (wrapping to 0) — where find lands from the caret. */
export function matchAtOrAfter(matches: FindMatch[], pos: number): number {
  const i = matches.findIndex((m) => m.to > pos)
  return i < 0 ? 0 : i
}

/** Replacement text for one match; regex mode expands `$1`, `$<name>`, `$&`, `$$`. */
export function replacementFor(
  text: string,
  match: FindMatch,
  query: string,
  replace: string,
  opts: FindOpts = {}
): string {
  if (!opts.regex) return replace
  const re = findRegex(query, opts)
  if (!re) return replace
  const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y')
  sticky.lastIndex = match.from
  const m = sticky.exec(text)
  if (!m) return replace
  return replace.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (all, tok: string, name?: string) => {
    if (tok === '$') return '$'
    if (tok === '&') return m[0]
    if (name !== undefined) return m.groups?.[name] ?? ''
    const n = Number(tok)
    return n > 0 && n < m.length ? (m[n] ?? '') : all
  })
}

/** A single selected line (≤200 chars) seeds the query when find opens, like every editor. */
export function seedFromSelection(sel: string): string | null {
  if (!sel || sel.length > 200 || sel.includes('\n')) return null
  return sel
}
