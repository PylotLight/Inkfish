import { useState } from 'react'
import { ACCENTS, THEMES, type EditMode, type FontId, type ThemeState } from '../theme'
import type { SysInfo, VaultInfo } from '../../../shared/types'

interface Props {
  prefs: ThemeState
  onChange: (next: ThemeState) => void
  vault: VaultInfo | null
  sys: SysInfo | null
  backend: string
  onClose: () => void
  onPickVault: () => void
  onRescan: () => void
  notify: (msg: string) => void
}

const FONTS: Array<{ id: FontId; name: string }> = [
  { id: 'compact', name: 'Compact' },
  { id: 'default', name: 'Default' },
  { id: 'large', name: 'Large' }
]

const MODES: Array<{ id: EditMode; name: string; hint: string }> = [
  { id: 'read', name: 'Read', hint: 'Rendered note' },
  { id: 'edit', name: 'Edit', hint: 'Markdown source' },
  { id: 'split', name: 'Split', hint: 'Side by side' }
]

/** Settings: themes, accents, reading size, editor default, window, vault. */
export default function Settings({
  prefs, onChange, vault, sys, backend, onClose, onPickVault, onRescan, notify
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<ThemeState>): void => onChange({ ...prefs, ...patch })

  const toggleBlur = (): void => {
    const next = !prefs.blur
    set({ blur: next })
    // macOS glass off/on — silent if unsupported.
    window.api.glass
      .set(next ? 'fullscreen-ui' : null)
      .catch(() => undefined)
  }

  const rescan = (): void => {
    setBusy(true)
    onRescan()
    window.setTimeout(() => setBusy(false), 800)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass strong settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="row between" style={{ marginTop: 0 }}>
          <h3>Settings</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <section>
          <h4>Theme</h4>
          <div className="swatches">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`swatch${prefs.theme === t.id ? ' sel' : ''}`}
                title={`${t.name} — ${t.blurb}`}
                onClick={() => set({ theme: t.id })}
              >
                <span className="chip" style={{ background: t.swatch }} aria-hidden />
                {t.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4>Accent</h4>
          <div className="swatches">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                className={`swatch${prefs.accent === a.id ? ' sel' : ''}`}
                title={a.name}
                onClick={() => set({ accent: a.id })}
              >
                <span className="dotpick" style={{ background: a.hex }} aria-hidden />
                {a.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4>Reading</h4>
          <div className="seg" role="group" aria-label="Reading font size">
            {FONTS.map((f) => (
              <button
                key={f.id}
                className={prefs.font === f.id ? 'on' : ''}
                onClick={() => set({ font: f.id })}
              >
                {f.name}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Default editor view" style={{ marginTop: 8 }}>
            {MODES.map((m) => (
              <button
                key={m.id}
                className={prefs.mode === m.id ? 'on' : ''}
                title={m.hint}
                onClick={() => {
                  set({ mode: m.id })
                  notify(`Editor default: ${m.name}`)
                }}
              >
                {m.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4>Window</h4>
          <label className="field row">
            <button
              className={`switch${prefs.blur ? ' on' : ''}`}
              role="switch"
              aria-checked={prefs.blur}
              aria-label="Window blur"
              onClick={toggleBlur}
            >
              <span className="knob" />
            </button>
            <span>Background blur <span className="muted small">(macOS vibrancy)</span></span>
          </label>
          <label className="field row">
            <button
              className={`switch${prefs.motion ? ' on' : ''}`}
              role="switch"
              aria-checked={prefs.motion}
              aria-label="Interface animations"
              onClick={() => set({ motion: !prefs.motion })}
            >
              <span className="knob" />
            </button>
            <span>Interface animations</span>
          </label>
        </section>

        <section>
          <h4>Notes home</h4>
          <p className="muted small" title={vault?.root ?? ''} style={{ margin: '0 0 8px', overflowWrap: 'anywhere' }}>
            {vault?.root ?? '…'}
          </p>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn ghost sm" disabled={vault?.managed} onClick={onPickVault}>
              Move notes…
            </button>
            <button className="btn ghost sm" disabled={!vault?.configured || busy} onClick={rescan}>
              {busy ? 'Scanning…' : 'Rescan vault'}
            </button>
          </div>
        </section>

        <p className="muted small" style={{ marginBottom: 0 }}>
          {sys ? `${sys.platform} · e${window.api.versions.electron()}` : '…'} · {backend}
        </p>
      </div>
    </div>
  )
}
