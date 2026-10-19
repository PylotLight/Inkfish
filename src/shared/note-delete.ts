/**
 * Sidebar delete + inline rename helpers. Quick deletes stay quick: a note with (almost) nothing in
 * it goes straight to Trash with an Undo toast; a note with real content gets a small confirm
 * popover with a preview. Pure so the rules are testable without a renderer.
 */

/** Body chars (after front matter + a leading title heading) under this = "empty enough" to skip confirm. */
export const QUICK_DELETE_CHARS = 40
/** Preview lines shown in the confirm popover. */
export const PREVIEW_LINES = 6

/** Strip a leading YAML front matter block (`---` … `---`). */
export function stripFrontMatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(md)
  return m ? md.slice(m[0].length) : md
}

/** Body text: front matter + a leading `# Title` heading (the title, not content) removed. */
export function noteBody(md: string): string {
  const body = stripFrontMatter(md).replace(/^\s+/, '')
  return body.replace(/^#{1,6}[ \t]+[^\n]*(?:\n|$)/, '')
}

/** Meaningful character count of the body: whitespace collapsed, bare list/heading/quote markers ignored. */
export function bodyChars(md: string): number {
  return noteBody(md)
    .split('\n')
    // A lone `-`, `- [ ]`, `#`, `>` is an empty bullet/heading, not content.
    .map((l) => l.replace(/^\s*(?:[-*+]\s*(?:\[[ xX]?\]\s*)?|\d+[.)]\s*|#{1,6}\s*|>\s*)/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim().length
}

/** True when deleting this note should ask first (it has real content). */
export function deleteNeedsConfirm(md: string, threshold = QUICK_DELETE_CHARS): boolean {
  return bodyChars(md) >= threshold
}

/** First `n` non-blank body lines for the glance preview (long lines clipped). */
export function previewLines(md: string, n = PREVIEW_LINES, max = 140): string[] {
  const out: string[] = []
  for (const raw of noteBody(md).split('\n')) {
    const l = raw.trimEnd()
    if (!l.trim()) continue
    out.push(l.length > max ? `${l.slice(0, max - 1)}…` : l)
    if (out.length >= n) break
  }
  return out
}

/** Stem shown in the inline rename field: the file name without `.md`. */
export function renameStem(rel: string): string {
  const base = rel.split('/').pop() ?? rel
  return base.replace(/\.md$/i, '')
}

/**
 * What an inline rename commit should do: null = nothing (empty / unchanged), else the new name to
 * hand `files.rename` (which adds `.md` when there's no extension).
 */
export function renameCommit(rel: string, value: string): string | null {
  const v = value.trim()
  if (!v) return null
  const stem = renameStem(rel)
  if (v === stem || v === `${stem}.md`) return null
  return v
}

export type RowKeyAction = 'rename' | 'delete' | null

/** Sidebar row keys (Finder-ish): F2 / Enter rename, ⌘⌫ (Ctrl+Backspace off-mac, or ⌘Delete) deletes. */
export function rowKeyAction(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): RowKeyAction {
  if (e.altKey) return null
  const mod = e.metaKey || e.ctrlKey
  if (!mod && (e.key === 'F2' || (e.key === 'Enter' && !e.shiftKey))) return 'rename'
  if (mod && (e.key === 'Backspace' || e.key === 'Delete')) return 'delete'
  return null
}
