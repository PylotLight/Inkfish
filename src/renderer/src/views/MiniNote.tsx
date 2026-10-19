import { useCallback, useEffect, useRef, useState } from 'react'
import { createAutosave, type Autosave } from '../../../shared/autosave'
import type { NoteDoc } from '../../../shared/types'
import { MINI_WINDOW_REVEAL_ZONE, isPopKey, miniHash, noteIdFromMiniHash } from '../../../shared/mini-window'
import { applyPrefs, loadPrefs } from '../theme'
import { baseName } from '../text'
import { dailyTitleForPath } from '../../../shared/daily'
import NoteEditor from './NoteEditor'
import { MINI_HINT_KEY, MINI_HINT_MS, miniHintText, shouldShowMiniHint } from '../../../shared/mini-window-tear'

type HeaderState = Awaited<ReturnType<typeof window.api.mini.state>>

const ARROWS: Record<string, string> = { left: '◂', right: '▸', up: '▴', down: '▾' }

/** Is this the mini-window renderer (`#mini?id=…`)? */
export function isMiniWindow(): boolean {
  return typeof window !== 'undefined' && noteIdFromMiniHash(window.location.hash) !== null
}

/**
 * A note in a mini window (main/mini-window.ts): just the editor, with an auto-hiding header
 * (drag to move, tuck to edge, back to the main window, close) that shows when the pointer nears
 * the top. Edits sync live with the main window and autosave after a short pause. Only the window
 * that made an edit saves it — text relayed from another window is shown, never re-saved here, so
 * two windows never race each other's writes.
 */
export default function MiniNote(): React.JSX.Element {
  const [noteId, setNoteId] = useState(() => noteIdFromMiniHash(window.location.hash) ?? '')
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
        if (d) document.title = `${dailyTitleForPath(d.path) ?? baseName(d.path)} — Inkfish Mini`
      })
      .catch(() => setMissing(true))
  }, [noteId])
  useEffect(load, [load])

  const autosaveRef = useRef<Autosave | null>(null)
  if (!autosaveRef.current) {
    autosaveRef.current = createAutosave<NoteDoc>({
      save: (id, markdown) => window.api.notes.save(id, markdown),
      onSaved: (_id, markdown, saved) => {
        setDoc(saved)
        if (draftRef.current === markdown) setDraft(undefined)
      },
      onError: (id, err) => console.error(`[mini] autosave failed for ${id}:`, err)
    })
  }
  const autosave = autosaveRef.current

  const setText = useCallback((markdown: string) => {
    const saved = docRef.current?.markdown
    setDraft(markdown === saved ? undefined : markdown)
  }, [])

  /** Typed here: show + autosave. */
  const localEdit = useCallback(
    (id: string, markdown: string) => {
      setText(markdown)
      autosave.schedule(id, markdown)
    },
    [autosave, setText]
  )

  // Live sync from the main window (or another mini on the same note): the sender owns the
  // save, so drop any older pending text of ours instead of writing it over theirs.
  useEffect(
    () =>
      window.api.mini.onDraft(({ id, markdown }) => {
        if (id !== noteId) return
        autosave.cancel(id)
        setText(markdown)
      }),
    [noteId, setText, autosave]
  )
  useEffect(
    () =>
      window.api.mini.onSaved((saved) => {
        if (saved.id !== noteId) return
        autosave.noteSaved(saved.id, saved.markdown)
        setDoc(saved)
        if (draftRef.current === saved.markdown) setDraft(undefined)
      }),
    [noteId, autosave]
  )
  // Moved/renamed in the main window (ids are paths): follow the note to its new id. `load`
  // re-reads it from the new id; pending text rides along with the rename.
  useEffect(
    () =>
      window.api.mini.onNoteMoved(({ from, to }) => {
        if (from !== noteId) return
        autosave.rename(from, to)
        try {
          window.history.replaceState(null, '', `#${miniHash(to)}`)
        } catch {
          // cosmetic only
        }
        setNoteId(to)
      }),
    [noteId, autosave]
  )
  // Changed on disk (sync, another app): reload when there's nothing unsaved here.
  useEffect(() => window.api.onVaultChanged(() => (draftRef.current === undefined ? load() : undefined)), [load])

  useEffect(() => {
    if (doc) autosave.noteSaved(doc.id, doc.markdown)
  }, [doc, autosave])

  // Flush on blur / hide / quit; synchronous last chance when the window unloads.
  useEffect(() => {
    const flush = (): void => void autosave.flushAll()
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    const onUnload = (): void => {
      const items = autosave.drain()
      if (items.length > 0) window.api.notes.saveSync(items)
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onUnload)
    const offFlush = window.api.onFlushRequest(() => autosave.flushAll())
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onUnload)
      offFlush()
    }
  }, [autosave])

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
    await autosave.flushAll()
    await window.api.mini.returnToMain()
  }

  const close = async (): Promise<void> => {
    await autosave.flushAll()
    await window.api.mini.close()
  }

  const reveal = (show: boolean): void => {
    window.clearTimeout(hideTimer.current)
    if (show) setRevealed(true)
    else hideTimer.current = window.setTimeout(() => setRevealed(false), 500)
  }

  const title = doc ? dailyTitleForPath(doc.path) ?? baseName(doc.path) : noteId

  return (
    <div
      className={`mini-shell${revealed || hint !== null ? ' revealed' : ''}`}
      onMouseMove={(e) => reveal(e.clientY <= MINI_WINDOW_REVEAL_ZONE)}
      onMouseLeave={() => reveal(false)}
    >
      <header className="mini-head" onMouseEnter={() => reveal(true)}>
        <span className="mini-title" title={doc?.path ?? noteId}>
          {title}
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
            draft={draft}
            onDraft={localEdit}
            onFlush={() => void autosave.flushAll()}
            onRename={() => undefined}
            onMore={() => undefined}
            compact
          />
        )}
      </div>
    </div>
  )
}
