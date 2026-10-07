import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  assetUrl, parseBlocks, renderMarkdown, spliceBlock, toggleTaskSource,
  type LiveBlock
} from '../md'

interface Props {
  docId: string
  /** Full markdown source — blocks re-derive from this. */
  text: string
  onChange: (full: string) => void
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(file)
  })
}

async function copyText(txt: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(txt)
    return true
  } catch {
    // Clipboard API unavailable (permissions) — legacy fallback.
    try {
      const ta = document.createElement('textarea')
      ta.value = txt
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * Live view: rendered markdown with click-to-edit blocks (Obsidian Live
 * Preview lite). Click a block → it becomes a focused textarea; blur/⌘Enter
 * commits back to the full source. Task checkboxes toggle in place.
 */
function LiveView({ docId, text, onChange }: Props): React.JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const textRef = useRef(text)
  textRef.current = text

  // Switching notes clears the editing block.
  useEffect(() => {
    setActiveKey(null)
    setDraft('')
  }, [docId])

  const startEdit = (b: LiveBlock): void => {
    setActiveKey(b.key)
    setDraft(b.source)
  }

  const commit = (): void => {
    if (!activeKey) return
    const b = blocks.find((x) => x.key === activeKey)
    setActiveKey(null)
    if (!b) {
      setDraft('')
      return
    }
    if (draft !== b.source) {
      changeRef.current(spliceBlock(textRef.current, b, draft))
    }
    setDraft('')
  }

  const cancel = (): void => {
    setActiveKey(null)
    setDraft('')
  }

  const toggleTask = (b: LiveBlock): void => {
    const next = toggleTaskSource(b.source)
    if (next === null) return
    changeRef.current(spliceBlock(textRef.current, b, next))
  }

  const onPasteImage = async (e: React.ClipboardEvent): Promise<void> => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    try {
      const rel = await window.api.assets.save(file.name || 'pasted.png', await toDataUrl(file))
      const insert = `\n![](${rel})\n`
      if (activeKey) {
        setDraft((d) => `${d}${insert}`)
      } else {
        changeRef.current(`${textRef.current}${insert}`)
      }
    } catch (err) {
      console.error('[live] image paste failed:', err)
    }
  }

  if (blocks.length === 0) {
    return (
      <div className="live-empty" onClick={() => changeRef.current(`${textRef.current}# New note\n`)}>
        <p className="muted">Empty note — click here to start writing.</p>
      </div>
    )
  }

  return (
    <div className="live" onPaste={(e) => void onPasteImage(e)}>
      {blocks.map((b) =>
        activeKey === b.key ? (
          <BlockEditor
            key={b.key}
            initial={draft}
            kind={b.kind}
            line={b.startLine + 1}
            onChange={setDraft}
            onCommit={commit}
            onCancel={cancel}
          />
        ) : (
          <LiveBlockView key={b.key} block={b} onEdit={startEdit} onToggle={toggleTask} />
        )
      )}
    </div>
  )
}

const LiveBlockView = memo(function LiveBlockView({
  block, onEdit, onToggle
}: {
  block: LiveBlock
  onEdit: (b: LiveBlock) => void
  onToggle: (b: LiveBlock) => void
}): React.JSX.Element {
  const html = useMemo(
    () => renderMarkdown(block.source, { resolveAsset: assetUrl }),
    [block.source]
  )
  return (
    <div
      className={`live-block kind-${block.kind}`}
      title="Click to edit"
      onClick={(e) => {
        const t = e.target as HTMLElement
        // Code block buttons (copy / expand) — handled here, never edit.
        const btn = t.closest?.('button')
        if (btn) {
          if (btn.classList.contains('copy-code')) {
            const code = btn.closest('.codeblock')?.querySelector('code')
            const txt = code?.textContent ?? ''
            if (txt) {
              btn.textContent = 'Copying…'
              void copyText(txt).then((ok) => {
                btn.textContent = ok ? 'Copied ✓' : 'Failed'
                window.setTimeout(() => {
                  btn.textContent = 'Copy'
                }, 1200)
              })
            }
            return
          }
          if (btn.classList.contains('expand-code')) {
            const wrap = btn.closest('.codeblock')
            const pre = wrap?.querySelector('pre')
            if (pre) {
              const collapsed = pre.classList.toggle('collapsed')
              btn.textContent = collapsed ? 'Expand' : 'Collapse'
            }
            return
          }
        }
        // Task checkbox toggles in place — don't open the editor.
        if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'checkbox') {
          e.stopPropagation()
          onToggle(block)
          return
        }
        if (t.tagName === 'A') return // let links work
        onEdit(block)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEdit(block)
      }}
      tabIndex={0}
      role="button"
      aria-label={`Edit ${block.kind} block, line ${block.startLine + 1}`}
    >
      <span className="live-ln" aria-hidden>{block.startLine + 1}</span>
      <div className="live-body md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
})

function BlockEditor({
  initial, kind, line, onChange, onCommit, onCancel
}: {
  initial: string
  kind: string
  line: number
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    autoGrow(el)
  }, [])

  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }

  return (
    <div className={`live-editing kind-${kind}`}>
      <span className="live-ln" aria-hidden>{line}</span>
      <textarea
        ref={ref}
        className="live-textarea"
        value={initial}
        rows={Math.min(24, Math.max(1, initial.split('\n').length))}
        onChange={(e) => {
          onChange(e.target.value)
          autoGrow(e.target)
        }}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        aria-label={`Edit ${kind} (⌘Enter to done, Esc to cancel)`}
      />
      <p className="muted small live-hint">⌘Enter done · Esc cancel</p>
    </div>
  )
}

export default memo(LiveView)
