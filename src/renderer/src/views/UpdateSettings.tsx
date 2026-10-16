import { useEffect, useState } from 'react'
import { BREW_UPGRADE_COMMAND, type UpdateState } from '../../../shared/update-feed'

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} aria-label={label}>
      <span className="knob" />
    </button>
  )
}

function ago(ts: number | null): string {
  if (!ts) return 'never'
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours} h ago` : new Date(ts).toLocaleDateString()
}

/**
 * Settings › About & updates (ported from Surffish): current version, the latest release from the
 * GitHub releases feed with its notes, Download / brew upgrade / Skip / Remind me later, and the
 * feed settings (beta channel, custom feed URL).
 */
export default function UpdateSettings({ notify }: { notify: (msg: string) => void }): React.JSX.Element {
  const [s, setS] = useState<UpdateState | null>(null)
  const [feed, setFeed] = useState('')
  const [feedError, setFeedError] = useState<string | null>(null)

  useEffect(() => {
    window.api.updates
      .get()
      .then((state) => {
        setS(state)
        setFeed(state.feedUrl)
      })
      .catch(() => undefined)
    return window.api.updates.onChanged(setS)
  }, [])

  const saveSettings = (patch: { feedUrl?: string; betaChannel?: boolean }): void => {
    void window.api.updates.setSettings(patch).then((r) => {
      if (r.ok) {
        setS(r.state)
        setFeedError(null)
      } else setFeedError(r.error)
    })
  }

  const latest = s?.latest ?? null
  const available = s?.updateAvailable && latest

  return (
    <>
      <section className="settings-group">
        <h4>About Inkfish</h4>
        <div className="setting-row inline">
          <span className="setting-label">
            Version {s?.currentVersion ?? '…'}
            <span className="muted small setting-hint">
              {s ? `Electron ${s.engine.electron} · Chromium ${s.engine.chromium}` : '…'}
            </span>
          </span>
          <button className="btn ghost sm" disabled={s?.status === 'checking'} onClick={() => void window.api.updates.check().then(setS)}>
            {s?.status === 'checking' ? 'Checking…' : 'Check now'}
          </button>
        </div>
        <p className="muted small setting-hint" role="status">
          {s?.message ?? 'Inkfish checks for new releases about 30 seconds after launch, then every 6 hours.'}
          {s ? ` Last checked ${ago(s.lastChecked)}.` : ''}
        </p>
      </section>

      {available && latest && (
        <section className="settings-group update-available" aria-label="Update available">
          <h4>
            {latest.title || `v${latest.version}`} is out
            {s?.skippedVersion === latest.version ? ' (skipped)' : ''}
          </h4>
          <div className="row" style={{ marginTop: 0, flexWrap: 'wrap', gap: 8 }}>
            <button className="btn mint sm" onClick={() => void window.api.updates.download()}>
              Download
            </button>
            <button
              className="btn ghost sm"
              title="Copy the Homebrew command"
              onClick={() => void window.api.updates.copyBrew().then(() => notify(`Copied: ${BREW_UPGRADE_COMMAND}`))}
            >
              Copy <code>{BREW_UPGRADE_COMMAND}</code>
            </button>
            <button className="btn ghost sm" onClick={() => void window.api.updates.openRelease()}>
              Release page
            </button>
            {s?.showBadge && (
              <>
                <button className="btn ghost sm" onClick={() => void window.api.updates.remindLater().then(setS)}>
                  Remind me later
                </button>
                <button className="btn ghost sm" onClick={() => void window.api.updates.skip(latest.version).then(setS)}>
                  Skip this version
                </button>
              </>
            )}
          </div>
          {latest.notes && <pre className="update-notes">{latest.notes}</pre>}
        </section>
      )}

      <section className="settings-group">
        <h4>Update feed</h4>
        <div className="setting-row inline">
          <span className="setting-label">
            Include pre-releases
            <span className="muted small setting-hint">Also tell me about beta tags like v0.3.0-beta.1.</span>
          </span>
          <Switch on={s?.betaChannel ?? false} label="Include pre-releases" onChange={(v) => saveSettings({ betaChannel: v })} />
        </div>
        <div className="setting-row stacked">
          <span className="setting-label">Feed URL</span>
          <div className="row" style={{ marginTop: 0 }}>
            <input
              className="grow"
              type="url"
              value={feed}
              placeholder={s?.defaultFeedUrl ?? ''}
              spellCheck={false}
              aria-label="Update feed URL"
              onChange={(e) => setFeed(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveSettings({ feedUrl: feed })
              }}
            />
            <button className="btn ghost sm" disabled={!s || feed === s.feedUrl} onClick={() => saveSettings({ feedUrl: feed })}>
              Save
            </button>
          </div>
          <p className="muted small setting-hint">{feedError ?? 'Blank uses the GitHub releases feed. Any Atom releases feed works.'}</p>
        </div>
      </section>
    </>
  )
}
