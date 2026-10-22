import { useEffect, useState } from 'react'
import {
  MINI_WINDOW_MIN_OPACITY,
  MINI_WINDOW_PEEK_DELAYS,
  acceleratorFromKeyEvent,
  formatAccelerator,
  shortcutClash,
  type MiniWindowSettings as Settings
} from '../../../shared/mini-window'
import { knownShortcutsWith, type ShortcutSettings } from '../../../shared/shortcuts'

const IS_MAC = navigator.platform.toUpperCase().includes('MAC')
const IS_LINUX = navigator.platform.toUpperCase().includes('LINUX')

type State = Awaited<ReturnType<typeof window.api.mini.settings>>

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} aria-label={label}>
      <span className="knob" />
    </button>
  )
}

/**
 * Settings › Mini window: the global show/hide shortcut (press keys to record; warns when it
 * would clash with 1Password, Spotlight or Inkfish's own keys), opacity, tuck to screen edge,
 * hover to peek (and its delay), and corner snapping.
 */
export default function MiniWindowSettings(): React.JSX.Element {
  const [state, setState] = useState<State | null>(null)
  const [recording, setRecording] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  // The capture shortcuts as configured, so a clash warning names the keys actually in use.
  const [capture, setCapture] = useState<ShortcutSettings | null>(null)

  useEffect(() => {
    window.api.mini.settings().then(setState).catch(console.error)
    window.api.shortcuts.get().then((s) => setCapture(s.settings)).catch(console.error)
  }, [])
  const known = capture ? knownShortcutsWith(capture) : undefined

  const update = (patch: Partial<Settings>): void => {
    window.api.mini.setSettings(patch).then(setState).catch(console.error)
  }

  const s = state?.settings
  const popKey = IS_MAC ? '⌘⇧M' : 'Ctrl+Shift+M'
  const shortcutLabel = s ? formatAccelerator(s.shortcut, IS_MAC) : '…'
  const pendingClash = pending ? shortcutClash(pending, IS_MAC, known) : null
  const status = !s?.shortcut
    ? 'Off'
    : state?.registered
      ? 'Active'
      : (state?.error ?? 'Not active')

  const record = (accelerator: string): void => {
    // A known clash (1Password's ⌘⇧Space, Spotlight…) asks first instead of silently stealing it.
    if (shortcutClash(accelerator, IS_MAC, known)) {
      setPending(accelerator)
      return
    }
    setPending(null)
    update({ shortcut: accelerator })
  }

  return (
    <section className="settings-group">
      <h4>Mini window</h4>
      <p className="muted small setting-hint">
        Pop a note out into a small window that floats over every app, on every Space and over full-screen apps.
        Use <b>Pop out to Mini Window</b> in a note’s ⋯ or tab menu, or press {popKey}; press {popKey} in the mini
        to send it back. Edits sync live with the main window and save automatically.
      </p>

      <div className="setting-row stacked">
        <span className="setting-label">
          Show / hide shortcut <span className="muted small">({status})</span>
          <span className="muted small setting-hint">
            Works from any app: with no mini open it pops out the note you have open, otherwise it hides or
            brings back your minis. Click the field and press new keys.
          </span>
        </span>
        <div className="row" style={{ marginTop: 0 }}>
          <input
            className="grow"
            type="text"
            readOnly
            value={recording ? 'Press keys…' : shortcutLabel}
            disabled={!s}
            aria-label="Mini window show/hide shortcut"
            onFocus={() => setRecording(true)}
            onBlur={() => setRecording(false)}
            onKeyDown={(e) => {
              e.preventDefault()
              if (e.key === 'Escape') return void (e.target as HTMLInputElement).blur()
              const acc = acceleratorFromKeyEvent(e, IS_MAC)
              if (!acc) return
              record(acc)
              ;(e.target as HTMLInputElement).blur()
            }}
          />
          <button className="btn ghost sm" disabled={!s?.shortcut} onClick={() => update({ shortcut: '' })}>
            Clear
          </button>
          {state && s?.shortcut !== state.defaults.shortcut && (
            <button className="btn ghost sm" onClick={() => update({ shortcut: state.defaults.shortcut })}>
              Default ({formatAccelerator(state.defaults.shortcut, IS_MAC)})
            </button>
          )}
        </div>
        {pending && (
          <p className="setting-hint warn small" role="alert">
            {formatAccelerator(pending, IS_MAC)} is used by {pendingClash}. Using it here would take it over.{' '}
            <button className="btn ghost sm" onClick={() => (update({ shortcut: pending }), setPending(null))}>
              Use anyway
            </button>{' '}
            <button className="btn ghost sm" onClick={() => setPending(null)}>
              Cancel
            </button>
          </p>
        )}
        {!pending && state?.clash && (
          <p className="setting-hint warn small">Heads up: this shortcut is also {state.clash}.</p>
        )}
        {!pending && s?.shortcut && state && !state.registered && (
          <p className="setting-hint warn small">
            Couldn’t register it — another app probably owns it. Pick a different one.
          </p>
        )}
      </div>

      <div className="setting-row stacked">
        <span className="setting-label">
          Opacity · {Math.round((s?.opacity ?? 1) * 100)}%
          {IS_LINUX && <span className="muted small setting-hint">Not supported on Linux.</span>}
        </span>
        <input
          type="range"
          min={MINI_WINDOW_MIN_OPACITY}
          max={1}
          step={0.05}
          value={s?.opacity ?? 1}
          disabled={!s || IS_LINUX}
          onChange={(e) => update({ opacity: Number(e.target.value) })}
          aria-label="Mini window opacity"
        />
      </div>

      <div className="setting-row inline">
        <span className="setting-label">
          Tuck to screen edge
          <span className="muted small setting-hint">
            Drag a mini against a screen edge (or use its ◂ button) and it slides away behind a small tab. Click the
            tab to slide it back; drag the tab along the edge to move it.
          </span>
        </span>
        <Switch on={s?.tuckToEdge ?? true} label="Tuck to screen edge" onChange={(v) => update({ tuckToEdge: v })} />
      </div>

      <div className="setting-row inline">
        <span className="setting-label">
          Peek on hover
          <span className="muted small setting-hint">Rest the pointer on a tucked tab to peek the note out until you move away.</span>
        </span>
        <Switch on={s?.peekOnHover ?? true} label="Peek on hover" onChange={(v) => update({ peekOnHover: v })} />
      </div>

      {s?.peekOnHover && s.tuckToEdge && (
        <div className="setting-row stacked">
          <span className="setting-label">Hover delay</span>
          <div className="seg-row" role="radiogroup" aria-label="Hover delay">
            {MINI_WINDOW_PEEK_DELAYS.map((ms) => (
              <button
                key={ms}
                role="radio"
                aria-checked={s.peekDelayMs === ms}
                className={`seg${s.peekDelayMs === ms ? ' selected' : ''}`}
                onClick={() => update({ peekDelayMs: ms })}
              >
                {ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="setting-row inline">
        <span className="setting-label">
          Snap to corners
          <span className="muted small setting-hint">Dropped near a screen corner, a mini settles neatly into it.</span>
        </span>
        <Switch on={s?.snapToCorners ?? true} label="Snap to corners" onChange={(v) => update({ snapToCorners: v })} />
      </div>
    </section>
  )
}
