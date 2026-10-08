import { useCallback, useEffect, useState } from 'react'
import type { SyncStatus } from '../../../main/sync'

function ago(ts: number | null): string {
  if (!ts) return 'never synced'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'synced just now'
  if (s < 3600) return `synced ${Math.round(s / 60)} min ago`
  if (s < 86400) return `synced ${Math.round(s / 3600)} h ago`
  return `synced ${new Date(ts).toLocaleDateString()}`
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

  const load = useCallback(() => {
    window.api.sync
      .status()
      .then((s) => {
        setSt(s)
        setName((n) => n || s.deviceName)
      })
      .catch(console.error)
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
                On Android open Inkfish › Settings › Sync › Pair with Mac and scan this. Same Wi-Fi as this Mac.
                Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
              </p>
              <div className="row" style={{ marginTop: 0 }}>
                <button className="btn ghost sm" onClick={() => window.api.sync.pair().then(setSt)}>
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
                <button className="btn ghost sm" onClick={() => window.api.sync.pair().then(setSt)}>
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
    </>
  )
}
