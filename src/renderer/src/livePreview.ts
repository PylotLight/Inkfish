import { RangeSetBuilder, StateField, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { indentLess, indentMore } from '@codemirror/commands'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet, KeyBinding } from '@codemirror/view'
import { findImages, imageCandidates, imageSourceOf, isBlockImage } from '../../shared/images'
import { copyImage, copyImagePath, copyMarkdown, imageMenuItems, revealImage } from './imageActions'
import {
  beginImageGestureSpec,
  concealedImageField,
  endImageGestureSpec,
  imageClickSpec,
  imageGestureField,
  imageRefNear,
  imageSourceRevealed,
  MIN_IMAGE_WIDTH,
  moveImageSpec,
  resizeImageSpec,
  selectedImageField,
  selectedImageRef,
  setImageGesture
} from './imageEdit'

/**
 * Obsidian-style live preview for one continuous CodeMirror document: the
 * whole file stays editable (selections span lines) while markdown chrome
 * (heading hashes, emphasis markers, quote markers, task brackets) is hidden
 * and content is styled in place. No block editors, no separate raw mode.
 *
 * Scope: headings, quotes, hr, tasks, bold/italic/strike, inline code, links,
 * images, fenced code styling. Tables stay as source (fully editable).
 *
 * Images: `![alt](src)`; `![alt|300](src)` (Obsidian size syntax, also
 * `|300x200`) at that width. Elsewhere the source is replaced by the picture.
 * While the caret/selection touches the ref its source is shown (dimmed) so it
 * stays editable — unless the caret only landed there as a side effect of a
 * paste / drop / move (concealedImageField), so the source never pops up
 * through a later resize until the caret is put on it on purpose. A ref alone on its line (a "block image") then renders as a
 * block widget BELOW the source line at the left edge, never inline beside the
 * text; a ref mixed with text keeps its picture inline after the source.
 * Pictures can be resized from a hover handle and dragged to move (see
 * ImageWidget). Decorations live in a StateField because block widgets can't
 * come from a ViewPlugin.
 */

export interface LivePreviewOptions {
  /** Flip the ` `/`x` inside task brackets at `pos`. */
  onToggleTask: (pos: number) => void
  /**
   * Loadable URLs for an image ref, most likely first (vault-root, then
   * note-relative). Defaults to resolving without a note path.
   */
  resolveImage?: (src: string) => string[]
}

/** Skip fancy decorations past this size — plain editing stays fast. */
const MAX_DECORATED_CHARS = 400_000

const FENCE_RE = /^(`{3,}|~{3,})/
const HEADING_RE = /^(#{1,4})\s+/
const HR_RE = /^\s{0,3}(---|\*\*\*|___)\s*$/
const QUOTE_PREFIX_RE = /^(?:\s{0,3}>\s?)+/
// `+` too (Obsidian renders it as a bullet), and any depth of indent — a deeply nested
// task must keep its checkbox, matching how plain bullets render at any indent.
const TASK_RE = /^(\s*[-*+])\s+\[([ xX])\](?=\s|$)/
const BULLET_RE = /^(\s*)([-*+])(\s+)/
const ORDERED_RE = /^(\s*)(\d+[.)])(\s+)/
const CODE_SPAN_RE = /`([^`\n]+?)`/g
const BOLD_RE = /\*\*(.+?)\*\*/g
const TRIPLE_RE = /\*\*\*(.+?)\*\*\*/g
const ITALIC_RE = /(^|[^*\w])\*([^*\n]+?)\*/g
// Underscore emphasis only at word boundaries (CommonMark): `_x_`, `__x__` — never snake_case.
const UNDER_BOLD_RE = /(^|[^\w_])__(?=[^\s_])([^_\n]*?[^\s_])__(?![\w_])/g
const UNDER_ITALIC_RE = /(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g
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
    s.textContent = '•'
    return s
  }
}

/** Task row: rendered bullet + interactive checkbox for `- [ ]` (also `*` / `+`, any depth). */
export class TaskBulletWidget extends WidgetType {
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
    return s
  }
}

/** Pixel offset a press must travel before it becomes a move-drag (not a click). */
const DRAG_SLOP = 5

/** Resize/move gestures in flight (any editor): image widgets swallow all events meanwhile. */
let activeGestures = 0

/** Stop the browser's native text selection for a press we own (pointerdown preventDefault doesn't). */
const noSelect = (e: Event): void => e.preventDefault()

interface GestureEnd {
  (spec?: TransactionSpec | null): void
  /** End as a plain click: select the picture `ref`, caret left where it was. */
  click(ref: { from: number; to: number }): void
}

/** Freeze the ref's rendering + selection for a gesture; returns the matching end. */
function beginGesture(view: EditorView, r: { from: number; to: number } | null): GestureEnd {
  activeGestures++
  document.addEventListener('selectstart', noSelect, true)
  if (r) view.dispatch(beginImageGestureSpec(view.state, r))
  let ended = false
  const finish = (): boolean => {
    if (ended) return false
    ended = true
    activeGestures = Math.max(0, activeGestures - 1)
    document.removeEventListener('selectstart', noSelect, true)
    return true
  }
  const end = ((spec?: TransactionSpec | null) => {
    if (!finish()) return
    if (r) view.dispatch(endImageGestureSpec(view.state, spec ?? null))
    else if (spec) view.dispatch(spec)
  }) as GestureEnd
  end.click = (ref) => {
    if (finish()) view.dispatch(imageClickSpec(view.state, ref))
  }
  return end
}

/**
 * Rendered `![alt](src)` / `![alt|300](src)`: tries each candidate URL, then a
 * "missing" chip. In an editable view it also carries:
 * - a corner + side handle (on hover) that resizes proportionally, showing the
 *   live px width, and writes `|N` into the ref on release (one undo step);
 *   double-click a handle, or right-click › Reset size, removes it;
 * - press-and-drag on the picture to move the ref elsewhere, with a drop caret.
 * A plain click selects the picture (ring) so ⌘C copies the image itself, without
 * moving the caret onto the ref (the source stays hidden); shift/alt/meta-clicks
 * go to CodeMirror untouched, so selection works as before.
 * Right-click (any view) opens Copy image / Copy image path / Copy markdown /
 * Reveal in Finder / Reset size.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly urls: string[],
    readonly alt: string,
    readonly src: string,
    readonly width?: number,
    readonly height?: number,
    /** Click-selected (ring; ⌘C copies the picture). */
    readonly selected = false,
    /** Block widget under a revealed block-image source line (not inline). */
    readonly block = false
  ) {
    super()
  }
  override eq(other: ImageWidget): boolean {
    return (
      other instanceof ImageWidget &&
      other.alt === this.alt &&
      other.src === this.src &&
      other.width === this.width &&
      other.height === this.height &&
      other.selected === this.selected &&
      other.block === this.block &&
      other.urls.join('\n') === this.urls.join('\n')
    )
  }
  override get estimatedHeight(): number {
    if (this.width && this.height) return this.height + 8
    return 160
  }
  override ignoreEvent(e: Event): boolean {
    // Mid resize/move: nothing on the image may move the caret (that would
    // reveal the ref's source under the pointer).
    if (activeGestures > 0) return true
    const t = e.target instanceof Element ? e.target : null
    // Handles are entirely ours.
    if (t?.closest('.lp-img-handle')) return true
    // Right-click opens our menu; don't let it move the caret (which would
    // reveal the source and re-render this widget under the open menu).
    if ((e.type === 'mousedown' || e.type === 'pointerdown') && (e as MouseEvent).button === 2) return true
    // A plain left press on the picture starts our click-or-drag gesture;
    // modified/other-button presses fall through to CodeMirror (shift-click
    // extends the selection over the image as before).
    if ((e.type === 'mousedown' || e.type === 'pointerdown') && t?.tagName === 'IMG') {
      const m = e as MouseEvent
      return m.button === 0 && !m.shiftKey && !m.altKey && !m.metaKey && !m.ctrlKey
    }
    return false
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrap: HTMLElement = document.createElement(this.block ? 'div' : 'span')
    wrap.className = 'lp-img'
    if (this.block) wrap.classList.add('lp-img-block')
    if (this.selected) wrap.classList.add('lp-img-selected')
    const ref = (): { from: number; to: number } | null => {
      let pos: number
      try {
        pos = view.posAtDOM(wrap)
      } catch {
        return null
      }
      const near = imageRefNear(view.state, pos, this.src)
      if (near || !this.block) return near
      // Block widget sits at the line end (after any trailing spaces).
      return blockImageRefAt(view.state, pos, this.src)
    }
    let imgEl: HTMLImageElement | null = null
    wrap.addEventListener('contextmenu', (e) => this.openMenu(view, e, imgEl, ref))
    // Right press: no native caret/selection move under the menu (CodeMirror ignores it via ignoreEvent).
    wrap.addEventListener('mousedown', (e) => {
      if (e.button === 2) e.preventDefault()
    })
    const missing = (): void => {
      imgEl = null
      wrap.classList.add('lp-img-missing')
      wrap.textContent = `🖼 ${this.alt || this.src} (not found)`
      wrap.title = this.src
      view.requestMeasure()
    }
    if (this.urls.length === 0) {
      missing()
      return wrap
    }
    const img = document.createElement('img')
    imgEl = img
    img.alt = this.alt
    img.title = this.alt || this.src
    img.draggable = false
    img.decoding = 'async'
    if (this.width) {
      // Explicit width wins over the default max-height cap; aspect preserved.
      wrap.classList.add('lp-img-sized')
      img.style.width = `${this.width}px`
      if (this.height) img.style.aspectRatio = `${this.width} / ${this.height}`
    }
    let i = 0
    img.addEventListener('load', () => view.requestMeasure())
    img.addEventListener('error', () => {
      i++
      if (i < this.urls.length) img.src = this.urls[i] as string
      else missing()
    })
    img.src = this.urls[0] as string
    wrap.appendChild(img)
    if (view.state.readOnly || !view.state.facet(EditorView.editable)) return wrap

    wrap.classList.add('lp-img-edit')
    const badge = document.createElement('span')
    badge.className = 'lp-img-size'
    badge.setAttribute('aria-hidden', 'true')
    const corner = document.createElement('span')
    corner.className = 'lp-img-handle lp-img-handle-corner'
    corner.title = 'Drag to resize · double-click to reset'
    const side = document.createElement('span')
    side.className = 'lp-img-handle lp-img-handle-side'
    side.title = corner.title
    wrap.append(side, corner, badge)

    const reset = (): void => {
      const r = ref()
      const spec = r && resizeImageSpec(view.state, r.from, null)
      if (spec) view.dispatch(spec)
    }
    for (const h of [corner, side]) {
      h.addEventListener('pointerdown', (e) => this.startResize(view, wrap, img, badge, h, e, ref))
      // Compat mousedown (if the platform still sends it) must not place the caret either.
      h.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      h.addEventListener('dblclick', (e) => {
        e.preventDefault()
        e.stopPropagation()
        reset()
      })
    }
    img.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
      this.startPress(view, wrap, img, e, ref)
    })
    return wrap
  }

  /** Right-click menu: copy image / path / markdown, reveal, reset size. */
  private openMenu(
    view: EditorView,
    e: MouseEvent,
    img: HTMLImageElement | null,
    ref: () => { from: number; to: number } | null
  ): void {
    e.preventDefault()
    e.stopPropagation()
    if (activeGestures > 0) return
    const r = ref()
    const markdown = r ? view.state.sliceDoc(r.from, r.to) : null
    const url = img && img.complete && img.naturalWidth > 0 ? img.currentSrc || img.src : null
    const editable = !view.state.readOnly && view.state.facet(EditorView.editable)
    const items = imageMenuItems({
      url,
      markdown,
      resettable: editable && !!this.width && !!r,
      copyImage: () => void copyImage(url),
      copyPath: () => void copyImagePath(url),
      copyMarkdown: () => {
        if (markdown) void copyMarkdown(markdown)
      },
      reveal: () => void revealImage(url),
      reset: () => {
        const at = r && imageRefNear(view.state, r.from, this.src)
        const spec = at && resizeImageSpec(view.state, at.from, null)
        if (spec) view.dispatch(spec)
      }
    })
    if (items.length > 0) imageMenu(e.clientX, e.clientY, items)
  }

  /** Corner/side handle drag: live width preview, one transaction on release. */
  private startResize(
    view: EditorView,
    wrap: HTMLElement,
    img: HTMLImageElement,
    badge: HTMLElement,
    handle: HTMLElement,
    e: PointerEvent,
    ref: () => { from: number; to: number } | null
  ): void {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = img.getBoundingClientRect().width
    const max = Math.max(MIN_IMAGE_WIDTH, paneWidth(wrap))
    const prev = { width: img.style.width, maxHeight: img.style.maxHeight }
    let w = Math.round(startW)
    let moved = false
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      // synthetic events in tests
    }
    wrap.classList.add('lp-img-resizing')
    document.body.classList.add('lp-img-resizing-any')
    const end = beginGesture(view, ref())
    const show = (): void => {
      badge.textContent = `${w}px`
    }
    show()
    const id = e.pointerId
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 1) return
      moved = true
      w = Math.round(Math.min(max, Math.max(MIN_IMAGE_WIDTH, startW + dx)))
      img.style.width = `${w}px`
      img.style.maxHeight = 'none'
      show()
    }
    const done = (commit: boolean): void => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key, true)
      wrap.classList.remove('lp-img-resizing')
      document.body.classList.remove('lp-img-resizing-any')
      const r = commit && moved ? ref() : null
      const spec = r && resizeImageSpec(view.state, r.from, w)
      if (!spec) {
        img.style.width = prev.width
        img.style.maxHeight = prev.maxHeight
      }
      end(spec)
    }
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === id) done(true)
    }
    const cancel = (): void => done(false)
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      done(false)
    }
    // On window (not the handle) so a lost pointer capture can't strand the drag.
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
  }

  /** Press on the picture: a click places the caret; a drag moves the ref. */
  private startPress(
    view: EditorView,
    wrap: HTMLElement,
    img: HTMLImageElement,
    e: PointerEvent,
    ref: () => { from: number; to: number } | null
  ): void {
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    let dragging = false
    let target: DropTarget | null = null
    let caret: HTMLElement | null = null
    const end = beginGesture(view, ref())
    try {
      img.setPointerCapture(e.pointerId)
    } catch {
      // synthetic events in tests
    }
    const id = e.pointerId
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_SLOP) return
        dragging = true
        wrap.classList.add('lp-img-dragging')
        document.body.classList.add('lp-img-moving')
        caret = document.createElement('div')
        caret.className = 'lp-img-drop'
        document.body.appendChild(caret)
      }
      autoScroll(view, ev.clientY)
      const r = ref()
      target = r ? dropTarget(view, ev.clientX, ev.clientY, r) : null
      if (caret) placeCaret(caret, target)
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key, true)
      wrap.classList.remove('lp-img-dragging')
      document.body.classList.remove('lp-img-moving')
      caret?.remove()
      const r = ref()
      if (!r) return end()
      if (!dragging) {
        // Plain click: select the picture (ring, ⌘C) without revealing its source.
        if (!commit) return end()
        end.click(r)
        view.focus()
        return
      }
      if (!commit || !target) return end()
      end(moveImageSpec(view.state, r.from, r.to, target.pos, target.place))
      view.focus()
    }
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === id) finish(true)
    }
    const cancel = (): void => finish(false)
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
  }
}

/** The image ref with `src` on the line at `pos` (block widgets sit at the line end). */
function blockImageRefAt(state: EditorState, pos: number, src: string): { from: number; to: number } | null {
  const l = state.doc.lineAt(Math.max(0, Math.min(pos, state.doc.length)))
  const im = findImages(l.text).find((m) => m.src === src)
  return im ? { from: l.from + im.index, to: l.from + im.index + im.length } : null
}

interface DropTarget {
  pos: number
  place: 'before' | 'after'
  /** Block refs drop between lines (horizontal bar); inline refs at a char (caret). */
  block: boolean
  rect: { left: number; top: number; width: number; height: number }
}

/** Usable width of the line the widget sits in (indent/padding excluded). */
function paneWidth(wrap: HTMLElement): number {
  const line = (wrap.closest('.cm-line') as HTMLElement | null) ?? wrap.parentElement
  if (!line) return 10_000
  const cs = getComputedStyle(line)
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const ti = Math.max(0, parseFloat(cs.textIndent) || 0)
  return Math.floor(line.clientWidth - pad - ti)
}

function dropTarget(view: EditorView, x: number, y: number, ref: { from: number; to: number }): DropTarget | null {
  const pos = view.posAtCoords({ x, y }, false)
  const state = view.state
  const content = view.contentDOM.getBoundingClientRect()
  const text = state.doc.toString()
  if (isBlockImage(text, ref.from, ref.to)) {
    const line = state.doc.lineAt(pos)
    const block = view.lineBlockAt(line.from)
    const top = view.documentTop + block.top
    const bottom = view.documentTop + block.bottom
    const place = y < (top + bottom) / 2 ? 'before' : 'after'
    return {
      pos: line.from,
      place,
      block: true,
      rect: { left: content.left, top: (place === 'before' ? top : bottom) - 1, width: content.width, height: 2 }
    }
  }
  const c = view.coordsAtPos(pos)
  if (!c) return null
  return {
    pos,
    place: 'after',
    block: false,
    rect: { left: c.left - 1, top: c.top, width: 2, height: c.bottom - c.top }
  }
}

function placeCaret(el: HTMLElement, t: DropTarget | null): void {
  if (!t) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'block'
  el.classList.toggle('lp-img-drop-block', t.block)
  el.style.left = `${t.rect.left}px`
  el.style.top = `${t.rect.top}px`
  el.style.width = `${t.rect.width}px`
  el.style.height = `${t.rect.height}px`
}

/** Scroll the editor while a move-drag hovers near its top/bottom edge. */
function autoScroll(view: EditorView, y: number): void {
  const r = view.scrollDOM.getBoundingClientRect()
  const edge = 32
  if (y < r.top + edge) view.scrollDOM.scrollTop -= Math.ceil((r.top + edge - y) / 2)
  else if (y > r.bottom - edge) view.scrollDOM.scrollTop += Math.ceil((y - (r.bottom - edge)) / 2)
}

/** Tiny context menu in the app's ctxmenu style (Dialogs.tsx ContextMenu look). */
function imageMenu(x: number, y: number, items: Array<{ label: string; action: () => void }>): void {
  const scrim = document.createElement('div')
  scrim.className = 'ctx-scrim'
  const menu = document.createElement('div')
  menu.className = 'ctxmenu glass strong'
  menu.setAttribute('role', 'menu')
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - items.length * 36 - 24)}px`
  const close = (): void => {
    scrim.remove()
    menu.remove()
    window.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }
  for (const it of items) {
    const b = document.createElement('button')
    b.className = 'ctxitem'
    b.setAttribute('role', 'menuitem')
    b.textContent = it.label
    b.addEventListener('click', () => {
      close()
      it.action()
    })
    menu.appendChild(b)
  }
  scrim.addEventListener('click', close)
  scrim.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    close()
  })
  window.addEventListener('keydown', onKey, true)
  document.body.append(scrim, menu)
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

/** Exported for tests — pure over the editor state, no DOM needed. */
export function buildDecorations(state: EditorState, opts: LivePreviewOptions): DecorationSet {
  const doc = state.doc
  if (doc.length > MAX_DECORATED_CHARS) return Decoration.none
  const resolve = opts.resolveImage ?? ((src: string) => imageCandidates(src))
  const picked = selectedImageRef(state)
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
  /**
   * Obsidian-style list line: the raw indent is hidden and replaced by a
   * padding proportional to its width, and the marker hangs in a negative
   * text-indent so wrapped lines align under the text, not the bullet.
   */
  const listLine = (at: number, indent: string, cls: string): void => {
    let cols = 0
    for (const ch of indent) cols += ch === '\t' ? 4 : 1
    hide(at, at + indent.length)
    ops.push({
      from: at,
      to: at,
      deco: Decoration.line({ class: `lp-li ${cls}`, attributes: { style: `--lp-depth: ${cols}` } })
    })
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
      if (!quoted) listLine(restBase, /^\s*/.exec(rest)?.[0] ?? '', 'lp-li-task')
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
        if (!quoted) listLine(restBase, bm[1] ?? '', 'lp-li-bullet')
        ops.push({
          from: wFrom,
          to: wFrom + markerLen,
          deco: Decoration.replace({ widget: new BulletWidget() })
        })
        claimed.push([wFrom, wFrom + markerLen])
      } else {
        const om = ORDERED_RE.exec(rest)
        if (om) {
          if (!quoted) listLine(restBase, om[1] ?? '', 'lp-li-ordered')
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
    // Images before links — LINK_RE would otherwise match the `[alt](src)`
    // tail of `![alt](src)`, hide it, and leave a bare `!` on the line.
    for (const im of findImages(rest)) {
      const sFrom = restBase + im.index
      const sTo = sFrom + im.length
      if (overlaps(claimed, sFrom, sTo)) continue
      claimed.push([sFrom, sTo])
      const selected = !!picked && picked.from === sFrom && picked.to === sTo
      if (imageSourceRevealed(state, sFrom, sTo)) {
        mark(sFrom, sTo, 'lp-imgsrc')
        // Alone on its (whole) line: picture as a block under the source line,
        // at the left edge — never inline to the right of the source text.
        const block = isBlockImage(text, sFrom - base, sTo - base)
        const widget = new ImageWidget(resolve(im.src), im.alt, im.src, im.width, im.height, selected, block)
        ops.push(
          block
            ? { from: l.to, to: l.to, deco: Decoration.widget({ widget, side: 1, block: true }) }
            : { from: sTo, to: sTo, deco: Decoration.widget({ widget, side: 1 }) }
        )
      } else {
        const widget = new ImageWidget(resolve(im.src), im.alt, im.src, im.width, im.height, selected)
        ops.push({ from: sFrom, to: sTo, deco: Decoration.replace({ widget }) })
      }
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
    // `__bold__` / `_italic_` (underscore forms; same hide-markers + style as the `*` forms).
    for (const [re, n, cls] of [
      [UNDER_BOLD_RE, 2, 'lp-bold'],
      [UNDER_ITALIC_RE, 1, 'lp-em']
    ] as const) {
      for (const m of rest.matchAll(re)) {
        const prefix = m[1] ?? ''
        const inner = m[2] ?? ''
        const from = restBase + (m.index ?? 0) + prefix.length
        const to = from + n + inner.length + n
        if (overlaps(claimed, from, to)) continue
        claimed.push([from, to])
        hide(from, from + n)
        hide(to - n, to)
        mark(from + n, to - n, cls)
      }
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
  // A StateField (not a ViewPlugin): revealed block images use block widgets,
  // which CodeMirror only accepts from state-level decorations.
  const field = StateField.define<{ decorations: DecorationSet; hasImages: boolean }>({
    create: (state) => ({ decorations: buildDecorations(state, opts), hasImages: state.doc.toString().includes('![') }),
    update(value, tr) {
      const hasImages = tr.docChanged ? tr.state.doc.toString().includes('![') : value.hasImages
      // Selection matters only for revealing image source — skip the
      // rebuild on caret moves in notes without images.
      const gesture =
        tr.effects.some((e) => e.is(setImageGesture)) ||
        tr.startState.field(selectedImageField, false) !== tr.state.field(selectedImageField, false) ||
        tr.startState.field(concealedImageField, false) !== tr.state.field(concealedImageField, false)
      if (tr.docChanged || gesture || (tr.selection && hasImages)) {
        return { decorations: buildDecorations(tr.state, opts), hasImages }
      }
      return value
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations)
  })
  return [imageGestureField, selectedImageField, concealedImageField, field, copySelectedImage]
}

/**
 * ⌘C / Edit › Copy with a click-selected picture (and no text selected) copies
 * the image itself. The copy DOM event fires for both the shortcut and the
 * menu role, so this is the one place it's handled.
 */
const copySelectedImage = EditorView.domEventHandlers({
  copy(e, view) {
    if (!selectedImageRef(view.state)) return false
    const img = view.contentDOM.querySelector<HTMLImageElement>('.lp-img-selected img')
    const url = img && img.naturalWidth > 0 ? img.currentSrc || img.src : null
    if (!url || !imageSourceOf(url)) return false
    e.preventDefault()
    void copyImage(url)
    return true
  }
})

/**
 * Obsidian-style list continuation for Enter: a new item at the same depth,
 * same marker (numbered items increment), tasks re-open as `[ ]`, and Enter on
 * an empty item clears it (exiting the list). Pure over the state so it is
 * unit-testable; the keymap only dispatches its result.
 */
export function listEnterUpdate(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to) return null
  const m = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line.text)
  if (!m) return null
  const indent = m[1] ?? ''
  const bullet = m[2] ?? '-'
  const rest = m[4] ?? ''
  if (!rest.trim()) {
    // Empty item: clear the whole line (marker + indent) and stay on it.
    return { changes: { from: line.from, to: line.to, insert: '' }, selection: { anchor: line.from } }
  }
  const nextBullet = /^\d/.test(bullet) ? `${parseInt(bullet, 10) + 1}.` : bullet
  const task = /^\[[ xX]\]\s*/.exec(rest)
  const cont = `${indent}${nextBullet} ${task ? '[ ] ' : ''}`
  return {
    changes: { from: sel.head, insert: `\n${cont}` },
    selection: { anchor: sel.head + 1 + cont.length }
  }
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
      const update = listEnterUpdate(view.state)
      if (!update) return false
      view.dispatch(update)
      return true
    }
  },
  { key: 'Tab', run: indentMore },
  { key: 'Shift-Tab', run: indentLess }
]
