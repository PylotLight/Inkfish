import { ACCENTS, DEFAULT_PREFS, THEMES, type DensityId, type EditMode, type Prefs } from '../theme'
import type { SysInfo, VaultInfo } from '../../../shared/types'
import AudioSettings from './AudioSettings'
import TranscriptionSettings from './TranscriptionSettings'

interface Props {
  prefs: Prefs
  vibrancySupported: boolean
  vault: VaultInfo | null
  sys: SysInfo | null
  backend: string
  onChange: (prefs: Prefs) => void
  onBack: () => void
  onPickVault: () => void
  onRescan: () => void
  notify: (msg: string) => void
}

const MODES: Array<{ id: EditMode; name: string; hint: string }> = [
  { id: 'live', name: 'Live', hint: 'Rendered note, click any block to edit.' },
  { id: 'raw', name: 'Raw', hint: 'Markdown source.' }
]

const TEXT_FONTS = [
  'SF Pro Text',
  'Inter',
  'Helvetica Neue',
  'Helvetica',
  'Arial',
  'Verdana',
  'Trebuchet MS',
  'Gill Sans',
  'Avenir Next',
  'Georgia',
  'Palatino',
  'Charter',
  'Times New Roman',
  'Optima',
  'Noto Sans'
]

const MONO_FONTS = [
  'SF Mono',
  'Menlo',
  'Consolas',
  'Cascadia Code',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'Roboto Mono',
  'Andale Mono',
  'Courier New'
]

function FontSelect({
  label, hint, value, options, sample, mono, placeholder, onChange
}: {
  label: string
  hint: string
  value: string
  options: string[]
  /** Sample text rendered in the candidate font for live preview. */
  sample: string
  mono?: boolean
  placeholder: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const isCustom = value !== '' && !options.includes(value)
  const selectValue = isCustom ? '__custom__' : value
  return (
    <div className="setting-row stacked">
      <span className="setting-label">{label}</span>
      <div className="row" style={{ marginTop: 0 }}>
        <select
          className="grow"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value
            if (v !== '__custom__') onChange(v)
          }}
          aria-label={label}
        >
          <option value="">{placeholder}</option>
          {options.map((f) => (
            <option key={f} value={f} style={{ fontFamily: `'${f}', sans-serif` }}>
              {f}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {value !== '' && (
          <button className="btn ghost sm" onClick={() => onChange('')} title="Reset to system default">
            ↺
          </button>
        )}
      </div>
      {isCustom && (
        <div className="row" style={{ marginTop: 8 }}>
          <input
            className="grow"
            type="text"
            value={value}
            placeholder="Custom font stack, e.g. 'Iowan Old Style', serif"
            onChange={(e) => onChange(e.target.value)}
            aria-label={`${label} (custom)`}
            spellCheck={false}
          />
        </div>
      )}
      <p
        className="font-preview"
        style={value ? { fontFamily: mono ? `'${value}', monospace` : `'${value}', sans-serif` } : undefined}
        aria-hidden
      >
        {sample}
      </p>
      <p className="muted small setting-hint">{hint}</p>
    </div>
  )
}

/**
 * Full-page settings view (not a modal) — same shape as Blobfish:
 * grouped sections, seg-row radios, hint lines, Back/Done.
 */
export default function SettingsView({
  prefs, vibrancySupported, vault, sys, backend, onChange, onBack, onPickVault, onRescan, notify
}: Props): React.JSX.Element {
  const set = (patch: Partial<Prefs>): void => {
    const next = { ...prefs, ...patch }
    onChange(next)
    // macOS glass follows the blur switch immediately.
    if (patch.blur !== undefined) {
      window.api.glass.set(patch.blur ? 'fullscreen-ui' : null).catch(() => undefined)
    }
  }

  return (
    <section className="card settings-page fade-in" aria-label="Settings">
      <div className="row between settings-top">
        <div>
          <span className="eyebrow">Inkfish</span>
          <h2 className="settings-title">Settings</h2>
          <p className="muted small settings-sub">
            Stored locally in this app — nothing leaves your machine.
          </p>
        </div>
        <button className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="settings-groups">
        <section className="settings-group">
          <h4>Appearance</h4>

          <div className="setting-row stacked">
            <span className="setting-label">Theme</span>
            <div className="seg-row" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={prefs.theme === t.id}
                  className={`seg${prefs.theme === t.id ? ' selected' : ''}`}
                  onClick={() => set({ theme: t.id })}
                  title={t.blurb}
                >
                  <span className="swatch theme-chip" style={{ background: t.swatch }} aria-hidden />
                  {t.name}
                </button>
              ))}
            </div>
            <p className="muted small setting-hint">
              {THEMES.find((t) => t.id === prefs.theme)?.blurb} Accent applies on top.
            </p>
          </div>

          <div className="setting-row stacked">
            <span className="setting-label">Accent color</span>
            <div className="seg-row" role="radiogroup" aria-label="Accent color">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={prefs.accent === a.id}
                  className={`seg${prefs.accent === a.id ? ' selected' : ''}`}
                  onClick={() => set({ accent: a.id })}
                  title={a.desc}
                >
                  <span className="swatch accent-chip" style={{ background: a.hex }} aria-hidden />
                  {a.name}
                </button>
              ))}
              <button
                role="radio"
                aria-checked={prefs.accent === 'custom'}
                className={`seg${prefs.accent === 'custom' ? ' selected' : ''}`}
                onClick={() => set({ accent: 'custom' })}
                title="Pick any color below."
              >
                <span className="swatch accent-chip" style={{ background: prefs.customAccent }} aria-hidden />
                Custom
              </button>
            </div>
            {prefs.accent === 'custom' && (
              <label className="custom-picker-row">
                <span>
                  Custom color <code>{prefs.customAccent}</code>
                </span>
                <input
                  type="color"
                  className="color-input"
                  value={prefs.customAccent}
                  onChange={(e) => set({ accent: 'custom', customAccent: e.target.value })}
                  aria-label="Pick a custom accent color"
                />
              </label>
            )}
            <p className="muted small setting-hint">
              Drives buttons, chips, selection and focus rings.
            </p>
          </div>

          <div className="setting-row inline">
            <div className="setting-label">
              Density
              <span className="muted small setting-hint">Comfortable breathes; compact fits more rows.</span>
            </div>
            <div className="seg-row" role="radiogroup" aria-label="Density">
              {(['comfortable', 'compact'] as DensityId[]).map((d) => (
                <button
                  key={d}
                  role="radio"
                  aria-checked={prefs.density === d}
                  className={`seg${prefs.density === d ? ' selected' : ''}`}
                  onClick={() => set({ density: d })}
                >
                  {d === 'comfortable' ? 'Comfortable' : 'Compact'}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row inline">
            <div className="setting-label">
              Motion
              <span className="muted small setting-hint">Reduced disables entrance and pulse animations.</span>
            </div>
            <div className="seg-row" role="radiogroup" aria-label="Motion">
              {(['full', 'reduced'] as Array<Prefs['motion']>).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={prefs.motion === m}
                  className={`seg${prefs.motion === m ? ' selected' : ''}`}
                  onClick={() => set({ motion: m })}
                >
                  {m === 'full' ? 'Full' : 'Reduced'}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-group">
          <h4>Font</h4>
          <FontSelect
            label="Interface font"
            hint="Base font for all of Inkfish. Empty = system default."
            value={prefs.interfaceFont}
            options={TEXT_FONTS}
            sample="AaBbCc 123 — interface preview"
            placeholder="System default"
            onChange={(v) => set({ interfaceFont: v })}
          />
          <FontSelect
            label="Text font"
            hint="Font for editing and reading views."
            value={prefs.textFont}
            options={TEXT_FONTS}
            sample="AaBbCc 123 — the quick brown fox jumps"
            placeholder="System default"
            onChange={(v) => set({ textFont: v })}
          />
          <FontSelect
            label="Monospace font"
            hint="Font for code blocks and editor source."
            value={prefs.monoFont}
            options={MONO_FONTS}
            sample="const inkfish = 42; // mono preview"
            mono
            placeholder="System monospace"
            onChange={(v) => set({ monoFont: v })}
          />

          <div className="setting-row stacked">
            <span className="setting-label">Font size</span>
            <div className="font-slider-row">
              <button
                className="btn ghost sm"
                title="Reset to default"
                onClick={() => set({ fontSize: DEFAULT_PREFS.fontSize })}
                aria-label="Reset font size"
              >
                ↺
              </button>
              <span className="font-size-num" aria-live="polite">{prefs.fontSize}</span>
              <input
                type="range"
                min={11}
                max={28}
                step={1}
                value={prefs.fontSize}
                onChange={(e) => set({ fontSize: Number(e.target.value) })}
                aria-label="Font size in pixels"
              />
            </div>
            <p className="muted small setting-hint">Font size in pixels that affects editing and reading views. UI chrome stays the same.</p>
          </div>

          <div className="setting-row inline">
            <div className="setting-label">
              Quick font size adjustment
              <span className="muted small setting-hint">Adjust the font size using Ctrl + Scroll, or using the trackpad pinch-zoom gesture.</span>
            </div>
            <button
              role="switch"
              aria-checked={prefs.quickZoom}
              className={`switch${prefs.quickZoom ? ' on' : ''}`}
              onClick={() => set({ quickZoom: !prefs.quickZoom })}
              aria-label="Quick font size adjustment"
            >
              <span className="knob" />
            </button>
          </div>

          <div className="setting-row stacked">
            <span className="setting-label">Default note view</span>
            <div className="seg-row" role="radiogroup" aria-label="Default note view">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={prefs.mode === m.id}
                  className={`seg${prefs.mode === m.id ? ' selected' : ''}`}
                  onClick={() => {
                    set({ mode: m.id })
                    notify(`Editor default: ${m.name}`)
                  }}
                  title={m.hint}
                >
                  {m.name}
                </button>
              ))}
            </div>
            <p className="muted small setting-hint">Live renders the note — click any block to edit. Raw shows markdown source.</p>
          </div>
        </section>

        <section className="settings-group">
          <h4>Window</h4>
          <div className="setting-row inline">
            <div className="setting-label">
              Native vibrancy blur {vibrancySupported ? '(macOS)' : ''}
              {!vibrancySupported && (
                <span className="muted small setting-hint">Only available on macOS.</span>
              )}
            </div>
            <button
              role="switch"
              aria-checked={prefs.blur}
              className={`switch${prefs.blur ? ' on' : ''}`}
              disabled={!vibrancySupported}
              onClick={() => set({ blur: !prefs.blur })}
              aria-label="Window blur"
            >
              <span className="knob" />
            </button>
          </div>
        </section>

        <AudioSettings />

        <TranscriptionSettings />

        <section className="settings-group">
          <h4>Notes home</h4>
          <div className="setting-row stacked">
            <span className="setting-label">Location</span>
            <p className="muted small setting-hint" title={vault?.root ?? ''} style={{ overflowWrap: 'anywhere' }}>
              {vault?.root ?? '…'}
            </p>
            <div className="row" style={{ marginTop: 0 }}>
              <button className="btn ghost sm" disabled={vault?.managed} onClick={onPickVault}>
                Move notes…
              </button>
              <button
                className="btn ghost sm"
                disabled={!vault?.configured}
                onClick={onRescan}
              >
                Rescan vault
              </button>
            </div>
          </div>
        </section>
      </div>

      <div className="row between">
        <span className="muted small">
          {sys ? `${sys.platform} · e${window.api.versions.electron()}` : '…'} · {backend}
        </span>
        <button className="btn mint" onClick={onBack}>
          Done
        </button>
      </div>
    </section>
  )
}
