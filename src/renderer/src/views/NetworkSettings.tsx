import { useEffect, useState } from 'react'
import type { ProxySettings } from '../../../shared/proxy-settings'

const initial: ProxySettings = {
  primary: { enabled: false, host: '127.0.0.1', port: 1080, bypassLocalNetwork: true },
  proxies: [],
  rules: [],
  killSwitch: false
}

export function NetworkSettings(): React.JSX.Element {
  const [value, setValue] = useState<ProxySettings>(initial)
  const [saved, setSaved] = useState<ProxySettings>(initial)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  useEffect(() => {
    let live = true
    void window.api.proxy
      .get()
      .then((settings) => {
        if (live) {
          setValue(settings)
          setSaved(settings)
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setLoadFailed(true)
          setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
        }
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [])

  const patch = (next: Partial<ProxySettings>): void => {
    setValue((current) => ({ ...current, ...next }))
    setMessage(null)
  }
  const changed = JSON.stringify(value) !== JSON.stringify(saved)
  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage({ text: 'Saving proxy settings…' })
    try {
      const result = await window.api.proxy.set({
        ...value,
        primary: { ...value.primary, port: Number(value.primary.port) },
        proxies: value.proxies.map((p) => ({ ...p, port: Number(p.port) }))
      })
      setValue(result)
      setSaved(result)
      setMessage({ text: 'Proxy settings saved. Existing connections were closed; new operations use these settings.' })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }
  const test = async (): Promise<void> => {
    setBusy(true)
    setMessage({ text: 'Testing TCP reachability…' })
    try {
      const result = await window.api.proxy.test(value)
      setMessage({
        text: `${result.reachable ? 'Reachable' : 'Not reachable'}: ${result.message}${result.reachable ? ' (TCP port check only; this does not verify SSH tunnel connectivity.)' : ''}`,
        error: !result.reachable
      })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBusy(false)
    }
  }
  const setPrimary = (patchValue: Partial<ProxySettings['primary']>): void =>
    patch({ primary: { ...value.primary, ...patchValue } })

  return (
    <section className="settings-group network-settings">
      <h4>SOCKS5 proxy</h4>
      <p className="muted small">
        Routes in-app web model downloads and benchmark clips in Inkfish—not links opened externally or OS-managed
        services. Only loopback proxy hosts are supported. Saving changes closes existing connections.
      </p>
      <p className="muted small">
        <strong>Native model downloads:</strong> FluidAudio cannot safely follow these routes, so native downloads are
        blocked while any proxy route is active. Existing native downloads pause when settings change. Downloaded models
        and offline transcription still work. Phone LAN sync stays direct.
      </p>
      {loading ? (
        <p className="muted small">Loading proxy settings…</p>
      ) : loadFailed ? (
        <p role="alert">Could not load proxy settings: {message?.text}. Reopen Settings to retry.</p>
      ) : (
        <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <div className="setting-row inline">
            <div className="setting-label">Use SOCKS5 proxy</div>
            <button
              type="button"
              role="switch"
              aria-label="Use SOCKS5 proxy"
              aria-checked={value.primary.enabled}
              className={`switch${value.primary.enabled ? ' on' : ''}`}
              onClick={() => setPrimary({ enabled: !value.primary.enabled })}
            >
              <span className="knob" />
            </button>
          </div>
          <div className="network-proxy-row">
            <label>
              Host
              <input
                value={value.primary.host}
                placeholder="127.0.0.1"
                onChange={(e) => setPrimary({ host: e.target.value })}
              />
            </label>
            <label>
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={value.primary.port}
                onChange={(e) => setPrimary({ port: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="network-check">
            <input
              type="checkbox"
              checked={value.primary.bypassLocalNetwork}
              onChange={(e) => setPrimary({ bypassLocalNetwork: e.target.checked })}
            />{' '}
            Bypass proxy for local network addresses
          </label>
          <div className="setting-row inline">
            <div className="setting-label">
              Kill switch
              <span className="muted small setting-hint">
                Block proxied operations if the SOCKS5 proxy is unavailable.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Proxy kill switch"
              aria-checked={value.killSwitch}
              className={`switch${value.killSwitch ? ' on' : ''}`}
              onClick={() => patch({ killSwitch: !value.killSwitch })}
            >
              <span className="knob" />
            </button>
          </div>
          <p className="muted small">
            For example, start a local SSH SOCKS tunnel with <code>ssh -N -D 127.0.0.1:1080 user@your-server</code>.
            Test checks TCP port reachability only, not SSH connectivity.
          </p>
          <div className="network-settings-block">
            <div className="row between">
              <strong>Named proxies</strong>
              <button
                className="btn ghost small"
                type="button"
                disabled={busy || value.proxies.length >= 16}
                onClick={() =>
                  patch({
                    proxies: [
                      ...value.proxies,
                      {
                        name: `Proxy ${value.proxies.length + 1}`,
                        host: '127.0.0.1',
                        port: 1081 + value.proxies.length
                      }
                    ]
                  })
                }
              >
                + Add proxy
              </button>
            </div>
            {value.proxies.map((proxy, index) => (
              <div className="network-proxy-row" key={index}>
                <label>
                  Name
                  <input
                    value={proxy.name}
                    onChange={(e) =>
                      patch({
                        proxies: value.proxies.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)),
                        rules: value.rules.map((r) =>
                          r.route === `proxy:${proxy.name}` ? { ...r, route: `proxy:${e.target.value}` } : r
                        )
                      })
                    }
                  />
                </label>
                <label>
                  Host
                  <input
                    value={proxy.host}
                    placeholder="127.0.0.1"
                    onChange={(e) =>
                      patch({
                        proxies: value.proxies.map((p, i) => (i === index ? { ...p, host: e.target.value } : p))
                      })
                    }
                  />
                </label>
                <label>
                  Port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={proxy.port}
                    onChange={(e) =>
                      patch({
                        proxies: value.proxies.map((p, i) => (i === index ? { ...p, port: Number(e.target.value) } : p))
                      })
                    }
                  />
                </label>
                <button
                  className="btn ghost small"
                  type="button"
                  aria-label={`Remove ${proxy.name}`}
                  onClick={() =>
                    patch({
                      proxies: value.proxies.filter((_p, i) => i !== index),
                      rules: value.rules.map((r) => (r.route === `proxy:${proxy.name}` ? { ...r, route: 'proxy' } : r))
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="network-settings-block">
            <div className="row between">
              <strong>Routing rules</strong>
              <button
                className="btn ghost small"
                type="button"
                disabled={busy || value.rules.length >= 500}
                onClick={() => patch({ rules: [...value.rules, { pattern: '', route: 'proxy' }] })}
              >
                + Add rule
              </button>
            </div>
            <p className="muted small">
              Match a host (for example <code>*.example.com</code>) and route it directly or through a proxy.
            </p>
            {value.rules.map((rule, index) => (
              <div className="network-proxy-row" key={index}>
                <label>
                  Host pattern
                  <input
                    value={rule.pattern}
                    placeholder="*.example.com"
                    onChange={(e) =>
                      patch({ rules: value.rules.map((r, i) => (i === index ? { ...r, pattern: e.target.value } : r)) })
                    }
                  />
                </label>
                <label>
                  Route
                  <select
                    value={rule.route}
                    onChange={(e) =>
                      patch({
                        rules: value.rules.map((r, i) =>
                          i === index ? { ...r, route: e.target.value as typeof r.route } : r
                        )
                      })
                    }
                  >
                    <option value="proxy">Main proxy</option>
                    <option value="direct">Direct</option>
                    {value.proxies.map((p) => (
                      <option key={p.name} value={`proxy:${p.name}`}>
                        {p.name || 'Unnamed proxy'}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn ghost small"
                  type="button"
                  aria-label={`Remove rule ${rule.pattern}`}
                  onClick={() => patch({ rules: value.rules.filter((_r, i) => i !== index) })}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="row end network-settings-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void test()}>
              Test TCP port
            </button>
            <button className="btn mint" type="button" disabled={busy || !changed} onClick={() => void save()}>
              {busy ? 'Working…' : 'Save proxy settings'}
            </button>
          </div>
          {message && (
            <p
              className={`muted small network-settings-message${message.error ? ' is-error' : ''}`}
              role={message.error ? 'alert' : 'status'}
            >
              {message.text}
            </p>
          )}
        </fieldset>
      )}
    </section>
  )
}
