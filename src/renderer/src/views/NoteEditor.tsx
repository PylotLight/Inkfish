import { memo, useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { NoteDoc } from '../../../shared/types'
import type { EditMode } from '../theme'
import { renderMarkdown } from '../md'

interface Props {
  doc: NoteDoc | null
  dirty: boolean
  defaultMode: EditMode
  onDirty: (dirty: boolean) => void
  onSave: (id: string, markdown: string) => void
}

const MODES: EditMode[] = ['read', 'edit', 'split']

/**
 * Center editor: CodeMirror 6 GFM source + rendered preview, image paste → assets/.
 *
 * Perf: the text lives in LOCAL state — typing never re-renders the parent
 * (sidebar, lists, queue). The preview follows on a short debounce and is
 * memoized, so keystrokes stay at editor speed.
 */
function NoteEditor({ doc, dirty, defaultMode, onDirty, onSave }: Props): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState('')
  const [mode, setMode] = useState<EditMode>(defaultMode)
  const textRef = useRef(text)
  textRef.current = text
  const saveRef = useRef({ doc, onSave })
  saveRef.current = { doc, onSave }
  const dirtyRef = useRef(onDirty)
  dirtyRef.current = onDirty

  // Create once.
  useEffect(() => {
    if (!mountRef.current || viewRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
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
  }, [])

  // Swap document content when selection changes.
  const docId = doc?.id ?? null
  useEffect(() => {
    const v = viewRef.current
    if (!v || !doc) return
    const next = doc.markdown
    if (textRef.current !== next) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } })
      setText(next)
      setPreview(next)
      dirtyRef.current(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  // Follow the settings default when it changes there.
  useEffect(() => {
    setMode(defaultMode)
  }, [defaultMode])

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

  return (
    <div className="editor">
      <div className="ed-head">
        <div>
          <h2>{doc.title}</h2>
          <p className="muted small">
            {doc.path} · {doc.tags.map((t) => `#${t}`).join(' ') || 'no tags'}
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
          <button className="btn mint sm" onClick={() => onSave(doc.id, textRef.current)}>
            Save ⌘S
          </button>
        </div>
      </div>
      <div className={`ed-cols ${mode}`}>
        <div
          className="ed-src"
          ref={mountRef}
          aria-label="Markdown source"
          hidden={mode === 'read'}
        />
        {(mode === 'read' || mode === 'split') && <Preview html={renderMarkdown(mode === 'read' ? text : preview)} />}
      </div>
    </div>
  )
}

/** Memoized so parent (dirty flag) re-renders don't redo the preview DOM. */
const Preview = memo(function Preview({ html }: { html: string }): React.JSX.Element {
  return (
    <div
      className="ed-preview md"
      aria-label="Rendered preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
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
