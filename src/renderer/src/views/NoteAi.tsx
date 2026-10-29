import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import type { NoteDoc } from '../../../shared/types'
import { AI_ACTIONS, AI_ACTION_INFO, contentHash, type AiAction, type ProcessedEntry } from '../../../shared/ai-process'
import { minimalEdit } from '../../../shared/mini-window'
import { imageCandidates } from '../../../shared/images'
import { livePreview } from '../livePreview'
import {
  AI_COMMAND_EVENT,
  AiNotConnectedError,
  aiErrorDetails,
  aiErrorMessage,
  isAbort,
  runAiProcess,
  type AiCommand
} from '../nativeAi'
import CopyDetails from './CopyDetails'

/**
 * AI on a note, always user-driven (nothing runs on its own):
 *
 * - Raw / Split / Processed view. Raw is the real file, untouched. Processed is an AI version made
 *   on demand with the chosen action, cached per note (main, `ai-processed/`) with the raw note's
 *   hash, so it shows "stale" after the raw changes. "Apply to note" replaces the raw text in ONE
 *   editor transaction (its own undo step, so ⌘Z restores) through the normal editor change path,
 *   so drafts / autosave pick it up like typing.
 * - Process selection: select → right-click, ⇧⌥S or ⌘K → pick an action → preview → Accept
 *   (replace, one undo step) / Insert below / Reject.
 *
 * Commands arrive as `inkfish:ai` window events (⌘K, note menu) and ⇧⌥P / ⇧⌥S shortcuts.
 */

type ViewMode = 'raw' | 'split' | 'processed'

/** View mode per note for this window session. */
const modeByNote = new Map<string, ViewMode>()

type Run =
  | { state: 'idle' }
  | { state: 'running'; partial: string }
  | { state: 'error'; message: string; connect: boolean; details?: string }

interface SelPop {
  from: number
  to: number
  x: number
  y: number
  phase: 'pick' | 'running' | 'done' | 'error'
  action: AiAction
  instruction: string
  partial: string
  result: string
  warnings: string[]
  notices: string[]
  error: string
  errorDetails?: string
  connect: boolean
}

interface Props {
  viewRef: RefObject<EditorView | null>
  doc: NoteDoc
  /** Current raw text (the editor's). */
  text: string
  children: ReactNode
}

function openAiSettings(): void {
  window.dispatchEvent(new CustomEvent('inkfish:open-settings', { detail: 'ai' }))
}

function ActionPicker({
  action,
  instruction,
  onAction,
  onInstruction,
  onRun,
  disabled
}: {
  action: AiAction
  instruction: string
  onAction: (a: AiAction) => void
  onInstruction: (s: string) => void
  onRun?: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <>
      <select
        className="ai-action"
        value={action}
        disabled={disabled}
        onChange={(e) => onAction(e.target.value as AiAction)}
        aria-label="What to do"
        title={AI_ACTION_INFO[action].hint}
      >
        {AI_ACTIONS.map((a) => (
          <option key={a} value={a}>
            {AI_ACTION_INFO[a].label}
          </option>
        ))}
      </select>
      {action === 'custom' && (
        <input
          className="ai-instruction"
          value={instruction}
          disabled={disabled}
          maxLength={2000}
          placeholder="e.g. Rewrite as meeting minutes with decisions first"
          onChange={(e) => onInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onRun) {
              e.preventDefault()
              onRun()
            }
          }}
          aria-label="Custom instruction"
        />
      )}
    </>
  )
}

/** Read-only live-preview rendering of the processed markdown. */
function ProcessedPreview({ text, notePath }: { text: string; notePath: string }): React.JSX.Element {
  const mount = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const pathRef = useRef(notePath)
  pathRef.current = notePath
  useEffect(() => {
    if (!mount.current) return
    const v = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          livePreview({ onToggleTask: () => undefined, resolveImage: (src) => imageCandidates(src, pathRef.current) }),
          EditorView.theme({
            '&': { backgroundColor: 'transparent', height: '100%' },
            '.cm-content': { fontFamily: 'var(--text-font)', fontSize: 'var(--ed-fs, 14px)' }
          })
        ]
      }),
      parent: mount.current
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === text) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
  }, [text])
  return <div className="ai-preview ed-src" ref={mount} aria-label="Processed note (read-only)" />
}

export default function NoteAi({ viewRef, doc, text, children }: Props): React.JSX.Element {
  const [mode, setModeState] = useState<ViewMode>(() => modeByNote.get(doc.id) ?? 'raw')
  const [entry, setEntry] = useState<ProcessedEntry | null>(null)
  const [action, setAction] = useState<AiAction>('tidy')
  const [instruction, setInstruction] = useState('')
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const [pop, setPop] = useState<SelPop | null>(null)
  const [flash, setFlash] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const setMode = useCallback(
    (m: ViewMode) => {
      modeByNote.set(doc.id, m)
      setModeState(m)
    },
    [doc.id]
  )

  // Switching notes: cancel anything running, restore that note's mode and cached version.
  useEffect(() => {
    abortRef.current?.abort()
    setRun({ state: 'idle' })
    setPop(null)
    setModeState(modeByNote.get(doc.id) ?? 'raw')
    setEntry(null)
    let live = true
    void window.api.aiApi
      .processedGet(doc.id)
      .then((e) => {
        if (live && e) {
          setEntry(e)
          setAction(e.action)
          setInstruction(e.instruction)
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
      abortRef.current?.abort()
    }
  }, [doc.id])

  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(''), 2200)
    return () => window.clearTimeout(t)
  }, [flash])

  const stale = useMemo(
    () => (entry && mode !== 'raw' ? entry.rawHash !== contentHash(text) : false),
    [entry, mode, text]
  )

  const processNote = useCallback(async (): Promise<void> => {
    if (action === 'custom' && !instruction.trim()) {
      setRun({ state: 'error', message: 'Type an instruction first.', connect: false })
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const raw = viewRef.current?.state.doc.toString() ?? text
    setRun({ state: 'running', partial: '' })
    try {
      const r = await runAiProcess(
        { action, instruction, text: raw, scope: 'note', onChunk: (partial) => setRun({ state: 'running', partial }) },
        ac.signal,
        { notePath: doc.path }
      )
      const next: ProcessedEntry = {
        noteId: doc.id,
        rawHash: contentHash(raw),
        action,
        instruction,
        text: r.text,
        warnings: r.warnings,
        notices: r.notices,
        at: Date.now()
      }
      setEntry(next)
      setRun({ state: 'idle' })
      void window.api.aiApi.processedSet(next).catch(() => undefined)
    } catch (err) {
      if (isAbort(err)) setRun({ state: 'idle' })
      else
        setRun({
          state: 'error',
          message: aiErrorMessage(err),
          connect: err instanceof AiNotConnectedError,
          details: err instanceof AiNotConnectedError ? undefined : aiErrorDetails(err)
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, instruction, doc.id, text])

  /** Replace the raw note with the processed text: one transaction, its own undo step. */
  const applyToNote = (): void => {
    const v = viewRef.current
    if (!v || !entry) return
    const raw = v.state.doc.toString()
    const edit = minimalEdit(raw, entry.text)
    if (!edit) {
      setFlash('Already the same')
      return
    }
    // Keep the source: snapshot the pre-apply text (deduped if it didn't change) so the
    // rewrite is recoverable from History any time — ⌘Z only lasts until the next step.
    void window.api.aiApi
      .historySave(doc.id, raw, {
        via: 'ai-apply',
        label: action === 'custom' ? 'Custom' : AI_ACTION_INFO[action].label
      })
      .catch(() => undefined)
    v.dispatch({ changes: edit, annotations: isolateHistory.of('full'), userEvent: 'input.ai', scrollIntoView: true })
    // The raw now matches: keep the cache fresh against it.
    const fresh = { ...entry, rawHash: contentHash(v.state.doc.toString()) }
    setEntry(fresh)
    void window.api.aiApi.processedSet(fresh).catch(() => undefined)
    setMode('raw')
    v.focus()
    setFlash('Applied · ⌘Z to undo')
  }

  const copy = (): void => {
    if (!entry) return
    void navigator.clipboard.writeText(entry.text).then(
      () => setFlash('Copied'),
      () => setFlash('Copy failed')
    )
  }

  const discard = (): void => {
    setEntry(null)
    void window.api.aiApi.processedClear(doc.id).catch(() => undefined)
  }

  // --- selection -------------------------------------------------------------------------

  const openSelection = useCallback((at?: { x: number; y: number }): void => {
    const v = viewRef.current
    if (!v) return
    const sel = v.state.selection.main
    if (sel.empty) {
      setFlash('Select some text first')
      return
    }
    const c = v.coordsAtPos(sel.to) ?? v.coordsAtPos(sel.from)
    const x = at?.x ?? c?.left ?? 200
    const y = at?.y ?? c?.bottom ?? 200
    setPop((p) => ({
      from: sel.from,
      to: sel.to,
      x,
      y,
      phase: 'pick',
      action: p?.action ?? 'tidy',
      instruction: p?.instruction ?? '',
      partial: '',
      result: '',
      warnings: [],
      notices: [],
      error: '',
      connect: false
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runSelection = async (): Promise<void> => {
    const v = viewRef.current
    if (!v || !pop) return
    if (pop.action === 'custom' && !pop.instruction.trim()) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const selected = v.state.doc.sliceString(pop.from, pop.to)
    setPop((p) => p && { ...p, phase: 'running', partial: '', error: '', errorDetails: undefined })
    try {
      const r = await runAiProcess(
        {
          action: pop.action,
          instruction: pop.instruction,
          text: selected,
          scope: 'selection',
          onChunk: (partial) => setPop((p) => p && { ...p, partial })
        },
        ac.signal,
        { notePath: doc.path }
      )
      setPop((p) => p && { ...p, phase: 'done', result: r.text, warnings: r.warnings, notices: r.notices })
    } catch (err) {
      if (isAbort(err)) setPop((p) => p && { ...p, phase: 'pick' })
      else
        setPop(
          (p) =>
            p && {
              ...p,
              phase: 'error',
              error: aiErrorMessage(err),
              errorDetails: err instanceof AiNotConnectedError ? undefined : aiErrorDetails(err),
              connect: err instanceof AiNotConnectedError
            }
        )
    }
  }

  const acceptSelection = (insertBelow: boolean): void => {
    const v = viewRef.current
    if (!v || !pop) return
    const len = v.state.doc.length
    const from = Math.min(pop.from, len)
    const to = Math.min(pop.to, len)
    if (insertBelow) {
      const line = v.state.doc.lineAt(to)
      const insert = `\n\n${pop.result.trim()}\n`
      v.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: line.to + insert.length },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.ai',
        scrollIntoView: true
      })
    } else {
      v.dispatch({
        changes: { from, to, insert: pop.result },
        selection: { anchor: from, head: from + pop.result.length },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.ai',
        scrollIntoView: true
      })
    }
    setPop(null)
    v.focus()
    setFlash(insertBelow ? 'Inserted · ⌘Z to undo' : 'Replaced · ⌘Z to undo')
  }

  const closePop = (): void => {
    if (pop?.phase === 'running') abortRef.current?.abort()
    setPop(null)
    viewRef.current?.focus()
  }

  // --- commands: ⌘K / note menu events, ⇧⌥P / ⇧⌥S, right-click on a selection ----------------

  const visible = (): boolean => !!rootRef.current && rootRef.current.offsetParent !== null
  const handlers = useRef({ setMode, processNote, openSelection, mode })
  handlers.current = { setMode, processNote, openSelection, mode }

  useEffect(() => {
    const onCommand = (e: Event): void => {
      if (!visible()) return
      const cmd = (e as CustomEvent<AiCommand>).detail
      const h = handlers.current
      if (cmd === 'toggle-view') h.setMode(h.mode === 'raw' ? 'split' : 'raw')
      else if (cmd === 'process-note') {
        if (h.mode === 'raw') h.setMode('split')
        void h.processNote()
      } else if (cmd === 'process-selection') h.openSelection()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey || !visible()) return
      if (e.code === 'KeyP') {
        e.preventDefault()
        handlers.current.setMode(handlers.current.mode === 'raw' ? 'split' : 'raw')
      } else if (e.code === 'KeyS') {
        e.preventDefault()
        handlers.current.openSelection()
      }
    }
    const onContext = (e: MouseEvent): void => {
      const v = viewRef.current
      if (!v || v.state.selection.main.empty || !(e.target instanceof Node) || !v.dom.contains(e.target)) return
      e.preventDefault()
      handlers.current.openSelection({ x: e.clientX, y: e.clientY })
    }
    window.addEventListener(AI_COMMAND_EVENT, onCommand)
    window.addEventListener('keydown', onKey)
    window.addEventListener('contextmenu', onContext)
    return () => {
      window.removeEventListener(AI_COMMAND_EVENT, onCommand)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onContext)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const running = run.state === 'running'
  const shown = running ? run.partial : (entry?.text ?? '')

  return (
    <div className="ai-wrap" ref={rootRef}>
      {mode !== 'raw' && (
        <div className="ai-bar" role="toolbar" aria-label="Processed view">
          <div className="seg-row ai-seg" role="radiogroup" aria-label="View">
            {(['raw', 'split', 'processed'] as ViewMode[]).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                className={`seg${mode === m ? ' selected' : ''}`}
                onClick={() => setMode(m)}
              >
                {m === 'raw' ? 'Raw' : m === 'split' ? 'Side by side' : 'Processed'}
              </button>
            ))}
          </div>
          <ActionPicker
            action={action}
            instruction={instruction}
            onAction={setAction}
            onInstruction={setInstruction}
            onRun={() => void processNote()}
            disabled={running}
          />
          {running ? (
            <button className="btn ghost sm" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className={`btn sm${!entry || stale ? ' mint' : ' ghost'}`} onClick={() => void processNote()}>
              {entry ? 'Re-process' : 'Process'}
            </button>
          )}
          {entry && !running && (
            <>
              {stale && (
                <span className="pill ai-stale" title="The raw note changed after this was processed">
                  Stale
                </span>
              )}
              <button
                className="btn ghost sm"
                onClick={applyToNote}
                title="Replace the note with this version (⌘Z undoes)"
              >
                Apply to note
              </button>
              <button className="btn ghost sm" onClick={copy}>
                Copy
              </button>
              <button
                className="btn ghost sm icon"
                onClick={discard}
                title="Discard the processed version"
                aria-label="Discard"
              >
                ⌫
              </button>
            </>
          )}
          <button
            className="btn ghost sm icon ai-close"
            onClick={() => setMode('raw')}
            title="Back to raw (⇧⌥P)"
            aria-label="Close processed view"
          >
            ×
          </button>
        </div>
      )}
      {mode !== 'raw' && run.state === 'error' && (
        <p className="small error-text ai-error">
          {run.message} {run.details && <CopyDetails text={run.details} />}
          {run.connect && (
            <button className="btn ghost sm" onClick={openAiSettings}>
              Open Settings › AI
            </button>
          )}
        </p>
      )}
      {mode !== 'raw' && entry && !running && (entry.notices?.length ?? 0) > 0 && (
        <p className="small muted ai-warn">{entry.notices?.join(' ')}</p>
      )}
      {mode !== 'raw' && entry && !running && entry.warnings.length > 0 && (
        <p className="small muted ai-warn">
          Dropped {entry.warnings.length} image/link ref{entry.warnings.length > 1 ? 's' : ''}:{' '}
          {entry.warnings.slice(0, 3).join(', ')}
        </p>
      )}
      <div className={`ed-body ai-${mode}`}>
        {children}
        {mode !== 'raw' && (
          <div className="ai-pane">
            {shown ? (
              <ProcessedPreview text={shown} notePath={doc.path} />
            ) : (
              <div className="ai-empty muted small">
                Pick what to do, then <b>Process</b>. The raw note stays as it is until you choose Apply.
              </div>
            )}
          </div>
        )}
      </div>
      {flash && (
        <div className="ai-flash small" role="status">
          {flash}
        </div>
      )}
      {pop && (
        <div
          className="ai-pop"
          role="dialog"
          aria-label="Process selection"
          style={{ left: Math.min(pop.x, window.innerWidth - 380), top: Math.min(pop.y + 6, window.innerHeight - 260) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              closePop()
            }
          }}
        >
          <div className="row ai-pop-head">
            <ActionPicker
              action={pop.action}
              instruction={pop.instruction}
              onAction={(a) => setPop((p) => p && { ...p, action: a })}
              onInstruction={(s) => setPop((p) => p && { ...p, instruction: s })}
              onRun={() => void runSelection()}
              disabled={pop.phase === 'running'}
            />
            {pop.phase === 'running' ? (
              <button className="btn ghost sm" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button className="btn sm mint" autoFocus onClick={() => void runSelection()}>
                {pop.phase === 'pick' ? 'Process' : 'Again'}
              </button>
            )}
            <button className="btn ghost sm icon" onClick={closePop} aria-label="Close" title="Close (Esc)">
              ×
            </button>
          </div>
          {(pop.phase === 'running' || pop.phase === 'done') && (
            <pre className="ai-pop-out">{pop.phase === 'running' ? pop.partial || 'Thinking…' : pop.result}</pre>
          )}
          {pop.phase === 'done' && pop.notices.length > 0 && <p className="small muted">{pop.notices.join(' ')}</p>}
          {pop.phase === 'done' && pop.warnings.length > 0 && (
            <p className="small muted">Dropped: {pop.warnings.slice(0, 3).join(', ')}</p>
          )}
          {pop.phase === 'error' && (
            <p className="small error-text">
              {pop.error} {pop.errorDetails && <CopyDetails text={pop.errorDetails} />}
              {pop.connect && (
                <button className="btn ghost sm" onClick={openAiSettings}>
                  Open Settings › AI
                </button>
              )}
            </p>
          )}
          {pop.phase === 'done' && (
            <div className="row ai-pop-actions">
              <button className="btn sm mint" onClick={() => acceptSelection(false)}>
                Accept
              </button>
              <button className="btn ghost sm" onClick={() => acceptSelection(true)}>
                Insert below
              </button>
              <button className="btn ghost sm" onClick={closePop}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
