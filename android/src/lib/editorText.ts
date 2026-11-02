export interface TextSelection {
  start: number
  end: number
}

export interface ImageInsertion {
  text: string
  selection: TextSelection
}

const TASK_DATE_RE = /[ \t]✅[ \t]\d{4}-\d{2}-\d{2}[ \t]*$/
const TASK_LINE_RE = /^([ \t]*(?:[-*+]\s+)?\[)([ xX]?)(\])(?=\s|$)(.*)$/

/** Toggle one Markdown task line. Bare `[]` is treated as unchecked. */
export function toggleTaskLine(line: string, date: string): string | null {
  const match = TASK_LINE_RE.exec(line)
  if (!match) return null
  const prefix = match[1] ?? ''
  const state = match[2] ?? ''
  let rest = match[4] ?? ''
  const checking = state.toLowerCase() !== 'x'
  if (checking) rest = `${rest.replace(TASK_DATE_RE, '').trimEnd()} ✅ ${date}`
  else rest = rest.replace(TASK_DATE_RE, '')
  return `${prefix}${checking ? 'x' : ' '}]${rest}`
}

/** Insert a block image reference at the selected range, preserving surrounding text. */
export function insertImageReference(text: string, selection: TextSelection, assetRel: string): ImageInsertion {
  const start = Math.max(0, Math.min(text.length, Math.min(selection.start, selection.end)))
  const end = Math.max(start, Math.min(text.length, Math.max(selection.start, selection.end)))
  const before = text.slice(0, start).replace(/[ \t]+$/, '')
  const after = text.slice(end).replace(/^[ \t]+/, '')
  const ref = `![](${assetRel})`
  const beforeBreak = before && !before.endsWith('\n') ? '\n' : ''
  const afterBreak = after && !after.startsWith('\n') ? '\n' : ''
  const insertion = `${beforeBreak}${ref}${afterBreak}`
  const caret = before.length + beforeBreak.length + ref.length + afterBreak.length
  return { text: `${before}${insertion}${after}`, selection: { start: caret, end: caret } }
}
