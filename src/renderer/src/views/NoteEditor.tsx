import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { NoteDoc } from '../../../shared/types'
import { minimalEdit } from '../../../shared/mini-window'
import PopOutIcon from './PopOutIcon'
import { fmtBytes, fmtChars, timeAgo } from '../text'
import {
  findMatches,
  isInvalidQuery,
  matchAtOrAfter,
  replacementFor,
  seedFromSelection,
  wrapIndex,
  type FindMatch,
  type FindOpts
} from '../find'
import { listKeys, livePreview } from '../livePreview'
import { codeHighlight } from '../codeHighlight'
import { imageCandidates, imageMarkdown } from '../../../shared/images'
import NoteAi from './NoteAi'
import TagChips from './TagChips'
import { breadcrumb } from '../../../shared/note-move'
import { sendAiCommand } from '../nativeAi'

/** Marks edits that came from another window (mini window sync) — never re-broadcast. */
const remoteSync = Annotation.define<boolean>()

/** In-note find highlight for the editor pane. */
const setFind = StateEffect.define<{ matches: FindMatch[]; current: number }>()
const findHitMark = Decoration.mark({ class: 'cm-find-hit' })
const findCurrentMark = Decoration.mark({ class: 'cm-find-hit current' })
function buildFindDeco(matches: FindMatch[], current: number, docLen: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  matches.forEach((m, i) => {
    if (m.to <= docLen) builder.add(m.from, m.to, i === current ? findCurrentMark : findHitMark)
  })
  return builder.finish()
}
/** Matches come from React (one source of truth with the counter); edits just map them along. */
const findDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (old, tr) => {
    for (const e of tr.effects) {
      if (e.is(setFind)) return buildFindDeco(e.value.matches, e.value.current, tr.newDoc.length)
    }
    return tr.docChanged ? old.map(tr.changes) : old
  },
  provide: (f) => EditorView.decorations.from(f)
})

interface Props {
  doc: NoteDoc | null
  /** Obsidian-style display title (filename or override). */
  title: string
  /**
   * Not-yet-written markdown for THIS doc (keyed by `doc.id`, never by the selected tab — see
   * `draftForEditor`). Lifted so tab switches and mini windows share it.
   */
  draft?: string
  /** A LOCAL edit (typing, paste, task toggle). Autosave hangs off this; remote/programmatic
   * content swaps never call it, so a synced or reloaded text is never re-saved from here. */
  onDraft: (id: string, markdown: string) => void
  /** ⌘S — autosave makes it a no-op flush; kept so muscle memory never does anything odd. */
  onFlush?: () => void
  /** Header title edited inline (Enter / blur). Empty string = cleared. */
  onRename: (title: string) => void
  /** Tooltip for the inline title (what a rename does: file rename vs display title). */
  renameHint?: string
  /** The editor lost focus (title → filename sync commits right away). */
  onEditorBlur?: () => void
  onMore: (x: number, y: number) => void
  /** Mini window: no title/path header, just the note. */
  compact?: boolean
  /** Shows the header's pop-out-to-mini-window button. */
  onPopOut?: () => void
  /** Its tooltip (with the user's shortcuts). */
  popOutTitle?: string
  /** Header breadcrumb click → "Move to…" folder picker anchored at (x, y). Vault notes only. */
  onMoveClick?: (x: number, y: number) => void
  /** Header tag chips → front matter `tags:`. Vault notes only. */
  onSetTags?: (tags: string[]) => void
  onTagClick?: (tag: string) => void
  /** Every tag in the vault (chip input autocomplete). */
  allTags?: readonly string[]
  /** Day notes: ‹ › beside the title to step to the previous / next day note (null = none). */
  dayNav?: { onPrev: (() => void) | null; onNext: (() => void) | null; prevLabel?: string; nextLabel?: string }
  /** When `id` is (or becomes) the open doc, put the caret at the end and focus — once per token
   *  (Today opens straight into typing). */
  focusEnd?: { id: string; token: number } | null
}

/**
 * Center editor: one continuous Obsidian-style live preview (CodeMirror 6).
 * The whole file renders and edits in place — selections span lines, no
 * block editors, no separate raw mode.
 *
 * Perf: the text lives in LOCAL state — typing never re-renders the parent
 * (sidebar, lists, queue). Edits are ALSO lifted via `onDraft`, where the
 * parent autosaves them (Obsidian-style: no Save button, nothing "unsaved").
 */
function NoteEditor({
  doc,
  title,
  draft,
  onDraft,
  onFlush,
  onRename,
  renameHint,
  onEditorBlur,
  onMore,
  compact,
  onPopOut,
  popOutTitle,
  onMoveClick,
  onSetTags,
  onTagClick,
  allTags,
  dayNav,
  focusEnd
}: Props): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [text, setText] = useState('')
  const [cmFailed, setCmFailed] = useState(false)
  const textRef = useRef(text)
  textRef.current = text
  /** True once the user has typed — guards the doc.markdown fallback below. */
  const editedRef = useRef(false)
  const saveRef = useRef({ doc, onFlush })
  saveRef.current = { doc, onFlush }
  const draftRef = useRef(onDraft)
  draftRef.current = onDraft
  /** Vault-relative path of the open note — image refs resolve against it. */
  const notePathRef = useRef<string | null>(doc?.path ?? null)
  notePathRef.current = doc?.path ?? null

  /** `local` = the user changed it here; false = we swapped content in (doc switch, live sync). */
  const handleText = useCallback((next: string, local = true): void => {
    setText(next)
    if (!local) return
    editedRef.current = true
    const d = saveRef.current.doc
    if (d) draftRef.current(d.id, next)
  }, [])

  const handleTextRef = useRef(handleText)
  handleTextRef.current = handleText

  /** Flip the task checkbox at `pos` (the ` `/`x` inside brackets). */
  const toggleTaskRef = useRef((pos: number): void => {
    const v = viewRef.current
    if (!v) return
    const ch = v.state.doc.sliceString(pos, pos + 1)
    if (ch !== ' ' && ch !== 'x' && ch !== 'X') return
    v.dispatch({ changes: { from: pos, to: pos + 1, insert: ch === ' ' ? 'x' : ' ' } })
    v.focus()
  })

  // --- in-note find ---------------------------------------------------------
  // ⌘F opens it from anywhere in the window while a note is showing (not just with the caret in
  // the editor), seeded from the selection and landing on the first hit after the caret. ↵ / ⇧↵ and
  // ⌘G / ⇧⌘G step, and the current hit is selected in the editor, so Esc leaves you right there.
  const rootRef = useRef<HTMLDivElement>(null)
  /** Caret when find opened — typing a query lands on the first hit after it. */
  const caretAnchorRef = useRef(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [findOpts, setFindOpts] = useState<FindOpts>({})
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const findInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  /** Bumped on every explicit navigation so the "move to hit" effect fires even on a same index. */
  const [findNav, setFindNav] = useState(0)
  const findOptsRef = useRef(findOpts)
  findOptsRef.current = findOpts
  const findQueryRef = useRef(findQuery)
  findQueryRef.current = findQuery

  const editorText = (): string => viewRef.current?.state.doc.toString() ?? textRef.current
  const caretPos = (): number => {
    const v = viewRef.current
    if (v) return v.state.selection.main.from
    const ta = document.querySelector<HTMLTextAreaElement>('.ed-fallback')
    return ta?.selectionStart ?? 0
  }

  const openFind = useCallback((withReplace = false) => {
    const v = viewRef.current
    // Seed only from a real selection in the note (not the hit we selected while the bar has focus).
    const sel = v && v.hasFocus ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : ''
    const seed = seedFromSelection(sel)
    const query = seed ?? findQueryRef.current
    caretAnchorRef.current = caretPos()
    setFindOpen(true)
    if (withReplace) setReplaceOpen(true)
    setFindQuery(query)
    setFindIndex(matchAtOrAfter(findMatches(editorText(), query, findOptsRef.current), caretAnchorRef.current))
    setFindNav((n) => n + 1)
    requestAnimationFrame(() => {
      const el = withReplace && seed ? replaceInputRef.current : findInputRef.current
      el?.focus()
      el?.select()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Close and hand focus back to the editor with the current hit selected. */
  const closeFind = useCallback(() => {
    setFindOpen(false)
    setReplaceOpen(false)
    const v = viewRef.current
    if (v) {
      v.dispatch({ effects: setFind.of({ matches: [], current: 0 }) })
      v.focus()
    }
  }, [])

  // Reset find when switching documents.
  const docId = doc?.id ?? null
  useEffect(() => {
    setFindOpen(false)
    setReplaceOpen(false)
    setFindQuery('')
    setFindIndex(0)
  }, [docId])

  // Editor mounts when the mount div exists. On app launch the tabs restore
  // before the note loads, so the first render is the `!doc` empty state and
  // there is no mount div yet — `hasDoc` re-runs this once the note arrives
  // (previously the editor never mounted until NoteEditor itself remounted).
  // Textarea fallback when CodeMirror fails.
  const hasDoc = doc != null
  useEffect(() => {
    if (cmFailed || !hasDoc || !mountRef.current || viewRef.current) return
    let view: EditorView | null = null
    try {
      view = new EditorView({
        state: EditorState.create({
          doc: textRef.current,
          extensions: [
            lineNumbers(),
            EditorView.lineWrapping,
            history(),
            keymap.of([
              ...listKeys,
              ...defaultKeymap,
              ...historyKeymap,
              {
                key: 'Mod-s',
                run: () => {
                  saveRef.current.onFlush?.()
                  return true
                }
              }
            ]),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return
              const next = u.state.doc.toString()
              const remote = u.transactions.some((t) => t.annotation(remoteSync))
              handleTextRef.current(next, !remote)
              // Live sync with mini windows: local edits only (remote ones came from there).
              const d = saveRef.current.doc
              if (d && !remote) window.api.mini?.draft(d.id, next)
            }),
            findDecoField,
            codeHighlight(),
            livePreview({
              onToggleTask: (pos) => toggleTaskRef.current(pos),
              resolveImage: (src) => imageCandidates(src, notePathRef.current)
            }),
            // Images: paste / drop → assets/, ref inserted on its own line.
            // Handled here (not a DOM listener) so CodeMirror doesn't also
            // paste the clipboard's text/html fallback for the same image.
            EditorView.domEventHandlers({
              paste: (e, v) => {
                const files = imageFiles(e.clipboardData)
                if (files.length === 0) return false
                e.preventDefault()
                void insertImages(v, files, v.state.selection.main.head)
                return true
              },
              dragover: (e) => {
                // Files aren't readable until drop — only allow the drop here.
                if (!hasFileDrag(e.dataTransfer)) return false
                e.preventDefault()
                return true
              },
              drop: (e, v) => {
                const files = imageFiles(e.dataTransfer)
                if (files.length === 0) return false
                e.preventDefault()
                const at = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head
                void insertImages(v, files, at)
                return true
              }
            }),
            EditorView.theme({
              '&': { backgroundColor: 'transparent', height: '100%' },
              '.cm-content': {
                fontFamily: 'var(--text-font)',
                fontSize: 'var(--ed-fs, 14px)',
                caretColor: 'var(--text)'
              },
              '.cm-cursor': { borderLeftColor: 'var(--text)' },
              '.cm-gutters': { backgroundColor: 'transparent', border: 'none' }
            })
          ]
        }),
        parent: mountRef.current
      })
    } catch (err) {
      console.error('[editor] CodeMirror mount failed, using textarea fallback:', err)
      setCmFailed(true)
      return
    }
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmFailed, hasDoc])

  // Swap document content when selection changes — lifted draft wins over
  // saved markdown so tab switches keep unsaved edits.
  useEffect(() => {
    if (!doc) return
    const next = draft ?? doc.markdown
    if (textRef.current !== next) {
      const v = viewRef.current
      if (v) {
        // Smallest edit, so a live update from a mini window keeps the caret and scroll.
        const edit = minimalEdit(v.state.doc.toString(), next)
        if (edit) v.dispatch({ changes: edit, annotations: remoteSync.of(true) })
        if (v.state.doc.toString() !== next) {
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next }, annotations: remoteSync.of(true) })
        }
        const have = v.state.doc.length
        if (have !== next.length) {
          console.error(`[editor] content mismatch for ${doc.id}: want ${next.length} chars, have ${have}`)
        }
      }
      setText(next)
      editedRef.current = draft !== undefined && draft !== doc.markdown
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, draft])

  // Caret ready at the end (Today opens straight into typing). Runs after the content swap above.
  const focusedTokenRef = useRef(0)
  useEffect(() => {
    if (!focusEnd || focusEnd.token === focusedTokenRef.current || !doc || doc.id !== focusEnd.id) return
    const v = viewRef.current
    if (!v || v.state.doc.toString() !== (draft ?? doc.markdown)) return
    focusedTokenRef.current = focusEnd.token
    const end = v.state.doc.length
    v.dispatch({ selection: { anchor: end }, scrollIntoView: true })
    v.focus()
  }, [focusEnd, doc, draft])

  // In-note find matches over the current source.
  // Hooks live above the `!doc` early return to keep hook order stable.
  const preSrc = text || (doc && !editedRef.current ? doc.markdown : '')
  const findHits = useMemo(
    () => (findOpen ? findMatches(preSrc, findQuery, findOpts) : []),
    [findOpen, preSrc, findQuery, findOpts]
  )
  const findTotal = findHits.length
  const findCurrent = wrapIndex(findIndex, findTotal)
  const findBad = isInvalidQuery(findQuery, findOpts)
  const findHitsRef = useRef(findHits)
  findHitsRef.current = findHits

  // Highlights follow the matches (typing in the note re-finds live).
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setFind.of({ matches: findHits, current: findCurrent }) })
  }, [findHits, findCurrent])

  // Move to the current hit — only on query / option / step changes, never while typing in the note.
  useEffect(() => {
    if (!findOpen) return
    const hits = findHitsRef.current
    const m = hits[wrapIndex(findIndex, hits.length)]
    if (!m) return
    const v = viewRef.current
    if (v) {
      v.dispatch({
        selection: { anchor: m.from, head: m.to },
        effects: EditorView.scrollIntoView(m.from, { y: 'center' })
      })
      return
    }
    const ta = document.querySelector<HTMLTextAreaElement>('.ed-fallback')
    ta?.setSelectionRange(m.from, m.to)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, findOpts, findIndex, findNav])

  const stepFind = useCallback((dir: 1 | -1) => {
    setFindIndex((i) => wrapIndex(i + dir, findHitsRef.current.length))
    setFindNav((n) => n + 1)
  }, [])

  const replaceOne = useCallback(() => {
    const hits = findHitsRef.current
    const m = hits[wrapIndex(findIndex, hits.length)]
    if (!m) return
    const src = editorText()
    const insert = replacementFor(src, m, findQuery, replaceText, findOpts)
    const v = viewRef.current
    if (v) v.dispatch({ changes: { from: m.from, to: m.to, insert }, userEvent: 'input.replace' })
    else handleText(src.slice(0, m.from) + insert + src.slice(m.to))
    // Same index now points at the next hit (the replaced one usually no longer matches).
    setFindNav((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findIndex, findQuery, replaceText, findOpts, handleText])

  const replaceAll = useCallback(() => {
    const hits = findHitsRef.current
    if (hits.length === 0) return
    const src = editorText()
    const changes = hits.map((m) => ({
      from: m.from,
      to: m.to,
      insert: replacementFor(src, m, findQuery, replaceText, findOpts)
    }))
    const v = viewRef.current
    if (v) {
      // One transaction → one ⌘Z.
      v.dispatch({ changes, userEvent: 'input.replace' })
    } else {
      let out = ''
      let at = 0
      for (const c of changes) {
        out += src.slice(at, c.from) + c.insert
        at = c.to
      }
      handleText(out + src.slice(at))
    }
    setFindIndex(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, replaceText, findOpts, handleText])

  // Window-level shortcuts (capture phase): work wherever focus is, as long as this note is on screen.
  const findKeysRef = useRef({ findOpen, openFind, stepFind })
  findKeysRef.current = { findOpen, openFind, stepFind }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const root = rootRef.current
      // Hidden (settings open, other view) → leave the key alone.
      if (!root || root.offsetParent === null) return
      // A modal / palette owns the keyboard.
      const t = e.target as HTMLElement | null
      if (t?.closest?.('[role="dialog"], .palette, .cmd-palette') && !root.contains(t)) return
      // e.code, not e.key: on macOS ⌥⌘F reports key 'ƒ' (and other layouts remap letters).
      const key = e.code === 'KeyF' ? 'f' : e.code === 'KeyG' ? 'g' : e.key.toLowerCase()
      const k = findKeysRef.current
      if (key === 'f' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        k.openFind(e.altKey)
      } else if (key === 'g' && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        if (k.findOpen) k.stepFind(e.shiftKey ? -1 : 1)
        else k.openFind()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Edit › Find in the macOS app menu (main/app-menu.ts): same actions, for when the key goes to the menu.
  useEffect(() => {
    const sub = (
      window as unknown as {
        api?: { onFind?: (cb: (action: 'find' | 'replace' | 'next' | 'prev') => void) => () => void }
      }
    ).api?.onFind
    if (!sub) return
    return sub((action) => {
      const root = rootRef.current
      if (!root || root.offsetParent === null) return
      const k = findKeysRef.current
      if (action === 'find') k.openFind(false)
      else if (action === 'replace') k.openFind(true)
      else if (k.findOpen) k.stepFind(action === 'prev' ? -1 : 1)
      else k.openFind()
    })
  }, [])

  if (!doc) {
    return (
      <div className="editor-empty">
        <div>
          <p className="empty-icon" aria-hidden>
            ✒
          </p>
          <p className="muted">
            Nothing open — pick a note on the left,
            <br />
            or hit ⌥Space to capture one.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="editor"
      onKeyDown={(e) => {
        // ⌘S from anywhere in the editor.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          onFlush?.()
          return
        }
        // Esc closes find from the bar or the note itself (caret stays on the hit).
        if (e.key === 'Escape' && findOpen) {
          e.preventDefault()
          closeFind()
        }
      }}
    >
      {!compact && (
        <div className="ed-head">
          {onMoveClick && (
            <div className="ed-crumbs-row">
              <button
                className="ed-crumbs"
                title={`In ${doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : 'the vault root'} — click to move`}
                aria-label="Note folder — move to another folder"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  onMoveClick(r.left, r.bottom + 6)
                }}
              >
                {breadcrumb(doc.path).length === 0 ? (
                  <span className="crumb root">Vault root</span>
                ) : (
                  breadcrumb(doc.path).map((c, i) => (
                    <span key={c.rel} className="crumb">
                      {i > 0 && (
                        <span className="crumb-sep" aria-hidden>
                          ›
                        </span>
                      )}
                      {c.name}
                    </span>
                  ))
                )}
                <span className="crumb-caret" aria-hidden>
                  ▾
                </span>
              </button>
            </div>
          )}
          <div className={`ed-title${dayNav ? ' ed-title-day' : ''}`}>
            {dayNav && (
              <button
                className="btn ghost sm icon ed-daynav"
                disabled={!dayNav.onPrev}
                title={dayNav.prevLabel ? `Previous day note · ${dayNav.prevLabel}` : 'No earlier day notes'}
                aria-label="Previous day note"
                onClick={() => dayNav.onPrev?.()}
              >
                ‹
              </button>
            )}
            <InlineTitle
              title={title || 'Untitled'}
              hint={renameHint}
              onCommit={onRename}
              onDone={() => viewRef.current?.focus()}
            />
            {dayNav && (
              <button
                className="btn ghost sm icon ed-daynav"
                disabled={!dayNav.onNext}
                title={dayNav.nextLabel ? `Next day note · ${dayNav.nextLabel}` : 'This is the latest day'}
                aria-label="Next day note"
                onClick={() => dayNav.onNext?.()}
              >
                ›
              </button>
            )}
          </div>
          <div className="row ed-actions">
            <button
              className={`btn ghost sm icon${findOpen ? ' active-opt' : ''}`}
              title="Find in note (⌘F)"
              aria-label="Find in note"
              aria-expanded={findOpen}
              onClick={() => (findOpen ? setFindOpen(false) : openFind())}
            >
              ⌕
            </button>
            <button
              className="btn ghost sm icon"
              title="Raw / Processed view with AI (⇧⌥P)"
              aria-label="Raw / Processed view"
              onClick={() => sendAiCommand('toggle-view')}
            >
              ✦
            </button>
            {onPopOut && (
              <button
                className="btn ghost sm icon ed-pop"
                title={popOutTitle ?? 'Pop out to mini window'}
                aria-label="Pop out to mini window"
                onClick={onPopOut}
              >
                <PopOutIcon size={13} />
              </button>
            )}
            <button className="btn ghost sm" onClick={() => void window.api.notes.reveal(doc.id)}>
              Reveal
            </button>
            <button
              className="btn ghost sm icon"
              title="Note actions (reveal, rename, delete)"
              aria-label="Note actions"
              onClick={(e) => {
                const r = (e.target as HTMLElement).getBoundingClientRect()
                onMore(r.left, r.bottom + 6)
              }}
            >
              ⋯
            </button>
          </div>
          <p
            className="muted small ed-meta"
            title={`Created ${new Date(doc.createdAt).toLocaleString()} · Updated ${new Date(doc.updatedAt).toLocaleString()}`}
          >
            {doc.path} ·{' '}
            {draft !== undefined
              ? `${fmtChars(text.length)} · `
              : doc.size > 0
                ? `${fmtBytes(doc.size)} · `
                : `${fmtChars(doc.markdown.length)} · `}
            edited {timeAgo(doc.updatedAt)} · created{' '}
            {new Date(doc.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
            {!onSetTags && (
              <>
                {' · '}
                {doc.tags.map((t) => `#${t}`).join(' ') || 'no tags'}
              </>
            )}
          </p>
          {onSetTags && <TagChips tags={doc.tags} allTags={allTags} onChange={onSetTags} onTagClick={onTagClick} />}
        </div>
      )}
      {findOpen && (
        <div className={`find-bar${replaceOpen ? ' with-replace' : ''}`} role="search" aria-label="Find in note">
          <div className="find-row">
            <button
              className="btn ghost sm icon find-expand"
              title={replaceOpen ? 'Hide replace' : 'Replace (⌥⌘F)'}
              aria-label="Toggle replace"
              aria-expanded={replaceOpen}
              onClick={() => setReplaceOpen((v) => !v)}
            >
              {replaceOpen ? '▾' : '▸'}
            </button>
            <input
              ref={findInputRef}
              className={`find-input${findBad ? ' bad' : ''}`}
              value={findQuery}
              autoFocus
              spellCheck={false}
              onChange={(e) => {
                const q = e.target.value
                setFindQuery(q)
                setFindIndex(matchAtOrAfter(findMatches(editorText(), q, findOpts), caretAnchorRef.current))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepFind(e.shiftKey ? -1 : 1)
                }
              }}
              placeholder="Find in note…"
              aria-label="Find in note"
            />
            <span className={`muted small find-count${findQuery && findTotal === 0 ? ' none' : ''}`} aria-live="polite">
              {findBad
                ? 'bad regex'
                : findQuery
                  ? findTotal > 0
                    ? `${findCurrent + 1}/${findTotal}`
                    : 'no results'
                  : ''}
            </span>
            <button
              className={`btn ghost sm icon find-opt${findOpts.caseSensitive ? ' on' : ''}`}
              title="Match case"
              aria-label="Match case"
              aria-pressed={!!findOpts.caseSensitive}
              onClick={() => setFindOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
            >
              Aa
            </button>
            <button
              className={`btn ghost sm icon find-opt${findOpts.wholeWord ? ' on' : ''}`}
              title="Whole word"
              aria-label="Whole word"
              aria-pressed={!!findOpts.wholeWord}
              onClick={() => setFindOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
            >
              ab
            </button>
            <button
              className={`btn ghost sm icon find-opt${findOpts.regex ? ' on' : ''}`}
              title="Regex"
              aria-label="Regex"
              aria-pressed={!!findOpts.regex}
              onClick={() => setFindOpts((o) => ({ ...o, regex: !o.regex }))}
            >
              .*
            </button>
            <button
              className="btn ghost sm icon"
              title="Previous (⇧↵ / ⇧⌘G)"
              aria-label="Previous match"
              onClick={() => stepFind(-1)}
              disabled={findTotal === 0}
            >
              ↑
            </button>
            <button
              className="btn ghost sm icon"
              title="Next (↵ / ⌘G)"
              aria-label="Next match"
              onClick={() => stepFind(1)}
              disabled={findTotal === 0}
            >
              ↓
            </button>
            <button className="btn ghost sm icon" title="Close (Esc)" aria-label="Close find" onClick={closeFind}>
              ×
            </button>
          </div>
          {replaceOpen && (
            <div className="find-row">
              <span className="find-expand-spacer" aria-hidden />
              <input
                ref={replaceInputRef}
                className="find-input"
                value={replaceText}
                spellCheck={false}
                onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if ((e.metaKey || e.ctrlKey) && e.altKey) replaceAll()
                    else replaceOne()
                  }
                }}
                placeholder={findOpts.regex ? 'Replace ($1 for groups)…' : 'Replace…'}
                aria-label="Replace with"
              />
              <button className="btn ghost sm" onClick={replaceOne} disabled={findTotal === 0} title="Replace (↵)">
                Replace
              </button>
              <button
                className="btn ghost sm"
                onClick={replaceAll}
                disabled={findTotal === 0}
                title="Replace all (⌥⌘↵)"
              >
                All
              </button>
            </div>
          )}
        </div>
      )}
      {/* AI: Raw / Processed view + Process selection (user-driven, see NoteAi). */}
      <NoteAi viewRef={viewRef} doc={doc} text={text}>
        <div
          className="ed-live"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onEditorBlur?.()
          }}
        >
          {cmFailed ? (
            <textarea
              className="ed-fallback"
              value={text}
              autoFocus
              onChange={(e) => handleText(e.target.value)}
              aria-label="Markdown source (fallback editor)"
            />
          ) : (
            <div className="ed-src" ref={mountRef} aria-label="Note editor" />
          )}
        </div>
      </NoteAi>
    </div>
  )
}

/**
 * The big header title, editable in place (Obsidian inline title): click into it and type.
 * Enter or blur commits, Esc cancels. Plain text only; one line.
 */
function InlineTitle({
  title,
  hint,
  onCommit,
  onDone
}: {
  title: string
  hint?: string
  onCommit: (t: string) => void
  onDone: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLHeadingElement>(null)
  const editing = useRef(false)
  const cancelled = useRef(false)
  // Show the current title whenever we're not mid-edit: rename landed, note switched, or a commit
  // that left `title` unchanged (rename failed, or the text sanitized back to the same file name).
  // No deps on purpose, so that last case snaps back on the next render instead of showing text
  // the file isn't called. Text is set here, never as React children — the browser owns the node
  // while you type.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !editing.current && el.textContent !== title) el.textContent = title
  })
  const read = (): string => (ref.current?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return (
    <h2
      ref={ref}
      className="ed-inline-title"
      contentEditable="plaintext-only"
      spellCheck={false}
      role="textbox"
      aria-label="Note title"
      title={hint ?? 'Click to rename'}
      onFocus={() => {
        editing.current = true
        cancelled.current = false
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
          onDone()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancelled.current = true
          if (ref.current) ref.current.textContent = title
          ref.current?.blur()
        }
      }}
      onPaste={(e) => {
        // One line of plain text, whatever the clipboard holds.
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain').replace(/\s+/g, ' ')
        document.execCommand('insertText', false, text)
      }}
      onBlur={() => {
        editing.current = false
        const next = read()
        if (cancelled.current || !next || next === title) {
          if (ref.current) ref.current.textContent = title
          return
        }
        onCommit(next)
      }}
    />
  )
}

function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return []
  return [...dt.files].filter((f) => f.type.startsWith('image/'))
}

function hasFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && [...dt.types].includes('Files')
}

/** Save each image to assets/ and insert its ref(s) on their own line at `at`. */
async function insertImages(view: EditorView, files: File[], at: number): Promise<void> {
  const refs: string[] = []
  for (const f of files) {
    try {
      const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*$/, '') || 'png'
      const rel = await window.api.assets.save(f.name || `pasted.${ext}`, await toDataUrl(f))
      refs.push(imageMarkdown(rel))
    } catch (err) {
      console.error('[editor] image save failed:', err)
    }
  }
  if (refs.length === 0) return
  const doc = view.state.doc
  const pos = Math.min(at, doc.length)
  const line = doc.lineAt(pos)
  const before = pos > line.from ? '\n' : ''
  const after = pos < line.to ? '\n' : ''
  const insert = `${before}${refs.join('\n')}${after}`
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
    scrollIntoView: true
  })
  view.focus()
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(file)
  })
}

export default memo(NoteEditor)
