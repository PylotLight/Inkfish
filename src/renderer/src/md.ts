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
        html.push(codeBlockHtml(codeLang, codeBuf.join('\n')))
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
  if (inCode) html.push(codeBlockHtml(codeLang, codeBuf.join('\n')))
  return html.join('\n')
}

// --- Code blocks: highlight + copy ------------------------------------------
// Dependency-free regex highlighter. Covers common language families with a
// single-pass scan (comments → strings → keys/tags → keywords → numbers) so
// token boundaries can't overlap. Unknown languages get generic treatment
// (comments + strings + numbers).

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const C_LIKE_KW = (
  'break case catch class const continue debugger default delete do else export extends ' +
  'finally for function if import in instanceof new return super switch this throw try ' +
  'typeof var void while with yield let static async await enum implements interface ' +
  'package private protected public type from as func package go map chan defer select ' +
  'fallthrough fn mut struct trait impl mod use crate pub ref self Self fn let mut ' +
  'fn def auto bool char double float int long short signed sizeof union unsigned void volatile'
).split(/\s+/)

const PYTHON_KW =
  'False None True and as assert async await break class continue def del elif else ' +
  'except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'

const BASH_KW =
  'if then else elif fi for while until in do done case esac function select return exit ' +
  'export local readonly declare unset alias unalias true false source'

const SQL_KW =
  'SELECT FROM WHERE AND OR NOT INSERT INTO UPDATE DELETE CREATE TABLE DROP ALTER JOIN ' +
  'LEFT RIGHT INNER OUTER ON AS BY ORDER GROUP HAVING LIMIT OFFSET DISTINCT NULL IS LIKE ' +
  'IN BETWEEN UNION ALL VALUES SET PRIMARY KEY REFERENCES INDEX VIEW TRIGGER PROCEDURE'

const CSS_AT = 'import media font-face keyframes supports charset namespace page document'

interface LangSpec {
  keywords: string[]
  caseInsensitive?: boolean
  lineComments?: string[]
  blockComment?: [string, string]
  yamlKeys?: boolean
  cssProps?: boolean
  htmlTags?: boolean
  attrKeys?: boolean
}

function specFor(lang: string): LangSpec {
  const L = lang.toLowerCase()
  if (L === 'py' || L === 'python' || L === 'pyi' || L === 'toml' || L === 'ini' || L === 'cfg') {
    return { keywords: PYTHON_KW.split(/\s+/), lineComments: ['#'] }
  }
  if (L === 'yaml' || L === 'yml') {
    return { keywords: 'true True TRUE false False FALSE null Null NULL ~ yes Yes YES no No NO on On ON off Off OFF'.split(/\s+/), lineComments: ['#'], yamlKeys: true }
  }
  if (L === 'json' || L === 'jsonc' || L === 'json5') {
    return { keywords: ['true', 'false', 'null'], lineComments: ['//'], yamlKeys: true }
  }
  if (L === 'sh' || L === 'bash' || L === 'zsh' || L === 'shell' || L === 'dockerfile' || L === 'docker') {
    return { keywords: BASH_KW.split(/\s+/), lineComments: ['#'] }
  }
  if (L === 'sql') {
    return { keywords: SQL_KW.split(/\s+/), caseInsensitive: true, lineComments: ['--'] }
  }
  if (L === 'css' || L === 'scss' || L === 'less') {
    return { keywords: CSS_AT.split(/\s+/).map((w) => `@${w}`), lineComments: [], blockComment: ['/*', '*/'], cssProps: true }
  }
  if (L === 'html' || L === 'xml' || L === 'vue' || L === 'svelte' || L === 'svg' || L === 'md' || L === 'markdown') {
    return { keywords: [], blockComment: ['<!--', '-->'], htmlTags: true, attrKeys: true }
  }
  if (
    ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'java', 'c', 'h', 'cpp', 'hpp', 'cc',
     'go', 'rs', 'rust', 'rb', 'ruby', 'php', 'swift', 'kt', 'kts', 'scala', 'cs', 'dart'].includes(L)
  ) {
    return { keywords: C_LIKE_KW, lineComments: ['//'], blockComment: ['/*', '*/'] }
  }
  // Unknown: generic strings + numbers + both common comment styles.
  return { keywords: [], lineComments: ['#', '//'] }
}

/** Highlight raw code for `lang`, returning escaped HTML with token spans. */
export function highlightCode(src: string, lang: string): string {
  const spec = specFor(lang)
  const parts: string[] = []
  if (spec.blockComment) {
    const [o, c] = spec.blockComment
    parts.push(`(?<comBlock>${escRe(o)}[\\s\\S]*?(?:${escRe(c)}|$))`)
  }
  if (spec.lineComments && spec.lineComments.length > 0) {
    parts.push(`(?<comLine>(?:${spec.lineComments.map(escRe).join('|')})[^\\n]*)`)
  }
  if (spec.htmlTags) {
    parts.push('(?<tag></?[A-Za-z][^\\s<>/!?=]*|/?>)')
  }
  parts.push(`(?<str>'(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`)`)
  if (spec.attrKeys) {
    parts.push(`(?<attr>[A-Za-z_:][\\w:.-]*(?=\\s*=))`)
  }
  if (spec.yamlKeys) {
    parts.push('(?<key>[A-Za-z0-9_.\\-/][A-Za-z0-9_.\\-/ ]*(?=:([ \\t]|$)))')
  }
  if (spec.cssProps) {
    parts.push('(?<key>[A-Za-z-]+(?=\\s*:))')
  }
  parts.push('(?<num>\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?)\\b)')
  if (spec.keywords.length > 0) {
    const uni = [...new Set(spec.keywords)].map(escRe).join('|')
    parts.push(`(?<kw>\\b(?:${uni})\\b)`)
  }
  const flags = spec.caseInsensitive ? 'gmi' : 'gm'
  const re = new RegExp(parts.join('|'), flags)
  let out = ''
  let last = 0
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const idx = m.index ?? 0
    out += esc(src.slice(last, idx))
    const g = m.groups ?? {}
    const tok = (Object.keys(g).find((k) => g[k] !== undefined) ?? '') as string
    const cls = tok === 'comBlock' || tok === 'comLine' ? 'tok-com'
      : tok === 'str' ? 'tok-str'
      : tok === 'num' ? 'tok-num'
      : tok === 'kw' ? 'tok-kw'
      : tok === 'key' || tok === 'attr' ? 'tok-key'
      : tok === 'tag' ? 'tok-tag' : ''
    out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0])
    last = idx + m[0].length
    if (m[0].length === 0) re.lastIndex++
  }
  out += esc(src.slice(last))
  return out
}

/** Full code block: header (lang + copy, expand when long) + highlighted pre. */
export function codeBlockHtml(lang: string, src: string): string {
  const body = highlightCode(src, lang)
  const label = esc(lang || 'code')
  const cls = lang ? ` class="lang-${esc(lang)}"` : ''
  const n = src.split('\n').length
  if (n > 25) {
    return (
      `<div class="codeblock long">` +
      `<div class="codehead"><span class="codelang">${label} · ${n} lines</span>` +
      `<span class="codeactions"><button type="button" class="copy-code" title="Copy code to clipboard">Copy</button>` +
      `<button type="button" class="expand-code" title="Expand code block">Expand</button></span></div>` +
      `<pre class="collapsed"><code${cls}>${body}</code></pre></div>`
    )
  }
  return (
    `<div class="codeblock">` +
    `<div class="codehead"><span class="codelang">${label}</span>` +
    `<span class="codeactions"><button type="button" class="copy-code" title="Copy code to clipboard">Copy</button></span></div>` +
    `<pre><code${cls}>${body}</code></pre></div>`
  )
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
