import { useEffect, useState } from 'react'
import type { MenuBarClick, MenuBarSettings as Settings } from '../../../shared/menubar'

const CLICKS: Array<{ id: MenuBarClick; label: string; hint: string }> = [
  { id: 'capture', label: 'Quick capture', hint: 'The capture popover drops out under the icon (same as ⌥Space).' },
  { id: 'today', label: 'Append to today', hint: 'The capture popover, set to append to today’s note (same as ⇧⌥Space).' },
  { id: 'window', label: 'Inkfish window', hint: 'Shows the main window; click again while it’s in front to hide it.' }
]

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      className={`switch${on ? ' on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-label={label}
    >
      <span className="knob" />
    </button>
  )
}

/**
 * Settings › Appearance › Menu bar: show/hide the menu bar (tray) icon, what clicking it opens, and
 * on macOS menu-bar-only mode (no Dock icon). Right-click on the icon always has the full menu.
 */
export default function MenuBarSettings(): React.JSX.Element {
  const [s, setS] = useState<Settings | null>(null)
  const [platform, setPlatform] = useState('')

  useEffect(() => {
    window.api.menubar
      .settings()
      .then((r) => {
        setS(r.settings)
        setPlatform(r.platform)
      })
      .catch(console.error)
    return window.api.menubar.onChanged(setS)
  }, [])

  const update = (patch: Partial<Settings>): void => {
    window.api.menubar.set(patch).then(setS).catch(console.error)
  }

  const isMac = platform === 'darwin'
  const where = isMac ? 'menu bar' : 'system tray'
  const click = CLICKS.find((c) => c.id === (s?.click ?? 'capture'))

  return (
    <section className="settings-group">
      <h4>Menu bar</h4>

      <div className="setting-row inline">
        <span className="setting-label">
          Show {where} icon
          <span className="muted small setting-hint">
            Off: reach Inkfish with ⌥Space / ⇧⌥Space{isMac ? ' and the Dock' : ''} only.
          </span>
        </span>
        <Switch on={s?.showIcon ?? true} label={`Show ${where} icon`} disabled={!s} onChange={(v) => update({ showIcon: v })} />
      </div>

      <div className="setting-row stacked">
        <span className="setting-label">Clicking the icon opens</span>
        <div className="seg-row" role="radiogroup" aria-label="Clicking the menu bar icon opens">
          {CLICKS.map((c) => (
            <button
              key={c.id}
              role="radio"
              aria-checked={s?.click === c.id}
              className={`seg${s?.click === c.id ? ' selected' : ''}`}
              disabled={!s?.showIcon}
              onClick={() => update({ click: c.id })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="muted small setting-hint">{click?.hint} Right-click the icon for the full menu.</p>
      </div>

      {s?.click === 'window' && (
        <div className="setting-row inline">
          <span className="setting-label">
            Drop the window under the icon
            <span className="muted small setting-hint">Like a popover: the window opens anchored below the {where} icon.</span>
          </span>
          <Switch on={s.anchorWindow} label="Drop the window under the icon" disabled={!s.showIcon} onChange={(v) => update({ anchorWindow: v })} />
        </div>
      )}

      {isMac && (
        <div className="setting-row inline">
          <span className="setting-label">
            Menu bar only (hide Dock icon)
            <span className="muted small setting-hint">
              {s?.showIcon
                ? 'Inkfish leaves the Dock and ⌘Tab and runs from the menu bar. Undo here or from the icon’s right-click menu.'
                : 'Needs the menu bar icon, so there’s always a way back in.'}
            </span>
          </span>
          <Switch
            on={s?.hideDock ?? false}
            label="Menu bar only (hide Dock icon)"
            disabled={!s?.showIcon}
            onChange={(v) => update({ hideDock: v })}
          />
        </div>
      )}
    </section>
  )
}
