import { useEffect, useState } from 'react'
import { DEFAULT_ROUTING_PREFS, type RoutingPrefs } from '../../../shared/routing'
import type { Project } from '../../../shared/types'

/**
 * Settings › Routing: how captures get filed. The router reads your vault (notes, tags) to pick a
 * folder or a related note to add to; nothing is keyed to folder names. Unsure captures wait in the
 * inbox unless you pick a default folder.
 */
export default function RoutingSettings(): React.JSX.Element {
  const [prefs, setPrefs] = useState<RoutingPrefs | null>(null)
  const [folders, setFolders] = useState<Project[]>([])

  useEffect(() => {
    window.api.routing.prefs().then(setPrefs).catch(console.error)
    window.api.projects.list().then(setFolders).catch(console.error)
  }, [])

  const update = (patch: Partial<RoutingPrefs>): void => {
    if (!prefs) return
    setPrefs({ ...prefs, ...patch })
    window.api.routing.setPrefs(patch).then(setPrefs).catch(console.error)
  }

  if (!prefs) return <section className="settings-group" />

  const folderSelect = (
    value: string,
    onChange: (v: string) => void,
    none: string,
    label: string
  ): React.JSX.Element => (
    <select className="sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{none}</option>
      {value && !folders.some((f) => f.dir === value) && <option value={value}>{value}</option>}
      {folders.map((f) => (
        <option key={f.id} value={f.dir}>
          {f.name}
        </option>
      ))}
    </select>
  )

  const toggle = (
    key: 'autoFile' | 'allowAppend' | 'appendToMeetings' | 'useAiProvider',
    label: string,
    disabled = false
  ): React.JSX.Element => (
    <button
      role="switch"
      aria-checked={prefs[key]}
      disabled={disabled}
      className={`switch${prefs[key] ? ' on' : ''}`}
      onClick={() => update({ [key]: !prefs[key] })}
      aria-label={label}
    >
      <span className="knob" />
    </button>
  )

  return (
    <section className="settings-group">
      <h4>Routing</h4>
      <div className="setting-row inline">
        <div className="setting-label">
          File captures automatically
          <span className="muted small setting-hint">
            Off: Inkfish only suggests a spot and the capture waits in the inbox until you hit File.
          </span>
        </div>
        {toggle('autoFile', 'File captures automatically')}
      </div>

      <div className="setting-row inline">
        <div className="setting-label">
          When it isn't sure
          <span className="muted small setting-hint">
            Captures that don't clearly match a folder stay in the inbox, or go to this folder.
          </span>
        </div>
        {folderSelect(prefs.defaultFolder, (v) => update({ defaultFolder: v }), 'Keep in inbox', 'Default folder')}
      </div>

      <div className="setting-row inline">
        <div className="setting-label">
          Add to related notes
          <span className="muted small setting-hint">
            A capture that clearly continues an existing note is added to it as a dated section. Undo removes just that
            section.
          </span>
        </div>
        {toggle('allowAppend', 'Add to related notes')}
      </div>

      <div className="setting-row stacked">
        <span className="setting-label">How close a match to add to a note</span>
        <div className="font-slider-row">
          <button
            className="btn ghost sm"
            title="Reset to default"
            disabled={!prefs.allowAppend}
            onClick={() => update({ appendThreshold: DEFAULT_ROUTING_PREFS.appendThreshold })}
            aria-label="Reset append match"
          >
            ↺
          </button>
          <span className="font-size-num" aria-live="polite">
            {Math.round(prefs.appendThreshold * 100)}%
          </span>
          <input
            type="range"
            min={0.4}
            max={0.95}
            step={0.05}
            value={prefs.appendThreshold}
            disabled={!prefs.allowAppend}
            onChange={(e) => update({ appendThreshold: Number(e.target.value) })}
            aria-label="Append match threshold"
          />
        </div>
        <p className="muted small setting-hint">Higher means fewer appends and more new notes.</p>
      </div>

      <div className="setting-row inline">
        <div className="setting-label">
          Allow adding to meeting and daily notes
          <span className="muted small setting-hint">Off keeps transcripts and day logs as they were written.</span>
        </div>
        {toggle('appendToMeetings', 'Allow adding to meeting and daily notes', !prefs.allowAppend)}
      </div>

      <div className="setting-row inline">
        <div className="setting-label">
          Meetings folder
          <span className="muted small setting-hint">
            Where live meetings are saved and imported transcripts filed. Not set: wherever your meeting notes already
            are, else the vault root, until you pick one when saving a meeting.
          </span>
        </div>
        {folderSelect(prefs.meetingsFolder, (v) => update({ meetingsFolder: v }), 'Not set', 'Meetings folder')}
      </div>

      <div className="setting-row inline">
        <div className="setting-label">
          Ask the AI provider
          <span className="muted small setting-hint">
            When an AI provider is connected, it picks between the folders and notes Inkfish found. The capture and a
            few note snippets are sent to it.
          </span>
        </div>
        {toggle('useAiProvider', 'Ask the AI provider')}
      </div>
    </section>
  )
}
