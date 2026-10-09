import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { NoteDoc } from '../../../shared/types'
import type { EditMode } from '../theme'
import { dropDupH1, fmtBytes, fmtChars, timeAgo } from '../text'
import { assetUrl, findAll, renderMarkdown } from '../md'
import LiveView from './LiveView'

/** In-note find highlight for the Raw CodeMirror pane. */
const setFind = StateEffect.define<{ query: string; current: number }>()
const findQueryField = StateField.define<{ query: string; current: number }>({
  create: () => ({ query: '', current: 0 }),
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setFind)) return e.value as { query: string; current: number }
    return v
  }
})
function buildFindDeco(docText: string, query: string, current: number): DecorationSet {
  if (!query) return Decoration.none
  const hay = docText.toLowerCase()
  const q = query.toLowerCase()
  const builder = new RangeSetBuilder<Decoration>()
  let ordinal = 0
  let from = 0
  while (true) {
    const i = hay.indexOf(q, from)
    if (i < 0) break
    builder.add(
      i,
      i + q.length,
      ordinal === current
        ? Decoration.mark({ class: 'cm-find-hit current' })
        : Decoration.mark({ class: 'cm-find-hit' })
    )
    ordinal++
    from = i + Math.max(1, q.length)
  }
  return builder.finish()
}
const findDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (old, tr) => {
    const q = tr.state.field(findQueryField)
    if (!tr.docChanged && !tr.effects.some((e) => e.is(setFind))) return old.map(tr.changes)
    return buildFindDeco(tr.newDoc.toString(), q.query, q.current)
  },
  provide: (f) => EditorView.decorations.from(f)
})

interface Props {
  doc: NoteDoc | null
  /** Obsidian-style display title (filename or override). */
  title: string
  dirty: boolean
  defaultMode: EditMode
  /** One-shot mode for freshly created notes (open straight into Raw). */
  openMode: EditMode | null
  /** Unsaved markdown lifted to the tab strip (survives tab switches). */
  draft?: string
  onDraft: (id: string, markdown: string) => void
  onDirty: (dirty: boolean) => void
  onSave: (id: string, markdown: string) => void
  onRename: (title: string) => void
  onMore: (x: number, y: number) => void
}

const MODES: EditMode[] = ['live', 'raw']

/** Normalize legacy one-shot modes (`edit`→`raw`, `read`/`split`→`live`). */
function normalizeMode(m: string | null | undefined): EditMode | null {
  if (m === 'live' || m === 'raw') return m
  if (m === 'edit') return 'raw'
  if (m === 'read' || m === 'split') return 'live'
  return null
}

/**
 * Center editor: Live rendered view (click-to-edit blocks) + Raw markdown
 * source (CodeMirror 6, image paste → assets/).
 *
 * Perf: the text lives in LOCAL state — typing never re-renders the parent
 * (sidebar, lists, queue). Unsaved text is ALSO lifted via `onDraft` so
 * switching tabs keeps edits; the tab strip owns dirtiness.
 */
function NoteEditor({ doc, title, dirty, defaultMode, openMode, draft, onDraft, onDirty, onSave, onRename, onMore }: Props): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<EditMode>(normalizeMode(defaultMode) ?? 'live')
  const [cmFailed, setCmFailed] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const textRef = useRef(text)
  textRef.current = text
  /** True once the user has typed — guards the doc.markdown fallback below. */
  const editedRef = useRef(false)
  const saveRef = useRef({ doc, onSave })
  saveRef.current = { doc, onSave }
  const dirtyRef = useRef(onDirty)
  dirtyRef.current = onDirty
  const draftRef = useRef(onDraft)
  draftRef.current = onDraft

  const handleText = useCallback((next: string): void => {
    setText(next)
    editedRef.current = true
    dirtyRef.current(true)
    const d = saveRef.current.doc
    if (d) draftRef.current(d.id, next)
  }, [])

  const handleTextRef = useRef(handleText)
  handleTextRef.current = handleText

  // --- in-note find ---------------------------------------------------------
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindIndex(0)
    requestAnimationFrame(() => findInputRef.current?.select())
  }, [])

  // Reset find when switching documents.
  const docId = doc?.id ?? null
  useEffect(() => {
    setFindOpen(false)
    setFindQuery('')
    setFindIndex(0)
  }, [docId])

  // Push find state into the Raw pane decorations + scroll to the hit.
  useEffect(() => {
    const v = viewRef.current
    if (!v || mode !== 'raw') return
    const srcText = v.state.doc.toString()
    const hits = findAll(srcText, findQuery)
    const cur = hits.length > 0 ? ((findIndex % hits.length) + hits.length) % hits.length : 0
    v.dispatch({ effects: setFind.of({ query: findQuery, current: cur }) })
    if (findQuery && hits[cur] !== undefined) {
      v.dispatch({ effects: EditorView.scrollIntoView(hits[cur] as number, { y: 'center' }) })
    }
  }, [findQuery, findIndex, mode])

  // Raw source pane mounts only in raw mode. Re-created with the current
  // text if the pane remounts. Textarea fallback when CodeMirror fails.
  useEffect(() => {
    if (mode !== 'raw' || cmFailed || !mountRef.current || viewRef.current) return
    let view: EditorView | null = null
    try {
      view = new EditorView({
      state: EditorState.create({
        doc: textRef.current,
        extensions: [
          lineNumbers(),
          foldGutter({ openText: '▾', closedText: '▸' }),
          syntaxHighlighting(defaultHighlightStyle),
          markdown(),
          EditorView.lineWrapping,
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            {
              key: 'Mod-s',
              run: () => {
                const { doc: d, onSave: save } = saveRef.current
                if (d) save(d.id, textRef.current)
                return true
              }
            }
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handleTextRef.current(u.state.doc.toString())
          }),
          findQueryField,
          findDecoField,
          EditorView.theme({
            '&': { backgroundColor: 'transparent', height: '100%' },
            '.cm-content': {
              fontFamily: 'var(--mono-font)',
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
    // Focus so the caret is visible immediately.
    requestAnimationFrame(() => view.focus())

    const onPaste = async (e: ClipboardEvent): Promise<void> => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      try {
        const rel = await window.api.assets.save(file.name || 'pasted.png', await toDataUrl(file))
        const v = viewRef.current
        if (!v) return
        const pos = v.state.selection.main.head
        v.dispatch({ changes: { from: pos, insert: `\n![](${rel})\n` } })
      } catch (err) {
        console.error('[editor] image paste failed:', err)
      }
    }
    const dom = view.dom
    const listener = (e: ClipboardEvent): void => void onPaste(e)
    dom.addEventListener('paste', listener)
    return () => {
      dom.removeEventListener('paste', listener)
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cmFailed])

  // Swap document content when selection changes — lifted draft wins over
  // saved markdown so tab switches keep unsaved edits.
  useEffect(() => {
    if (!doc) return
    const next = draft ?? doc.markdown
    if (textRef.current !== next) {
      const v = viewRef.current
      if (v) {
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } })
        if (v.state.doc.toString() !== next) {
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } })
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

  // Follow the settings default when it changes there.
  useEffect(() => {
    const m = normalizeMode(defaultMode)
    if (m) setMode(m)
  }, [defaultMode])

  // Freshly created notes open straight into Raw.
  useEffect(() => {
    const m = normalizeMode(openMode)
    if (m && doc && m === 'raw') setMode('raw')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMode, docId])

  // CodeMirror can't measure inside `display: none` — remeasure on reveal.
  useEffect(() => {
    if (mode === 'live') return
    const t = requestAnimationFrame(() => viewRef.current?.requestMeasure())
    return () => cancelAnimationFrame(t)
  }, [mode, docId])

  // In-note find matches over the current source (live + raw share ordinals).
  // Hooks live above the `!doc` early return to keep hook order stable.
  const preSrc = text || (doc && !editedRef.current ? doc.markdown : '')
  const findHits = useMemo(() => findAll(preSrc, findQuery), [preSrc, findQuery])
  const findTotal = findHits.length
  const findCurrent = findTotal > 0 ? ((findIndex % findTotal) + findTotal) % findTotal : 0
  const stepFind = useCallback(
    (dir: 1 | -1) => {
      setFindIndex((i) => (findTotal > 0 ? i + dir : 0))
      // Fallback textarea can't render marks — jump the caret instead.
      if (mode === 'raw' && cmFailed && findTotal > 0) {
        const ta = document.querySelector<HTMLTextAreaElement>('.ed-fallback')
        const pos = findHits[((findIndex + dir) % findTotal + findTotal) % findTotal] ?? 0
        if (ta) {
          ta.focus()
          ta.setSelectionRange(pos, pos + findQuery.length)
        }
      }
    },
    [findTotal, findHits, findIndex, findQuery.length, mode, cmFailed]
  )

  if (!doc) {
    return (
      <div className="editor-empty">
        <div>
          <p className="empty-icon" aria-hidden>✒</p>
          <p className="muted">Nothing open — pick a note on the left,<br />or hit ⌥Space to capture one.</p>
        </div>
      </div>
    )
  }

  // First paint can beat the editor sync — fall back to the saved markdown
  // until the user types. Never render a silent blank box: surface the error.
  // A leading H1 duplicating the filename title is dropped (double header).
  const src = text || (!editedRef.current ? doc.markdown : '')
  const deduped = dropDupH1(src, title)
  let html = ''
  let failed = false
  try {
    html = renderMarkdown(deduped, { resolveAsset: assetUrl })
  } catch (err) {
    console.error('[editor] preview failed:', err)
    failed = true
  }
  const showFallback = failed || (src.trim() !== '' && html.trim() === '')

  const commitRename = (): void => {
    setRenaming(false)
    onRename(nameDraft.trim())
  }

  return (
    <div
      className="editor"
      onKeyDown={(e) => {
        // ⌘S from anywhere in the editor (live blocks are textareas).
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          onSave(doc.id, textRef.current)
          return
        }
        // ⌘F opens in-note find (we highlight ourselves, not the browser).
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          if (findOpen) findInputRef.current?.select()
          else openFind()
          return
        }
        // Esc inside the find bar closes it (live block edits own their Esc).
        if (e.key === 'Escape' && findOpen && (e.target as HTMLElement)?.closest?.('.find-bar')) {
          e.preventDefault()
          setFindOpen(false)
          setFindQuery('')
        }
      }}
    >
      <div className="ed-head">
        <div className="ed-title">
          {renaming ? (
            <input
              className="rename-input"
              value={nameDraft}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={commitRename}
              aria-label="Note title (empty restores filename)"
              placeholder="Custom title — empty restores filename"
            />
          ) : (
            <>
              <h2>{title || 'Untitled'}</h2>
              <button
                className="btn ghost sm icon"
                title="Rename (stored in app config, file untouched)"
                aria-label="Rename note"
                onClick={() => {
                  setNameDraft(title)
                  setRenaming(true)
                }}
              >
                ✎
              </button>
            </>
          )}
          <p
            className="muted small"
            title={`Created ${new Date(doc.createdAt).toLocaleString()} · Updated ${new Date(doc.updatedAt).toLocaleString()}`}
          >
            {doc.path} · {doc.size > 0 ? `${fmtBytes(doc.size)} · ` : `${fmtChars(doc.markdown.length)} · `}
            edited {timeAgo(doc.updatedAt)} · created {new Date(doc.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
            {' · '}{doc.tags.map((t) => `#${t}`).join(' ') || 'no tags'}
          </p>
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
          <div className="seg sm" role="group" aria-label="View mode">
            {MODES.map((m) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {m === 'live' ? 'Live' : 'Raw'}
              </button>
            ))}
          </div>
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
          <button className={`btn sm${dirty ? ' mint' : ' ghost'}`} onClick={() => onSave(doc.id, textRef.current)}>
            Save ⌘S
          </button>
        </div>
      </div>
      {findOpen && (
        <div className="find-bar" role="search" aria-label="Find in note">
          <input
            ref={findInputRef}
            className="find-input"
            value={findQuery}
            autoFocus
            onChange={(e) => {
              setFindQuery(e.target.value)
              setFindIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                stepFind(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setFindOpen(false)
                setFindQuery('')
              }
            }}
            placeholder="Find in note…"
            aria-label="Find in note"
          />
          <span className="muted small find-count" aria-live="polite">
            {findQuery ? (findTotal > 0 ? `${findCurrent + 1}/${findTotal}` : '0/0') : ''}
          </span>
          <button className="btn ghost sm icon" title="Previous (⇧↵)" aria-label="Previous match" onClick={() => stepFind(-1)} disabled={findTotal === 0}>
            ↑
          </button>
          <button className="btn ghost sm icon" title="Next (↵)" aria-label="Next match" onClick={() => stepFind(1)} disabled={findTotal === 0}>
            ↓
          </button>
          <button
            className="btn ghost sm icon"
            title="Close (Esc)"
            aria-label="Close find"
            onClick={() => {
              setFindOpen(false)
              setFindQuery('')
            }}
          >
            ×
          </button>
        </div>
      )}
      <div className={`ed-cols ${mode}`}>
        {mode === 'raw' ? (
          cmFailed ? (
            <textarea
              className="ed-fallback"
              value={text}
              autoFocus
              onChange={(e) => handleText(e.target.value)}
              aria-label="Markdown source (fallback editor)"
            />
          ) : (
            <div className="ed-src" ref={mountRef} aria-label="Markdown source" />
          )
        ) : showFallback ? (
          <div className="ed-preview md">
            <p className="muted">Preview failed for this note — switch to Raw to see the source.</p>
          </div>
        ) : (
          <LiveView docId={doc.id} text={src} onChange={handleText} find={{ query: findQuery, current: findCurrent }} />
        )}
      </div>
    </div>
  )
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
