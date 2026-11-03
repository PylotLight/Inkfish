import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type KeyBinding } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { findImages } from '../../../src/shared/images'
import { resolveImage, vaultFileUri, isAudio, type ImageToken } from './mdimages'

const TASK_RE = /^([ \t]*)(?:([-*+])([ \t]+))?\[([ xX]?)\](?=\s|$)/
const FENCE_RE = /^\s*(`{3,}|~{3,})/
const HEADING_RE = /^(#{1,6})(\s+)(.*)$/
const QUOTE_RE = /^(?:\s{0,3}>\s?)+/
const HR_RE = /^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/
const EMBED_RE = /!\[\[([^\]\n]+)\]\]/g

type Range = {
  from: number
  to: number
  value:
    | ReturnType<typeof Decoration.mark>
    | ReturnType<typeof Decoration.replace>
    | ReturnType<typeof Decoration.line>
    | ReturnType<typeof Decoration.widget>
}
export interface LiveMarkdownOptions {
  notePath: string | null
  files: readonly string[]
  vaultRoot: string
  title: string
  hideCompletedTasks: boolean
  collapsedHeadings?: readonly string[]
}
type ToggleTask = (lineFrom: number) => void
type ToggleHeading = (key: string) => void

export function headingCollapseKey(sourceLine: string, occurrence: number): string {
  return `${sourceLine}\u0000${occurrence}`
}

function addMark(ranges: Range[], from: number, to: number, className: string): void {
  if (to > from) ranges.push({ from, to, value: Decoration.mark({ class: className }) })
}
function hide(ranges: Range[], from: number, to: number): void {
  if (to > from) ranges.push({ from, to, value: Decoration.replace({}) })
}

export class TaskBoxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly lineFrom: number,
    readonly bullet: boolean,
    readonly toggle: ToggleTask
  ) {
    super()
  }
  override eq(other: TaskBoxWidget): boolean {
    return (
      other instanceof TaskBoxWidget &&
      other.checked === this.checked &&
      other.lineFrom === this.lineFrom &&
      other.bullet === this.bullet
    )
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = this.bullet ? 'cm-md-task cm-md-task-bullet' : 'cm-md-task'
    if (this.bullet) {
      const bullet = document.createElement('span')
      bullet.className = 'cm-md-bullet'
      bullet.textContent = '•'
      bullet.setAttribute('aria-hidden', 'true')
      wrap.appendChild(bullet)
    }
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-md-task-box'
    box.tabIndex = 0
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.setAttribute('aria-label', this.checked ? 'Uncheck task' : 'Check task')
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      event.preventDefault()
      this.toggle(this.lineFrom)
      view.focus()
    })
    wrap.appendChild(box)
    return wrap
  }
  override ignoreEvent(): boolean {
    return false
  }
}

class HeadingFoldWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly label: string,
    readonly collapsed: boolean,
    readonly toggle: ToggleHeading
  ) {
    super()
  }
  override eq(other: HeadingFoldWidget): boolean {
    return (
      other instanceof HeadingFoldWidget &&
      other.key === this.key &&
      other.collapsed === this.collapsed &&
      other.label === this.label
    )
  }
  override toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-md-heading-fold'
    button.textContent = this.collapsed ? '›' : '⌄'
    button.setAttribute('aria-expanded', String(!this.collapsed))
    button.setAttribute('aria-label', `${this.collapsed ? 'Expand' : 'Collapse'} section: ${this.label}`)
    button.title = `${this.collapsed ? 'Expand' : 'Collapse'} section`
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.toggle(this.key)
      view.focus()
    })
    return button
  }
  override ignoreEvent(): boolean {
    return false
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly token: ImageToken,
    readonly uri: string | null,
    readonly block: boolean
  ) {
    super()
  }
  override eq(other: ImageWidget): boolean {
    return (
      other instanceof ImageWidget &&
      other.token.src === this.token.src &&
      other.token.alt === this.token.alt &&
      other.uri === this.uri &&
      other.block === this.block &&
      other.token.width === this.token.width &&
      other.token.height === this.token.height
    )
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = this.block ? 'cm-md-image cm-md-image-block' : 'cm-md-image'
    const label = this.token.alt || this.token.src.split('/').pop() || 'image'
    if (isAudio(this.token.src)) {
      wrap.classList.add('cm-md-audio')
      wrap.textContent = `Voice memo · ${label}`
      wrap.setAttribute('role', 'img')
      wrap.setAttribute('aria-label', `Voice memo: ${label}`)
      return wrap
    }
    if (!this.uri) {
      wrap.textContent = `Image · ${label}`
      wrap.setAttribute('role', 'img')
      wrap.setAttribute('aria-label', `Image: ${label}`)
      return wrap
    }
    const image = document.createElement('img')
    image.src = this.uri
    image.alt = label
    image.loading = 'lazy'
    image.className = 'cm-md-image-content'
    image.style.maxWidth = '100%'
    image.style.maxHeight = '280px'
    image.style.objectFit = 'contain'
    if (this.token.width) image.style.width = `${this.token.width}px`
    if (this.token.height) image.style.height = `${this.token.height}px`
    image.addEventListener('error', () => {
      wrap.replaceChildren(document.createTextNode(`Image · ${label}`))
      wrap.setAttribute('role', 'img')
      wrap.setAttribute('aria-label', `Image: ${label}`)
    })
    wrap.appendChild(image)
    return wrap
  }
  override ignoreEvent(): boolean {
    return false
  }
}

class RuleWidget extends WidgetType {
  override eq(other: RuleWidget): boolean {
    return other instanceof RuleWidget
  }
  override toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'cm-md-rule'
    rule.setAttribute('role', 'separator')
    return rule
  }
}

function imageRanges(lineText: string, lineFrom: number): Array<{ from: number; to: number; token: ImageToken }> {
  const found: Array<{ from: number; to: number; token: ImageToken }> = []
  for (const image of findImages(lineText)) {
    found.push({
      from: lineFrom + image.index,
      to: lineFrom + image.index + image.length,
      token: {
        t: 'img',
        alt: image.alt,
        src: image.src,
        embed: false,
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {})
      }
    })
  }
  for (const match of lineText.matchAll(EMBED_RE)) {
    const index = match.index ?? 0
    if (found.some((item) => index >= item.from - lineFrom && index < item.to - lineFrom)) continue
    const raw = match[0]
    const token = raw ? resolveEmbed(raw) : null
    if (token) found.push({ from: lineFrom + index, to: lineFrom + index + raw.length, token })
  }
  return found.sort((a, b) => a.from - b.from)
}

function resolveEmbed(raw: string): ImageToken | null {
  const match = /^!\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?((?:\|[^\]\n]*)?)\]\]$/.exec(raw)
  if (!match) return null
  const src = (match[1] ?? '').trim()
  if (!src) return null
  const size = /\|\s*(\d{1,5})(?:\s*x\s*(\d{1,5}))?\s*$/.exec(match[2] ?? '')
  const width = size ? Number(size[1]) : undefined
  const height = size?.[2] ? Number(size[2]) : undefined
  const displayAlt = (match[2] ?? '')
    .replace(/^\|/, '')
    .replace(/\|\s*\d{1,5}(?:\s*x\s*\d{1,5})?\s*$/, '')
    .trim()
  return {
    t: 'img',
    src,
    alt:
      displayAlt ||
      src
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') ||
      src,
    embed: true,
    ...(width && width > 0 ? { width } : {}),
    ...(height && height > 0 ? { height } : {})
  }
}

function titleHeadingRange(state: EditorState, title: string): { from: number; to: number } | null {
  const all = state.doc.toString()
  const leading = all.length - all.trimStart().length
  const first = all.slice(leading)
  const match = /^(#\s+[^\n]*)(?:\n|$)/.exec(first)
  if (!match || match[1]!.slice(2).trim() !== title.trim()) return null
  return { from: leading, to: leading + match[1]!.length }
}

function overlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < b.to && b.from < a.to
}

function inlineDecorations(
  lineText: string,
  lineFrom: number,
  ranges: Range[],
  revealSyntax: boolean,
  images: Array<{ from: number; to: number }>
): void {
  const definitions: Array<{ re: RegExp; className: string }> = [
    { re: /\*\*([^*\n]+)\*\*/g, className: 'cm-md-bold' },
    { re: /~~([^~\n]+)~~/g, className: 'cm-md-strike' },
    { re: /`([^`\n]+)`/g, className: 'cm-md-code' },
    { re: /(?<![\w*])\*([^*\n]+)\*(?!\w)/g, className: 'cm-md-italic' },
    { re: /(?<!\w)_([^_\n]+)_(?!\w)/g, className: 'cm-md-italic' }
  ]
  for (const { re, className } of definitions) {
    for (const match of lineText.matchAll(re)) {
      const at = match.index ?? 0
      const whole = match[0]
      const inner = match[1] ?? ''
      const from = lineFrom + at
      const innerFrom = from + whole.indexOf(inner)
      const to = from + whole.length
      if (images.some((image) => overlap({ from, to }, image))) continue
      addMark(ranges, innerFrom, innerFrom + inner.length, className)
      if (!revealSyntax) {
        hide(ranges, from, innerFrom)
        hide(ranges, innerFrom + inner.length, to)
      }
    }
  }
  const linkRe = /\[([^\]\n]+)\]\(([^)\n]*)\)/g
  for (const match of lineText.matchAll(linkRe)) {
    const at = match.index ?? 0
    const whole = match[0]
    const label = match[1] ?? ''
    const from = lineFrom + at
    const labelFrom = from + whole.indexOf(label)
    const labelTo = labelFrom + label.length
    const to = from + whole.length
    if (images.some((image) => overlap({ from, to }, image))) continue
    addMark(ranges, labelFrom, labelTo, 'cm-md-link')
    if (!revealSyntax) {
      hide(ranges, from, labelFrom)
      hide(ranges, labelTo, to)
    }
  }
}

export function buildLiveMarkdownDecorations(
  state: EditorState,
  options: LiveMarkdownOptions,
  activeLine: number,
  toggle: ToggleTask,
  toggleHeading: ToggleHeading = () => undefined
): DecorationSet {
  const ranges: Range[] = []
  const titleRange = titleHeadingRange(state, options.title)
  const collapsedHeadings = options.collapsedHeadings ?? []
  const headingOccurrences = new Map<string, number>()
  let inFence = false
  let collapsedLevel: number | null = null
  let completedTaskIndent: number | null = null
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number)
    const text = line.text
    const revealSyntax = number === activeLine
    const fence = FENCE_RE.exec(text)
    const heading = !inFence && !fence ? HEADING_RE.exec(text) : null
    let headingKey: string | null = null
    if (heading) {
      const sourceLine = text
      const occurrence = (headingOccurrences.get(sourceLine) ?? 0) + 1
      headingOccurrences.set(sourceLine, occurrence)
      headingKey = headingCollapseKey(sourceLine, occurrence)
      const level = heading[1]?.length ?? 1
      if (collapsedLevel !== null && level <= collapsedLevel) collapsedLevel = null
    }
    const hiddenByHeading = collapsedLevel !== null

    let hiddenByCompletedTask = false
    if (completedTaskIndent !== null) {
      if (!text.trim()) hiddenByCompletedTask = true
      else {
        const indentLength = /^[ \t]*/.exec(text)?.[0].length ?? 0
        if (indentLength > completedTaskIndent) hiddenByCompletedTask = true
        else completedTaskIndent = null
      }
    }
    if (hiddenByCompletedTask) {
      ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-hidden-completed' }) })
      if (fence) inFence = !inFence
      continue
    }

    if (inFence) {
      if (fence) {
        if (hiddenByHeading) {
          ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-folded-line' }) })
        } else {
          addMark(ranges, line.from, line.to, 'cm-md-code-fence')
          if (!revealSyntax) hide(ranges, line.from, line.to)
        }
        inFence = false
      } else if (hiddenByHeading) {
        ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-folded-line' }) })
      } else {
        ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-code-block' }) })
        addMark(ranges, line.from, line.to, 'cm-md-code-block-text')
      }
      continue
    }
    if (fence) {
      inFence = true
      if (hiddenByHeading)
        ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-folded-line' }) })
      else {
        addMark(ranges, line.from, line.to, 'cm-md-code-fence')
        if (!revealSyntax) hide(ranges, line.from, line.to)
      }
      continue
    }
    if (hiddenByHeading) {
      ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-folded-line' }) })
      continue
    }

    const task = TASK_RE.exec(text)
    if (task) {
      const indent = task[1] ?? ''
      const bullet = Boolean(task[2])
      const markerFrom = line.from + indent.length
      const markerTo = line.from + task[0].length
      const checked = (task[4] ?? '') !== '' && task[4] !== ' '
      if (options.hideCompletedTasks && checked) {
        ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-hidden-completed' }) })
        completedTaskIndent = indent.length
        continue
      }
      ranges.push({
        from: markerFrom,
        to: markerTo,
        value: Decoration.replace({ widget: new TaskBoxWidget(checked, line.from, bullet, toggle), inclusive: false })
      })
      if (checked) addMark(ranges, markerTo, line.to, 'cm-md-task-done')
      const images = imageRanges(text, line.from)
      for (const image of images) {
        if (revealSyntax) addMark(ranges, image.from, image.to, 'cm-md-image-source')
        else {
          const target = resolveImage(image.token, options.notePath, options.files)
          const uri =
            target?.kind === 'remote'
              ? target.uri
              : target && options.vaultRoot
                ? vaultFileUri(options.vaultRoot, target.rel)
                : null
          ranges.push({
            from: image.from,
            to: image.to,
            value: Decoration.replace({ widget: new ImageWidget(image.token, uri, false), inclusive: false })
          })
        }
      }
      inlineDecorations(text, line.from, ranges, revealSyntax, images)
      continue
    }
    const images = imageRanges(text, line.from)
    if (titleRange && line.from === titleRange.from) {
      hide(ranges, titleRange.from, titleRange.to)
      ranges.push({ from: line.from, to: line.from, value: Decoration.line({ class: 'cm-md-duplicate-title' }) })
      continue
    }
    if (HR_RE.test(text)) {
      if (revealSyntax) addMark(ranges, line.from, line.to, 'cm-md-rule-source')
      else
        ranges.push({
          from: line.from,
          to: line.to,
          value: Decoration.replace({ widget: new RuleWidget(), inclusive: false })
        })
      continue
    }
    if (heading) {
      const level = heading[1]?.length ?? 1
      const collapsed = headingKey !== null && collapsedHeadings.includes(headingKey)
      const label = (heading[3] ?? '').trim() || 'Untitled section'
      ranges.push({
        from: line.from,
        to: line.from,
        value: Decoration.widget({
          widget: new HeadingFoldWidget(headingKey ?? '', label, collapsed, toggleHeading),
          side: -1
        })
      })
      const markerEnd = line.from + (heading[1]?.length ?? 0) + (heading[2]?.length ?? 0)
      addMark(ranges, markerEnd, line.to, `cm-md-h${Math.min(level, 3)}`)
      if (!revealSyntax) hide(ranges, line.from, markerEnd)
      if (collapsed) collapsedLevel = level
    }
    const quote = QUOTE_RE.exec(text)
    if (quote) {
      if (!revealSyntax) hide(ranges, line.from, line.from + quote[0].length)
      addMark(ranges, line.from + quote[0].length, line.to, 'cm-md-quote')
    }
    const bullet = /^([ \t]*)([-*+])([ \t]+)/.exec(text)
    if (bullet && !heading && !quote) {
      const from = line.from + (bullet[1]?.length ?? 0)
      const to = line.from + bullet[0].length
      if (!revealSyntax) {
        const widget = documentWidgetBullet()
        ranges.push({ from, to, value: Decoration.replace({ widget, inclusive: false }) })
      }
    }
    for (const image of images) {
      if (revealSyntax) addMark(ranges, image.from, image.to, 'cm-md-image-source')
      else {
        const target = resolveImage(image.token, options.notePath, options.files)
        const uri =
          target?.kind === 'remote'
            ? target.uri
            : target && options.vaultRoot
              ? vaultFileUri(options.vaultRoot, target.rel)
              : null
        const block =
          text.slice(0, image.from - line.from).trim() === '' && text.slice(image.to - line.from).trim() === ''
        ranges.push({
          from: image.from,
          to: image.to,
          value: Decoration.replace({ widget: new ImageWidget(image.token, uri, block), inclusive: false })
        })
      }
    }
    inlineDecorations(text, line.from, ranges, revealSyntax, images)
  }
  return Decoration.set(ranges, true)
}

class BulletWidget extends WidgetType {
  override eq(other: BulletWidget): boolean {
    return other instanceof BulletWidget
  }
  override toDOM(): HTMLElement {
    const bullet = document.createElement('span')
    bullet.className = 'cm-md-bullet'
    bullet.textContent = '• '
    bullet.setAttribute('aria-hidden', 'true')
    return bullet
  }
}
function documentWidgetBullet(): WidgetType {
  return new BulletWidget()
}

/** Continue a list item on Enter, reopening tasks as unchecked. */
export function listEnterUpdate(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to) return null
  const bullet = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line.text)
  const task = bullet ? null : /^(\s*)\[[ xX]?\](?=\s|$)(.*)$/.exec(line.text)
  if (!bullet && !task) return null
  const indent = (bullet ?? task)![1] ?? ''
  const rest = bullet ? (bullet[4] ?? '') : (task![2] ?? '')
  if (!rest.trim()) {
    return { changes: { from: line.from, to: line.to, insert: '' }, selection: { anchor: line.from } }
  }
  let continuation: string
  if (bullet) {
    const marker = bullet[2] ?? '-'
    const nextMarker = /^\d/.test(marker) ? `${Number.parseInt(marker, 10) + 1}.` : marker
    const hasTask = /^\[[ xX]\]\s*/.test(rest)
    continuation = `${indent}${nextMarker} ${hasTask ? '[ ] ' : ''}`
  } else {
    continuation = `${indent}[ ] `
  }
  return {
    changes: { from: sel.head, insert: `\n${continuation}` },
    selection: { anchor: sel.head + 1 + continuation.length }
  }
}

const listEnterKey: KeyBinding = {
  key: 'Enter',
  run: (view) => {
    const update = listEnterUpdate(view.state)
    if (!update) return false
    view.dispatch(update)
    return true
  }
}

export function liveMarkdownExtension(
  options: () => LiveMarkdownOptions,
  toggle: ToggleTask,
  toggleHeading: ToggleHeading = () => undefined
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(readonly view: EditorView) {
        this.decorations = buildLiveMarkdownDecorations(view.state, options(), this.activeLine(), toggle, toggleHeading)
      }
      activeLine(): number {
        return this.view.hasFocus ? this.view.state.doc.lineAt(this.view.state.selection.main.head).number : -1
      }
      update(update: { view: EditorView; docChanged: boolean; selectionSet: boolean; focusChanged: boolean }): void {
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          this.decorations = buildLiveMarkdownDecorations(
            update.view.state,
            options(),
            this.activeLine(),
            toggle,
            toggleHeading
          )
        }
      }
    },
    { decorations: (value) => value.decorations }
  )
  return [
    markdown(),
    history(),
    keymap.of([listEnterKey, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      role: 'textbox',
      'aria-label': 'Note content',
      'aria-multiline': 'true',
      spellcheck: 'true'
    }),
    plugin,
    EditorView.theme(
      {
        '&': {
          color: 'var(--md-text)',
          backgroundColor: 'var(--md-bg)',
          fontSize: 'var(--md-font-size)',
          height: '100%'
        },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'system-ui, sans-serif', lineHeight: 'var(--md-line-height)' },
        '.cm-content': { padding: '12px 20px 44px', caretColor: 'var(--md-accent)', minHeight: '100%' },
        '.cm-line': { padding: '1px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
        '.cm-cursor': { borderLeftColor: 'var(--md-accent)' },
        '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--md-selection)' },
        '&.cm-focused': { outline: 'none' },
        '.cm-md-bold': { fontWeight: '700' },
        '.cm-md-italic': { fontStyle: 'italic' },
        '.cm-md-strike, .cm-md-task-done': { textDecoration: 'line-through', color: 'var(--md-muted)' },
        '.cm-md-code, .cm-md-code-block-text': { fontFamily: 'monospace', color: 'var(--md-code)' },
        '.cm-md-code-block': { backgroundColor: 'var(--md-inset)' },
        '.cm-md-code-fence': { color: 'var(--md-faint)', fontFamily: 'monospace' },
        '.cm-md-h1': { fontSize: '1.55em', fontWeight: '700', lineHeight: '1.3' },
        '.cm-md-h2': { fontSize: '1.35em', fontWeight: '700', lineHeight: '1.3' },
        '.cm-md-h3': { fontSize: '1.2em', fontWeight: '700', lineHeight: '1.35' },
        '.cm-md-heading-fold': {
          display: 'inline-block',
          width: '22px',
          margin: '0 5px 0 0',
          padding: '0',
          border: '0',
          background: 'transparent',
          color: 'var(--md-muted)',
          fontSize: '16px',
          lineHeight: '1',
          verticalAlign: 'middle',
          cursor: 'pointer'
        },
        '.cm-md-quote': { color: 'var(--md-muted)', fontStyle: 'italic' },
        '.cm-md-link': { color: 'var(--md-accent)', textDecoration: 'underline' },
        '.cm-md-image-source': { color: 'var(--md-muted)' },
        '.cm-md-task': {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '7px',
          marginRight: '8px',
          verticalAlign: 'middle'
        },
        '.cm-md-task-bullet': { gap: '6px' },
        '.cm-md-task-box': {
          width: '20px',
          height: '20px',
          margin: '0',
          accentColor: 'var(--md-accent)',
          verticalAlign: 'middle'
        },
        '.cm-md-bullet': { display: 'inline-block', minWidth: '18px', color: 'var(--md-muted)' },
        '.cm-md-image': { display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', margin: '2px 0' },
        '.cm-md-image-block': { display: 'block', margin: '8px 0' },
        '.cm-md-image-content': { borderRadius: '6px' },
        '.cm-md-audio': { color: 'var(--md-muted)', fontSize: '0.9em' },
        '.cm-md-rule': {
          display: 'inline-block',
          width: '100%',
          borderTop: '1px solid var(--md-border)',
          height: '1px',
          verticalAlign: 'middle'
        },
        '.cm-md-hidden-completed': { display: 'none' },
        '.cm-md-folded-line': { display: 'none' },
        '.cm-md-duplicate-title': { opacity: '0', pointerEvents: 'none' }
      },
      { dark: true }
    )
  ]
}
