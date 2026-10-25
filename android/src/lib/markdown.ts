import { blockImage, type ImageToken } from './mdimages'

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'li'; text: string; depth: number }
  | { t: 'code'; text: string }
  | { t: 'img'; img: ImageToken }
  | { t: 'task'; done: boolean; text: string; depth: number }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'gap' }

function listDepth(indent: string): number {
  // Two spaces (or one tab) represent one visual level in the compact renderer.
  return Math.floor(indent.replace(/\t/g, '  ').length / 2)
}

/** Parse the small Markdown subset used by the Android note reader. */
export function parseMarkdown(text: string): Block[] {
  const out: Block[] = []
  const lines = text.split('\n')
  let code: string[] | null = null
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code) {
        out.push({ t: 'code', text: code.join('\n') })
        code = null
      } else code = []
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push({ t: 'hr' })
      continue
    }
    const task = /^([ \t]*)[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line)
    if (task) {
      out.push({
        t: 'task',
        done: task[2] !== ' ',
        text: task[3] ?? '',
        depth: listDepth(task[1] ?? '')
      })
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      out.push({ t: 'quote', text: q[1] ?? '' })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ t: 'h', level: h[1]?.length ?? 1, text: h[2] ?? '' })
      continue
    }
    const img = line.includes('![') ? blockImage(line) : null
    if (img) {
      out.push({ t: 'img', img })
      continue
    }
    const bullet = /^([ \t]*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      out.push({ t: 'li', text: bullet[2] ?? '', depth: listDepth(bullet[1] ?? '') })
      continue
    }
    const numbered = /^([ \t]*)\d+\.\s+(.*)$/.exec(line)
    if (numbered) {
      out.push({ t: 'li', text: numbered[2] ?? '', depth: listDepth(numbered[1] ?? '') })
      continue
    }
    if (!line.trim()) {
      out.push({ t: 'gap' })
      continue
    }
    out.push({ t: 'p', text: line })
  }
  if (code) out.push({ t: 'code', text: code.join('\n') })
  return out
}
