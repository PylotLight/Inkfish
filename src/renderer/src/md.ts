/** Tiny GFM-ish renderer for note preview. No deps: headings, bold/italic,
 * inline code, links, images, quotes, lists, task items, fenced code, tables. */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s: string): string {
  let out = esc(s)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />')
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  out = out.replace(/(`[^`]+`)/g, (m) => `<code>${m.slice(1, -1)}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return out
}

export function renderMarkdown(md: string): string {
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
      html.push(`<blockquote>${quoteBuf.map(inline).join('<br />')}</blockquote>`)
      quoteBuf = null
    }
  }

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      if (inCode) {
        html.push(`<pre><code class="lang-${esc(codeLang)}">${esc(codeBuf.join('\n'))}</code></pre>`)
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
      html.push(`<h${level}>${inline(h[2] ?? '')}</h${level}>`)
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
      html.push(`<li class="task"><input type="checkbox" disabled${checked} /> ${inline(task[2] ?? '')}</li>`)
      continue
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) {
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${inline(li[1] ?? '')}</li>`)
      continue
    }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      closeList()
      html.push(`<ol><li>${inline(ol[1] ?? '')}</li></ol>`)
      continue
    }
    closeList()
    if (/^\s*$/.test(line)) continue
    if (/^\|.*\|\s*$/.test(line) && /---/.test(line)) continue
    html.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  closeQuote()
  if (inCode) html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`)
  return html.join('\n')
}
