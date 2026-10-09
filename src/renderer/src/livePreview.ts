import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { indentLess, indentMore } from '@codemirror/commands'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, KeyBinding, ViewUpdate } from '@codemirror/view'

/**
 * Obsidian-style live preview for one continuous CodeMirror document: the
 * whole file stays editable (selections span lines) while markdown chrome
 * (heading hashes, emphasis markers, quote markers, task brackets) is hidden
 * and content is styled in place. No block editors, no separate raw mode.
 *
 * Scope: headings, quotes, hr, tasks, bold/italic/strike, inline code, links,
 * fenced code styling. Images + tables stay as dimmed source (fully editable).
 */

export interface LivePreviewOptions {
  /** Flip the ` `/`x` inside task brackets at `pos`. */
  onToggleTask: (pos: number) => void
}

/** Skip fancy decorations past this size — plain editing stays fast. */
const MAX_DECORATED_CHARS = 400_000

const FENCE_RE = /^(`{3,}|~{3,})/
const HEADING_RE = /^(#{1,4})\s+/
const HR_RE = /^\s{0,3}(---|\*\*\*|___)\s*$/
const QUOTE_PREFIX_RE = /^(?:\s{0,3}>\s?)+/
const TASK_RE = /^(\s{0,8}[-*])\s+\[([ xX])\](?=\s|$)/
const BULLET_RE = /^(\s*)([-*+])(\s+)/
const ORDERED_RE = /^(\s*)(\d+[.)])(\s+)/
const CODE_SPAN_RE = /`([^`\n]+?)`/g
const BOLD_RE = /\*\*(.+?)\*\*/g
const TRIPLE_RE = /\*\*\*(.+?)\*\*\*/g
const ITALIC_RE = /(^|[^*\w])\*([^*\n]+?)\*/g
const STRIKE_RE = /~~(.+?)~~/g
const LINK_RE = /\[([^\]\n]*)\]\(([^)\n]*)\)/g

/** Rendered list bullet (`•`) replacing the typed `-`/`*` marker. */
class BulletWidget extends WidgetType {
  override eq(other: unknown): boolean {
    return other instanceof BulletWidget
  }
  override ignoreEvent(): boolean {
    return false
  }
  override toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'lp-bullet'
    s.textContent = '• '
    return s
  }
}

/** Task row: rendered bullet + interactive checkbox for `- [ ]`. */
class TaskBulletWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
    readonly onToggle: (pos: number) => void
  ) {
    super()
  }
  override eq(other: TaskBulletWidget): boolean {
    return other instanceof TaskBulletWidget && other.checked === this.checked && other.pos === this.pos
  }
  override ignoreEvent(): boolean {
    return false
  }
  override toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'lp-taskbullet'
    s.textContent = '• '
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.className = 'lp-taskbox'
    input.setAttribute('aria-label', this.checked ? 'Uncheck task' : 'Check task')
    input.tabIndex = -1
    input.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.onToggle(this.pos)
    })
    s.appendChild(input)
    s.appendChild(document.createTextNode(' '))
    return s
  }
}

interface Op {
  from: number
  to: number
  deco: Decoration
}

function overlaps(claimed: Array<[number, number]>, from: number, to: number): boolean {
  for (const [a, b] of claimed) if (from < b && to > a) return true
  return false
}

function buildDecorations(view: EditorView, opts: LivePreviewOptions): DecorationSet {
  const doc = view.state.doc
  if (doc.length > MAX_DECORATED_CHARS) return Decoration.none
  const ops: Op[] = []
  const hide = (from: number, to: number): void => {
    if (to > from) ops.push({ from, to, deco: Decoration.replace({}) })
  }
  const mark = (from: number, to: number, cls: string): void => {
    if (to > from) ops.push({ from, to, deco: Decoration.mark({ class: cls }) })
  }
  const line = (at: number, cls: string): void => {
    ops.push({ from: at, to: at, deco: Decoration.line({ class: cls }) })
  }

  let inFence = false
  for (let ln = 1; ln <= doc.lines; ln++) {
    const l = doc.line(ln)
    const text = l.text
    const base = l.from

    if (FENCE_RE.test(text)) {
      inFence = !inFence
      line(base, 'lp-fence')
      continue
    }
    if (inFence) {
      line(base, 'lp-code')
      continue
    }

    // Blockquote prefix first; the rest of the line still decorates.
    let rest = text
    let restBase = base
    let quoted = false
    const qm = QUOTE_PREFIX_RE.exec(text)
    if (qm) {
      hide(base, base + qm[0].length)
      line(base, 'lp-quote')
      quoted = true
      rest = text.slice(qm[0].length)
      restBase = base + qm[0].length
    }

    // Headings (also inside quotes).
    const hm = HEADING_RE.exec(rest)
    if (hm) {
      const level = Math.min(4, hm[1]?.length ?? 1)
      hide(restBase, restBase + hm[0].length)
      line(base, `lp-h${level}`)
      rest = rest.slice(hm[0].length)
      restBase += hm[0].length
    } else if (HR_RE.test(rest) && !quoted) {
      const trimmed = rest.match(/^\s*/)![0].length
      hide(restBase + trimmed, restBase + rest.trimEnd().length)
      line(base, 'lp-hr')
      continue
    }

    // Tasks render as bullet + checkbox; plain bullets as `•`; ordered
    // numbers stay visible, subtly styled. Indent spaces are untouched so
    // nesting keeps its alignment.
    const claimed: Array<[number, number]> = []
    const tm = TASK_RE.exec(rest)
    if (tm) {
      const bulletLen = tm[1]?.length ?? 0
      const openBracket = restBase + bulletLen + 1
      const checkPos = openBracket + 1
      ops.push({
        from: restBase + bulletLen - 1,
        to: openBracket + 3,
        deco: Decoration.replace({
          widget: new TaskBulletWidget(tm[2]?.toLowerCase() === 'x', checkPos, opts.onToggleTask)
        })
      })
      claimed.push([restBase + bulletLen - 1, openBracket + 3])
    } else {
      const bm = BULLET_RE.exec(rest)
      if (bm) {
        const indentLen = bm[1]?.length ?? 0
        const markerLen = 1 + (bm[3]?.length ?? 1)
        const wFrom = restBase + indentLen
        ops.push({
          from: wFrom,
          to: wFrom + markerLen,
          deco: Decoration.replace({ widget: new BulletWidget() })
        })
        claimed.push([wFrom, wFrom + markerLen])
      } else {
        const om = ORDERED_RE.exec(rest)
        if (om) {
          const numFrom = restBase + (om[1]?.length ?? 0)
          mark(numFrom, numFrom + (om[2]?.length ?? 0), 'lp-olist')
          claimed.push([numFrom, numFrom + (om[2]?.length ?? 0)])
        }
      }
    }

    // Inline code first — other markup inside code spans stays literal.
    for (const m of rest.matchAll(CODE_SPAN_RE)) {
      const i = m.index ?? 0
      const spanFrom = restBase + i
      const spanTo = spanFrom + m[0].length
      if (overlaps(claimed, spanFrom, spanTo)) continue
      claimed.push([spanFrom, spanTo])
      hide(spanFrom, spanFrom + 1)
      hide(spanTo - 1, spanTo)
      mark(spanFrom + 1, spanTo - 1, 'lp-codespan')
    }
    // Links: hide brackets + URL, style the text.
    for (const m of rest.matchAll(LINK_RE)) {
      const i = m.index ?? 0
      const label = m[1] ?? ''
      const sFrom = restBase + i
      const labelFrom = sFrom + 1
      const labelTo = labelFrom + label.length
      const sTo = sFrom + m[0].length
      if (overlaps(claimed, sFrom, sTo)) continue
      claimed.push([sFrom, sTo])
      hide(sFrom, labelFrom)
      mark(labelFrom, labelTo, 'lp-link')
      hide(labelTo, sTo)
    }
    // Emphasis (triple → bold → italic → strike).
    for (const m of rest.matchAll(TRIPLE_RE)) {
      const i = m.index ?? 0
      const sFrom = restBase + i
      const sTo = sFrom + m[0].length
      if (overlaps(claimed, sFrom, sTo)) continue
      claimed.push([sFrom, sTo])
      hide(sFrom, sFrom + 3)
      hide(sTo - 3, sTo)
      mark(sFrom + 3, sTo - 3, `lp-bold lp-em`)
    }
    for (const m of rest.matchAll(BOLD_RE)) {
      const i = m.index ?? 0
      // Skip triple-asterisk leftovers already claimed.
      if (rest.startsWith('***', i) || rest.startsWith('***', i + m[0].length - 3)) continue
      const sFrom = restBase + i
      const sTo = sFrom + m[0].length
      if (overlaps(claimed, sFrom, sTo)) continue
      claimed.push([sFrom, sTo])
      hide(sFrom, sFrom + 2)
      hide(sTo - 2, sTo)
      mark(sFrom + 2, sTo - 2, 'lp-bold')
    }
    for (const m of rest.matchAll(ITALIC_RE)) {
      const prefix = m[1] ?? ''
      const inner = m[2] ?? ''
      const i = m.index ?? 0
      const starFrom = restBase + i + prefix.length
      const sTo = starFrom + 1 + inner.length + 1
      if (overlaps(claimed, starFrom, sTo)) continue
      claimed.push([starFrom, sTo])
      hide(starFrom, starFrom + 1)
      hide(sTo - 1, sTo)
      mark(starFrom + 1, sTo - 1, 'lp-em')
    }
    for (const m of rest.matchAll(STRIKE_RE)) {
      const i = m.index ?? 0
      const sFrom = restBase + i
      const sTo = sFrom + m[0].length
      if (overlaps(claimed, sFrom, sTo)) continue
      claimed.push([sFrom, sTo])
      hide(sFrom, sFrom + 2)
      hide(sTo - 2, sTo)
      mark(sFrom + 2, sTo - 2, 'lp-strike')
    }
  }

  ops.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const o of ops) {
    try {
      builder.add(o.from, o.to, o.deco)
    } catch {
      // Overlapping ranges from independent patterns — skip the loser.
    }
  }
  return builder.finish()
}

/** Live-preview decorations as a CodeMirror extension. */
export function livePreview(opts: LivePreviewOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts)
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, opts)
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
}

/**
 * Obsidian-style list keys: Enter continues bullets/numbered items/tasks
 * (Enter on an empty item exits the list), Tab/Shift-Tab indent. Bind before
 * the default keymap so they win.
 */
export const listKeys: KeyBinding[] = [
  {
    key: 'Enter',
    run: (view) => {
      const sel = view.state.selection.main
      if (!sel.empty) return false
      const line = view.state.doc.lineAt(sel.head)
      if (sel.head !== line.to) return false
      const m = /^(\s*)([-*]|\d+[.)])(\s+)(.*)$/.exec(line.text)
      if (!m) return false
      const indent = m[1] ?? ''
      const bullet = m[2] ?? '-'
      const rest = m[4] ?? ''
      if (!rest.trim()) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: '' } })
        return true
      }
      const nextBullet = /^\d/.test(bullet) ? `${parseInt(bullet, 10) + 1}.` : bullet
      const task = /^\[[ xX]\]\s*/.exec(rest)
      const cont = `${indent}${nextBullet} ${task ? '[ ] ' : ''}`
      view.dispatch({
        changes: { from: sel.head, insert: `\n${cont}` },
        selection: { anchor: sel.head + 1 + cont.length }
      })
      return true
    }
  },
  { key: 'Tab', run: indentMore },
  { key: 'Shift-Tab', run: indentLess }
]
