import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { NoteDoc } from '../../../shared/types'
import { renderMarkdown } from '../md'

interface Props {
  doc: NoteDoc | null
  onChange: (markdown: string) => void
  onSave: () => void
}

/** Center editor: CodeMirror 6 GFM source + rendered preview, image paste → assets/. */
export default function NoteEditor({ doc, onChange, onSave }: Props): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const docIdRef = useRef<string | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const changeRef = useRef(onChange)
  changeRef.current = onChange

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
            { key: 'Mod-s', run: () => (saveRef.current(), true) }
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changeRef.current(u.state.doc.toString())
          }),
          EditorView.theme({
            '&': { backgroundColor: 'transparent', height: '100%' },
            '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13.5px' },
            '.cm-gutters': { backgroundColor: 'transparent', border: 'none' }
          })
        ]
      }),
      parent: mountRef.current,
      // Image paste → assets/ is handled on the DOM paste listener below.
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
    dom.addEventListener('paste', (e) => void onPaste(e))
    return () => {
      dom.removeEventListener('paste', (e) => void onPaste(e))
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Swap document content when selection changes.
  useEffect(() => {
    const v = viewRef.current
    if (!v || !doc) return
    if (docIdRef.current === doc.id) return
    docIdRef.current = doc.id
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc.markdown } })
  }, [doc?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) {
    return (
      <div className="editor-empty">
        <p className="muted">Select a note — or drop a .md folder fact: everything lives in your vault.</p>
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
        <div className="row">
          <button className="btn ghost sm" onClick={() => void window.api.notes.reveal(doc.id)}>
            Reveal
          </button>
          <button className="btn mint sm" onClick={onSave}>
            Save ⌘S
          </button>
        </div>
      </div>
      <div className="ed-cols">
        <div className="ed-src" ref={mountRef} aria-label="Markdown source" />
        <div
          className="ed-preview md"
          aria-label="Rendered preview"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.markdown) }}
        />
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
