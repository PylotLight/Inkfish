import { useEffect, useState } from 'react'
import type { VaultInfo } from '../../../shared/types'

interface Props {
  step: number
  setStep: (n: number) => void
  vault: VaultInfo | null
  onVaultReady: (v: VaultInfo) => void
  onDone: () => void
  notify: (msg: string) => void
}

/** Onboarding: vault location FIRST (before any setup), then mic, shortcut. */
export default function Onboarding({ step, setStep, vault, onVaultReady, onDone, notify }: Props): React.JSX.Element {
  const [picked, setPicked] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [mic, setMic] = useState<'untested' | 'ok' | 'blocked'>('untested')

  useEffect(() => {
    setPicked(vault?.root ?? '')
  }, [vault?.root])

  const testMic = async (): Promise<void> => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
      setMic('ok')
    } catch {
      setMic('blocked')
    }
  }

  const choose = async (): Promise<void> => {
    const r = await window.api.vault.pick()
    if ('path' in r) setPicked(r.path)
    else if (r.error !== 'cancelled') notify(`Picker failed: ${r.error}`)
  }

  /** Commit the location: creates + seeds + indexes BEFORE anything else runs. */
  const useLocation = async (): Promise<void> => {
    if (vault?.managed) {
      // Dev/test env owns the location and main already initialized it.
      setStep(1)
      return
    }
    const root = picked.trim()
    if (!root) return
    if (vault?.configured && root === vault.root) {
      setStep(1)
      return
    }
    setBusy(true)
    try {
      const r = await window.api.vault.setRoot(root)
      if ('error' in r) {
        notify(`Vault setup failed: ${r.error}`)
      } else {
        onVaultReady(r.info)
        notify(`Notes ready — ${r.indexed} files indexed`)
        setStep(1)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal glass strong onboard">
        <span className="stat-label">Inkfish setup {step + 1}/3</span>
        {step === 0 && (
          <>
            <h3>Where do your notes live?</h3>
            <p className="muted">
              Pick a folder for your notes — a fresh empty folder, or an existing
              vault (Obsidian etc.) whose <code>.md</code> files get indexed on
              import. Inkfish adds <code>inbox/</code>, <code>projects/</code> and{' '}
              <code>assets/</code> inside; your files stay plain Markdown.
              Nothing is created until you confirm.
            </p>
            <code className="pill">{picked || '…'}</code>
            {vault?.managed && (
              <p className="muted small">Location is managed by INKFISH_VAULT (dev mode).</p>
            )}
            <div className="row">
              <button className="btn ghost" disabled={vault?.managed} onClick={() => void choose()}>
                Choose folder…
              </button>
              <button className="btn ghost" onClick={() => void window.api.vault.reveal()}>
                Reveal
              </button>
            </div>
            <div className="row end">
              <button
                className="btn mint"
                disabled={(!picked.trim() || busy) && vault?.managed !== true}
                onClick={() => void useLocation()}
              >
                {busy
                  ? 'Setting up…'
                  : vault?.managed
                    ? 'Continue'
                    : vault?.configured
                      ? 'Move notes here'
                      : 'Use this folder'}
              </button>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h3>Mic check</h3>
            <p className="muted">
              Voice notes + meeting capture need the mic. Headphones recommended (model-card
              noise weakness).
            </p>
            <div className="row">
              <button className="btn" onClick={() => void testMic()}>
                Test mic
              </button>
              <span className="muted">
                {mic === 'ok' ? '✓ hearing you' : mic === 'blocked' ? 'blocked — typing still works' : ''}
              </span>
            </div>
            <div className="row end">
              <button className="btn ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button className="btn" onClick={() => setStep(2)}>
                Next
              </button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h3>⌥Space captures from anywhere</h3>
            <p className="muted">
              The global shortcut pops capture from anywhere. <code>⌘↵</code> saves to the
              inbox — the worker routes it, raw is never deleted.
            </p>
            <div className="row end">
              <button className="btn ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button
                className="btn mint"
                onClick={() => {
                  localStorage.setItem('inkfish.onboarded', '1')
                  onDone()
                }}
              >
                Start capturing
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
