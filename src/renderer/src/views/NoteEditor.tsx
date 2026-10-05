import { memo, useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { NoteDoc } from '../../../shared/types'
import type { EditMode } from '../theme'
import { dropDupH1, fmtBytes, fmtChars, timeAgo } from '../text'
import { assetUrl, renderMarkdown } from '../md'

interface Props {
  doc: NoteDoc | null
  /** Obsidian-style display title (filename or override). */
  title: string
  dirty: boolean
  defaultMode: EditMode
  /** One-shot mode for freshly created notes (open straight into Edit). */
  openMode: EditMode | null
  onDirty: (dirty: boolean) => void
  onSave: (id: string, markdown: string) => void
  onRename: (title: string) => void
  onMore: (x: number, y: number) => void
}

const MODES: EditMode[] = ['read', 'edit', 'split']

/**
 * Center editor: CodeMirror 6 GFM source + rendered preview, image paste → assets/.
 *
 * Perf: the text lives in LOCAL state — typing never re-renders the parent
 * (sidebar, lists, queue). The preview follows on a short debounce and is
 * memoized, so keystrokes stay at editor speed.
 */
function NoteEditor({ doc, title, dirty, defaultMode, openMode, onDirty, onSave, onRename, onMore }: Props): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState('')
  const [mode, setMode] = useState<EditMode>(defaultMode)
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

  // Created when the source pane mounts (edit/split). Re-created with the
  // current text if the pane remounts (mode switch). Textarea fallback above.
  useEffect(() => {
    if (cmFailed || !mountRef.current || viewRef.current) return
    let view: EditorView | null = null
    try {
      view = new EditorView({
      state: EditorState.create({
        doc: textRef.current,
        extensions: [
          markdown(),
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
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
            if (u.docChanged) {
              setText(u.state.doc.toString())
              editedRef.current = true
              dirtyRef.current(true)
            }
          }),
          EditorView.theme({
            '&': { backgroundColor: 'transparent', height: '100%' },
            '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--ed-fs, 13.5px)' },
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

  // Swap document content when selection changes. Verifies the insert took
  // (logs sizes so a blank editor is diagnosable, not silent). Works for the
  // textarea fallback too (no CodeMirror view there).
  const docId = doc?.id ?? null
  useEffect(() => {
    if (!doc) return
    const next = doc.markdown
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
      setPreview(next)
      editedRef.current = false
      dirtyRef.current(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  // Follow the settings default when it changes there.
  useEffect(() => {
    setMode(defaultMode)
  }, [defaultMode])

  // Freshly created notes open straight into Edit.
  useEffect(() => {
    if (openMode && doc && openMode === 'edit') setMode('edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMode, docId])

  // CodeMirror can't measure inside `display: none` — remeasure on reveal.
  useEffect(() => {
    if (mode === 'read') return
    const t = requestAnimationFrame(() => viewRef.current?.requestMeasure())
    return () => cancelAnimationFrame(t)
  }, [mode, docId])

  // Debounced preview — the expensive renderMarkdown stays off the keystroke path.
  useEffect(() => {
    const t = window.setTimeout(() => setPreview(text), 180)
    return () => window.clearTimeout(t)
  }, [text])

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
  const previewSrc = mode === 'read' ? deduped : dropDupH1(preview || (!editedRef.current ? doc.markdown : ''), title)
  let html = ''
  let failed = false
  try {
    html = renderMarkdown(previewSrc, { resolveAsset: assetUrl })
  } catch (err) {
    console.error('[editor] preview failed:', err)
    failed = true
  }
  const showFallback = (failed || (src.trim() !== '' && html.trim() === '')) && mode !== 'edit'

  const commitRename = (): void => {
    setRenaming(false)
    onRename(nameDraft.trim())
  }

  return (
    <div className="editor">
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
          <div className="seg sm" role="group" aria-label="View mode">
            {MODES.map((m) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {m === 'read' ? 'Read' : m === 'edit' ? 'Edit' : 'Split'}
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
          <button className="btn mint sm" onClick={() => onSave(doc.id, textRef.current)}>
            Save ⌘S
          </button>
        </div>
      </div>
      <div className={`ed-cols ${mode}`}>
        {(mode === 'edit' || mode === 'split') &&
          (cmFailed ? (
            <textarea
              className="ed-fallback"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                editedRef.current = true
                dirtyRef.current(true)
              }}
              aria-label="Markdown source (fallback editor)"
            />
          ) : (
            <div className="ed-src" ref={mountRef} aria-label="Markdown source" />
          ))}
        {(mode === 'read' || mode === 'split') &&
          (showFallback ? (
            <div className="ed-preview md">
              <p className="muted">Preview failed for this note — switch to Edit to see the source.</p>
            </div>
          ) : (
            <Preview key={doc.id} html={html} />
          ))}
      </div>
    </div>
  )
}

/** Memoized so parent (dirty flag) re-renders don't redo the preview DOM. */
const Preview = memo(function Preview({ html }: { html: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [invisible, setInvisible] = useState(false)

  // Rendered-but-invisible is the worst failure (silent blank box) — measure
  // and say so loudly instead of leaving a mystery. Double-rAF + delayed
  // recheck: a single rAF fires before grid layout settles (false positive).
  useEffect(() => {
    const el = ref.current
    if (!el || html.trim() === '') {
      setInvisible(false)
      return
    }
    let dead = false
    const check = (): void => {
      if (dead || !ref.current) return
      const blank = ref.current.scrollHeight < 24
      setInvisible(blank)
      if (blank) console.warn(`[editor] preview rendered ${html.length} chars but measures 0px — CSS issue?`)
    }
    const r1 = requestAnimationFrame(() => {
      void requestAnimationFrame(check)
    })
    const t = window.setTimeout(check, 350)
    return () => {
      dead = true
      cancelAnimationFrame(r1)
      window.clearTimeout(t)
    }
  }, [html])

  return (
    <div className="ed-preview md" aria-label="Rendered preview">
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {invisible && <p className="preview-warn">Rendered content is invisible — open devtools console and report this.</p>}
    </div>
  )
})

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(file)
  })
}

export default memo(NoteEditor)
