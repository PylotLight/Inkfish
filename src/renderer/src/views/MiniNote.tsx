import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDoc } from '../../../shared/types'
import { MINI_WINDOW_REVEAL_ZONE, isPopKey, noteIdFromMiniHash } from '../../../shared/mini-window'
import { applyPrefs, loadPrefs } from '../theme'
import { baseName } from '../text'
import NoteEditor from './NoteEditor'
import { MINI_HINT_KEY, MINI_HINT_MS, miniHintText, shouldShowMiniHint } from '../../../shared/mini-window-tear'

type HeaderState = Awaited<ReturnType<typeof window.api.mini.state>>

const ARROWS: Record<string, string> = { left: '◂', right: '▸', up: '▴', down: '▾' }
/** Unsaved edits in a mini save themselves after this long idle (it has no Save button). */
const AUTOSAVE_MS = 1200

/** Is this the mini-window renderer (`#mini?id=…`)? */
export function isMiniWindow(): boolean {
  return typeof window !== 'undefined' && noteIdFromMiniHash(window.location.hash) !== null
}

/**
 * A note in a mini window (main/mini-window.ts): just the editor, with an auto-hiding header
 * (drag to move, tuck to edge, back to the main window, close) that shows when the pointer nears
 * the top. Edits sync live with the main window and autosave after a short pause.
 */
export default function MiniNote(): React.JSX.Element {
  const [noteId] = useState(() => noteIdFromMiniHash(window.location.hash) ?? '')
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  const [missing, setMissing] = useState(false)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [revealed, setRevealed] = useState(false)
  const [state, setState] = useState<HeaderState>(null)
  const docRef = useRef<NoteDoc | null>(null)
  docRef.current = doc
  const draftRef = useRef<string | undefined>(undefined)
  draftRef.current = draft
  const hideTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    applyPrefs(loadPrefs())
    document.documentElement.classList.add('mini-window')
    const onStorage = (): void => applyPrefs(loadPrefs())
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(() => {
    window.api.notes
      .get(noteId)
      .then((d) => {
        setDoc(d)
        setMissing(!d)
        if (d) document.title = `${baseName(d.path)} — Inkfish Mini`
      })
      .catch(() => setMissing(true))
  }, [noteId])
  useEffect(load, [load])

  const setText = useCallback((markdown: string) => {
    const saved = docRef.current?.markdown
    setDraft(markdown === saved ? undefined : markdown)
  }, [])

  // Live sync from the main window (or another mini on the same note).
  useEffect(
    () =>
      window.api.mini.onDraft(({ id, markdown }) => {
        if (id === noteId) setText(markdown)
      }),
    [noteId, setText]
  )
  useEffect(
    () =>
      window.api.mini.onSaved((saved) => {
        if (saved.id !== noteId) return
        setDoc(saved)
        if (draftRef.current === saved.markdown) setDraft(undefined)
      }),
    [noteId]
  )
  // Changed on disk (sync, another app): reload when there's nothing unsaved here.
  useEffect(() => window.api.onVaultChanged(() => (draftRef.current === undefined ? load() : undefined)), [load])

  const save = useCallback((id: string, markdown: string) => {
    window.api.notes
      .save(id, markdown)
      .then((saved) => {
        if (!saved) return
        setDoc(saved)
        if (draftRef.current === markdown) setDraft(undefined)
      })
      .catch(console.error)
  }, [])

  // Autosave after a pause, and on the way out.
  useEffect(() => {
    if (draft === undefined || !doc) return
    const t = window.setTimeout(() => save(doc.id, draft), AUTOSAVE_MS)
    return () => window.clearTimeout(t)
  }, [draft, doc, save])
  useEffect(() => {
    const flush = (): void => {
      const d = docRef.current
      if (d && draftRef.current !== undefined) void window.api.notes.save(d.id, draftRef.current)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  useEffect(() => {
    void window.api.mini.state().then(setState)
    return window.api.mini.onState(setState)
  }, [])

  // One-time hint: tucking to the edge isn't discoverable from a hidden header. Shown once ever
  // (marked seen as soon as it shows), gone after a few seconds, on ×, or once the note is tucked.
  const [hint, setHint] = useState<string | null>(null)
  const hintChecked = useRef(false)
  useEffect(() => {
    if (hintChecked.current || !state) return
    hintChecked.current = true
    let seen: string | null = null
    try {
      seen = localStorage.getItem(MINI_HINT_KEY)
    } catch {
      seen = '1'
    }
    if (!shouldShowMiniHint(seen, state)) return
    try {
      localStorage.setItem(MINI_HINT_KEY, '1')
    } catch {
      // can't remember it: still show it this once
    }
    const isMac = navigator.platform.toUpperCase().includes('MAC')
    setHint(miniHintText(null, isMac))
    window.api.mini
      .settings()
      .then((st) => setHint((h) => (h === null ? h : miniHintText(st.settings.shortcut, isMac))))
      .catch(() => undefined)
  }, [state])
  useEffect(() => {
    if (hint === null) return
    const t = window.setTimeout(() => setHint(null), MINI_HINT_MS)
    return () => window.clearTimeout(t)
  }, [hint])
  useEffect(() => {
    if (state?.docked) setHint(null)
  }, [state?.docked])

  // ⌘⇧M hands the note back to the main window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isPopKey(e)) return
      e.preventDefault()
      void backToMain()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const backToMain = async (): Promise<void> => {
    const d = docRef.current
    if (d && draftRef.current !== undefined) await window.api.notes.save(d.id, draftRef.current).catch(() => null)
    await window.api.mini.returnToMain()
  }

  const close = async (): Promise<void> => {
    const d = docRef.current
    if (d && draftRef.current !== undefined) await window.api.notes.save(d.id, draftRef.current).catch(() => null)
    await window.api.mini.close()
  }

  const reveal = (show: boolean): void => {
    window.clearTimeout(hideTimer.current)
    if (show) setRevealed(true)
    else hideTimer.current = window.setTimeout(() => setRevealed(false), 500)
  }

  const title = doc ? baseName(doc.path) : noteId

  return (
    <div
      className={`mini-shell${revealed || hint !== null ? ' revealed' : ''}`}
      onMouseMove={(e) => reveal(e.clientY <= MINI_WINDOW_REVEAL_ZONE)}
      onMouseLeave={() => reveal(false)}
    >
      <header className="mini-head" onMouseEnter={() => reveal(true)}>
        <span className="mini-title" title={doc?.path ?? noteId}>
          {title}
          {draft !== undefined && <span className="mini-dirty" aria-label="Unsaved"> •</span>}
        </span>
        <div className="mini-actions">
          {state?.tuckEnabled && state.arrow && (
            <button
              className="mini-btn"
              title={state.tucked ? 'Slide back out' : 'Tuck to screen edge'}
              aria-label={state.tucked ? 'Slide back out' : 'Tuck to screen edge'}
              onClick={() => void window.api.mini.tuck()}
            >
              {ARROWS[state.arrow] ?? '▸'}
            </button>
          )}
          <button
            className="mini-btn"
            title="Back to main window (⌘⇧M)"
            aria-label="Back to main window"
            onClick={() => void backToMain()}
          >
            ⤢
          </button>
          <button className="mini-btn" title="Close mini window" aria-label="Close mini window" onClick={() => void close()}>
            ×
          </button>
        </div>
      </header>
      {hint !== null && (
        <div className="mini-hint glass" role="status">
          <span>{hint}</span>
          <button className="mini-btn" title="Got it" aria-label="Dismiss hint" onClick={() => setHint(null)}>
            ×
          </button>
        </div>
      )}
      <div className="mini-body">
        {missing ? (
          <div className="editor-empty">
            <p className="muted">This note is gone (moved or deleted).</p>
          </div>
        ) : (
          <NoteEditor
            doc={doc}
            title={title}
            dirty={draft !== undefined}
            draft={draft}
            onDraft={(_id, md) => setText(md)}
            onDirty={() => undefined}
            onSave={save}
            onRename={() => undefined}
            onMore={() => undefined}
            compact
          />
        )}
      </div>
    </div>
  )
}
