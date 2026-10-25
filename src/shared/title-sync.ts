/**
 * Filename follows the note title (Obsidian-ish). Pure helpers shared by main (the rename) and the
 * renderer (when to rename), plus a tiny debounce scheduler so typing never renames per keystroke.
 *
 * The rule:
 *  - The note's title is its first line when that line is a `# H1` (front matter `title:` wins
 *    when the text has front matter). No H1 → no title → the filename is left alone.
 *  - A file is "auto-named" while its name is `Untitled…` (`Untitled`, `Untitled 3`,
 *    `Untitled 3 2`), or Inkfish named it from its title before and it still equals the sanitized
 *    title it was last synced from (a `" 2"` collision suffix still counts). Only auto-named files
 *    follow the title. Imported notes that merely happen to be named after their `# heading`
 *    only follow when the user opts in (`headingNamed`, Settings → also rename notes named after
 *    their heading) — so opening an Obsidian vault never renames its files behind your back.
 *  - Rename the file by hand to anything else and it stops following — nothing extra is stored,
 *    it simply no longer matches. Rename it back to the title and it follows again.
 *  - Renames happen ~2s after typing stops, and right away when you leave the note / editor.
 */

/** Wait this long after the last keystroke before renaming. */
export const TITLE_SYNC_DELAY_MS = 2000
/** Longest file name (without `.md`) a title produces. */
export const MAX_TITLE_FILENAME = 100

/** Notes that never follow their title: inbox captures and day logs are named by the app. */
export function isTitleSyncPath(path: string): boolean {
  return !(path.startsWith('inbox/') || path.startsWith('daily/')) && path.toLowerCase().endsWith('.md')
}

/**
 * Title → safe file name (no extension): illegal path chars (`/ \ : * ? " < > |`), the characters
 * that break a `[[wikilink]]` to the file (`# ^ [ ]`, which Obsidian also refuses) and control chars
 * become spaces, whitespace collapses, leading dots go (no hidden files), trimmed, capped at
 * `MAX_TITLE_FILENAME`. Empty string = nothing usable.
 */
export function sanitizeFileTitle(title: string): string {
  let s = title
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|#^[\]\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
  if (s.length > MAX_TITLE_FILENAME) s = s.slice(0, MAX_TITLE_FILENAME)
  // Trailing dots/spaces confuse Finder/Windows; strip after the cap too.
  s = s.replace(/[.\s]+$/, '')
  if (s.toLowerCase().endsWith('.md')) s = s.slice(0, -3).replace(/[.\s]+$/, '')
  return s
}

/** Inline markdown → plain text for a title (`**Japan** [list](x)` → `Japan list`). */
function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+#+\s*$/, '') // closing `# Title ##`
    .trim()
}

/** Plain display text for Markdown titles, shared by both platform renderers. */
export function plainTitle(s: string): string {
  return plainInline(s)
}

/**
 * The note's title from its text: front matter `title:` if present, else the first non-blank
 * line when it is a `# H1`. Empty string when there is none.
 */
export function titleFromMarkdown(md: string): string {
  let body = md
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end !== -1) {
      const fm = body.slice(3, end)
      const m = /^title:\s*(.+?)\s*$/m.exec(fm)
      if (m?.[1]) {
        const v = m[1]
          .replace(/^(['"])(.*)\1$/, '$2')
          .replace(/\\(["\\])/g, '$1')
          .trim()
        if (v) return v
      }
      body = body.slice(end + 4)
    }
  }
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    const h = /^#[ \t]+(.+)$/.exec(line)
    return h?.[1] ? plainInline(h[1]) : ''
  }
  return ''
}

/** `Untitled`, `Untitled 3`, `Untitled 3 2` (any case). */
export function isUntitledName(base: string): boolean {
  return /^untitled(?: \d+)*$/i.test(base.trim())
}

/** Does `base` (no extension) equal `name`, allowing a `" 2"`-style collision suffix? Case-insensitive. */
export function matchesName(base: string, name: string): boolean {
  if (!name) return false
  const b = base.toLowerCase()
  const n = name.toLowerCase()
  if (b === n) return true
  if (!b.startsWith(`${n} `)) return false
  return /^\d+$/.test(b.slice(n.length + 1))
}

/** File name without folder or `.md`. */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base
}

export interface AutoRenameOptions {
  /** Inkfish named this file from its title before (kept in app data, follows moves). */
  inkfishNamed?: boolean
  /** Opt-in: any note still named after its heading follows it (imported notes too). */
  headingNamed?: boolean
}

/**
 * Should the note at `path` be renamed now? Returns the new file name (no `.md`, before collision
 * handling) or null. `baseTitle` = the title the filename was last synced from (or the saved
 * title when the note was opened); `title` = the title now. Only `Untitled…` notes and (per
 * `opts`) notes Inkfish named / any heading-named note follow their title.
 */
export function autoRenameTarget(
  path: string,
  baseTitle: string,
  title: string,
  opts: AutoRenameOptions = {}
): string | null {
  if (!isTitleSyncPath(path)) return null
  const next = sanitizeFileTitle(title)
  if (!next) return null // empty title keeps the current name
  const stem = stemOf(path)
  if (!isUntitledName(stem) && !opts.inkfishNamed && !opts.headingNamed) return null
  if (stem === next || matchesName(stem, next)) {
    // Same name, or only a case change on its own suffix-free name.
    return stem !== next && stem.toLowerCase() === next.toLowerCase() ? next : null
  }
  const auto = isUntitledName(stem) || matchesName(stem, sanitizeFileTitle(baseTitle))
  return auto ? next : null
}

// --- [[wikilinks]] ------------------------------------------------------------------------------

/**
 * Point `[[Old]]` / `[[Old|alias]]` / `[[Old#heading]]` / `[[dir/Old]]` (and `.md` variants) at a
 * renamed note. `oldPath`/`newPath` are vault rels. Bare `[[Old]]` is only rewritten when
 * `bareUnique` (no other note shares the old stem — otherwise it may mean that one). When
 * `newAmbiguous` (another note already has the new stem) a rewritten bare link gets the folder path
 * (`[[dir/New]]`) so it can't resolve to that other note. Fenced code is left alone.
 * Returns the new text and the number of links changed.
 */
export function rewriteWikiLinks(
  md: string,
  oldPath: string,
  newPath: string,
  bareUnique: boolean,
  newAmbiguous = false
): { text: string; changed: number } {
  const oldStem = stemOf(oldPath)
  const newStem = stemOf(newPath)
  const oldNoExt = oldPath.replace(/\.md$/i, '')
  const newNoExt = newPath.replace(/\.md$/i, '')
  if (!md.includes('[[')) return { text: md, changed: 0 }
  let changed = 0
  const parts = md.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part
    return part.replace(
      /(!?)\[\[([^\]|#\n]+)((?:#[^\]|\n]*)?)((?:\|[^\]\n]*)?)\]\]/g,
      (whole, bang: string, target: string, heading: string, alias: string) => {
        const t = target.trim()
        const hasExt = /\.md$/i.test(t)
        const bare = hasExt ? t.slice(0, -3) : t
        let next: string | null = null
        if (bare.includes('/')) {
          if (bare.replace(/^\/+/, '').toLowerCase() === oldNoExt.toLowerCase()) next = newNoExt
        } else if (bareUnique && bare.toLowerCase() === oldStem.toLowerCase()) {
          next = newAmbiguous && newNoExt.includes('/') ? newNoExt : newStem
        }
        if (next === null) return whole
        changed++
        return `${bang}[[${next}${hasExt ? '.md' : ''}${heading}${alias}]]`
      }
    )
  })
  return { text: out.join(''), changed }
}

// --- debounce scheduler -------------------------------------------------------------------------

export interface TitleSyncScheduler {
  /** A local edit for note `id`: (re)start its timer with the newest text. */
  schedule: (id: string, markdown: string) => void
  /** Run `id`'s pending sync now (leaving the note / editor blur). */
  flush: (id?: string) => void
  /** Forget `id`'s pending sync (note closed / moved by something else). */
  cancel: (id: string) => void
  /** A note's id changed (rename): carry the pending sync over. */
  rename: (from: string, to: string) => void
  pending: (id: string) => string | undefined
}

export function createTitleSync(opts: {
  run: (id: string, markdown: string) => void
  delayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): TitleSyncScheduler {
  const delay = opts.delayMs ?? TITLE_SYNC_DELAY_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const text = new Map<string, string>()
  const timers = new Map<string, unknown>()
  const stop = (id: string): void => {
    const t = timers.get(id)
    if (t !== undefined) clearTimer(t)
    timers.delete(id)
  }
  const fire = (id: string): void => {
    stop(id)
    const md = text.get(id)
    if (md === undefined) return
    text.delete(id)
    opts.run(id, md)
  }
  return {
    schedule(id, markdown) {
      text.set(id, markdown)
      stop(id)
      timers.set(
        id,
        setTimer(() => fire(id), delay)
      )
    },
    flush(id) {
      if (id !== undefined) fire(id)
      else for (const k of [...text.keys()]) fire(k)
    },
    cancel(id) {
      stop(id)
      text.delete(id)
    },
    rename(from, to) {
      if (from === to) return
      const md = text.get(from)
      const had = timers.has(from)
      stop(from)
      text.delete(from)
      if (md === undefined) return
      text.set(to, md)
      if (had)
        timers.set(
          to,
          setTimer(() => fire(to), delay)
        )
    },
    pending: (id) => text.get(id)
  }
}
