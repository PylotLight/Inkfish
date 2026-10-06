/** Tiny GFM-ish renderer for note preview. No deps: headings, bold/italic,
 * inline code, links, images, quotes, lists, task items, fenced code, tables. */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s: string, resolveAsset?: (src: string) => string): string {
  let out = esc(s)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, src: string) => {
    const safe = resolveAsset ? resolveAsset(src) : src
    return `<img alt="${alt}" src="${safe}" />`
  })
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  out = out.replace(/(`[^`]+`)/g, (m) => `<code>${m.slice(1, -1)}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return out
}

export interface RenderOptions {
  /** Map a vault-relative image src (e.g. `assets/2026/10/x.png`) to a loadable URL. */
  resolveAsset?: (src: string) => string
}

/** Vault-relative image refs can't load raw — map them to `asset://` URLs. */
export function assetUrl(src: string): string {
  const s = src.trim()
  if (/^(https?:|data:|blob:|file:|asset:)/i.test(s) || s.startsWith('#')) return src
  const rel = s.replace(/^\.\//, '').replace(/^[/\\]+/, '')
  return `asset://${rel.split('/').map(encodeURIComponent).join('/')}`
}

export function renderMarkdown(md: string, opts?: RenderOptions): string {
  const lines = md.split('\n')
  const html: string[] = []
  let inCode = false
  let codeLang = ''
  let codeBuf: string[] = []
  let listOpen = false
  let quoteBuf: string[] | null = null

  const closeList = (): void => {
    if (listOpen) {
      html.push('</ul>')
      listOpen = false
    }
  }
  const closeQuote = (): void => {
    if (quoteBuf) {
      html.push(`<blockquote>${quoteBuf.map((q) => inline(q, opts?.resolveAsset)).join('<br />')}</blockquote>`)
      quoteBuf = null
    }
  }

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      if (inCode) {
        const body = esc(codeBuf.join('\n'))
        const n = codeBuf.length
        if (n > 25) {
          html.push(
            `<details class="codeblock"><summary>${esc(codeLang || 'code')} · ${n} lines — expand</summary><pre><code class="lang-${esc(codeLang)}">${body}</code></pre></details>`
          )
        } else {
          html.push(`<pre><code class="lang-${esc(codeLang)}">${body}</code></pre>`)
        }
        codeBuf = []
        inCode = false
      } else {
        closeList()
        closeQuote()
        inCode = true
        codeLang = fence[1] ?? ''
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      closeQuote()
      const level = h[1]?.length ?? 1
      html.push(`<h${level}>${inline(h[2] ?? '', opts?.resolveAsset)}</h${level}>`)
      continue
    }
    const q = /^>\s?(.*)$/.exec(line)
    if (q) {
      closeList()
      quoteBuf ??= []
      quoteBuf.push(q[1] ?? '')
      continue
    }
    closeQuote()
    const task = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      const checked = task[1]?.toLowerCase() === 'x' ? ' checked' : ''
      html.push(`<li class="task"><input type="checkbox" disabled${checked} /> ${inline(task[2] ?? '', opts?.resolveAsset)}</li>`)
      continue
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${inline(li[1] ?? '', opts?.resolveAsset)}</li>`)
      continue
    }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      closeList()
      html.push(`<ol><li>${inline(ol[1] ?? '', opts?.resolveAsset)}</li></ol>`)
      continue
    }
    closeList()
    if (/^\s*$/.test(line)) continue
    if (/^\|.*\|\s*$/.test(line) && /---/.test(line)) continue
    html.push(`<p>${inline(line, opts?.resolveAsset)}</p>`)
  }
  closeList()
  closeQuote()
  if (inCode) html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`)
  return html.join('\n')
}

// --- Live blocks --------------------------------------------------------------
// Split source into independently renderable/editable blocks so the Live view
// can offer click-to-edit reading. Each block tracks its source line range
// for splicing edits back into the full document.

export type BlockKind =
  | 'heading' | 'paragraph' | 'list' | 'task' | 'quote' | 'code' | 'table' | 'hr'

export interface LiveBlock {
  /** Stable within one parse — `b<startLine>-<index>`. */
  key: string
  kind: BlockKind
  /** Raw markdown source lines for this block. */
  source: string
  startLine: number
  endLine: number
}

const TASK_RE = /^\s*-\s+\[([ xX])\]\s+/
const LIST_RE = /^\s*(?:[-*]|\d+\.)\s+/
const HEADING_RE = /^(#{1,4})\s+/
const HR_RE = /^\s*(?:---|\*\*\*|___)\s*$/
const QUOTE_RE = /^>\s?/
const FENCE_RE = /^```/

function isTableRow(line: string): boolean {
  return /^\|.*\|\s*$/.test(line)
}

export function parseBlocks(markdown: string): LiveBlock[] {
  const lines = markdown.split('\n')
  const blocks: LiveBlock[] = []
  let i = 0
  let n = 0
  const push = (kind: BlockKind, start: number, end: number): void => {
    const source = lines.slice(start, end).join('\n')
    if (source.trim() === '' && kind !== 'code') return
    blocks.push({ key: `b${start}-${n++}`, kind, source, startLine: start, endLine: end })
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    // Skip blank separators (they're re-added on splice).
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    // Fenced code — one block through the closing fence.
    if (FENCE_RE.test(line)) {
      const start = i
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) i++
      if (i < lines.length) i++ // consume closing fence
      push('code', start, i)
      continue
    }
    if (HR_RE.test(line)) {
      push('hr', i, i + 1)
      i++
      continue
    }
    if (HEADING_RE.test(line)) {
      push('heading', i, i + 1)
      i++
      continue
    }
    if (QUOTE_RE.test(line)) {
      const start = i
      while (i < lines.length && QUOTE_RE.test(lines[i] ?? '')) i++
      push('quote', start, i)
      continue
    }
    // Tables: consecutive pipe rows (+ delimiter) stay together.
    if (isTableRow(line)) {
      const start = i
      while (i < lines.length && (isTableRow(lines[i] ?? '') || /^\s*\|?\s*:?-{3,}/.test(lines[i] ?? ''))) i++
      push('table', start, i)
      continue
    }
    // Lists: each item is its own block so tasks toggle independently.
    // Continuation lines (indented, non-item) join the current item.
    if (LIST_RE.test(line) || TASK_RE.test(line)) {
      const start = i
      const kind: BlockKind = TASK_RE.test(line) ? 'task' : 'list'
      i++
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i] ?? '') &&
        !LIST_RE.test(lines[i] ?? '') &&
        !TASK_RE.test(lines[i] ?? '') &&
        !HEADING_RE.test(lines[i] ?? '') &&
        !FENCE_RE.test(lines[i] ?? '') &&
        !HR_RE.test(lines[i] ?? '') &&
        !QUOTE_RE.test(lines[i] ?? '')
      ) {
        i++
      }
      push(kind, start, i)
      continue
    }
    // Paragraph: run of plain lines.
    const start = i
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i] ?? '') &&
      !FENCE_RE.test(lines[i] ?? '') &&
      !HEADING_RE.test(lines[i] ?? '') &&
      !HR_RE.test(lines[i] ?? '') &&
      !QUOTE_RE.test(lines[i] ?? '') &&
      !LIST_RE.test(lines[i] ?? '') &&
      !TASK_RE.test(lines[i] ?? '') &&
      !isTableRow(lines[i] ?? '')
    ) {
      i++
    }
    push('paragraph', start, i)
  }
  return blocks
}

/** Splice an edited block back into the full document. */
export function spliceBlock(full: string, block: LiveBlock, nextSource: string): string {
  const lines = full.split('\n')
  const head = lines.slice(0, block.startLine)
  const tail = lines.slice(block.endLine)
  const insert = nextSource.split('\n')
  // Preserve a blank separator when inserting between content.
  return [...head, ...insert, ...tail].join('\n')
}

/** Flip `- [ ]` ↔ `- [x]` for a task block. Returns null when not a task. */
export function toggleTaskSource(source: string): string | null {
  const m = /^(\s*-\s+\[)([ xX])(\]\s+)/.exec(source)
  if (!m) return null
  const checked = m[2]?.toLowerCase() === 'x'
  return `${m[1]}${checked ? ' ' : 'x'}${m[3]}${source.slice(m[0].length)}`
}
