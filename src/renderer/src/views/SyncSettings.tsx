import { useCallback, useEffect, useState } from 'react'
import type { SyncStatus } from '../../../main/sync'
import { summarize, type SyncLogEntry } from '../../../shared/sync'

function ago(ts: number | null): string {
  if (!ts) return 'never synced'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'synced just now'
  if (s < 3600) return `synced ${Math.round(s / 60)} min ago`
  if (s < 86400) return `synced ${Math.round(s / 3600)} h ago`
  return `synced ${new Date(ts).toLocaleDateString()}`
}

function when(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

function probeStatus(status: number): string {
  if (status === 200) return '200 · route and Inkfish listener responded'
  if (status === 403) return '403 · pairing code is missing or expired'
  if (status === 401) return '401 · pairing key was rejected'
  return `${status} · listener responded with an error`
}

/**
 * Settings › Sync: pair phones by QR and see who's paired. LAN only — the
 * phone finds this Mac on the same Wi-Fi and syncs directly, end-to-end
 * encrypted with a key that only ever travels inside the QR.
 */
export default function SyncSettings(): React.JSX.Element {
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [, tick] = useState(0)
  const [name, setName] = useState('')
  const [log, setLog] = useState<SyncLogEntry[]>([])

  const load = useCallback(() => {
    window.api.sync
      .status()
      .then((s) => {
        setSt(s)
        setName((n) => n || s.deviceName)
      })
      .catch(console.error)
    window.api.sync.log().then(setLog).catch(console.error)
  }, [])

  useEffect(() => {
    load()
    const off = window.api.sync.onStatus(load)
    const t = window.setInterval(() => tick((x) => x + 1), 1000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [load])

  const showPairingCode = (): void => {
    void window.api.sync
      .pair()
      .then(setSt)
      .catch((err: unknown) =>
        window.alert(`Could not start pairing: ${err instanceof Error ? err.message : String(err)}`)
      )
  }

  const pairing = st?.pairing && st.pairing.exp > Date.now() ? st.pairing : null
  const left = pairing ? Math.max(0, Math.round((pairing.exp - Date.now()) / 1000)) : 0

  return (
    <>
      <section className="settings-group">
        <h4>Sync with your phone</h4>
        <div className="setting-row inline">
          <div className="setting-label">
            Local network
            <span className="muted small setting-hint">
              {st?.running
                ? `Listening on ${st.hosts.length ? st.hosts.join(', ') : 'no Wi-Fi address'} · port ${st.port}`
                : st?.error
                  ? `Not listening: ${st.error}`
                  : 'Starting…'}
            </span>
          </div>
          <span className={`muted small`} aria-live="polite">
            {st?.running ? '● On' : '○ Off'}
          </span>
        </div>

        <details style={{ margin: '4px 0 12px 8px' }}>
          <summary className="muted small" style={{ cursor: 'pointer' }}>
            Network diagnostics
          </summary>
          <div className="muted small setting-hint" style={{ marginTop: 8 }}>
            Listener: {st?.running ? `0.0.0.0:${st.port} (all IPv4 interfaces)` : (st?.error ?? 'starting')}. The Mac's
            HTTP proxy does not control this inbound listener; a VPN, firewall, or Wi-Fi client isolation can still
            block it.
          </div>
          <div className="muted small setting-hint" style={{ marginTop: 8 }}>
            {st?.interfaces.length
              ? st.interfaces.map((iface) => (
                  <div key={iface.name}>
                    <strong>{iface.name}</strong>:{' '}
                    {iface.addresses
                      .map(
                        (address) =>
                          `${address.address} (${address.scope === 'vpn-overlay' ? 'VPN/overlay' : address.scope === 'link-local' ? 'link-local' : 'LAN'}${address.includedInQr ? ', in QR' : ', not in QR'})`
                      )
                      .join(' · ') || 'no local IPv4 address'}
                    {iface.omittedIpv4Count ? ` · ${iface.omittedIpv4Count} other IPv4 address(es) omitted` : ''}
                  </div>
                ))
              : 'No eligible local IPv4 interfaces found.'}
          </div>
          <div className="muted small setting-hint" style={{ marginTop: 8 }}>
            {st?.probes.length ? (
              <>
                Recent inbound probes (newest last):
                {st.probes.map((probe, i) => (
                  <div key={`${probe.at}-${i}`}>
                    {new Date(probe.at).toLocaleTimeString()} · {probe.remoteAddress} · {probe.method} {probe.path} ·{' '}
                    {probeStatus(probe.status)}
                  </div>
                ))}
                <div>
                  A probe means Android reached this listener. If pairing still fails, check the QR expiry/key and
                  compare the Android scan details.
                </div>
              </>
            ) : (
              'No /hello or pairing request has reached this Mac since the app started. If Android reports attempts, check that its VPN/proxy allows local addresses, both devices are on a non-guest network, and the Mac firewall allows Inkfish.'
            )}
          </div>
        </details>

        <div className="setting-row inline">
          <div className="setting-label">
            This Mac's name
            <span className="muted small setting-hint">Shown on the phone and in conflict copies.</span>
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && window.api.sync.rename(name).then(setSt)}
            aria-label="This Mac's name"
            style={{ maxWidth: 200 }}
          />
        </div>

        <div className="setting-row stacked">
          <span className="setting-label">Pair a phone</span>
          {pairing ? (
            <div className="sync-pair">
              <div className="sync-qr" dangerouslySetInnerHTML={{ __html: pairing.svg }} />
              <p className="muted small setting-hint">
                On Android open Inkfish › Settings › Sync › Pair with Mac and scan this, or use the Camera app and tap
                its Inkfish link. Same Wi-Fi as this Mac.
                <br />
                Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
              </p>
              <div className="row" style={{ marginTop: 0 }}>
                <button className="btn ghost sm" onClick={showPairingCode}>
                  New code
                </button>
                <button className="btn ghost sm" onClick={() => window.api.sync.cancelPair().then(setSt)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="muted small setting-hint">
                Shows a QR code for Inkfish on Android. Notes then sync directly over your Wi-Fi, encrypted, with no
                server or account. macOS may ask to allow incoming connections the first time.
              </p>
              <div className="row" style={{ marginTop: 0 }}>
                <button className="btn ghost sm" onClick={showPairingCode}>
                  Show pairing code
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="settings-group">
        <h4>Paired devices</h4>
        {st?.peers.length ? (
          st.peers.map((p) => (
            <div key={p.id} className="setting-row inline">
              <div className="setting-label">
                {p.name}
                <span className="muted small setting-hint">{ago(p.lastSync)}</span>
              </div>
              <button
                className="btn ghost sm"
                onClick={() => {
                  if (confirm(`Unpair ${p.name}? It will stop syncing until you pair again.`))
                    void window.api.sync.unpair(p.id).then(setSt)
                }}
              >
                Unpair
              </button>
            </div>
          ))
        ) : (
          <p className="muted small setting-hint">No phones yet.</p>
        )}
      </section>

      <section className="settings-group">
        <h4>Recent syncs</h4>
        {log.length ? (
          [...log]
            .reverse()
            .slice(0, 10)
            .map((e, i) => (
              <div key={`${e.at}-${i}`} className="setting-row inline">
                <div className="setting-label">
                  {e.peer || 'This Mac'}
                  <span className="muted small setting-hint">
                    {summarize(e)} · {when(e.at)}
                  </span>
                </div>
                <span
                  className="muted small"
                  style={e.kind === 'error' ? { color: 'var(--danger)' } : undefined}
                  aria-live="polite"
                >
                  {e.kind === 'error'
                    ? '● Failed'
                    : e.kind === 'hold'
                      ? '● Held'
                      : e.kind === 'heal'
                        ? '◆ Healed'
                        : '● Ok'}
                </span>
              </div>
            ))
        ) : (
          <p className="muted small setting-hint">No syncs yet — pair a phone above.</p>
        )}
      </section>
    </>
  )
}
