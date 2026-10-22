import { useCallback, useEffect, useState } from 'react'
import {
  autoPick,
  describeSource,
  isPicked,
  loadPrefs,
  pickerRows,
  savePrefs,
  toggleApp,
  type AudioApp,
  type SystemAudioPrefs
} from '../../../shared/systemAudio'

const store = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)

/**
 * "System audio source" for meetings (macOS 14.2+ only; renders nothing
 * elsewhere): all system audio (default, optionally narrowed to a meeting app
 * that's playing), or just the apps you tick — e.g. Teams, so the music you
 * have on in Spotify stays out of the transcript. The choice is remembered
 * and used by every meeting start (here and in quick capture).
 */
export default function SystemAudioPicker({ disabled }: { disabled?: boolean }): React.JSX.Element | null {
  const [supported, setSupported] = useState(false)
  const [prefs, setPrefs] = useState<SystemAudioPrefs>(() => loadPrefs(store()))
  const [apps, setApps] = useState<AudioApp[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    window.api.systap
      .supported()
      .then((s) => live && setSupported(s))
      .catch(() => live && setSupported(false))
    return () => {
      live = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const r = await window.api.systap.apps()
      if ('error' in r) {
        setError(r.error)
        setApps([])
      } else {
        setError('')
        setApps(r)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Load once (for the auto-pick preview), then keep fresh while the list is open.
  useEffect(() => {
    if (!supported) return
    void refresh()
    if (!open || disabled) return
    const id = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(id)
  }, [supported, open, disabled, refresh])

  if (!supported) return null

  const update = (next: SystemAudioPrefs): void => {
    setPrefs(next)
    savePrefs(store(), next)
  }

  const preview = prefs.source.mode === 'all' && prefs.autoPick ? autoPick(apps) : null
  const summary =
    prefs.source.mode === 'apps'
      ? describeSource(prefs.source)
      : preview
        ? `Auto: ${describeSource({ mode: 'apps', apps: preview })}`
        : 'All system audio'
  const rows = pickerRows(apps, prefs.source)

  return (
    <div className="meet-src" aria-label="System audio source">
      <div className="row meet-src-head">
        <span className="muted small">Call audio from</span>
        <button
          className="btn ghost sm meet-src-btn"
          onClick={() => setOpen(!open)}
          disabled={disabled}
          aria-expanded={open}
          title={disabled ? 'Change before starting the meeting' : 'Choose which apps count as the call'}
        >
          {summary} <span aria-hidden>{open ? '▴' : '▾'}</span>
        </button>
        {open && !disabled && (
          <button className="btn ghost sm" onClick={() => void refresh()} disabled={loading} title="Refresh app list">
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        )}
      </div>

      {open && !disabled && (
        <div className="meet-src-list">
          <label className="meet-src-row">
            <input
              type="radio"
              name="meet-src"
              checked={prefs.source.mode === 'all'}
              onChange={() => update({ ...prefs, source: { mode: 'all' } })}
            />
            <span className="meet-src-name">All system audio</span>
            <span className="muted small">everything this Mac plays</span>
          </label>
          {prefs.source.mode === 'all' && (
            <label className="meet-src-row sub">
              <input
                type="checkbox"
                checked={prefs.autoPick}
                onChange={(e) => update({ ...prefs, autoPick: e.target.checked })}
              />
              <span className="small">
                Auto-pick a meeting app if it&apos;s playing (Teams, Zoom, Webex, Slack, FaceTime; else Meet in a
                browser)
                {preview && <b> — now: {describeSource({ mode: 'apps', apps: preview })}</b>}
              </span>
            </label>
          )}

          <div className="muted small meet-src-sep">Only these apps</div>
          {error && <p className="muted small">{error}</p>}
          {!error && rows.length === 0 && (
            <p className="muted small">{loading ? 'Looking for apps…' : 'No apps using audio right now.'}</p>
          )}
          {rows.map((a) => (
            <label key={a.id} className={`meet-src-row${a.outputting ? ' playing' : ''}`} title={a.id}>
              <input
                type="checkbox"
                checked={isPicked(prefs.source, a.id)}
                onChange={() => update({ ...prefs, source: toggleApp(prefs.source, { id: a.id, name: a.name }) })}
              />
              {a.icon ? (
                <img className="meet-src-icon" src={a.icon} alt="" />
              ) : (
                <span className="meet-src-icon blank" aria-hidden />
              )}
              <span className="meet-src-name">{a.name}</span>
              {a.outputting ? (
                <span className="meet-src-tag on">playing</span>
              ) : a.pids.length === 0 ? (
                <span className="meet-src-tag">not running</span>
              ) : null}
              {a.kind === 'meeting' && <span className="meet-src-tag">meeting</span>}
              {a.kind === 'browser' && <span className="meet-src-tag">browser</span>}
            </label>
          ))}
          <p className="muted small meet-src-foot">
            Picked apps are followed if they restart; until one plays, the call side records silence. Needs System Audio
            Recording permission for Inkfish.
          </p>
        </div>
      )}
    </div>
  )
}
