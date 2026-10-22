import { useEffect, useState } from 'react'
import { formatAccelerator, rawAcceleratorFromKeyEvent, shortcutClash } from '../../../shared/mini-window'
import {
  SHORTCUT_NAMES,
  knownShortcutsWith,
  validateGlobalShortcut,
  type ShortcutId,
  type ShortcutState
} from '../../../shared/shortcuts'

const IS_MAC = navigator.platform.toUpperCase().includes('MAC')
/** Well-known shortcuts to warn about (1Password, Spotlight…); Inkfish's own keys are checked in main. */
const KNOWN = knownShortcutsWith({ capture: '', daily: '' })

const HINTS: Record<ShortcutId, string> = {
  capture: 'Opens the capture popover near the cursor from any app.',
  daily: 'Opens the capture popover set to append to today’s note.'
}

/**
 * One recorder field: click it and press keys. Esc cancels, Backspace / Delete (no modifiers)
 * turns the shortcut off. Refusals (no modifier, taken by another app, already one of Inkfish's
 * own) show inline and keep the old shortcut.
 */
function ShortcutField({
  id,
  state,
  onState
}: {
  id: ShortcutId
  state: ShortcutState | null
  onState: (s: ShortcutState) => void
}): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  // Leaving Settings mid-record: give the capture shortcuts back.
  useEffect(() => () => window.api.shortcuts.recording(false), [])

  const value = state?.settings[id] ?? ''
  const fallback = state?.defaults[id] ?? ''
  const pendingClash = pending ? shortcutClash(pending, IS_MAC, KNOWN) : null
  const status = !value
    ? 'Off'
    : state?.disabled
      ? 'Off for this run (INKFISH_SHORTCUTS=off)'
      : state?.registered[id]
        ? 'Active'
        : 'Not active'

  const apply = (accelerator: string): void => {
    setPending(null)
    window.api.shortcuts
      .set(id, accelerator)
      .then((r) => {
        onState(r)
        setError(r.error)
      })
      .catch((err: unknown) => setError(String(err)))
  }

  const record = (accelerator: string): void => {
    // A well-known clash (1Password's ⌘⇧Space, Spotlight…) asks first instead of silently stealing it.
    if (shortcutClash(accelerator, IS_MAC, KNOWN)) {
      setError(null)
      setPending(accelerator)
      return
    }
    apply(accelerator)
  }

  return (
    <div className="setting-row stacked">
      <span className="setting-label">
        {SHORTCUT_NAMES[id]} <span className="muted small">({status})</span>
        <span className="muted small setting-hint">
          {HINTS[id]} Click the field and press new keys; Esc cancels, ⌫ turns it off.
        </span>
      </span>
      <div className="row" style={{ marginTop: 0 }}>
        <input
          className="grow"
          type="text"
          readOnly
          value={recording ? 'Press keys…' : state ? formatAccelerator(value, IS_MAC) : '…'}
          disabled={!state}
          aria-label={`${SHORTCUT_NAMES[id]} shortcut`}
          aria-invalid={!!error}
          data-shortcut={id}
          onFocus={() => {
            setRecording(true)
            window.api.shortcuts.recording(true)
          }}
          onBlur={() => {
            setRecording(false)
            window.api.shortcuts.recording(false)
          }}
          onKeyDown={(e) => {
            const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
            if (e.key === 'Tab' && plain) return // keep keyboard navigation
            e.preventDefault()
            const input = e.target as HTMLInputElement
            if (e.key === 'Escape' && plain) return void input.blur()
            if ((e.key === 'Backspace' || e.key === 'Delete') && plain) {
              apply('')
              return void input.blur()
            }
            const raw = rawAcceleratorFromKeyEvent(e, IS_MAC)
            if (!raw) return // only modifiers down so far
            const check = validateGlobalShortcut(raw, IS_MAC)
            if (!check.ok) return void setError(check.error)
            record(check.accelerator)
            input.blur()
          }}
        />
        <button className="btn ghost sm" disabled={!value} onClick={() => apply('')}>
          Clear
        </button>
        {state && value !== fallback && (
          <button className="btn ghost sm" onClick={() => apply(fallback)}>
            Reset to default{fallback ? ` (${formatAccelerator(fallback, IS_MAC)})` : ''}
          </button>
        )}
      </div>
      {pending && (
        <p className="setting-hint warn small" role="alert">
          {formatAccelerator(pending, IS_MAC)} is used by {pendingClash}. Using it here would take it over.{' '}
          <button className="btn ghost sm" onClick={() => apply(pending)}>
            Use anyway
          </button>{' '}
          <button className="btn ghost sm" onClick={() => setPending(null)}>
            Cancel
          </button>
        </p>
      )}
      {!pending && error && (
        <p className="setting-hint warn small" role="alert" data-shortcut-error={id}>
          {error}
        </p>
      )}
      {!pending && !error && value && state && !state.disabled && !state.registered[id] && (
        <p className="setting-hint warn small">
          {state.errors[id] ?? 'Couldn’t register it — another app probably owns it.'} Pick a different one.
        </p>
      )}
    </div>
  )
}

/** Settings › Shortcuts: the global capture shortcuts (⌥Space / ⇧⌥Space by default). */
export default function ShortcutSettings(): React.JSX.Element {
  const [state, setState] = useState<ShortcutState | null>(null)

  useEffect(() => {
    window.api.shortcuts.get().then(setState).catch(console.error)
    return window.api.shortcuts.onChanged(setState)
  }, [])

  return (
    <section className="settings-group">
      <h4>Global shortcuts</h4>
      <p className="muted small setting-hint">
        These work from any app, even when Inkfish is in the background. Changes apply right away. The mini window’s
        show/hide shortcut lives in Settings › Mini window.
      </p>
      <ShortcutField id="capture" state={state} onState={setState} />
      <ShortcutField id="daily" state={state} onState={setState} />
    </section>
  )
}
