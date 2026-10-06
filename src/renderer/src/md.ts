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
